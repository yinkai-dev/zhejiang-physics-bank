// One command from "bank release is active locally" to "site and PDF service serve it".
//
//   node scripts/publish.mjs status [--server] [--json]
//   node scripts/publish.mjs run [--dry-run [--verify]] [--scope pdf,site] [--skip-sync] [--paper-meta <json>] [--allow-change] [--message <text>]
//   node scripts/publish.mjs rollback-pdf [--bundle <id>]
//
// run: sync snapshot -> export -> verify -> guard against published data -> install bank releases
// on the PDF server (only missing content is uploaded) -> switch the PDF service and prove it with
// a real PDF job (automatic rollback on failure) -> commit/push data -> wait for Pages -> verify live.
// The PDF service goes first so the site never offers questions the service cannot typeset.
// Every step is idempotent; re-running after an interruption continues where it stopped.
// Machine-specific settings live in the git-ignored .local/publish-config.json.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { readJson, writeJson, sha, verifyReleaseTree, parseArgs, loadConfig } from './lib/common.mjs';
import { diffPublic, describeDiff, diffSummary, loadPublicDir, loadPublicGit, totals } from './lib/diff.mjs';
import { Remote, buildBlob, blobSpec, fileEntry, pendingChunks } from './lib/remote.mjs';
import { classifyStatus } from './lib/gitstate.mjs';
import { request, describeError } from './lib/http.mjs';
import { choosePdfSample } from './lib/pdf-sample.mjs';

const DEFAULTS = {
  site_url: 'https://yinkai-dev.github.io/zhejiang-physics-bank/',
  pdf_url: 'https://8.141.125.113',
  pdf_origin: 'https://yinkai-dev.github.io',
  git_remote: 'origin', git_branch: 'main',
  remote: { python: '/opt/pwmcp/envs/v0.1.2-6910da0/bin/python', banks_root: '/srv/pwmcp/banks', service_root: '/opt/zjpdf', service: 'zjpdf', health: 'http://127.0.0.1:8781/bank-pdf/healthz', staging: '/var/tmp/zjpdf-deploy', engine_version: '0.1.2' },
};
const DATA_PATHS = ['public/data', 'public/images', 'metadata/paper-catalog.json'];
const BUNDLE_FILES = ['pdf-service/app.py', 'pdf-service/contract.py', 'pdf-service/compile_job.py', 'pdf-service/test_service.py', 'pdf-service/requirements.txt', 'pdf-service/README.md', 'pdf-service/zjpdf.service', 'pdf-service/deploy_remote.py', 'public/data/catalog.json', 'public/data/questions-index.json'];

const [command = 'status', ...rest] = process.argv.slice(2);
const args = parseArgs(rest, { flags: ['dry-run', 'verify', 'skip-sync', 'allow-change', 'server', 'json'], values: ['scope', 'message', 'bundle', 'paper-meta', 'ai-references'] });
const local = loadConfig();
const config = { ...DEFAULTS, ...local, remote: { ...DEFAULTS.remote, ...(local.remote || {}) } };
const dryRun = !!args['dry-run'];
const scope = new Set((args.scope || 'pdf,site').split(',').filter(Boolean));
for (const s of scope) assert(['pdf', 'site'].includes(s), `Unknown scope: ${s}`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const evidence = { schema_version: 1, command, started_at: new Date().toISOString(), dry_run: dryRun, scope: [...scope], steps: [] };
const say = (...m) => console.error(...m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- process helpers ----------
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
const gitOk = (...a) => spawnSync('git', a, { stdio: 'ignore' }).status === 0;
function runNode(script, scriptArgs = [], { capture = false } = {}) {
  const r = spawnSync(process.execPath, [script, ...scriptArgs], { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'], maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw Error(`${script} ${scriptArgs.join(' ')} failed (exit ${r.status})`);
  return capture ? r.stdout.toString('utf8') : '';
}
const lastJson = text => JSON.parse(text.slice(text.lastIndexOf('\n{') + 1 || text.indexOf('{')));
async function step(name, fn) {
  const started = Date.now();
  say(`\n▶ ${name}`);
  try {
    const result = await fn();
    const seconds = +((Date.now() - started) / 1000).toFixed(1);
    evidence.steps.push({ name, ok: true, seconds, ...(result && typeof result === 'object' ? { result } : {}) });
    say(`✔ ${name}（${seconds}s）`);
    return result;
  } catch (e) {
    evidence.steps.push({ name, ok: false, seconds: +((Date.now() - started) / 1000).toFixed(1), error: describeError(e), ...(e.result ? { remote: e.result } : {}) });
    throw e;
  }
}
function saveEvidence(ok) {
  Object.assign(evidence, { ok, finished_at: new Date().toISOString() });
  const file = `.local/evidence/publish/${stamp}-${command}${dryRun ? '-dry-run' : ''}.json`;
  writeJson(file, evidence, true);
  if (command === 'run' && !dryRun) writeJson('.local/evidence/publish/latest.json', evidence, true);
  return file;
}
async function fetchJson(url, init = {}, options = {}) {
  const { response: r, value: text } = await request(url, init, { log: say, ...options });
  let value = null;
  try { value = JSON.parse(text); } catch { /* reported by the caller through status */ }
  return { status: r.status, ok: r.ok, value, text };
}
const tryFetchJson = async url => { try { return await fetchJson(url); } catch (e) { return { ok: false, error: e.message }; } };

// ---------- local state ----------
const publicState = () => { const p = loadPublicDir('public'); return { ...p, summary: totals(p) }; };
function gitState() {
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD'), head = git('rev-parse', 'HEAD');
  // Untrimmed on purpose: the first status column of the first line may be a space.
  const changes = classifyStatus(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }), DATA_PATHS);
  const ref = `${config.git_remote}/${config.git_branch}`;
  const hasRef = gitOk('rev-parse', '--verify', '--quiet', ref);
  return {
    branch, head, ref, has_ref: hasRef,
    ...changes,
    ahead: hasRef ? Number(git('rev-list', '--count', `${ref}..HEAD`)) : null,
    behind: hasRef ? Number(git('rev-list', '--count', `HEAD..${ref}`)) : null,
  };
}
function wantedReleases(catalog) {
  return Object.fromEntries(Object.entries(catalog.source_releases).map(([bank, pointer]) => {
    const dir = `.local/banks/${bank}/releases/${pointer.release_id}`;
    const files = verifyReleaseTree(dir, pointer.release_sums_sha256);
    return [bank, { ...pointer, dir, files: files.map(f => [f.path, f.sha256, f.bytes]) }];
  }));
}
function bundleBlob() {
  return buildBlob(BUNDLE_FILES.map(p => { const b = fs.readFileSync(p); return { path: p, sha256: sha(b), bytes: b.length, read: () => b }; }));
}
const mb = n => (n / 1048576).toFixed(1) + ' MB';

// ---------- status ----------
async function status() {
  const pub = publicState(), g = gitState();
  const snapshot = readJson('.local/banks/active.json');
  const source = config.source_banks && fs.existsSync(path.join(config.source_banks, 'active.json')) ? readJson(path.join(config.source_banks, 'active.json')) : null;
  const [site, pdf] = await Promise.all([tryFetchJson(config.site_url + 'data/catalog.json?v=' + Date.now().toString(36)), tryFetchJson(config.pdf_url + '/bank-pdf/healthz')]);
  const out = {
    local: { public: pub.summary, releases: Object.fromEntries(Object.entries(pub.catalog.source_releases || {}).map(([k, v]) => [k, v.release_id])), snapshot: Object.fromEntries(Object.entries(snapshot).map(([k, v]) => [k, v.release_id])), source: source && Object.fromEntries(Object.keys(snapshot).map(k => [k, source[k]?.release_id ?? null])) },
    git: g,
    site: site.ok ? { version: site.value.version, papers: site.value.papers.length, questions: site.value.papers.reduce((s, p) => s + p.question_count, 0) } : { error: site.error || `HTTP ${site.status}` },
    pdf: pdf.ok ? pdf.value : { error: pdf.error || `HTTP ${pdf.status}` },
    drift: [],
  };
  if (out.local.source) for (const [bank, id] of Object.entries(out.local.source)) if (id !== out.local.snapshot[bank]) out.drift.push(`本机快照 ${bank} 落后于题库：${out.local.snapshot[bank]} → ${id}（运行 bank:publish 会同步）`);
  for (const [bank, id] of Object.entries(out.local.snapshot)) if (out.local.releases[bank] !== id) out.drift.push(`公开投影 ${bank} 未按当前快照导出`);
  if (g.data_changes) out.drift.push(`公开数据有 ${g.data_changes} 处未提交`);
  if (g.ahead) out.drift.push(`本地领先 ${g.ref} ${g.ahead} 个提交未推送`);
  if (out.site.error) out.drift.push(`站点无法读取：${out.site.error}`); else if (out.site.version !== pub.summary.version) out.drift.push('线上站点数据版本与本机不同');
  if (out.pdf.error) out.drift.push(`PDF 服务无法读取：${out.pdf.error}`); else if (out.pdf.public_version !== pub.summary.version) out.drift.push('PDF 服务数据版本与本机不同（新题无法生成 PDF）');
  if (!out.site.error && !out.pdf.error && out.site.version !== out.pdf.public_version) out.drift.push('站点与 PDF 服务不是同一数据版本');
  if (args.server) out.server = await new Remote(config, 'pdf-service/deploy_remote.py').call('status', { banks: Object.keys(snapshot) });
  if (args.json) { console.log(JSON.stringify(out, null, 2)); return out; }
  const short = v => (v || '—').slice(0, 12);
  console.log(`本机   ${short(pub.summary.version)}  ${pub.summary.papers} 卷 / ${pub.summary.questions} 题 / 来源答案 ${pub.summary.answers.source}`);
  for (const [bank, id] of Object.entries(out.local.snapshot)) console.log(`       ${bank}  ${id}${out.local.source && out.local.source[bank] !== id ? `  （题库已是 ${out.local.source[bank]}）` : ''}`);
  console.log(`Git    ${g.branch} @ ${g.head.slice(0, 7)}  数据未提交 ${g.data_changes}  领先 ${g.ahead ?? '—'} / 落后 ${g.behind ?? '—'}`);
  console.log(`站点   ${out.site.error ? '读取失败：' + out.site.error : `${short(out.site.version)}  ${out.site.papers} 卷 / ${out.site.questions} 题`}`);
  console.log(`PDF    ${out.pdf.error ? '读取失败：' + out.pdf.error : `${short(out.pdf.public_version)}  ${out.pdf.questions ?? '—'} 题  bundle ${out.pdf.bundle ?? '—'}`}`);
  if (out.server) { console.log(`服务器 current=${out.server.current}  已装 bundle：${out.server.bundles.join(', ')}`); for (const [bank, b] of Object.entries(out.server.banks)) console.log(`       ${bank}  已装 ${b.installed.join(', ')}  （原 MCP 使用 ${b.mcp_active_release}）`); }
  console.log(out.drift.length ? '\n不一致：\n' + out.drift.map(d => '  - ' + d).join('\n') : '\n本机、站点、PDF 服务数据版本一致。');
  return out;
}

// ---------- PDF service ----------
async function smokeJob(pub, preferred) {
  const papers = new Map(pub.catalog.papers.map(p => [p.paper_id, p]));
  const pool = preferred.length ? pub.index.filter(q => preferred.includes(q.id)) : pub.index.filter(q => q.paper_id === pub.catalog.papers.at(-1).paper_id);
  const chosen = choosePdfSample(pool, papers);
  assert(chosen.length, 'PDF 自检找不到公开题目');
  const body = { title: `发布自检 ${stamp.slice(0, 16)}`, answers: true, items: chosen.map(q => ({ id: q.id, fingerprint: q.fingerprint })) };
  const headers = { 'Content-Type': 'application/json', Origin: config.pdf_origin };
  // Store.submit deduplicates the same request hash while queued/running/succeeded.
  // Keep exactly the same title, selection and body on retries after a lost response.
  let job = await fetchJson(config.pdf_url + '/bank-pdf/jobs', { method: 'POST', headers, body: JSON.stringify(body) }, { idempotent: true });
  assert(job.ok, `PDF 任务提交失败（HTTP ${job.status}）：${job.value?.message || job.text.slice(0, 200)}`);
  const id = job.value.job_id, deadline = Date.now() + 240000;
  while (['queued', 'running'].includes(job.value.status)) {
    assert(Date.now() < deadline, 'PDF 任务超时');
    await sleep(2000);
    job = await fetchJson(`${config.pdf_url}/bank-pdf/jobs/${id}`);
  }
  assert.equal(job.value.status, 'succeeded', `PDF 任务失败：${job.value.message || job.value.status}（任务 ${id}）`);
  const sourceAnswers = chosen.filter(q => q.answer_status === 'source').length;
  assert.equal(job.value.answers?.with_source_answer, sourceAnswers, 'PDF 自检原卷答案数量不符');
  assert.deepEqual(job.value.files.map(f => f.kind).sort(), sourceAnswers ? ['answers', 'worksheet'] : ['worksheet'], 'PDF 自检缺少预期产物');
  const files = [];
  for (const f of job.value.files) {
    const { response: r, value: bytes } = await request(config.pdf_url + f.url, {}, { timeoutMs: 60000, read: r => r.arrayBuffer(), log: say });
    const data = Buffer.from(bytes);
    assert(r.ok && data.subarray(0, 5).toString() === '%PDF-' && sha(data) === f.sha256, `下载的 ${f.kind} PDF 校验失败`);
    const file = `.local/evidence/publish/${stamp}-${f.kind}.pdf`;
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data);
    files.push({ kind: f.kind, pages: f.pages, bytes: data.length, sha256: f.sha256, saved: file });
  }
  return { job_id: id, questions: chosen.map(q => `${papers.get(q.paper_id).title} 第${q.number}题（${q.type}）`), answers: job.value.answers, files };
}

async function publishPdf(pub, addedQuestions) {
  const remote = new Remote(config, 'pdf-service/deploy_remote.py');
  const wanted = wantedReleases(pub.catalog), bundle = bundleBlob();
  const releaseArgs = Object.fromEntries(Object.entries(wanted).map(([bank, w]) => [bank, { release_id: w.release_id, release_sums_sha256: w.release_sums_sha256, files: w.files }]));
  // Connection 1: what is installed, which file contents are missing, which chunks are already staged.
  const plan = await step('探测 PDF 服务器（只读）', async () => {
    const probe = await remote.call('probe', { releases: releaseArgs });
    const blobs = {}, pending = {};
    for (const [bank, state] of Object.entries(probe.releases)) {
      if (state.present) continue;
      assert(!state.target_exists, `服务器上 ${bank}/${wanted[bank].release_id} 目录已存在但校验不符，需人工检查`);
      const missing = new Set(state.missing);
      blobs[bank] = buildBlob(wanted[bank].files.filter(f => missing.has(f[0])).map(f => fileEntry(wanted[bank].dir, ...f)));
      pending[bank] = pendingChunks(blobs[bank], probe.chunks);
    }
    const summary = {
      service: probe.service, bundle_id: bundle.id, bundle_current: probe.service.current === bundle.id && probe.service.health?.public_version === pub.summary.version,
      releases: Object.fromEntries(Object.entries(wanted).map(([bank, w]) => [bank, probe.releases[bank].present ? { release_id: w.release_id, installed: true } : { release_id: w.release_id, installed: false, total_files: w.files.length, upload_files: blobs[bank].entries.length, upload_bytes: blobs[bank].bytes, reuse_files: w.files.length - blobs[bank].entries.length, chunks: blobs[bank].chunks.length, chunks_already_uploaded: blobs[bank].chunks.length - pending[bank].length }])),
    };
    say(`  服务当前 bundle=${probe.service.current}，数据版本 ${(probe.service.health?.public_version || '不可用').slice(0, 12)} → 目标 ${pub.summary.version.slice(0, 12)}（bundle ${bundle.id}）`);
    for (const [bank, r] of Object.entries(summary.releases)) say(r.installed ? `  ${bank}/${r.release_id} 已安装` : `  ${bank}/${r.release_id} 待安装：上传 ${r.upload_files} 个文件 ${mb(r.upload_bytes)}，服务器已有内容复用 ${r.reuse_files} 个；分 ${r.chunks} 块，已传 ${r.chunks_already_uploaded} 块`);
    return { summary, blobs, pending, staged: probe.chunks };
  });
  evidence.steps.at(-1).result = plan.summary;
  if (dryRun) return { plan: plan.summary };

  // Connection 2 (per missing release): upload the missing content and install it in the same session.
  for (const [bank, blob] of Object.entries(plan.blobs)) {
    await step(`上传并安装题库 release ${bank}/${wanted[bank].release_id}`, () =>
      remote.call('install', { bank, ...releaseArgs[bank], blob: blobSpec(blob) }, { stream: plan.pending[bank], log: say }));
  }
  // Connection 3: bundle upload, preflight, switch, health check (the server rolls itself back if unhealthy).
  const deployed = await step('切换 PDF 服务', async () => {
    if (plan.summary.bundle_current) return { bundle: bundle.id, switched: false, health: plan.summary.service.health };
    return remote.call('deploy', { bundle_id: bundle.id, expected_public_version: pub.summary.version, blob: blobSpec(bundle) }, { stream: pendingChunks(bundle, plan.staged), log: say });
  });
  try {
    await step('公网真实生成 PDF 自检', async () => {
      const health = await fetchJson(config.pdf_url + '/bank-pdf/healthz');
      assert(health.ok && health.value.public_version === pub.summary.version, `公网健康检查版本不符：${health.value?.public_version}`);
      return smokeJob(pub, addedQuestions);
    });
  } catch (e) {
    if (deployed.switched && deployed.previous) {
      say(`✘ 自检失败，回滚 PDF 服务到 ${deployed.previous}`);
      await step('回滚 PDF 服务', () => remote.call('rollback', { bundle_id: deployed.previous }));
    }
    throw e;
  }
  return { bundle: bundle.id, previous: deployed.previous ?? null, switched: !!deployed.switched, ssh_connections: remote.connections };
}

// ---------- site ----------
async function publishSite(pub, diff) {
  const committed = await step('提交公开数据', () => {
    execFileSync('git', ['add', '--', ...DATA_PATHS], { stdio: 'inherit' });
    const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
    const outside = staged.filter(f => !DATA_PATHS.some(p => f.startsWith(p)));
    assert(!outside.length, `暂存区含数据以外的文件：${outside.join(', ')}`);
    if (!staged.length) return { committed: false, head: git('rev-parse', 'HEAD') };
    const n = diff.totals.next;
    const message = args.message || `data: publish ${n.papers} papers / ${n.questions} questions\n\n+${diff.added_papers.length} papers, +${diff.added_questions.length} questions, +${diff.answers_gained.length} answers on existing questions; source answers ${n.answers.source}.\nPublic version ${n.version}.`;
    execFileSync('git', ['commit', '-q', '-m', message], { stdio: 'inherit' });
    return { committed: true, files: staged.length, head: git('rev-parse', 'HEAD') };
  });
  const head = committed.head, ref = `${config.git_remote}/${config.git_branch}`;
  const pushed = await step('推送到 GitHub', () => {
    if (git('rev-parse', ref) === head) return { pushed: false };
    execFileSync('git', ['push', config.git_remote, `HEAD:${config.git_branch}`], { stdio: 'inherit' });
    return { pushed: true };
  });
  if (pushed.pushed && spawnSync('gh', ['--version'], { stdio: 'ignore' }).status === 0) await step('等待 Pages 构建', async () => {
    for (const deadline = Date.now() + 900000; Date.now() < deadline; await sleep(8000)) {
      const r = spawnSync('gh', ['run', 'list', '--commit', head, '--json', 'databaseId,status,conclusion,workflowName', '--limit', '5'], { encoding: 'utf8' });
      const run = r.status === 0 ? JSON.parse(r.stdout)[0] : null;
      if (run?.status === 'completed') { assert.equal(run.conclusion, 'success', `Pages 构建失败：run ${run.databaseId}`); return { run: run.databaseId }; }
    }
    throw Error('等待 Pages 构建超时');
  });
  return step('线上站点验证', async () => {
    const image = pub.index.length ? (pub.paper(pub.catalog.papers.at(-1).paper_id) || []).flatMap(q => JSON.stringify(q).match(/images\/[a-f0-9]{64}\.png/g) || [])[0] : null;
    for (const deadline = Date.now() + 480000; ; await sleep(6000)) {
      const live = await tryFetchJson(`${config.site_url}data/catalog.json?v=${pub.summary.version.slice(0, 12)}-${Date.now().toString(36)}`);
      if (live.ok && live.value.version === pub.summary.version) break;
      assert(Date.now() < deadline, `线上数据版本仍为 ${live.value?.version || live.error}`);
    }
    const checks = { catalog_version: pub.summary.version };
    for (const [name, p] of Object.entries({ index: '', ...(image ? { image } : {}) })) { const { response: r } = await request(config.site_url + p, {}, { timeoutMs: 30000, read: r => r.arrayBuffer(), log: say }); assert(r.ok, `${name} HTTP ${r.status}`); checks[name] = r.status; }
    return { head, ...checks };
  });
}

// ---------- run ----------
async function run() {
  const g0 = await step('检查工作区', () => {
    if (gitOk('remote', 'get-url', config.git_remote)) execFileSync('git', ['fetch', '-q', config.git_remote, config.git_branch], { stdio: 'inherit', timeout: 60000 });
    const g = gitState(), problems = [];
    if (g.branch !== config.git_branch) problems.push(`当前分支 ${g.branch}，发布只从 ${config.git_branch} 进行`);
    if (g.other_changes.length) problems.push(`数据以外有未提交改动：${g.other_changes.slice(0, 6).join(', ')}`);
    if (g.behind) problems.push(`本地落后 ${g.ref} ${g.behind} 个提交`);
    if (scope.has('pdf')) assert(config.ssh_host, '缺少 ssh_host：在 .local/publish-config.json 中配置');
    if (problems.length) { if (!dryRun) throw Error(problems.join('；')); problems.forEach(p => say('  ⚠ ' + p + '（dry-run 继续）')); }
    return { ...g, problems };
  });
  if (!args['skip-sync']) {
    assert(config.source_banks, '缺少 source_banks：在 .local/publish-config.json 中配置，或加 --skip-sync');
    const synced = await step(dryRun ? '同步题库快照（预演）' : '同步题库快照', () => {
      const syncArgs = dryRun ? ['--dry-run'] : [];
      if (args['allow-change']) syncArgs.push('--allow-removal');
      const metaPath = args['paper-meta'] || config.paper_meta;
      if (metaPath) syncArgs.push('--paper-meta', path.resolve(metaPath));
      const s = lastJson(runNode('scripts/sync-bank.mjs', syncArgs, { capture: true }));
      for (const b of s.banks) say(`  ${b.bank_id}  ${b.pointer_changed ? `${b.previous_release_id} → ${b.release_id}，新增 ${b.added_papers.length} 卷` : `${b.release_id}（未变）`}`);
      return s;
    });
    if (dryRun && synced.changed) say('  ⚠ 题库有新 release，dry-run 不改本机文件；以下计划基于当前已导出的投影，正式运行会先同步并重新导出。');
  }
  if (!dryRun) await step('导出公开投影', () => {
    const exportArgs = args['allow-change'] ? ['--allow-change'] : [];
    if (args['ai-references']) exportArgs.push('--ai-references', path.resolve(args['ai-references']));
    return lastJson(runNode('scripts/export-bank.mjs', exportArgs, { capture: true }));
  });
  if (dryRun && !args.verify) say('  本次仅预览发布计划。正式发布会执行数据、公式、接口和构建校验。');
  else await step('校验与构建', () => {
    runNode('scripts/check-public.mjs', [], { capture: true });
    runNode('--test', ['tests/*.test.mjs'], { capture: true });
    const math = lastJson(runNode('scripts/check-math.mjs', [], { capture: true }));
    const python = config.python || ['.venv/Scripts/python.exe', '.venv/bin/python'].find(p => fs.existsSync(p));
    let pdfTests = 'skipped: no python environment';
    if (python) { const r = spawnSync(python, ['-m', 'unittest', 'discover', '-s', 'pdf-service', '-p', 'test_*.py'], { encoding: 'utf8' }); if (r.status !== 0) throw Error('pdf-service tests failed:\n' + r.stderr.slice(-2000)); pdfTests = (r.stderr.match(/Ran \d+ tests?/) || ['ok'])[0]; }
    runNode('node_modules/typescript/bin/tsc', ['--noEmit']);
    runNode('node_modules/vite/bin/vite.js', ['build', '--logLevel', 'warn']);
    const dist = lastJson(runNode('scripts/check-public.mjs', ['dist'], { capture: true }));
    return { formulas: math.count, formula_errors: math.errors, distinct_formulas_rendered: math.rendered,
      distinct_formulas_reused: math.reused, pdf_service_tests: pdfTests, dist };
  });
  const pub = publicState();
  const diff = await step('对比已发布数据', () => {
    const ref = g0.has_ref ? g0.ref : 'HEAD';
    const d = diffPublic(loadPublicGit(ref), pub);
    describeDiff(d).forEach(l => say('  ' + l));
    assert(!d.blocking || args['allow-change'], '会移除或改动已上线题目：按常设授权需先向负责人确认，再加 --allow-change 重跑。');
    return d;
  });
  evidence.steps.at(-1).result = diffSummary(diff);
  const outcome = { version: pub.summary.version, totals: pub.summary };
  if (scope.has('pdf')) outcome.pdf = await publishPdf(pub, diff.added_questions);
  if (scope.has('site')) {
    if (dryRun) await step('站点发布计划', () => { const g = gitState(); say(`  待提交数据文件 ${g.data_changes} 处；领先 ${g.ref} ${g.ahead ?? '—'} 个提交`); return { data_changes: g.data_changes, ahead: g.ahead }; });
    else outcome.site = await publishSite(pub, diff);
  }
  return outcome;
}

async function rollbackPdf() {
  let bundle = args.bundle;
  if (!bundle) { const last = readJson('.local/evidence/publish/latest.json'); bundle = last.outcome?.pdf?.previous; }
  assert(bundle, '没有可回滚的 bundle：用 --bundle <id> 指定（status --server 可列出已安装的 bundle）');
  return step(`回滚 PDF 服务到 ${bundle}`, () => new Remote(config, 'pdf-service/deploy_remote.py').call('rollback', { bundle_id: bundle }));
}

try {
  if (command === 'status') await status();
  else if (command === 'run') {
    evidence.outcome = await run();
    const file = saveEvidence(true);
    say(`\n${dryRun ? '预演完成（未改动服务器、未提交）' : '发布完成'}。记录：${file}`);
    if (!dryRun) { say(''); await status(); }
  } else if (command === 'rollback-pdf') { evidence.outcome = await rollbackPdf(); saveEvidence(true); console.log(JSON.stringify(evidence.outcome, null, 2)); }
  else throw Error(`Unknown command: ${command}`);
} catch (e) {
  if (command !== 'status') say(`\n✘ ${e.message}\n记录：${saveEvidence(false)}`); else say(`✘ ${e.message}`);
  process.exit(1);
}

// Sync the active release of each public bank from the source bank root into the local snapshot,
// then refresh the import report and the public paper catalog. Generic: no per-batch constants.
//
//   node scripts/sync-bank.mjs [--source <SourceBanks>] [--bank <id>]... [--paper-meta <json>]
//                              [--allow-removal] [--dry-run] [--root <dir>]
//
// --source defaults to `source_banks` in .local/publish-config.json. Only banks already listed in
// metadata/paper-catalog.json are considered; other banks under the source root are never read.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readJson, readLines, writeJson, verifyReleaseTree, validPointer, parseArgs, loadConfig, sha } from './lib/common.mjs';
import { buildNewPaper } from './lib/paper-meta.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['dry-run', 'allow-removal'], values: ['source', 'root', 'paper-meta'], multi: ['bank'] });
const root = path.resolve(args.root || process.cwd());
const at = (...p) => path.join(root, ...p);
const sourceArg = args.source || loadConfig(root).source_banks;
assert(sourceArg, 'Source bank root missing: pass --source or set source_banks in .local/publish-config.json');
const sourceRoot = path.resolve(sourceArg);
const dryRun = !!args['dry-run'];
const paperMeta = args['paper-meta'] ? readJson(path.resolve(args['paper-meta'])) : {};

const catalogPath = at('metadata/paper-catalog.json');
const catalog = readJson(catalogPath);
const publicBanks = catalog.collections.map(c => c.collection_id);
const banks = args.bank || publicBanks;
for (const b of banks) assert(publicBanks.includes(b), `Bank is not in the public catalog: ${b}`);

const sourceActive = readJson(path.join(sourceRoot, 'active.json'));
const localActivePath = at('.local/banks/active.json');
// A machine without a snapshot yet starts empty and is filled from the source releases.
const localActive = fs.existsSync(localActivePath) ? readJson(localActivePath) : {};
const reportPath = at('.local/import-report.json');
const report = fs.existsSync(reportPath) ? readJson(reportPath) : { generated_at: null, method: 'sync-bank: source release manifest verified; every copied file SHA256 compared; existing mismatches stop', file_count: 0, total_bytes: 0, releases: {}, files: [] };
const reportPaths = new Set(report.files.map(f => f.path));
const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
const summary = { dry_run: dryRun, source_root: sourceRoot, banks: [] };
let changed = false;

function newPaper(collection, doc, questionCount, sourceAnswers) {
  return buildNewPaper(collection, doc, questionCount, sourceAnswers, paperMeta);
}

for (const bankId of banks) {
  const pointer = sourceActive[bankId];
  assert(validPointer(pointer), `Invalid source pointer for ${bankId}`);
  const relative = `${bankId}/releases/${pointer.release_id}`;
  const sourceRelease = path.join(sourceRoot, relative);
  const destRelease = at('.local/banks', relative);
  const previous = localActive[bankId];
  const entry = { bank_id: bankId, release_id: pointer.release_id, previous_release_id: previous?.release_id || null };
  summary.banks.push(entry);
  const samePointer = previous && previous.release_id === pointer.release_id && previous.release_sums_sha256 === pointer.release_sums_sha256;

  // 1. Verify the source release completely, then mirror it (never overwriting differing files).
  const files = verifyReleaseTree(sourceRelease, pointer.release_sums_sha256);
  let copied = 0, copiedBytes = 0;
  for (const f of files) {
    const dest = path.join(destRelease, f.path);
    if (fs.existsSync(dest)) { assert.equal(sha(fs.readFileSync(dest)), f.sha256, `Existing local snapshot differs: ${relative}/${f.path}`); continue; }
    copied++; copiedBytes += f.bytes;
    if (dryRun) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(sourceRelease, f.path), dest);
    assert.equal(sha(fs.readFileSync(dest)), f.sha256, `Copied file differs: ${f.path}`);
  }
  Object.assign(entry, { files: files.length, copied_files: copied, copied_bytes: copiedBytes, pointer_changed: !samePointer });

  // 2. Pointer and import report (old release entries stay; they remain verifiable on disk).
  if (!samePointer) { localActive[bankId] = pointer; report.releases[bankId] = pointer; changed = true; }
  const added = files.map(f => ({ path: `${relative}/${f.path}`, sha256: f.sha256, bytes: f.bytes })).filter(f => !reportPaths.has(f.path));
  if (added.length) {
    report.files = report.files.concat(added); added.forEach(f => reportPaths.add(f.path));
    report.file_count = report.files.length;
    report.total_bytes = report.files.reduce((s, f) => s + f.bytes, 0);
    report.expansions = (report.expansions || []).concat([{ bank_id: bankId, release_id: pointer.release_id, previous_release_id: entry.previous_release_id, imported_at: now.toISOString(), added_files: added.length, method: 'sync-bank: source release manifest verified; every copied file SHA256 compared; earlier snapshot entries preserved' }]);
    changed = true;
  }

  // 3. Catalog: counts always follow the release; hand-maintained paper metadata is preserved.
  const release = readJson(path.join(sourceRelease, 'release.json'));
  const pkg = readJson(path.join(sourceRelease, 'question-package/package.json'));
  const questions = readLines(path.join(sourceRelease, 'question-package/questions.jsonl'));
  const answerId = release.components.answers?.answer_package_id;
  const answers = answerId ? readLines(path.join(sourceRelease, 'answers', answerId, 'answers.jsonl')) : [];
  const collection = catalog.collections.find(c => c.collection_id === bankId);
  const before = JSON.stringify([collection, catalog.papers.filter(p => p.collection_id === bankId)]);
  Object.assign(collection, {
    paper_count: pkg.documents.length, question_count: questions.length,
    question_image_count: release.components.question_package.required_asset_count,
    source_answer_count: answers.filter(a => a.status === 'source').length,
    explicitly_missing_answer_count: answers.filter(a => a.status === 'missing').length,
    answer_not_ingested_count: questions.length - answers.length,
  });
  const byId = new Map(catalog.papers.map(p => [p.paper_id, p]));
  const seen = new Set(), addedPapers = [];
  for (const doc of pkg.documents) {
    const paperId = `${bankId}--${doc.document_id}`;
    seen.add(paperId);
    const count = questions.filter(q => q.document_id === doc.document_id).length;
    const source = answers.filter(a => a.document_id === doc.document_id && a.status === 'source').length;
    const existing = byId.get(paperId);
    if (existing) Object.assign(existing, { question_count: count, source_answer_count: source });
    else { catalog.papers.push(newPaper(collection, doc, count, source)); addedPapers.push(paperId); }
  }
  const removed = catalog.papers.filter(p => p.collection_id === bankId && !seen.has(p.paper_id)).map(p => p.paper_id);
  if (removed.length) {
    assert(args['allow-removal'], `Release ${pointer.release_id} no longer contains published papers: ${removed.join(', ')}. Re-run with --allow-removal only after the owner confirms.`);
    catalog.papers = catalog.papers.filter(p => !removed.includes(p.paper_id));
  }
  if (JSON.stringify([collection, catalog.papers.filter(p => p.collection_id === bankId)]) !== before) changed = true;
  Object.assign(entry, { added_papers: addedPapers, removed_papers: removed, papers: pkg.documents.length, questions: questions.length, answers: { source: collection.source_answer_count, missing: collection.explicitly_missing_answer_count, not_ingested: collection.answer_not_ingested_count } });
}

summary.changed = changed;
summary.papers = catalog.papers.length;
summary.questions = catalog.collections.reduce((s, c) => s + c.question_count, 0);
if (changed && !dryRun) {
  catalog.snapshot_date = today;
  report.generated_at = now.toISOString();
  writeJson(localActivePath, localActive, true);
  writeJson(reportPath, report, true);
  writeJson(catalogPath, catalog, true);
  writeJson(at('.local/evidence/sync', `${now.toISOString().replace(/[:.]/g, '-')}.json`), summary, true);
}
console.log(JSON.stringify(summary, null, 2));

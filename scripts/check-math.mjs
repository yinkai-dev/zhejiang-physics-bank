import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { parseArgs, readJson, sha, walkFiles } from './lib/common.mjs';

const require = createRequire(import.meta.url);
const rendererEntry = require.resolve('mathjax/es5/node-main.js');
const renderConfig = {
  loader: { load: ['input/tex-full', 'output/svg'] },
  startup: { typeset: false },
  svg: { fontCache: 'none' },
};
const renderOptions = { display: false };
const renderError = /data-mjx-error|merror|fill="red"/;
const cachePath = '.local/evidence/math-success-cache.json';
const reportPath = '.local/evidence/math-report.json';
const cacheSchema = 1;
const checksum = /^[a-f0-9]{64}$/;

// Only reuse results for the closed, context-independent math commands
// accepted by the frozen worksheet renderer. Any other syntax falls back to
// a full check in input order, since MathJax commands can affect later formulas.
const independentControls = new Set((
  'frac dfrac tfrac sqrt cdot times div pm mp le leq ge geq ll gg ne neq approx sim simeq ' +
  'equiv propto infty degree circ angle perp parallel sin cos tan cot arcsin arccos ' +
  'arctan log ln exp max min lim sum prod int iint oint partial nabla Delta delta ' +
  'alpha beta gamma Gamma theta Theta lambda Lambda mu nu rho sigma Sigma tau phi ' +
  'Phi omega Omega epsilon varepsilon pi Pi eta kappa zeta chi psi Psi varphi vartheta ' +
  'vec overrightarrow overline underline hat bar dot ddot mathrm mathbf mathit text ' +
  'left right lvert rvert vert Vert lVert rVert cdots ldots dots quad qquad forall ' +
  'exists in notin subset supset cup cap to rightarrow leftarrow leftrightarrow ' +
  'Rightarrow Leftarrow Leftrightarrow'
).split(' ').concat([...'{},;! |%']));

function isContextIndependent(tex) {
  if (/[#$&\x00-\x1f\x7f]|\^\^/.test(tex)) return false;
  for (const [, control] of tex.matchAll(/\\([A-Za-z]+|[^A-Za-z])/g)) {
    if (!independentControls.has(control)) return false;
  }
  return true;
}

function collectFormulas() {
  const formulas = new Map();
  let questions = 0;
  let count = 0;

  function walk(value, qid) {
    if (!value || typeof value !== 'object') return;
    if (value.type === 'math') {
      assert.equal(typeof value.value, 'string', 'Invalid formula value: ' + qid);
      count++;
      if (!formulas.has(value.value)) formulas.set(value.value, qid);
    }
    for (const child of Object.values(value)) walk(child, qid);
  }

  const dir = 'public/data/papers';
  const files = fs.readdirSync(dir);
  for (const file of files) {
    for (const question of readJson(path.join(dir, file)).questions) {
      questions++;
      walk(question, question.id);
    }
  }
  return { papers: files.length, questions, count, formulas };
}

function rendererIdentity() {
  const dir = path.dirname(rendererEntry);
  const components = walkFiles(dir).sort().map(file => [
    path.relative(dir, file).split(path.sep).join('/'),
    sha(fs.readFileSync(file)),
  ]);
  return sha(JSON.stringify({
    components,
    package: sha(fs.readFileSync(path.join(dir, '..', 'package.json'))),
    checker: sha(fs.readFileSync(new URL(import.meta.url))),
    runtime: [process.platform, process.arch, process.versions, process.execArgv, process.env.NODE_OPTIONS],
  }));
}

function readSuccessCache(renderer) {
  try {
    const { schema_version, renderer_id, successes, digest } = readJson(cachePath);
    const payload = { schema_version, renderer_id, successes };
    if (schema_version === cacheSchema && checksum.test(renderer_id) &&
        Array.isArray(successes) && successes.every(hash => typeof hash === 'string' && checksum.test(hash)) &&
        digest === sha(JSON.stringify(payload))) {
      if (renderer_id === renderer) return { status: 'reused', known: new Set(successes) };
      return { status: 'renderer-changed', known: new Set() };
    }
  } catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', known: new Set() };
  }
  return { status: 'invalid', known: new Set() };
}

function writeAtomicJson(file, value, indent) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, indent) + '\n', { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

const args = parseArgs(process.argv.slice(2), { flags: ['full'] });
assert.equal(args._.length, 0, 'Usage: node scripts/check-math.mjs [--full]');
const { papers, questions, count, formulas } = collectFormulas();
const contextIndependent = [...formulas.keys()].every(isContextIndependent);
const renderer = rendererIdentity();
const selected = !contextIndependent ? 'context-dependent' : args.full ? 'forced' : null;
const cache = selected ? { status: selected, known: new Set() } : readSuccessCache(renderer);
const pending = new Map();
const successes = [];
for (const [tex, qid] of formulas) {
  // JSON encoding preserves the exact string, including whitespace and lone surrogates.
  const hash = sha(JSON.stringify(tex));
  if (!cache.known.has(hash)) pending.set(tex, qid);
  successes.push(hash);
}

const problems = [];
if (pending.size) {
  const { init } = require(rendererEntry);
  const math = await init(renderConfig);
  for (const [tex, qid] of pending) {
    const output = math.startup.adaptor.outerHTML(math.tex2svg(tex, renderOptions));
    if (renderError.test(output)) problems.push({ qid, tex, output });
  }
}

const stats = {
  papers, questions, count, unique: formulas.size, errors: problems.length,
  rendered: pending.size, reused: formulas.size - pending.size, cache_status: cache.status,
  renderer_id: renderer,
};
writeAtomicJson(reportPath, { ...stats, problems }, 2);
console.log(JSON.stringify({ ...stats, problems: problems.map(({ qid, tex }) => ({ qid, tex })) }, null, 2));
assert.equal(problems.length, 0, 'Formula rendering errors');
if (contextIndependent && (cache.status !== 'reused' || pending.size || cache.known.size !== formulas.size)) {
  const payload = { schema_version: cacheSchema, renderer_id: renderer, successes: successes.sort() };
  try {
    writeAtomicJson(cachePath, { ...payload, digest: sha(JSON.stringify(payload)) });
  } catch (error) {
    console.warn('Could not save formula cache: ' + error.message);
  }
}

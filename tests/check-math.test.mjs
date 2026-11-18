import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('../scripts/check-math.mjs', import.meta.url));
const require = createRequire(import.meta.url);
const cacheFile = '.local/evidence/math-success-cache.json';
const simple = String.raw`\frac{1}{2}`;
const oldZ20 = String.raw`B q v = M \frac {v ^ {2}}{r}, \text {\text{联立可得}：} r = \frac {\sqrt {2 M E _ {1}}}{B q}`;
const fixedZ20 = oldZ20.replace(String.raw`\text {\text{联立可得}：}`, String.raw`\text{联立可得：}`);
const math = value => ({ type: 'math', value });

function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'zhejiang-check-math-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'public/data/papers'), { recursive: true });
  return cwd;
}

function writePaper(cwd, first = simple, second = fixedZ20) {
  const question = {
    id: 'z20-lianmeng-2605--q18',
    body: [math(first)],
    choices: [[math(simple)]],
    answer: { body: [{ type: 'table', rows: [[[math(second)]]] }] },
  };
  fs.writeFileSync(path.join(cwd, 'public/data/papers/z20.json'), JSON.stringify({ questions: [question] }));
}

function run(cwd, { script = checker, flags = [], status = 0 } = {}) {
  const result = spawnSync(process.execPath, [script, ...flags], { cwd, encoding: 'utf8' });
  assert.equal(result.status, status, result.stderr || result.error?.message);
  return JSON.parse(result.stdout);
}

test('math check reuses exact successes and performs a full check after cache damage or --full', t => {
  const cwd = setup(t);
  writePaper(cwd);
  const cold = run(cwd);
  const warm = run(cwd);
  assert.deepEqual(cold, { ...warm, rendered: 2, reused: 0, cache_status: 'missing' });
  assert.deepEqual(
    [warm.papers, warm.questions, warm.count, warm.unique, warm.rendered, warm.reused, warm.errors, warm.cache_status],
    [1, 1, 3, 2, 0, 2, 0, 'reused'],
  );

  writePaper(cwd, simple, fixedZ20 + ' ');
  const changed = run(cwd);
  assert.deepEqual([changed.rendered, changed.reused, changed.errors], [1, 1, 0]);
  const full = run(cwd, { flags: ['--full'] });
  assert.deepEqual(full, { ...changed, rendered: 2, reused: 0, cache_status: 'forced' });

  const cache = path.join(cwd, cacheFile);
  const contents = JSON.parse(fs.readFileSync(cache, 'utf8'));
  contents.successes.pop();
  fs.writeFileSync(cache, JSON.stringify(contents));
  const recovered = run(cwd);
  assert.deepEqual(recovered, { ...full, cache_status: 'invalid' });
});

test('the old Z20 answer remains an error with a warm cache and after a retry', t => {
  const cwd = setup(t);
  writePaper(cwd);
  run(cwd);
  const cache = path.join(cwd, cacheFile);
  const before = fs.readFileSync(cache, 'utf8');
  writePaper(cwd, simple, oldZ20);
  const failed = run(cwd, { status: 1 });
  assert.deepEqual([failed.errors, failed.rendered, failed.reused], [1, 1, 1]);
  assert.deepEqual(failed.problems, [{ qid: 'z20-lianmeng-2605--q18', tex: oldZ20 }]);
  assert.deepEqual(run(cwd, { status: 1 }), failed);
  assert.equal(fs.readFileSync(cache, 'utf8'), before);
  writePaper(cwd);
  const fixed = run(cwd);
  assert.deepEqual([fixed.errors, fixed.rendered, fixed.reused], [0, 0, 2]);
});

test('a macro redefining a cached control forces a full check in input order', t => {
  const cwd = setup(t);
  writePaper(cwd);
  run(cwd);
  const cache = path.join(cwd, cacheFile);
  const before = fs.readFileSync(cache, 'utf8');
  writePaper(cwd, String.raw`\def\frac#1#2{\text{\text{changed}}}`);
  const failed = run(cwd, { status: 1 });
  assert.deepEqual([failed.cache_status, failed.rendered, failed.reused, failed.errors], ['context-dependent', 3, 0, 2]);
  assert.ok(failed.problems.some(problem => problem.tex === simple));
  assert.equal(fs.readFileSync(cache, 'utf8'), before);
});

test('changed MathJax component bytes invalidate the cache at the same package version', t => {
  const cwd = setup(t);
  const source = path.dirname(require.resolve('mathjax/package.json'));
  const copiedPackage = path.join(cwd, 'node_modules/mathjax');
  for (const name of ['package.json', 'es5/node-main.js', 'es5/input/tex-full.js', 'es5/output/svg.js', 'es5/output/svg/fonts/tex.js']) {
    const destination = path.join(copiedPackage, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, name), destination);
  }
  const script = path.join(cwd, 'scripts/check-math.mjs');
  const sourceCommon = path.join(path.dirname(checker), 'lib/common.mjs');
  const localCommon = path.join(cwd, 'scripts/lib/common.mjs');
  fs.mkdirSync(path.dirname(localCommon), { recursive: true });
  fs.copyFileSync(checker, script);
  fs.copyFileSync(sourceCommon, localCommon);
  writePaper(cwd);
  const first = run(cwd, { script });
  fs.appendFileSync(path.join(copiedPackage, 'es5/input/tex-full.js'), '\n// locally modified renderer\n');
  const changed = run(cwd, { script });
  assert.notEqual(changed.renderer_id, first.renderer_id);
  assert.deepEqual([changed.cache_status, changed.rendered, changed.reused, changed.errors], ['renderer-changed', 2, 0, 0]);
});

// Shared helpers for the bank sync / export / check / publish scripts.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const stripBom = s => s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
export const readJson = p => JSON.parse(stripBom(fs.readFileSync(p, 'utf8')));
export const readLines = p => fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
export const sha = b => createHash('sha256').update(b).digest('hex');
// Key-sorted JSON; the public `version` and question fingerprints depend on this exact form.
export const canonical = v => JSON.stringify(v && typeof v === 'object' ? (Array.isArray(v) ? v.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical(v[k]))]))) : v);
export const pick = (v, keys) => Object.fromEntries(keys.map(k => [k, v[k]]));
export const writeJson = (p, v, pretty = false) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, pretty ? 2 : undefined) + '\n'); };

export function assertSafeRelative(relative) {
  assert(typeof relative === 'string' && relative && !relative.includes('\\') && !relative.includes(':') && !relative.split('/').includes('..') && !path.isAbsolute(relative), `Unsafe path: ${relative}`);
}
export function confined(base, relative) {
  assertSafeRelative(relative);
  const p = path.resolve(base, relative);
  assert(p.startsWith(path.resolve(base) + path.sep));
  assert(!fs.lstatSync(p).isSymbolicLink(), 'Symlink forbidden');
  return p;
}
export const walkFiles = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walkFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]);

// Parse and fully verify a release directory against its SHA256SUMS and the expected pointer.
// Returns [{path, sha256, bytes}] for every file including SHA256SUMS itself.
export function verifyReleaseTree(releaseDir, expectedSumsSha) {
  const sumsRaw = fs.readFileSync(path.join(releaseDir, 'SHA256SUMS'));
  assert.equal(sha(sumsRaw), expectedSumsSha, `Release checksum manifest mismatch: ${releaseDir}`);
  const declared = new Map();
  for (const line of sumsRaw.toString('utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = /^([a-f0-9]{64})  (.+)$/.exec(line);
    assert(m && m[2] !== 'SHA256SUMS' && !declared.has(m[2]), 'Invalid checksum row');
    declared.set(m[2], m[1]);
  }
  const files = [];
  for (const [rel, hash] of declared) {
    const bytes = fs.readFileSync(confined(releaseDir, rel));
    assert.equal(sha(bytes), hash, `Checksum mismatch: ${rel}`);
    files.push({ path: rel, sha256: hash, bytes: bytes.length });
  }
  for (const file of walkFiles(releaseDir)) {
    const rel = path.relative(releaseDir, file).split(path.sep).join('/');
    assert(rel === 'SHA256SUMS' || declared.has(rel), `Undeclared file: ${rel}`);
  }
  files.push({ path: 'SHA256SUMS', sha256: expectedSumsSha, bytes: sumsRaw.length });
  return files;
}

export const validPointer = p => p && /^rel-[a-f0-9]+$/.test(p.release_id) && /^[a-f0-9]{64}$/.test(p.release_sums_sha256);

// Minimal `--flag value` / `--flag` parser. Repeated flags collect into arrays when listed in `multi`.
export function parseArgs(argv, { flags = [], values = [], multi = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const name = a.slice(2);
    if (flags.includes(name)) out[name] = true;
    else if (values.includes(name) || multi.includes(name)) {
      const v = argv[++i];
      assert(v !== undefined && !v.startsWith('--'), `Missing value for --${name}`);
      if (multi.includes(name)) (out[name] ||= []).push(v); else out[name] = v;
    } else throw Error(`Unknown option --${name}`);
  }
  return out;
}

export function loadConfig(root = process.cwd()) {
  const p = path.join(root, '.local/publish-config.json');
  return fs.existsSync(p) ? readJson(p) : {};
}

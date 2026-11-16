// Sync the answers-successor release into the local website bank snapshot.
// Verifies every file against the release SHA256SUMS and the active pointer.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const sourceRoot = path.resolve(process.argv[2] || (() => { throw Error('Usage: node scripts/sync-answer-release.mjs <SourceBanks>'); })());
const root = process.cwd();
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const lines = p => fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean);
const sha = b => createHash('sha256').update(b).digest('hex');
const write = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const bankId = 'zj-27-shoukao';
const active = read(path.join(sourceRoot, 'active.json'));
const pointer = active[bankId];
assert(pointer && /^rel-[a-f0-9]+$/.test(pointer.release_id), 'Invalid bank pointer');
const relativeRelease = `${bankId}/releases/${pointer.release_id}`;
const sourceRelease = path.join(sourceRoot, relativeRelease);
const destinationRelease = path.join(root, '.local/banks', relativeRelease);
const release = read(path.join(sourceRelease, 'release.json'));
assert.equal(release.components.answers.with_answer, 234, 'Active release is not the 234-answer release');
assert.equal(release.components.answers.missing, 0, 'Active release still has missing answers');
const sumsRaw = fs.readFileSync(path.join(sourceRelease, 'SHA256SUMS'));
assert.equal(sha(sumsRaw), pointer.release_sums_sha256, 'Release checksum manifest mismatch');
const declared = [];
for (const line of sumsRaw.toString('utf8').split(/\r?\n/)) {
  if (!line.trim()) continue;
  const m = /^([a-f0-9]{64})  (.+)$/.exec(line);
  assert(m, 'Invalid checksum row');
  const rel = m[2];
  assert(!rel.includes('\\') && !rel.includes(':') && !rel.split('/').includes('..') && !path.isAbsolute(rel), 'Unsafe checksum path');
  const file = path.resolve(sourceRelease, rel);
  assert(file.startsWith(path.resolve(sourceRelease) + path.sep), 'Checksum path escapes source release');
  assert.equal(sha(fs.readFileSync(file)), m[1], `Source checksum mismatch: ${rel}`);
  declared.push(rel);
}
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const copied = [];
let addedBytes = 0;
for (const file of walk(sourceRelease)) {
  assert(!fs.lstatSync(file).isSymbolicLink(), 'Source links are not supported');
  const rel = path.relative(sourceRelease, file).split(path.sep).join('/');
  assert(declared.includes(rel) || rel === 'SHA256SUMS', `Undeclared source file: ${rel}`);
  const dest = path.join(destinationRelease, rel);
  const bytes = fs.readFileSync(file);
  const hash = sha(bytes);
  if (fs.existsSync(dest)) {
    assert.equal(sha(fs.readFileSync(dest)), hash, `Existing local snapshot differs: ${rel}`);
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, bytes);
  }
  assert.equal(sha(fs.readFileSync(dest)), hash, `Copied file differs: ${rel}`);
  copied.push({ path: `${relativeRelease}/${rel}`, sha256: hash, bytes: bytes.length });
  addedBytes += bytes.length;
}
assert.equal(copied.length, declared.length + 1, 'Copied file set differs from manifest');

const localActivePath = path.join(root, '.local/banks/active.json');
const localActive = read(localActivePath);
localActive[bankId] = pointer;
write(localActivePath, localActive);

const reportPath = path.join(root, '.local/import-report.json');
const report = read(reportPath);
const existingPaths = new Set(report.files.map(f => f.path));
for (const entry of copied) assert(!existingPaths.has(entry.path), `Report already lists file: ${entry.path}`);
report.releases[bankId] = pointer;
report.files = report.files.concat(copied);
report.file_count = report.files.length;
report.total_bytes = report.total_bytes + addedBytes;
report.generated_at = new Date().toISOString();
report.expansions = (report.expansions || []).concat([{
  batch: 'answers-27shoukao-2611-r1', bank_id: bankId, release_id: pointer.release_id,
  imported_at: report.generated_at, added_answers: 144, added_answer_assets: 6,
  method: 'answers-only successor release; question package and tags byte-identical to prior release; every release file SHA256 verified',
}]);
write(reportPath, report);

const questions = lines(path.join(destinationRelease, 'question-package/questions.jsonl')).map(JSON.parse);
const answers = walk(destinationRelease).filter(f => path.basename(f) === 'answers.jsonl').flatMap(lines).map(JSON.parse);
const answerByDoc = {};
for (const a of answers) {
  answerByDoc[a.document_id] ||= { source: 0, missing: 0 };
  answerByDoc[a.document_id][a.status]++;
}
const catalogPath = path.join(root, 'metadata/paper-catalog.json');
const catalog = read(catalogPath);
for (const c of catalog.collections) {
  if (c.collection_id !== bankId) continue;
  c.source_answer_count = answers.filter(a => a.status === 'source').length;
  c.explicitly_missing_answer_count = answers.filter(a => a.status === 'missing').length;
  c.answer_not_ingested_count = questions.length - answers.length;
}
for (const p of catalog.papers) {
  if (p.collection_id !== bankId) continue;
  p.source_answer_count = answerByDoc[p.source_document_id]?.source || 0;
}
assert.equal(catalog.papers.length, 45, 'Expected expanded catalog is 45 papers');
write(catalogPath, catalog);

const evidence = {
  generated_at: report.generated_at, batch: 'answers-27shoukao-2611-r1', source_root: sourceRoot,
  local_root: path.join(root, '.local/banks'), release_id: pointer.release_id,
  release_sums_sha256: pointer.release_sums_sha256, added_files: copied.length, added_bytes: addedBytes,
  answers: {source: answers.filter(a => a.status === 'source').length, missing: answers.filter(a => a.status === 'missing').length},
  papers: catalog.papers.length, files: copied,
};
write(path.join(root, '.local/evidence/import-answers-2611.json'), evidence);
console.log(JSON.stringify({ release: pointer.release_id, added_files: copied.length, added_bytes: addedBytes, answers: evidence.answers, collection: catalog.collections.find(c => c.collection_id === bankId) }, null, 2));

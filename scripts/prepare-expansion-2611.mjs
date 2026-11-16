// Expansion import batch: zj-27-shoukao 5 papers/90 questions -> 13 papers/234 questions (2611 batch, 8 papers without answers).
// Does not modify prepare-existing-banks.ps1 or its fixed 37-paper baseline; appends to the existing snapshot, report and catalog.
// Usage: node scripts/prepare-expansion-2611.mjs <SourceBanks>   (run from project root)
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const sourceRoot = path.resolve(process.argv[2] || (() => { throw Error('Usage: node scripts/prepare-expansion-2611.mjs <SourceBanks>'); })());
const root = process.cwd();
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const lines = p => fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const sha = b => createHash('sha256').update(b).digest('hex');
const write = (p, v) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n'); };
const bankId = 'zj-27-shoukao';
const active = read(path.join(sourceRoot, 'active.json'));
const pointer = active[bankId];
assert(pointer && /^rel-[a-f0-9]+$/.test(pointer.release_id), 'Invalid bank pointer');
const relativeRelease = `${bankId}/releases/${pointer.release_id}`;
const sourceRelease = path.join(sourceRoot, relativeRelease);
const destinationRelease = path.join(root, '.local/banks', relativeRelease);
const release = read(path.join(sourceRelease, 'release.json'));
assert.equal(release.components.question_package.document_count, 13, 'Active release is not the 13-paper expansion');
assert.equal(release.components.question_package.question_count, 234, 'Active release is not the 234-question expansion');
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
const walk = dir => fs.readdirSync(dir, {withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
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
    fs.mkdirSync(path.dirname(dest), {recursive:true});
    fs.writeFileSync(dest, bytes);
  }
  assert.equal(sha(fs.readFileSync(dest)), hash, `Copied file differs: ${rel}`);
  copied.push({path: `${relativeRelease}/${rel}`, sha256: hash, bytes: bytes.length});
  addedBytes += bytes.length;
}
assert.equal(copied.length, declared.length + 1, 'Copied file set differs from manifest');
// local active pointer: only zj-27-shoukao moves
const localActivePath = path.join(root, '.local/banks/active.json');
const localActive = read(localActivePath);
localActive[bankId] = pointer;
write(localActivePath, localActive);
// import report: keep baseline entries, append expansion files and move the pointer
const reportPath = path.join(root, '.local/import-report.json');
const report = read(reportPath);
const existingPaths = new Set(report.files.map(f => f.path));
for (const entry of copied) assert(!existingPaths.has(entry.path), `Report already lists expansion file: ${entry.path}`);
report.releases[bankId] = pointer;
report.files = report.files.concat(copied);
report.file_count = report.files.length;
report.total_bytes = report.total_bytes + addedBytes;
report.generated_at = new Date().toISOString();
report.expansions = (report.expansions || []).concat([{
  batch: 'zj-2611-20261116-r2', bank_id: bankId, release_id: pointer.release_id,
  imported_at: report.generated_at, added_papers: 8, added_questions: 144,
  method: 'source release manifest verified; every copied file SHA256 compared; baseline snapshot and report entries preserved',
}]);
write(reportPath, report);
// catalog: update collection counts and append the 8 new papers
const pkg = read(path.join(destinationRelease, 'question-package/package.json'));
const questions = lines(path.join(destinationRelease, 'question-package/questions.jsonl'));
const answers = walk(destinationRelease).filter(f => path.basename(f) === 'answers.jsonl').flatMap(lines);
const catalogPath = path.join(root, 'metadata/paper-catalog.json');
const catalog = read(catalogPath);
for (const c of catalog.collections) {
  if (c.collection_id !== bankId) continue;
  c.paper_count = pkg.documents.length;
  c.question_count = questions.length;
  c.question_image_count = release.components.question_package.required_asset_count;
  c.source_answer_count = answers.filter(a => a.status === 'source').length;
  c.explicitly_missing_answer_count = answers.filter(a => a.status === 'missing').length;
  c.answer_not_ingested_count = questions.length - answers.length;
}
const byId = new Map(catalog.papers.map(p => [p.paper_id, p]));
let added = 0;
for (const doc of pkg.documents) {
  const paperId = `${bankId}--${doc.document_id}`;
  const m = /^物理卷-(\d{2})(\d{2})/.exec(doc.title);
  assert(m, 'Title does not carry YYMM');
  const examYear = 2000 + Number(m[1]), examMonth = Number(m[2]);
  assert(examMonth >= 1 && examMonth <= 12, 'Invalid month in title');
  const docQuestions = questions.filter(q => q.document_id === doc.document_id);
  const docAnswers = answers.filter(a => a.document_id === doc.document_id);
  const expected = {
    paper_id: paperId, collection_id: bankId, source_document_id: doc.document_id,
    title: doc.title, target_year: 2027, target_session: 'first',
    exam_year: examYear, exam_month: examMonth, exam_date: null, date_basis: 'source_title_yymm',
    exam_kind: 'practice', official_session: null, original_classification: '2027 首考',
    question_count: docQuestions.length, source_answer_count: docAnswers.filter(a => a.status === 'source').length,
    metadata_review_status: 'classification_preserved_date_inferred',
  };
  const existing = byId.get(paperId);
  if (existing) {
    assert.deepEqual(existing, expected, `Existing catalog entry differs: ${paperId}`);
  } else {
    catalog.papers.push(expected);
    added++;
  }
}
assert(added === 8 || added === 0, `Expected 8 new papers (or idempotent re-run), added ${added}`);
catalog.snapshot_date = '2026-11-16';
const totalQuestions = catalog.collections.reduce((s, c) => s + c.question_count, 0);
assert.equal(catalog.papers.length, 45, 'Expected expanded catalog is 45 papers');
assert.equal(totalQuestions, 810, 'Expected expanded catalog is 810 questions');
write(catalogPath, catalog);
const evidence = {
  generated_at: report.generated_at, batch: 'zj-2611-20261116-r2', source_root: sourceRoot,
  local_root: path.join(root, '.local/banks'), release_id: pointer.release_id,
  release_sums_sha256: pointer.release_sums_sha256,
  added_files: copied.length, added_bytes: addedBytes, added_papers: added,
  papers: catalog.papers.length, questions: totalQuestions, files: copied,
};
write(path.join(root, '.local/evidence/import-expansion-2611.json'), evidence);
console.log(JSON.stringify({papers: catalog.papers.length, questions: totalQuestions, added_files: copied.length, added_bytes: addedBytes, added_papers: added, release: pointer.release_id, catalog: 'metadata/paper-catalog.json'}, null, 2));
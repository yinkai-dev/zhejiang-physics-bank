// Deterministic public projection of the local bank snapshot. Original releases remain read-only.
//
//   node scripts/export-bank.mjs [--allow-change] [--verify-history]
//
// No hard-coded totals: counts must agree with metadata/paper-catalog.json (refresh it with
// scripts/sync-bank.mjs) and with the releases themselves. Compared with the projection currently
// on disk, published questions may only be added or gain a source answer; removals or content
// changes abort unless --allow-change is given after the owner has confirmed them.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readJson, readLines, sha, canonical, pick, confined, effectiveAnswerStatus, parseArgs } from './lib/common.mjs';
import { diffPublic, describeDiff, diffSummary, loadPublicDir } from './lib/diff.mjs';
import { awaitingFirstRelease } from './lib/paper-meta.mjs';
import { verifySnapshot } from './lib/snapshot.mjs';
import { validateReference } from './lib/ai-reference.mjs';

const args = parseArgs(process.argv.slice(2), { flags: ['allow-change', 'verify-history'], values: ['ai-references'] });
const write = (p, v) => { fs.mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v) + '\n'); };
const pointers = readJson('.local/banks/active.json');
const report = readJson('.local/import-report.json');
const verified = verifySnapshot('.local/banks', pointers, report, args['verify-history']);
const catalog = readJson('metadata/paper-catalog.json');
catalog.collections = catalog.collections.filter(c => !awaitingFirstRelease(c, catalog.papers));
const collectionIds = catalog.collections.map(c => c.collection_id);
assert.deepEqual(Object.keys(pointers).sort(), [...collectionIds].sort(), 'Active banks differ from catalog collections');
// The ledger appends new papers. Follow their published order even when a registry rewrites its JSON keys.
const bankOrder = new Set([...catalog.papers.map(p => p.collection_id), ...collectionIds]);
const active = Object.fromEntries([...bankOrder].map(id => [id, pointers[id]]));
const paperFields = ['paper_id','collection_id','source_document_id','title','target_year','target_session','exam_year','exam_month','exam_date','date_basis','exam_kind','official_session','original_classification','question_count','source_answer_count','metadata_review_status'];
const papers = catalog.papers.map(p => pick(p, paperFields));
const index = [], assets = new Map(), details = new Map(papers.map(p => [p.paper_id, []]));
const answerCounts = {source:0, missing:0, not_ingested:0};
const perCollection = Object.fromEntries(catalog.collections.map(c => [c.collection_id, {questions:0, source:0, missing:0, not_ingested:0}]));
const blockCounts = {};
const previous = loadPublicDir('public');
const priorReferences = new Map(previous.catalog.papers.flatMap(p =>
  (previous.paper(p.paper_id) || []).filter(q => q.ai_reference).map(q => [q.id, q.ai_reference])));
const incoming = args['ai-references'] ? readJson(args['ai-references']) : {};
const usedReferences = {};

function attachReference(q) {
  const fresh = Object.hasOwn(incoming, q.id);
  const ref = fresh ? incoming[q.id] : priorReferences.get(q.id);
  if (!ref) return q;
  validateReference(ref, q);
  for (const block of ref.body) {
    if (block.type !== 'figure') continue;
    assert(/^images\/[a-f0-9]{64}\.png$/.test(block.src));
    const base = fresh ? path.dirname(path.resolve(args['ai-references'])) : 'public';
    const data = fs.readFileSync(confined(base, block.src));
    assert.equal(sha(data), block.src.slice(7, -4), 'AI reference image digest mismatch');
    assets.set(block.src, data);
  }
  usedReferences[q.id] = ref;
  return {...q, ai_reference:ref};
}

function projectBlocks(blocks, assetMap, base, qid) {
  assert(Array.isArray(blocks));
  return blocks.map(b => {
    blockCounts[b.type] = (blockCounts[b.type] || 0) + 1;
    switch (b.type) {
      case 'text': case 'math': case 'score':
        assert.equal(typeof b.value, 'string');
        return {type:b.type, value:b.value};
      case 'figure': {
        const a = assetMap.get(`${qid}:${b.asset_id}`);
        assert(a && a.review_status === 'approved', `Missing/unapproved asset ${qid}:${b.asset_id}`);
        assert(/^[a-f0-9]{64}$/.test(a.asset_id));
        const bytes = fs.readFileSync(confined(base, a.path));
        assert.equal(sha(bytes), a.runtime_sha256);
        assert.equal(bytes.length, a.bytes);
        assert.equal(a.asset_id, a.runtime_sha256);
        const filename = `images/${a.asset_id}.png`;
        assert.equal(a.media_type, 'image/png');
        assert.equal(bytes.subarray(0,8).toString('hex'), '89504e470d0a1a0a');
        assert.equal(bytes.readUInt32BE(16), a.width);
        assert.equal(bytes.readUInt32BE(20), a.height);
        assets.set(filename, bytes);
        return {type:'figure',src:filename,width:a.width,height:a.height,width_mm:a.width_mm,...(a.source_layout?.row_group ? {row_group:a.source_layout.row_group} : {})};
      }
      case 'table':
        assert(Array.isArray(b.rows) && b.rows.length);
        return {type:'table',rows:b.rows.map(row => row.map(cell => projectBlocks(cell, assetMap, base, qid)))};
      default: throw Error(`Unsupported block ${qid}: ${b.type}`);
    }
  });
}
for (const [collection, release] of Object.entries(active)) {
  const base = `.local/banks/${collection}/releases/${release.release_id}`;
  assert.equal(sha(fs.readFileSync(base+'/SHA256SUMS')), release.release_sums_sha256);
  const pkg = base+'/question-package';
  const qs = readLines(pkg+'/questions.jsonl');
  const tags = readJson(base+'/tags.json').questions;
  const tagMap = new Map(tags.map(t => [t.question_id,t]));
  assert.equal(tagMap.size, qs.length);
  const qassets = new Map(readLines(pkg+'/asset-manifest.jsonl').map(a => [`${a.question_id}:${a.asset_id}`,a]));
  const releaseInfo = readJson(base+'/release.json');
  const aid = releaseInfo.components.answers?.answer_package_id;
  const answerBase = aid ? `${base}/answers/${aid}` : null;
  const answers = new Map(answerBase ? readLines(answerBase+'/answers.jsonl').map(a => [a.question_id,a]) : []);
  const aassets = new Map(answerBase ? readLines(answerBase+'/asset-manifest.jsonl').map(a => [`${a.question_id}:${a.asset_id}`,a]) : []);
  if (answerBase) assert.equal(answers.size, qs.length, 'Incomplete answer coverage');
  for (const q of qs) {
    assert.equal(q.review_status, 'approved', q.question_id);
    const fp = sha(canonical(q));
    const tag = tagMap.get(q.question_id);
    assert.equal(tag.question_sha256, fp, 'Tag fingerprint mismatch: '+q.question_id);
    const paperId = `${collection}--${q.document_id}`;
    assert(details.has(paperId), `Unknown paper ${paperId}; run scripts/sync-bank.mjs to refresh the catalog`);
    const id = `${collection}--${q.question_id}`;
    const a = answers.get(q.question_id);
    if (a) {
      assert.equal(a.question_sha256, fp, 'Answer fingerprint mismatch: '+id);
      assert.equal(a.document_id, q.document_id);
      assert.equal(a.original_question_number, q.original_question_number);
      assert(['source','missing'].includes(a.status));
    }
    const status = effectiveAnswerStatus(a);
    answerCounts[status]++; perCollection[collection][status]++; perCollection[collection].questions++;
    const type = tag.question_type === '选择题' ? (tag.choice_mode === 'multiple' ? '多选题' : '单选题') : tag.question_type;
    assert(['单选题','多选题','实验题','计算题'].includes(type));
    assert(tag.topics.length && tag.topics.every(t => ['力学','电学','光学','热学','近代物理'].includes(t)));
    const summary = {id,paper_id:paperId,source_question_id:q.question_id,number:q.original_question_number,order:q.order,type,topics:tag.topics,answer_status:status,fingerprint:fp,search_text:q.retrieval_text};
    index.push(summary);
    details.get(paperId).push(attachReference({...pick(summary,['id','paper_id','source_question_id','number','order','type','topics','answer_status','fingerprint']),body:projectBlocks(q.body,qassets,pkg,q.question_id),choices:q.choices.map(c => projectBlocks(c,qassets,pkg,q.question_id)),answer:{status,key:status==='source'?(a?.key||null):null,body:status==='source'&&a?projectBlocks(a.body,aassets,answerBase,q.question_id):[]}}));
  }
}
// Acceptance contract derived from the data itself: catalog metadata, releases and projection agree.
assert.equal(new Set(index.map(q=>q.id)).size, index.length, 'Duplicate public question id');
assert.equal(index.length, papers.reduce((s,p)=>s+p.question_count,0), 'Catalog question total differs from releases; run scripts/sync-bank.mjs');
for (const c of catalog.collections) {
  const actual = perCollection[c.collection_id], hint = `${c.collection_id}: catalog differs from release; run scripts/sync-bank.mjs`;
  assert.equal(papers.filter(p=>p.collection_id===c.collection_id).length, c.paper_count, hint);
  assert.deepEqual([actual.questions,actual.source,actual.missing,actual.not_ingested],[c.question_count,c.source_answer_count,c.explicitly_missing_answer_count,c.answer_not_ingested_count], hint);
}
for (const p of papers) {
  const qs = details.get(p.paper_id).sort((a,b)=>a.order-b.order);
  assert.equal(qs.length, p.question_count, p.paper_id);
  assert.equal(qs.filter(q=>q.answer_status==='source').length,p.source_answer_count, p.paper_id);
  // Compare the actual source number set; no positional question-type inference.
  assert.equal(new Set(qs.map(q=>q.number)).size,qs.length);
}
assert(Object.keys(incoming).every(id => Object.hasOwn(usedReferences, id)), 'AI reference has no current question match');
const version = sha(canonical({papers,index,source_releases:active,
  ...(Object.keys(usedReferences).length ? {ai_references:usedReferences} : {})}));
// Regression guard against the projection currently on disk (normally the last published one).
const diff = diffPublic(previous, {catalog:{papers,version},index,paper:id=>details.get(id)||null});
for (const line of describeDiff(diff)) console.error(line);
assert(!diff.blocking || args['allow-change'], 'Published questions would be removed or changed. Stop and confirm with the owner; then re-run with --allow-change.');
// Explicit generated output directories only. Stale files are removed only when changes were allowed.
for (const [dir, expected] of [['public/data/papers',new Set(papers.map(p=>p.paper_id+'.json'))],['public/images',new Set([...assets.keys()].map(p=>p.split('/').at(-1)))]]) {
  fs.mkdirSync(dir,{recursive:true});
  for(const f of fs.readdirSync(dir)) {
    if (expected.has(f)) continue;
    assert(args['allow-change'], `Unexpected stale output: ${dir}/${f}; review before removal`);
    fs.unlinkSync(`${dir}/${f}`);
  }
}
write('public/data/catalog.json',{schema_version:1,version,snapshot_date:catalog.snapshot_date,source_releases:active,collections:catalog.collections.map(c=>pick(c,['collection_id','label','target_year','target_session','paper_count','question_count','source_answer_count','explicitly_missing_answer_count','answer_not_ingested_count'])),papers});
write('public/data/questions-index.json',{schema_version:1,version,questions:index});
for(const [id,questions] of details) write(`public/data/papers/${id}.json`,{schema_version:1,paper_id:id,questions});
for(const [p,b] of assets) fs.writeFileSync('public/'+p,b);
const result={schema_version:1,version,papers:papers.length,questions:index.length,answers:answerCounts,assets:assets.size,asset_bytes:[...assets.values()].reduce((s,b)=>s+b.length,0),blocks:blockCounts,releases:Object.fromEntries(Object.entries(active).map(([k,v])=>[k,v.release_id])),source_files_verified:verified.current+verified.archived,active_files_verified:verified.current,archived_files_verified:verified.archived,diff:diffSummary(diff)};
write('.local/evidence/export-report.json',result);
console.log(JSON.stringify(result,null,2));

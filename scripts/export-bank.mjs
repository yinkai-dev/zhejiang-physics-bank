// Deterministic public projection. Original releases remain read-only.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = process.cwd();
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const lines = p => fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
const sha = b => createHash('sha256').update(b).digest('hex');
const canonical = v => JSON.stringify(v && typeof v === 'object' ? (Array.isArray(v) ? v.map(v => JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(v).sort().map(k => [k, JSON.parse(canonical(v[k]))]))) : v);
const write = (p, v) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, JSON.stringify(v) + '\n'); };
const confined = (base, relative) => {
  assert(!relative.includes('\\') && !relative.includes(':') && !relative.split('/').includes('..') && !path.isAbsolute(relative), `Unsafe path: ${relative}`);
  const p = path.resolve(base, relative);
  assert(p.startsWith(path.resolve(base) + path.sep));
  assert(!fs.lstatSync(p).isSymbolicLink(), 'Symlink forbidden');
  return p;
};
const active = read('.local/banks/active.json');
const report = read('.local/import-report.json');
assert.deepEqual(active, report.releases, 'Import report release mismatch');
for (const f of report.files) {
  const p = confined('.local/banks', f.path), b = fs.readFileSync(p);
  assert.equal(b.length, f.bytes, f.path);
  assert.equal(sha(b), f.sha256, `Source drift: ${f.path}`);
}
const catalog = read('metadata/paper-catalog.json');
const paperFields = ['paper_id','collection_id','source_document_id','title','target_year','target_session','exam_year','exam_month','exam_date','date_basis','exam_kind','official_session','original_classification','question_count','source_answer_count','metadata_review_status'];
const pick = (v, keys) => Object.fromEntries(keys.map(k => [k,v[k]]));
const papers = catalog.papers.map(p => pick(p, paperFields));
const index = [], assets = new Map(), details = new Map(papers.map(p => [p.paper_id, []]));
const answerCounts = {source:0, missing:0, not_ingested:0};
const blockCounts = {};

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
  const qs = lines(pkg+'/questions.jsonl');
  const tags = read(base+'/tags.json').questions;
  const tagMap = new Map(tags.map(t => [t.question_id,t]));
  assert.equal(tagMap.size, qs.length);
  const qassets = new Map(lines(pkg+'/asset-manifest.jsonl').map(a => [`${a.question_id}:${a.asset_id}`,a]));
  const releaseInfo = read(base+'/release.json');
  const aid = releaseInfo.components.answers?.answer_package_id;
  const answerBase = aid ? `${base}/answers/${aid}` : null;
  const answers = new Map(answerBase ? lines(answerBase+'/answers.jsonl').map(a => [a.question_id,a]) : []);
  const aassets = new Map(answerBase ? lines(answerBase+'/asset-manifest.jsonl').map(a => [`${a.question_id}:${a.asset_id}`,a]) : []);
  if (answerBase) assert.equal(answers.size, qs.length, 'Incomplete answer coverage');
  for (const q of qs) {
    assert.equal(q.review_status, 'approved', q.question_id);
    const fp = sha(canonical(q));
    const tag = tagMap.get(q.question_id);
    assert.equal(tag.question_sha256, fp, 'Tag fingerprint mismatch: '+q.question_id);
    const paperId = `${collection}--${q.document_id}`;
    assert(details.has(paperId), 'Unknown paper '+paperId);
    const id = `${collection}--${q.question_id}`;
    const a = answers.get(q.question_id);
    if (a) {
      assert.equal(a.question_sha256, fp, 'Answer fingerprint mismatch: '+id);
      assert.equal(a.document_id, q.document_id);
      assert.equal(a.original_question_number, q.original_question_number);
      assert(['source','missing'].includes(a.status));
    }
    const status = a?.status || 'not_ingested';
    answerCounts[status]++;
    const type = tag.question_type === '选择题' ? (tag.choice_mode === 'multiple' ? '多选题' : '单选题') : tag.question_type;
    assert(['单选题','多选题','实验题','计算题'].includes(type));
    assert(tag.topics.length && tag.topics.every(t => ['力学','电学','光学','热学','近代物理'].includes(t)));
    const summary = {id,paper_id:paperId,source_question_id:q.question_id,number:q.original_question_number,order:q.order,type,topics:tag.topics,answer_status:status,fingerprint:fp,search_text:q.retrieval_text};
    index.push(summary);
    details.get(paperId).push({...pick(summary,['id','paper_id','source_question_id','number','order','type','topics','answer_status','fingerprint']),body:projectBlocks(q.body,qassets,pkg,q.question_id),choices:q.choices.map(c => projectBlocks(c,qassets,pkg,q.question_id)),answer:{status,key:a?.key || null,body:a ? projectBlocks(a.body,aassets,answerBase,q.question_id) : []}});
  }
}
assert.equal(papers.length,37); assert.equal(index.length,666); assert.equal(new Set(index.map(q=>q.id)).size,666);
assert.deepEqual(answerCounts,{source:463,missing:5,not_ingested:198});
for (const p of papers) {
  const qs = details.get(p.paper_id).sort((a,b)=>a.order-b.order);
  assert.equal(qs.length, p.question_count);
  assert.equal(qs.filter(q=>q.answer_status==='source').length,p.source_answer_count);
  // Compare the actual source number set; no positional question-type inference.
  assert.equal(new Set(qs.map(q=>q.number)).size,qs.length);
}
// Explicit generated output directories only; refuse unexpected stale assets.
for (const [dir, expected] of [['public/data/papers',new Set(papers.map(p=>p.paper_id+'.json'))],['public/images',new Set([...assets.keys()].map(p=>p.split('/').at(-1)))]]) {
  fs.mkdirSync(dir,{recursive:true});
  for(const f of fs.readdirSync(dir)) assert(expected.has(f), `Unexpected stale output: ${dir}/${f}; review before removal`);
}
const version = sha(canonical({papers,index,source_releases:active}));
write('public/data/catalog.json',{schema_version:1,version,snapshot_date:catalog.snapshot_date,source_releases:active,collections:catalog.collections.map(c=>pick(c,['collection_id','label','target_year','target_session','paper_count','question_count','source_answer_count','explicitly_missing_answer_count','answer_not_ingested_count'])),papers});
write('public/data/questions-index.json',{schema_version:1,version,questions:index});
for(const [id,questions] of details) write(`public/data/papers/${id}.json`,{schema_version:1,paper_id:id,questions});
for(const [p,b] of assets) fs.writeFileSync('public/'+p,b);
const result={schema_version:1,version,papers:papers.length,questions:index.length,answers:answerCounts,assets:assets.size,asset_bytes:[...assets.values()].reduce((s,b)=>s+b.length,0),blocks:blockCounts,releases:Object.fromEntries(Object.entries(active).map(([k,v])=>[k,v.release_id])),source_files_verified:report.files.length};
write('.local/evidence/export-report.json',result);
console.log(JSON.stringify(result,null,2));

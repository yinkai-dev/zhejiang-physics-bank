import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseFilters,filterQuestions,addSelection,moveSelection,selectionIssues} from '../src/domain.mjs';
const catalog=JSON.parse(fs.readFileSync('public/data/catalog.json','utf8'));
const index=JSON.parse(fs.readFileSync('public/data/questions-index.json','utf8')).questions;
const papers=new Map(catalog.papers.map(p=>[p.paper_id,p]));
const filter=query=>filterQuestions(index,papers,parseFilters(new URLSearchParams(query)),new URLSearchParams(query).get('q')||'');
// Expected totals come from catalog metadata (a separate aggregation path from the question index
// that the filter walks), so the suite keeps holding when papers are added.
const sumCollections=(pick,keep=()=>true)=>catalog.collections.filter(keep).reduce((s,c)=>s+pick(c),0);
const sumPapers=keep=>catalog.papers.filter(keep).reduce((s,p)=>s+p.question_count,0);
const years=[...new Set(catalog.collections.map(c=>c.target_year))].sort();
test('every bank is present and target year stays separate from actual exam year',()=>{
  assert.equal(filter('').length,sumCollections(c=>c.question_count));
  for(const y of years)assert.equal(filter('year='+y).length,sumCollections(c=>c.question_count,c=>c.target_year===y));
  for(const c of catalog.collections)assert.equal(filter(`year=${c.target_year}&session=${c.target_session}`).length,sumCollections(x=>x.question_count,x=>x.target_year===c.target_year&&x.target_session===c.target_session));
  const examYears=[...new Set(catalog.papers.map(p=>p.exam_year))].filter(y=>y!==null);
  for(const y of examYears)assert.equal(filter('examYear='+y).length,sumPapers(p=>p.exam_year===y));
  // A preparation target year with no paper actually sat in that year must not match by exam year.
  for(const y of years.filter(y=>!examYears.includes(y)))assert.equal(filter('examYear='+y).length,0);
  const prepared=catalog.papers.find(p=>p.exam_year!==null&&p.exam_year!==p.target_year);
  if(prepared)assert.equal(filter(`year=${prepared.target_year}&examYear=${prepared.exam_year}`).length,sumPapers(p=>p.target_year===prepared.target_year&&p.exam_year===prepared.exam_year));
  assert.equal(filter('kind=official').length,sumPapers(p=>p.exam_kind==='official'));
  assert.equal(filter('kind=practice').length,sumPapers(p=>p.exam_kind==='practice'));
});
test('same dimension union, cross dimension intersection, unique topics',()=>{
  const [first,last]=[years[0],years.at(-1)];
  assert.equal(filter(`year=${first}&year=${last}`).length,sumCollections(c=>c.question_count,c=>[first,last].includes(c.target_year)));
  for(const s of new Set(catalog.collections.map(c=>c.target_session)))assert.equal(filter('session='+s).length,sumCollections(c=>c.question_count,c=>c.target_session===s));
  const qs=filter('topic=光学&topic=近代物理');assert.equal(qs.length,new Set(qs.map(q=>q.id)).size);
  const year=catalog.collections[0].target_year,intersection=filter(`topic=光学&type=实验题&year=${year}`);
  assert(intersection.every(q=>q.topics.includes('光学')&&q.type==='实验题'&&papers.get(q.paper_id).target_year===year));
});
test('answer states and keyword matching use actual data',()=>{
  assert.equal(filter('answer=source').length,sumCollections(c=>c.source_answer_count));
  assert.equal(filter('answer=missing').length,sumCollections(c=>c.explicitly_missing_answer_count));
  assert.equal(filter('answer=not_ingested').length,sumCollections(c=>c.answer_not_ingested_count));
  // Keyword search covers the paper title: every question of a paper is found by a title fragment.
  const paper=catalog.papers.at(-1),fragment=paper.title.slice(-4),hits=filter(`q=${encodeURIComponent(fragment)}&year=${paper.target_year}`);
  assert(hits.length>=paper.question_count);
  assert.equal(hits.filter(q=>q.paper_id===paper.paper_id).length,paper.question_count);
  assert(hits.every(q=>(papers.get(q.paper_id).title+' '+q.search_text+' '+q.topics.join(' ')+' '+q.type).toLocaleLowerCase().includes(fragment.toLocaleLowerCase())));
  assert(filter('q=绝不匹配的虚构题库关键词').length===0);
});
test('cross-paper selection deduplication, ordering and source drift',()=>{let rows=[];const a=index[0],b=index.at(-1);rows=addSelection(rows,a);rows=addSelection(rows,b);rows=addSelection(rows,a);assert.equal(rows.length,2);rows=moveSelection(rows,b.id,-1);assert.equal(rows[0].id,b.id);assert.deepEqual(selectionIssues(rows,index),[]);assert.equal(selectionIssues([{id:a.id,fingerprint:'old'}],index)[0].reason,'changed');assert.equal(selectionIssues([{id:'removed',fingerprint:'old'}],index)[0].reason,'removed');});

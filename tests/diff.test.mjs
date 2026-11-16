import {test} from 'node:test';
import assert from 'node:assert/strict';
import {diffPublic} from '../scripts/lib/diff.mjs';

const question=(id,over={})=>({id,paper_id:'bank--p1',source_question_id:id,number:'1',order:1,type:'单选题',topics:['力学'],answer_status:'source',fingerprint:'f-'+id,body:[{type:'text',value:'题干 '+id}],choices:[],answer:{status:'source',key:'A',body:[]},...over});
const paper=(id,count,over={})=>({paper_id:id,collection_id:'bank',source_document_id:id,title:'物理卷-2611 '+id,target_year:2027,target_session:'first',exam_year:2026,exam_month:11,exam_date:null,date_basis:'source_title_yymm',exam_kind:'practice',official_session:null,original_classification:'2027 首考',question_count:count,source_answer_count:count,metadata_review_status:'x',...over});
// Build a projection from {paperId: [questions]}; the index mirrors the details like the exporter does.
function projection(byPaper,paperOver={}) {
  const details=new Map(Object.entries(byPaper));
  const index=[...details.entries()].flatMap(([pid,qs])=>qs.map(({body,choices,answer,...summary})=>({...summary,paper_id:pid,search_text:'检索 '+summary.id})));
  return {catalog:{version:'v',papers:[...details.keys()].map(id=>paper(id,details.get(id).length,paperOver[id]))},index,paper:id=>details.get(id)||null};
}
const base=()=>projection({'bank--p1':[question('q1'),question('q2')]});

test('identical projections do not block',()=>{
  const d=diffPublic(base(),base());
  assert.equal(d.blocking,false);
  assert.deepEqual([d.added_papers,d.removed_papers,d.added_questions,d.removed_questions,d.changed_questions,d.answers_gained],[[],[],[],[],[],[]]);
});
test('adding papers and questions is allowed',()=>{
  const next=projection({'bank--p1':[question('q1'),question('q2'),question('q3')],'bank--p2':[question('q9',{paper_id:'bank--p2'})]});
  const d=diffPublic(base(),next);
  assert.equal(d.blocking,false);
  assert.deepEqual(d.added_papers,['bank--p2']);
  assert.deepEqual(d.added_questions.sort(),['q3','q9']);
  assert.deepEqual([d.totals.previous.questions,d.totals.next.questions],[2,4]);
});
test('removing a published question or paper blocks',()=>{
  assert.deepEqual(diffPublic(base(),projection({'bank--p1':[question('q1')]})).removed_questions,['q2']);
  assert.equal(diffPublic(base(),projection({'bank--p1':[question('q1')]})).blocking,true);
  const d=diffPublic(base(),projection({'bank--p2':[question('q1',{paper_id:'bank--p2'})]}));
  assert.deepEqual(d.removed_papers,['bank--p1']);assert.equal(d.blocking,true);
});
test('changing published content, tags or retrieval text blocks',()=>{
  const body=diffPublic(base(),projection({'bank--p1':[question('q1',{body:[{type:'text',value:'改过的题干'}]}),question('q2')]}));
  assert.equal(body.blocking,true);assert.deepEqual(body.changed_questions,[{id:'q1',fields:['body']}]);
  const topics=diffPublic(base(),projection({'bank--p1':[question('q1',{topics:['电学']}),question('q2')]}));
  assert.equal(topics.blocking,true);assert.deepEqual(topics.changed_questions[0].fields,['topics','index']);
  const next=base();next.index[0].search_text='另一段检索文字';
  const search=diffPublic(base(),next);
  assert.equal(search.blocking,true);assert.deepEqual(search.changed_questions,[{id:'q1',fields:['index']}]);
});
test('gaining a source answer is the one allowed change to a published question',()=>{
  const missing={answer_status:'missing',answer:{status:'missing',key:null,body:[]}};
  const d=diffPublic(projection({'bank--p1':[question('q1',missing),question('q2')]}),base());
  assert.equal(d.blocking,false);assert.deepEqual(d.answers_gained,['q1']);
  // Losing or rewriting an existing source answer is a content change.
  assert.equal(diffPublic(base(),projection({'bank--p1':[question('q1',missing),question('q2')]})).blocking,true);
  assert.equal(diffPublic(base(),projection({'bank--p1':[question('q1',{answer:{status:'source',key:'B',body:[]}}),question('q2')]})).blocking,true);
});
test('paper metadata edits are reported without blocking',()=>{
  const d=diffPublic(base(),projection({'bank--p1':[question('q1'),question('q2')]},{'bank--p1':{exam_month:12}}));
  assert.equal(d.blocking,false);assert.deepEqual(d.paper_meta_changed,[{paper_id:'bank--p1',fields:['exam_month']}]);
});
test('first export against an empty projection adds everything',()=>{
  const d=diffPublic({catalog:{papers:[],version:null},index:[],paper:()=>null},base());
  assert.equal(d.blocking,false);assert.equal(d.added_questions.length,2);
});

export const filterKeys = ['year','session','kind','type','topic','answer','examYear','month'];
export function parseFilters(params) {
  return Object.fromEntries(filterKeys.map(k=>[k, params.getAll(k).flatMap(v=>v.split(',')).filter(Boolean)]));
}
export function filterQuestions(questions, paperMap, filters, search='') {
  const tokens = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return questions.filter(q=>{
    const p = paperMap.get(q.paper_id);
    const values = {year:[String(p.target_year)],session:[p.target_session],kind:[p.exam_kind],type:[q.type],topic:q.topics,answer:[q.answer_status],examYear:[p.exam_year === null ? 'unknown' : String(p.exam_year)],month:[p.exam_month === null ? 'unknown' : String(p.exam_month)]};
    return filterKeys.every(k=>!filters[k]?.length || filters[k].some(v=>values[k].includes(v))) && tokens.every(t=>(p.title+' '+q.search_text+' '+q.topics.join(' ')+' '+q.type).toLocaleLowerCase().includes(t));
  });
}
export function addSelection(rows, q) {
  return rows.some(r=>r.id===q.id) ? rows : [...rows,{id:q.id,fingerprint:q.fingerprint}];
}
export function moveSelection(rows,id,delta) {
  const copy=rows.slice(), from=copy.findIndex(r=>r.id===id), to=from+delta;
  if(from>=0 && to>=0 && to<copy.length) [copy[from],copy[to]]=[copy[to],copy[from]];
  return copy;
}
export function selectionIssues(rows, index) {
  const map = new Map(index.map(q=>[q.id,q]));
  return rows.flatMap(r=>!map.has(r.id) ? [{id:r.id,reason:'removed'}] : map.get(r.id).fingerprint!==r.fingerprint ? [{id:r.id,reason:'changed'}] : []);
}

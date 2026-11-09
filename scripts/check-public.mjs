import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=process.argv[2]||'public';
const read=p=>JSON.parse(fs.readFileSync(`${root}/${p}`,'utf8'));
const catalog=read('data/catalog.json'),index=read('data/questions-index.json');
assert.equal(catalog.schema_version,1);assert.equal(index.schema_version,1);assert.equal(catalog.version,index.version);
assert.equal(catalog.papers.length,37);assert.equal(index.questions.length,666);assert.equal(new Set(index.questions.map(q=>q.id)).size,666);
const allowedIndex=['id','paper_id','source_question_id','number','order','type','topics','answer_status','fingerprint','search_text'];
const allowedQuestion=allowedIndex.filter(k=>k!=='search_text').concat(['body','choices','answer']);
const safeKeys=(v,keys)=>assert(Object.keys(v).every(k=>keys.includes(k)), 'Unexpected public field '+Object.keys(v).filter(k=>!keys.includes(k)));
const counts={source:0,missing:0,not_ingested:0},images=new Set(),ids=new Set();
function walk(blocks) {assert(Array.isArray(blocks));for(const b of blocks){
  if(['text','math','score'].includes(b.type)){safeKeys(b,['type','value']);assert.equal(typeof b.value,'string');}
  else if(b.type==='figure'){safeKeys(b,['type','src','width','height','width_mm','row_group']);assert(/^images\/[a-f0-9]{64}\.png$/.test(b.src));if(b.row_group)assert(/^[a-zA-Z0-9._-]+$/.test(b.row_group));const data=fs.readFileSync(`${root}/${b.src}`);assert.equal(createHash('sha256').update(data).digest('hex'),b.src.slice(7,-4));images.add(b.src);}
  else if(b.type==='table'){safeKeys(b,['type','rows']);b.rows.forEach(r=>r.forEach(walk));}
  else throw Error('Unsupported public block '+b.type);
}}
for(const p of catalog.papers){const d=read(`data/papers/${p.paper_id}.json`);assert.equal(d.paper_id,p.paper_id);assert.equal(d.questions.length,p.question_count);const expected=index.questions.filter(q=>q.paper_id===p.paper_id);assert.deepEqual(d.questions.map(q=>q.id).sort(),expected.map(q=>q.id).sort());for(const q of d.questions){safeKeys(q,allowedQuestion);const s=expected.find(s=>s.id===q.id);safeKeys(s,allowedIndex);for(const k of allowedIndex.filter(k=>k!=='search_text'))assert.deepEqual(q[k],s[k]);assert(!ids.has(q.id));ids.add(q.id);safeKeys(q.answer,['status','key','body']);assert.equal(q.answer.status,q.answer_status);counts[q.answer_status]++;walk(q.body);q.choices.forEach(walk);walk(q.answer.body);assert(q.answer.status==='source'||(!q.answer.key&&!q.answer.body.length));}}
assert.deepEqual(counts,{source:463,missing:5,not_ingested:198});
assert.deepEqual(fs.readdirSync(`${root}/images`).map(f=>'images/'+f).sort(),[...images].sort());
assert.deepEqual(fs.readdirSync(`${root}/data`).sort(),['catalog.json','papers','questions-index.json']);
assert.deepEqual(fs.readdirSync(`${root}/data/papers`).sort(),catalog.papers.map(p=>p.paper_id+'.json').sort());
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(dir+'/'+e.name):[dir+'/'+e.name]);}
const all=files(root);for(const file of all){assert(!/\.pdf$|\.jsonl$|SHA256SUMS|release\.json|\.pem$|\.key$/i.test(file), 'Private/source file '+file);if(/\.(json|html|js|txt)$/.test(file)){const s=fs.readFileSync(file,'utf8');assert(!/[A-Z]:\\(?:Users|yinkai_self)|[A-Z]:\/(?:Users|yinkai_self)|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30}|github_pat_[A-Za-z0-9_]{30}/.test(s),'Private string '+file);}}
const bytes=all.reduce((s,p)=>s+fs.statSync(p).size,0);assert(bytes<1024**3);
console.log(JSON.stringify({root,papers:catalog.papers.length,questions:ids.size,answers:counts,images:images.size,files:all.length,bytes},null,2));

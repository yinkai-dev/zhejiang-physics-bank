import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{init}=require('mathjax/es5/node-main.js');
const math=await init({loader:{load:['input/tex-full','output/svg']},startup:{typeset:false},svg:{fontCache:'none'}});
const problems=[],formulas=new Map();let count=0;
function walk(v,qid){if(Array.isArray(v))v.forEach(x=>walk(x,qid));else if(v&&typeof v==='object'){if(v.type==='math'){count++;if(!formulas.has(v.value)){const out=math.startup.adaptor.outerHTML(math.tex2svg(v.value,{display:false}));formulas.set(v.value,out);if(/data-mjx-error|merror|fill="red"/.test(out))problems.push({qid,tex:v.value,output:out});}}Object.values(v).forEach(x=>walk(x,qid));}}
for(const f of fs.readdirSync('public/data/papers'))for(const q of JSON.parse(fs.readFileSync('public/data/papers/'+f,'utf8')).questions)walk(q,q.id);
fs.mkdirSync('.local/evidence',{recursive:true});fs.writeFileSync('.local/evidence/math-report.json',JSON.stringify({count,unique:formulas.size,problems},null,2));
console.log(JSON.stringify({count,unique:formulas.size,errors:problems.length,problems:problems.map(p=>({qid:p.qid,tex:p.tex}))},null,2));assert.equal(problems.length,0,'Formula rendering errors');

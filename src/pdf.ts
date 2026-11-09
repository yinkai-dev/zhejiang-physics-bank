import type {Question,Selection} from './types';
import {el,button} from './render';

const endpoint='https://8.141.125.113';
const lastJobKey='zhejiang-physics-last-pdf-v1';
interface Job {job_id:string;status:string;expires_at:number;message?:string;question_count?:number;files?:{kind:string;url:string;pages:number;bytes:number}[];answers?:{requested:boolean;with_source_answer:number;missing:number;banks_without_package:string[]};}
async function request(path:string,body?:unknown):Promise<Job> {
  const r=await fetch(endpoint+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,cache:'no-store',signal:AbortSignal.timeout(20000)});
  const value=await r.json();if(!r.ok)throw Error(value.message||'PDF 服务暂时不可用，请稍后重试。');return value;
}
export function pdfControls(getSelection:()=>Selection[],getTitle:()=>string,getAnswers:()=>boolean) {
  const result=el('section','pdf-result no-print');result.hidden=true;result.setAttribute('aria-label','PDF 生成结果');
  let busy=false;
  function describe(job:Job,title:string,count:number) {
    result.hidden=false;result.replaceChildren(el('h2','','PDF · '+title),el('p','muted small',`已提交 ${count} 道题，按提交时的顺序排版。`));
    const status=el('p','pdf-status');status.setAttribute('role','status');
    if(job.status==='succeeded') {
      status.textContent='生成完成，可以下载。';result.append(status);
      const files=el('div','pdf-downloads');
      for(const f of job.files||[]){const a=el('a','button',`${f.kind==='worksheet'?'下载练习卷':'下载原卷答案'} · ${f.pages} 页`);a.href=endpoint+f.url;a.target='_blank';a.rel='noopener';files.append(a);}result.append(files);
      if(job.answers?.requested){const a=job.answers;result.append(el('p','muted small',`来源答案：${a.with_source_answer} 题${a.missing?`；${a.missing} 题原卷缺答`:''}${a.banks_without_package.length?'；部分题目答案尚未入库':''}。缺失答案不会自动补写。`));}
      result.append(el('p','muted small','文件临时保留 24 小时，请及时下载；持有文件链接的人可以访问。'));
    } else if(job.status==='failed') {status.textContent=job.message||'生成失败，请重试。';result.append(status,el('p','muted small','反馈时可附任务编号：'+job.job_id));}
    else {status.textContent=job.status==='queued'?'已提交，正在等待排版…':'正在排版并检查 PDF…';result.append(status);}
  }
  async function follow(job:Job,title:string,count:number) {
    const deadline=Date.now()+240000;
    while(['queued','running'].includes(job.status)) {
      describe(job,title,count);if(Date.now()>deadline)throw Error('本次排版较久，稍后刷新页面可继续查看结果。');
      await new Promise(resolve=>setTimeout(resolve,1800));job=await request('/bank-pdf/jobs/'+job.job_id);
    }
    describe(job,title,count);
  }
  const generate=button('生成 PDF',async()=>{
    if(busy)return;const rows=getSelection();
    if(rows.length>50){result.hidden=false;result.replaceChildren(el('p','','每次最多生成 50 题，请分批导出。'));return;}
    const title=getTitle().trim()||'浙江物理专项练习';busy=true;generate.dataset.busy='true';generate.disabled=true;generate.textContent='正在生成…';result.hidden=false;result.replaceChildren(el('p','','正在提交选题…'));
    try{const job=await request('/bank-pdf/jobs',{title,answers:getAnswers(),items:rows});try{localStorage.setItem(lastJobKey,JSON.stringify({id:job.job_id,title,count:rows.length}));}catch{}await follow(job,title,rows.length);}
    catch(e){result.hidden=false;result.replaceChildren(el('p','',(e as Error).name==='TypeError'?'PDF 服务连接失败，请稍后重试；也可使用浏览器打印。':(e as Error).message));}
    finally{busy=false;delete generate.dataset.busy;generate.textContent='生成 PDF';generate.disabled=!getSelection().length;}
  },'button primary');
  async function restore() {
    try {const saved=JSON.parse(localStorage.getItem(lastJobKey)||'null');if(!saved||!/^[a-f0-9]{32}$/.test(saved.id))return;const job=await request('/bank-pdf/jobs/'+saved.id);if(job.expires_at*1000<Date.now())return;busy=true;generate.dataset.busy='true';generate.disabled=true;await follow(job,saved.title,saved.count);}
    catch {/* An expired previous download never blocks the current worksheet. */}
    finally{busy=false;delete generate.dataset.busy;generate.disabled=!getSelection().length;}
  }
  return {generate,result,restore};
}

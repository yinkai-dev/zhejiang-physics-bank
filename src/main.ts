/* 页面约束：主内容为试卷与原题，次级为来源和分类，辅助为统计和状态。
   首页主操作为搜索；练习页主操作为打印。先以留白、字重和边线建立层级。
   原生 TypeScript，无组件库和 Tailwind；浅色阅读界面。间距 4/8/12/16/24/32/48/64，
   字号 12/14/16/18/20/24/30/36/48；配色来自 design/design-tokens.json。 */
import './style.css';
import {getCatalog,getIndex,getPaper,url} from './data';
import {el,link,button,dateLabel,statusLabel,content,answerContent,typeset,clearMath} from './render';
import {filterKeys,parseFilters,filterQuestions,addSelection,moveSelection,selectionIssues} from './domain.mjs';
import type {Catalog,Paper,Question,Summary,Selection} from './types';
import {pdfControls} from './pdf';

const app=document.querySelector<HTMLElement>('#app')!;
const page=location.pathname.split('/').pop() || 'index.html';
const params=new URLSearchParams(location.search);
const storageKey='zhejiang-physics-worksheet-v1';
let selected:Selection[]=[];
let storageWarning='';
try {
  const saved=JSON.parse(localStorage.getItem(storageKey)||'[]');
  if(!Array.isArray(saved)||saved.some(r=>typeof r?.id!=='string'||typeof r?.fingerprint!=='string'))throw Error();
  selected=[...new Map(saved.map((r:Selection)=>[r.id,{id:r.id,fingerprint:r.fingerprint}])).values()] as Selection[];
} catch {storageWarning='练习清单读取失败；本次可继续选题，请检查浏览器的本地存储设置。';}
function toast(message:string) {const n=document.querySelector<HTMLElement>('#toast')!;n.textContent=message;n.hidden=false;window.setTimeout(()=>n.hidden=true,4000);}
function save() {
  try {localStorage.setItem(storageKey,JSON.stringify(selected));}
  catch {toast('当前浏览器无法保存清单；关闭页面后可能丢失。');}
  document.querySelectorAll('[data-selection-count]').forEach(n=>n.textContent=String(selected.length));
  document.querySelectorAll<HTMLButtonElement>('[data-select]').forEach(b=>{const exists=selected.some(s=>s.id===b.dataset.select);b.textContent=exists?'已加入练习 ✓':'加入练习 ＋';b.setAttribute('aria-pressed',String(exists));});
}
function selectButton(q:Summary|Question) {
  const b=button('加入练习 ＋',()=>{selected=addSelection(selected,q);save();},'button small-button');b.dataset.select=q.id;b.setAttribute('aria-label',`第 ${q.number} 题：加入练习`);return b;
}
function shell() {
  const header=el('header','site-header no-print'),inner=el('div','header-inner');
  const brand=link('', 'index.html','brand');brand.append(el('span','brand-mark','φ'),el('span','','yinkai 的浙江高考物理题库'));
  const nav=el('nav','main-nav');nav.setAttribute('aria-label','主导航');
  const bankLink=link('浏览题库','index.html',page==='index.html'?'active':'');
  const worksheetLink=link('我的练习 ','worksheet.html',page==='worksheet.html'?'active':'');const count=el('span','nav-count',String(selected.length));count.dataset.selectionCount='';worksheetLink.append(count);
  nav.append(bankLink,worksheetLink,link('关于题库','about.html',page==='about.html'?'active':''));inner.append(brand,nav);header.append(inner);
  const main=el('main','page');main.id='main';
  const footer=el('footer','site-footer no-print');footer.append(el('p','','为浙江物理选考备考整理 · 保留原题与来源'),link('数据说明与反馈','about.html'));
  const toastNode=el('div','toast no-print');toastNode.id='toast';toastNode.hidden=true;toastNode.setAttribute('role','status');
  const skip=el('a','skip-link no-print','跳到正文');skip.href='#main';app.append(skip,header,main,footer,toastNode);return main;
}
const main=shell();
function crumb(items:{text:string;href?:string}[]) {const n=el('nav','breadcrumbs no-print');n.setAttribute('aria-label','当前位置');items.forEach((x,i)=>{if(i)n.append(el('span','','/'));n.append(x.href?link(x.text,x.href):el('span','',x.text));});return n;}
function alertBox(message:string,cls='notice') {const n=el('div',cls,message);n.setAttribute('role','status');return n;}
function heading(kicker:string,title:string,description?:string) {const h=el('div','page-heading');h.append(el('p','eyebrow',kicker),el('h1','',title));if(description)h.append(el('p','intro',description));return h;}
function paperMeta(p:Paper) {const m=el('div','metadata');m.append(el('span','badge',`${p.original_classification}备考`),el('span','',dateLabel(p)),el('span','','备考卷'));return m;}
function questionCard(q:Question,p:Paper,options:{answer?:boolean;number?:number}={}) {
  const card=el('article','question-card');card.dataset.questionId=q.id;
  const top=el('div','question-top'),label=el('div','question-label');label.append(el('span','question-number',options.number===undefined?`第 ${q.number} 题`:`${options.number}.`),el('span','question-type',q.type),el('span','muted small',q.topics.join(' · ')));
  const actions=el('div','question-actions no-print');actions.append(link('单题链接',`question.html?id=${encodeURIComponent(q.id)}`),selectButton(q));top.append(label,actions);
  const source=el('p','question-source',`${p.title} · 原第 ${q.number} 题 · ${p.original_classification}备考 · 实际 ${dateLabel(p)}`);
  card.append(top,source,content(q));
  if(options.answer!==false) {const d=el('details','answer-details');const summary=el('summary','',q.answer.status==='source'?'查看原卷答案':statusLabel[q.answer.status]);d.append(summary,answerContent(q));d.addEventListener('toggle',()=>{if(d.open)typeset(d).catch(e=>toast(e.message));});card.append(d);}
  return card;
}

async function indexPage(catalog:Catalog,index:Summary[],papers:Map<string,Paper>) {
  main.append(heading('ZHEJIANG · PHYSICS','从一道原题，开始今天的练习。','按备考届别找试卷，按主题选原题。已有原卷答案随题查看，选好的题目可以生成 PDF。'));
  const collections=el('div','collection-grid');
  [...catalog.collections].sort((a,b)=>b.target_year-a.target_year).forEach(c=>{const a=link('',`index.html?year=${c.target_year}&session=${c.target_session}`,'collection-card');a.append(el('span','eyebrow',c.target_session==='first'?'首考备考':'二考备考'),el('strong','collection-year',String(c.target_year)),el('span','',`${c.paper_count} 卷 · ${c.question_count} 题`),el('span','card-arrow','↗'));collections.append(a);});main.append(collections);
  const info=el('p','catalog-note','已收录 37 卷 · 666 道原题 · 463 题有来源答案。当前均为模拟、联考或诊断等备考卷。');main.append(info);
  const layout=el('div','catalog-layout'),filterPanel=el('details','filters no-print');filterPanel.open=matchMedia('(min-width: 760px)').matches;
  const filterSummary=el('summary','filter-heading','筛选题库');filterPanel.append(filterSummary);
  const form=el('form','filter-form');form.setAttribute('aria-label','题库筛选');
  const reset=button('清除全部筛选',()=>{for(const key of filterKeys)params.delete(key);params.delete('q');params.delete('page');history.pushState(null,'',url('index.html')+(params.size?'?'+params:''));location.reload();},'text-button');
  const groups:{key:string;label:string;options:[string,string][];advanced?:boolean}[]=[
    {key:'year',label:'备考年份',options:[...new Set(catalog.papers.map(p=>p.target_year))].sort((a,b)=>b-a).map(y=>[String(y),String(y)])},
    {key:'session',label:'备考阶段',options:[['first','首考'],['second','二考']]},
    {key:'topic',label:'主题',options:['力学','电学','光学','热学','近代物理'].map(t=>[t,t])},
    {key:'type',label:'题型',options:['单选题','多选题','实验题','计算题'].map(t=>[t,t])},
    {key:'answer',label:'答案状态',options:[['source','已有原卷答案'],['missing','原卷答案缺失'],['not_ingested','答案尚未入库']]},
    {key:'kind',label:'试卷性质',options:[['practice','备考卷'],['official','正式真题']],advanced:true},
    {key:'examYear',label:'实际考试年份',options:[...new Set(catalog.papers.map(p=>p.exam_year))].sort().map(y=>[y===null?'unknown':String(y),y===null?'未知':String(y)]),advanced:true},
    {key:'month',label:'实际考试月份',options:[...new Set(catalog.papers.map(p=>p.exam_month))].sort((a,b)=>(a||0)-(b||0)).map(m=>[m===null?'unknown':String(m),m===null?'未知':`${m} 月`]),advanced:true}
  ];
  const advanced=el('details','advanced-filters');advanced.open=['examYear','kind','month'].some(k=>params.has(k));advanced.append(el('summary','','更多筛选'));
  for(const g of groups) {
    const field=el('fieldset','filter-group');field.append(el('legend','',g.label));
    const opts=g.options.slice();for(const v of parseFilters(params)[g.key])if(!opts.some(o=>o[0]===v))opts.push([v,v]);
    opts.forEach(([value,label])=>{const l=el('label','check-label'),input=el('input');input.type='checkbox';input.name=g.key;input.value=value;input.checked=parseFilters(params)[g.key].includes(value);l.append(input,el('span','',label));field.append(l);});
    (g.advanced?advanced:form).append(field);
  }
  form.append(advanced,reset);filterPanel.append(form);
  const result=el('section','results');result.setAttribute('aria-label','筛选结果');
  const search=el('form','search-form');search.setAttribute('role','search');const input=el('input');input.type='search';input.name='q';input.placeholder='搜索试卷、地区、学校或题目关键词';input.setAttribute('aria-label','搜索试卷或题目');input.value=params.get('q')||'';const submit=el('button','button primary','搜索');submit.type='submit';search.append(input,submit);
  const toolbar=el('div','results-toolbar'),count=el('div'),controls=el('div','results-controls');
  const view=el('select');view.setAttribute('aria-label','结果视图');[['papers','按试卷'],['questions','按题目']].forEach(([v,t])=>{const o=el('option','',t);o.value=v;view.append(o);});view.value=params.get('view')==='questions'?'questions':'papers';
  const sort=el('select');sort.setAttribute('aria-label','排序');[['recent','实际考试时间 ↓'],['oldest','实际考试时间 ↑'],['title','试卷名称']].forEach(([v,t])=>{const o=el('option','',t);o.value=v;sort.append(o);});sort.value=['recent','oldest','title'].includes(params.get('sort')||'')?params.get('sort')!:'recent';controls.append(view,sort);toolbar.append(count,controls);
  const chips=el('div','filter-chips'),list=el('div','result-list'),pagination=el('nav','pagination');pagination.setAttribute('aria-label','结果分页');
  result.append(search,toolbar,chips,list,pagination);layout.append(filterPanel,result);main.append(layout);
  function updateURL() {history.pushState(null,'',url('index.html')+(params.size?'?'+params.toString():''));}
  function renderResults() {
    const filters=parseFilters(params),matched=filterQuestions(index,papers,filters,params.get('q')||'');
    const grouped=new Map<string,Summary[]>();matched.forEach(q=>grouped.set(q.paper_id,[...(grouped.get(q.paper_id)||[]),q]));
    const compare=(a:Paper,b:Paper)=>sort.value==='title'?a.title.localeCompare(b.title,'zh-CN'):((a.exam_year||0)*100+(a.exam_month||0)-(b.exam_year||0)*100-(b.exam_month||0))*(sort.value==='oldest'?1:-1)||b.target_year-a.target_year||a.title.localeCompare(b.title,'zh-CN');
    const sortedPapers=[...grouped.keys()].map(id=>papers.get(id)!).sort(compare);
    matched.sort((a,b)=>compare(papers.get(a.paper_id)!,papers.get(b.paper_id)!)||a.order-b.order);
    count.replaceChildren(el('strong','',`${matched.length} 道题`),el('span','muted',` / ${grouped.size} 张试卷`));count.setAttribute('role','status');
    chips.replaceChildren();for(const g of groups)for(const v of filters[g.key]){const label=g.options.find(o=>o[0]===v)?.[1]||v;chips.append(button(`${g.label}：${label} ×`,()=>{const next=filters[g.key].filter(x=>x!==v);params.delete(g.key);next.forEach(x=>params.append(g.key,x));params.delete('page');form.querySelectorAll<HTMLInputElement>(`input[name="${g.key}"]`).forEach(i=>i.checked=next.includes(i.value));updateURL();renderResults();},'chip'));}
    if(params.get('q'))chips.append(el('span','chip',`关键词：${params.get('q')}`));
    list.replaceChildren();pagination.replaceChildren();
    if(!matched.length){const empty=el('div','empty-state');empty.append(el('div','empty-symbol','∅'),el('h2','','没有符合条件的题目'),el('p','muted','试着减少筛选条件或更换关键词。当前条件已保留。'),button('清除全部筛选',()=>reset.click(),'button'));list.append(empty);return;}
    const isQuestions=view.value==='questions',size=isQuestions?20:10,total=isQuestions?matched.length:sortedPapers.length,totalPages=Math.ceil(total/size),current=Math.min(totalPages,Math.max(1,Number(params.get('page'))||1)),start=(current-1)*size;
    if(isQuestions) matched.slice(start,start+size).forEach(q=>{const p=papers.get(q.paper_id)!,card=el('article','question-result');const top=el('div','result-card-top');top.append(el('span','badge',q.type),el('span','muted small',q.topics.join(' · ')),selectButton(q));card.append(top,link(`${p.title} · 第 ${q.number} 题`,`question.html?id=${encodeURIComponent(q.id)}`,'result-title'),el('p','question-preview',q.search_text.slice(0,170)+(q.search_text.length>170?'…':'')),el('div','muted small',`${p.original_classification}备考 · 实际 ${dateLabel(p)} · ${statusLabel[q.answer_status]}`));list.append(card);});
    else sortedPapers.slice(start,start+size).forEach(p=>{const qs=grouped.get(p.paper_id)!,card=el('article','paper-result');const content=el('div','paper-result-content');content.append(paperMeta(p),link(p.title,`paper.html?id=${encodeURIComponent(p.paper_id)}`,'result-title'),el('p','muted small',`${qs.length} 题符合筛选 · 全卷 ${p.question_count} 题 · ${p.source_answer_count} 题有来源答案`));const action=link('浏览试卷 →',`paper.html?id=${encodeURIComponent(p.paper_id)}`,'paper-open');card.append(content,action);list.append(card);});
    if(totalPages>1){if(current>1)pagination.append(button('← 上一页',()=>goPage(current-1),'button'));pagination.append(el('span','muted',`第 ${current} / ${totalPages} 页`));if(current<totalPages)pagination.append(button('下一页 →',()=>goPage(current+1),'button'));}
    save();
  }
  function goPage(n:number){params.set('page',String(n));updateURL();renderResults();result.scrollIntoView({block:'start',behavior:'smooth'});}
  form.addEventListener('change',()=>{for(const key of filterKeys){params.delete(key);form.querySelectorAll<HTMLInputElement>(`input[name="${key}"]:checked`).forEach(i=>params.append(key,i.value));}params.delete('page');updateURL();renderResults();});
  search.addEventListener('submit',e=>{e.preventDefault();const q=input.value.trim();q?params.set('q',q):params.delete('q');params.delete('page');updateURL();renderResults();});
  view.addEventListener('change',()=>{params.set('view',view.value);params.delete('page');updateURL();renderResults();});sort.addEventListener('change',()=>{params.set('sort',sort.value);params.delete('page');updateURL();renderResults();});
  window.addEventListener('popstate',()=>location.reload());renderResults();
}

async function paperPage(catalog:Catalog,papers:Map<string,Paper>) {
  const p=papers.get(params.get('id')||'');if(!p)throw Error('没有找到这张试卷，请从题库目录重新选择。');
  document.title=p.title+' · 浙江物理题库';main.append(crumb([{text:'题库',href:'index.html'},{text:p.original_classification},{text:p.title}]),heading('原卷浏览',p.title),paperMeta(p));
  main.append(el('p','muted date-note','实际考试年月由原卷标题推得，精确到月；“'+p.original_classification+'”是备考分类。'));
  const qs=await getPaper(p.paper_id),actions=el('div','paper-actions no-print');
  actions.append(button('整卷加入练习 ＋',()=>{qs.forEach(q=>selected=addSelection(selected,q));save();toast(`已将本卷 ${qs.length} 题加入练习，重复题自动去重。`);}),link('查看练习并打印 →','worksheet.html','button primary'));
  main.append(actions);
  const nav=el('nav','question-nav no-print');nav.setAttribute('aria-label','跳转原题号');qs.forEach(q=>{const a=el('a','',q.number);a.href='#q-'+q.number;nav.append(a);});main.append(nav);
  for(const q of qs){const card=questionCard(q,p);card.id='q-'+q.number;main.append(card);}save();await typeset(main);
}
async function singlePage(index:Summary[],papers:Map<string,Paper>) {
  const s=index.find(q=>q.id===params.get('id'));if(!s)throw Error('没有找到这道题，请从题库目录重新选择。');
  const p=papers.get(s.paper_id)!,qs=await getPaper(p.paper_id),q=qs.find(q=>q.id===s.id)!;
  document.title=`${p.title} 第 ${q.number} 题 · 浙江物理题库`;
  main.classList.add('reading-page');main.append(crumb([{text:'题库',href:'index.html'},{text:p.title,href:`paper.html?id=${encodeURIComponent(p.paper_id)}`},{text:`第 ${q.number} 题`}]),heading(p.original_classification+'备考',`第 ${q.number} 题 · ${q.type}`),paperMeta(p),questionCard(q,p));
  const nav=el('nav','question-pagination no-print');nav.setAttribute('aria-label','切换题目');const pos=qs.findIndex(x=>x.id===q.id);
  if(pos>0)nav.append(link('← 上一题',`question.html?id=${encodeURIComponent(qs[pos-1].id)}`,'button'));
  nav.append(link('返回整卷',`paper.html?id=${encodeURIComponent(p.paper_id)}#q-${q.number}`,'button'));
  if(pos<qs.length-1)nav.append(link('下一题 →',`question.html?id=${encodeURIComponent(qs[pos+1].id)}`,'button'));
  nav.append(button('复制本题链接',async()=>{try{await navigator.clipboard.writeText(location.href);toast('题目链接已复制。');}catch{toast('请复制地址栏中的本题链接。');}},'text-button'));main.append(nav);save();await typeset(main);
}

async function worksheetPage(index:Summary[],papers:Map<string,Paper>) {
  main.classList.add('worksheet-page');main.append(heading('我的练习','把选好的题，变成一份练习。','跨卷选题、调整顺序，生成排版好的 PDF。清单保存在当前浏览器。'));
  const tools=el('div','worksheet-tools no-print'),titleLabel=el('label','title-field','练习标题'),title=el('input');title.value='浙江物理专项练习';title.maxLength=60;title.setAttribute('aria-label','练习标题');titleLabel.append(title);
  const checkLabel=el('label','check-label'),include=el('input');include.type='checkbox';checkLabel.append(include,el('span','','同时附上已有原卷答案'));
  const print=button('浏览器打印',async()=>{print.disabled=true;print.textContent='正在准备…';try{await preparePrint();window.print();}catch(e){toast((e as Error).message);}finally{print.disabled=false;print.textContent='浏览器打印';}},'button');
  const pdf=pdfControls(()=>selected,()=>title.value,()=>include.checked);pdf.generate.disabled=true;
  tools.append(titleLabel,checkLabel,pdf.generate,print,button('清空清单',()=>{if(confirm(`清空当前 ${selected.length} 道题？`)){selected=[];save();render();}},'text-button'));
  const printStatus=el('p','muted small no-print');printStatus.setAttribute('role','status');
  const area=el('div','worksheet-content');main.append(tools,el('p','muted small no-print','PDF 使用试卷排版，每次最多 50 题；练习卷与可用答案分别下载。浏览器打印可直接打印当前页面。'),pdf.result,printStatus,area);
  let generation=0;
  async function preparePrint(){await typeset(area);const imgs=[...area.querySelectorAll('img')].filter(i=>!i.closest('[hidden]'));imgs.forEach(i=>i.loading='eager');await Promise.all(imgs.map(i=>i.decode().catch(()=>{throw Error('有图片未加载成功，请检查网络后重试打印。');})));await document.fonts.ready;}
  async function render() {
    const run=++generation;clearMath(area);area.replaceChildren();print.disabled=true;pdf.generate.disabled=true;printStatus.textContent='';
    if(!selected.length){const empty=el('div','empty-state');empty.append(el('div','empty-symbol','＋'),el('h2','','练习清单还是空的'),el('p','muted','浏览试卷或单题，点击“加入练习”即可。'),link('去题库选题 →','index.html','button primary'));area.append(empty);return;}
    const issues=selectionIssues(selected,index);
    if(issues.length){const warning=el('div','notice no-print');warning.append(el('p','','有 '+issues.length+' 道已选题已变更或不在当前题库，核对后才能打印。'));for(const issue of issues){const q=index.find(q=>q.id===issue.id);warning.append(el('p','small',`${q?papers.get(q.paper_id)!.title+' 第 '+q.number+' 题':issue.id}：${issue.reason==='changed'?'来源版本已变化':'题目已不可用'}`));if(q)warning.append(link('查看当前题目',`question.html?id=${encodeURIComponent(q.id)}`),button('确认采用当前版本',()=>{selected=selected.map(r=>r.id===q.id?{id:q.id,fingerprint:q.fingerprint}:r);save();render();},'button'));else warning.append(button('移除此题',()=>{selected=selected.filter(r=>r.id!==issue.id);save();render();},'button'));}area.append(warning);return;}
    printStatus.textContent='正在准备题目、公式和图片…';
    const paperIds=[...new Set(selected.map(r=>index.find(q=>q.id===r.id)!.paper_id))];const loaded=await Promise.all(paperIds.map(id=>getPaper(id)));if(run!==generation)return;
    const map=new Map(loaded.flat().map(q=>[q.id,q]));const qs=selected.map(r=>map.get(r.id)!);
    const printHeading=el('div','print-heading');printHeading.append(el('h1','worksheet-title',title.value||'浙江物理专项练习'),el('p','',`共 ${qs.length} 题　姓名：____________　日期：____________`));area.append(printHeading);
    qs.forEach((q,i)=>{const p=papers.get(q.paper_id)!,card=questionCard(q,p,{answer:false,number:i+1});const reorder=el('div','reorder no-print');const up=button('↑ 上移',()=>{selected=moveSelection(selected,q.id,-1);save();render();},'text-button');up.disabled=i===0;const down=button('↓ 下移',()=>{selected=moveSelection(selected,q.id,1);save();render();},'text-button');down.disabled=i===qs.length-1;const remove=button('移除',()=>{selected=selected.filter(r=>r.id!==q.id);save();render();},'text-button');up.setAttribute('aria-label',`练习第 ${i+1} 题上移`);down.setAttribute('aria-label',`练习第 ${i+1} 题下移`);remove.setAttribute('aria-label',`移除练习第 ${i+1} 题`);reorder.append(up,down,remove);card.prepend(reorder);area.append(card);});
    const answers=el('section','worksheet-answers');answers.hidden=!include.checked;answers.append(el('h2','','原卷参考答案'));
    qs.forEach((q,i)=>{const a=el('article','answer-item');a.append(el('h3','',`${i+1}. ${papers.get(q.paper_id)!.title} · 原第 ${q.number} 题`),answerContent(q));answers.append(a);});area.append(answers);
    save();pdf.generate.disabled=!!pdf.generate.dataset.busy;try{await preparePrint();if(run!==generation)return;print.disabled=false;printStatus.textContent=`已就绪 · ${qs.length} 道题${include.checked?' · 附已有答案':''} · 浏览器打印会隐藏操作按钮`;}catch(e){printStatus.textContent=(e as Error).message;}
  }
  title.addEventListener('input',()=>{const h=area.querySelector('.worksheet-title');if(h)h.textContent=title.value||'浙江物理专项练习';});
  include.addEventListener('change',async()=>{const a=area.querySelector<HTMLElement>('.worksheet-answers');if(a){a.hidden=!include.checked;print.disabled=true;try{await preparePrint();print.disabled=false;printStatus.textContent=`已就绪 · ${selected.length} 道题${include.checked?' · 附已有答案':''} · 打印时自动隐藏操作按钮`;}catch(e){printStatus.textContent=(e as Error).message;}}});
  await render();await pdf.restore();pdf.generate.disabled=!selected.length||selectionIssues(selected,index).length>0;
}
function aboutPage() {
  main.classList.add('reading-page');main.append(heading('关于题库','让整理好的原题，方便地被使用。','面向浙江物理选考备考的公开静态题库。'));
  const section=el('article','prose');section.innerHTML=`<h2>目前收录</h2><p>2025 二考 11 卷 198 题、2026 二考 21 卷 378 题、2027 首考 5 卷 90 题，共 37 卷 666 题。当前全部为模拟、联考、诊断等备考卷，尚未收录正式高考真题。</p><h2>年份与答案</h2><p>“2027 首考”表示备考目标，卷面实际考试可能在 2026 年。实际年月从原卷标题推得，并非逐卷重新确认的完整考试日期。</p><p>463 题有来源答案；2026 二考有 5 题明确缺失原卷答案，2025 二考 198 题尚未接入答案包。只有答案字母的题目不代表附有完整解题过程。本站不自动补写答案。</p><h2>使用方法</h2><p>组合年份、阶段、主题和题型筛选，或搜索试卷名与题目关键词。筛选取交集，同一维度多选取并集。题目加入“我的练习”后可调序、移除，再点击“生成 PDF”取得排版好的练习卷，并可同时生成独立的原卷答案 PDF。也保留浏览器打印。单题和筛选链接可以直接分享。</p><p>练习清单仅保存在当前浏览器，不跨设备同步。PDF 每次最多 50 题，文件保留 24 小时，请及时下载；持有文件链接的人可以访问。使用浏览器打印时请等待“已就绪”，推荐 A4 并关闭页眉页脚。长题可跨页。</p><h2>来源与状态</h2><p>题目文字、公式、题图、答案来自已整理的原卷内容，保留原卷标题与题号。主题和题型沿用来源 AI 分类，尚未经过教师逐题复核。工程校验只验证关联、转换和展示，不等于教师审核或教学效果证明。</p><p>网站代码、题目内容和第三方依赖分别管理。题目及原卷图片的权利属于相应权利人，本站的整理与公开展示不授予内容再许可。</p><h2>勘误与反馈</h2><p>如发现缺图、题文或答案问题，请附上单题链接和原卷题号；涉及内容权利的问题也可通过仓库反馈。</p>`;
  const repo=el('p');const a=el('a','','在 GitHub 提交反馈 ↗');a.href='https://github.com/yinkai-dev/zhejiang-physics-bank/issues';a.target='_blank';a.rel='noopener noreferrer';repo.append(a);section.append(repo,link('第三方依赖声明','THIRD_PARTY_NOTICES.txt'));main.append(section);
}
async function start() {
  if(storageWarning)main.append(alertBox(storageWarning));
  if(page==='about.html'){aboutPage();return;}
  const loading=el('p','loading','正在打开题库…');main.append(loading);
  const [catalog,index]=await Promise.all([getCatalog(),getIndex()]);loading.remove();
  const papers=new Map(catalog.papers.map(p=>[p.paper_id,p]));
  if(page==='paper.html')await paperPage(catalog,papers);
  else if(page==='question.html')await singlePage(index,papers);
  else if(page==='worksheet.html')await worksheetPage(index,papers);
  else await indexPage(catalog,index,papers);
}
start().catch(e=>{main.querySelector('.loading')?.remove();main.append(alertBox((e as Error).message,'error-state'),link('返回题库','index.html','button'));console.error(e);});

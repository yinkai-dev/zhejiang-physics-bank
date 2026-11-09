import type {Block,Question,Paper} from './types';
import {url} from './data';
export function el<K extends keyof HTMLElementTagNameMap>(tag:K,cls='',text?:string):HTMLElementTagNameMap[K] {
  const node=document.createElement(tag); if(cls)node.className=cls; if(text!==undefined)node.textContent=text; return node;
}
export function link(text:string,href:string,cls='') {const a=el('a',cls,text);a.href=url(href);return a;}
export function button(text:string,action:()=>unknown,cls='button') {const b=el('button',cls,text);b.type='button';b.addEventListener('click',action);return b;}
export function dateLabel(p:Paper) {return p.exam_year===null?'实际年月未知':`${p.exam_year} 年${p.exam_month===null?'':` ${p.exam_month} 月`}`;}
export const statusLabel={source:'已有原卷答案',missing:'原卷答案缺失',not_ingested:'答案尚未入库'};
let mathPromise:Promise<void>|undefined;
type MathJax = {startup:{promise:Promise<void>};typesetPromise:(nodes:Element[])=>Promise<void>;typesetClear:(nodes:Element[])=>void;};
declare global {interface Window {MathJax:MathJax;}}
export function initMath() {
  if(!mathPromise) mathPromise=new Promise<void>((resolve,reject)=>{
    const config={loader:{paths:{mathjax:url('vendor/mathjax')}},tex:{inlineMath:[['\\(','\\)']],displayMath:[['\\[','\\]']],processEscapes:false,packages:{'[+]':['noerrors','noundefined']}},svg:{fontCache:'local'},options:{enableMenu:false,ignoreHtmlClass:'tex-ignore',processHtmlClass:'tex-process'},startup:{typeset:false}};
    Object.assign(window,{MathJax:config});
    const script=document.createElement('script');script.src=url('vendor/mathjax/tex-svg-full.js');
    script.onload=()=>window.MathJax.startup.promise.then(resolve,reject);script.onerror=()=>reject(Error('公式资源加载失败，请刷新重试'));document.head.append(script);
  });
  return mathPromise;
}
let mathQueue=Promise.resolve();
export function typeset(node:HTMLElement) {
  mathQueue=mathQueue.catch(()=>{}).then(async()=>{if(node.querySelector('.tex-process')){await initMath();if(node.isConnected)await window.MathJax.typesetPromise([node]);}});
  return mathQueue;
}
export function clearMath(node:HTMLElement) {if(window.MathJax?.typesetClear)window.MathJax.typesetClear([node]);}
function figure(b:Extract<Block,{type:'figure'}>,label='') {
  const fig=el('figure','source-figure'), img=el('img');img.src=url(b.src);img.alt='原卷配图';img.width=b.width;img.height=b.height;img.loading='lazy';
  fig.style.setProperty('--figure-width',`${b.width_mm}mm`);if(label)fig.append(el('figcaption','figure-label',label));fig.append(img);return fig;
}
const imageLabel=/^\s*[A-D][.．、]\s*$/;
const imageCaption=/^[\s第\d一二三四五六七八九十题图ⅠⅡⅢIV甲乙丙丁A-Da-d()（）.,，、:：左右上下\-]*$/;
export function blocks(parent:HTMLElement,items:Block[]) {
  let pendingLabel='';
  for(let i=0;i<items.length;i++) {
    const b=items[i];
    if(b.type==='text'||b.type==='score') {
      const label=b.type==='text'&&items[i+1]?.type==='figure'?b.value.match(/(^|\n)([A-D][.．、])\s*$/):null;
      if(label){const before=b.value.slice(0,label.index);if(before)parent.append(el('span','text-block',before));pendingLabel=label[2];}
      else parent.append(el('span',b.type==='score'?'score':'text-block',b.value));
    }
    else if(b.type==='math') parent.append(el('span','tex-process',`\\(${b.value}\\)`));
    else if(b.type==='figure') {
      const figures=[figure(b,pendingLabel)];pendingLabel='';let cursor=i;
      // Only reunite adjacent figures that the source explicitly places in one row.
      while(b.row_group){
        const separator=items[cursor+1],next=items[cursor+2];
        if(separator?.type==='figure'&&separator.row_group===b.row_group){figures.push(figure(separator));cursor++;continue;}
        if(separator?.type==='text'&&separator.value.length<80&&imageCaption.test(separator.value)&&next?.type==='figure'&&next.row_group===b.row_group){
          const isLabel=imageLabel.test(separator.value);
          if(!isLabel&&separator.value.trim())figures.at(-1)!.append(el('figcaption','figure-caption',separator.value.trim()));
          figures.push(figure(next,isLabel?separator.value.trim():''));cursor+=2;continue;
        }break;
      }
      if(figures.length>1){const row=el('div','figure-row');row.append(...figures);parent.append(row);i=cursor;}
      else parent.append(figures[0]);
    } else if(b.type==='table') {
      const scroll=el('div','table-scroll'),table=el('table'),body=el('tbody');
      b.rows.forEach(row=>{const tr=el('tr');row.forEach(cell=>{const td=el('td');blocks(td,cell);tr.append(td);});body.append(tr);});table.append(body);scroll.append(table);parent.append(scroll);
    }
  }
}
export function content(q:Question) {
  const body=el('div','question-body tex-ignore');blocks(body,q.body);
  if(q.choices.length){const choices=el('div','choices');q.choices.forEach(c=>{const item=el('div','choice');blocks(item,c);choices.append(item);});body.append(choices);}
  return body;
}
export function answerContent(q:Question) {
  const body=el('div','answer-body tex-ignore');
  if(q.answer.status!=='source') body.append(el('p','muted',statusLabel[q.answer.status]+'。后续补充来源答案。'));
  else {if(q.answer.key)body.append(el('p','answer-key','参考答案：'+q.answer.key));blocks(body,q.answer.body);if(!q.answer.body.length)body.append(el('p','muted small','来源仅提供答案，未附解题过程。'));}
  return body;
}

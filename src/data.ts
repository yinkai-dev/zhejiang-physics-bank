import type {Catalog,Question,Summary} from './types';
export const base = import.meta.env.BASE_URL;
export const url = (p:string) => base+p;
async function json<T>(p:string):Promise<T> {
  const r=await fetch(url(p));
  if(!r.ok) throw new Error('资源加载失败，请刷新重试（'+r.status+'）');
  return r.json();
}
const cache = new Map<string,Promise<Question[]>>();
export const getCatalog=()=>json<Catalog>('data/catalog.json');
export const getIndex=async()=> (await json<{questions:Summary[]}>('data/questions-index.json')).questions;
export function getPaper(id:string) {
  if(!cache.has(id)) cache.set(id,json<{questions:Question[]}>('data/papers/'+encodeURIComponent(id)+'.json').then(r=>r.questions));
  return cache.get(id)!;
}

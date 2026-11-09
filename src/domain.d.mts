import type {Summary,Paper,Selection} from './types';
export const filterKeys: string[];
export function parseFilters(params:URLSearchParams):Record<string,string[]>;
export function filterQuestions(questions:Summary[],papers:Map<string,Paper>,filters:Record<string,string[]>,search?:string):Summary[];
export function addSelection(rows:Selection[],q:Summary|import('./types').Question):Selection[];
export function moveSelection(rows:Selection[],id:string,delta:number):Selection[];
export function selectionIssues(rows:Selection[],index:Summary[]):{id:string;reason:string}[];

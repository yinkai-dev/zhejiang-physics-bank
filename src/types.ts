export type Block = {type:'text'|'math'|'score';value:string} | {type:'figure';src:string;width:number;height:number;width_mm:number;row_group?:string} | {type:'table';rows:Block[][][]};
export type AnswerStatus = 'source'|'missing'|'not_ingested';
export interface Paper {paper_id:string;collection_id:string;source_document_id:string;title:string;target_year:number;target_session:string;exam_year:number|null;exam_month:number|null;exam_date:string|null;exam_kind:string;question_count:number;source_answer_count:number;original_classification:string;date_basis:string;}
export interface Summary {id:string;paper_id:string;source_question_id:string;number:string;order:number;type:string;topics:string[];answer_status:AnswerStatus;fingerprint:string;search_text:string;}
export interface Question extends Omit<Summary,'search_text'> {body:Block[];choices:Block[][];answer:{status:AnswerStatus;key:string|null;body:Block[]};}
export interface Catalog {schema_version:number;version:string;snapshot_date:string;papers:Paper[];collections:{collection_id:string;label:string;target_year:number;target_session:string;paper_count:number;question_count:number}[];}
export interface Selection {id:string;fingerprint:string;}

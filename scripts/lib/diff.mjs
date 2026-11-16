// Compare two public projections. Replaces hard-coded count contracts: already published questions
// must stay byte-identical (the only allowed change is gaining a source answer); everything else
// is reported as blocking unless the caller explicitly allows changes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { canonical, readJson } from './common.mjs';

const EMPTY = { catalog: { papers: [], version: null }, index: [], paper: () => null };
const countAnswers = index => index.reduce((c, q) => (c[q.answer_status]++, c), { source: 0, missing: 0, not_ingested: 0 });
export const totals = p => ({ version: p.catalog.version ?? null, papers: p.catalog.papers.length, questions: p.index.length, answers: countAnswers(p.index) });

export function loadPublicDir(dir) {
  if (!fs.existsSync(path.join(dir, 'data/catalog.json'))) return EMPTY;
  return {
    catalog: readJson(path.join(dir, 'data/catalog.json')),
    index: readJson(path.join(dir, 'data/questions-index.json')).questions,
    paper: id => { const p = path.join(dir, 'data/papers', id + '.json'); return fs.existsSync(p) ? readJson(p).questions : null; },
  };
}

export function loadPublicGit(ref, cwd = process.cwd()) {
  const show = p => { try { return JSON.parse(execFileSync('git', ['show', `${ref}:${p}`], { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')); } catch { return null; } };
  const catalog = show('public/data/catalog.json');
  if (!catalog) return EMPTY;
  return { catalog, index: show('public/data/questions-index.json').questions, paper: id => show(`public/data/papers/${id}.json`)?.questions ?? null };
}

const withoutAnswer = ({ answer, answer_status, ...rest }) => rest;
const paperMetaKeys = ['title', 'target_year', 'target_session', 'exam_year', 'exam_month', 'exam_date', 'date_basis', 'exam_kind', 'official_session', 'original_classification', 'collection_id', 'source_document_id', 'metadata_review_status'];

export function diffPublic(prev, next) {
  const prevPapers = new Map(prev.catalog.papers.map(p => [p.paper_id, p])), nextPapers = new Map(next.catalog.papers.map(p => [p.paper_id, p]));
  const prevIndex = new Map(prev.index.map(q => [q.id, q])), nextIndex = new Map(next.index.map(q => [q.id, q]));
  const d = {
    added_papers: [...nextPapers.keys()].filter(id => !prevPapers.has(id)),
    removed_papers: [...prevPapers.keys()].filter(id => !nextPapers.has(id)),
    added_questions: [...nextIndex.keys()].filter(id => !prevIndex.has(id)),
    removed_questions: [...prevIndex.keys()].filter(id => !nextIndex.has(id)),
    changed_questions: [], answers_gained: [], paper_meta_changed: [],
  };
  for (const [paperId, np] of nextPapers) {
    const pp = prevPapers.get(paperId);
    if (!pp) continue;
    const fields = paperMetaKeys.filter(k => canonical(pp[k] ?? null) !== canonical(np[k] ?? null));
    if (fields.length) d.paper_meta_changed.push({ paper_id: paperId, fields });
    const before = new Map((prev.paper(paperId) || []).map(q => [q.id, q]));
    for (const q of next.paper(paperId) || []) {
      const old = before.get(q.id);
      if (!old) continue;
      const summaryChanged = canonical(withoutAnswer(prevIndex.get(q.id) || {})) !== canonical(withoutAnswer(nextIndex.get(q.id) || {}));
      if (canonical(old) === canonical(q) && !summaryChanged) continue;
      const sameContent = !summaryChanged && canonical(withoutAnswer(old)) === canonical(withoutAnswer(q));
      if (sameContent && old.answer.status !== 'source' && q.answer.status === 'source') d.answers_gained.push(q.id);
      else d.changed_questions.push({ id: q.id, fields: [...new Set([...Object.keys(old), ...Object.keys(q)])].filter(k => canonical(old[k] ?? null) !== canonical(q[k] ?? null)).concat(summaryChanged ? ['index'] : []) });
    }
  }
  d.blocking = d.removed_papers.length + d.removed_questions.length + d.changed_questions.length > 0;
  d.totals = { previous: totals(prev), next: totals(next) };
  return d;
}

export function describeDiff(d) {
  const p = d.totals.previous, n = d.totals.next;
  const lines = [`${p.papers} 卷/${p.questions} 题 → ${n.papers} 卷/${n.questions} 题；来源答案 ${p.answers.source} → ${n.answers.source}`,
    `新增 ${d.added_papers.length} 卷、${d.added_questions.length} 题；已有题补齐答案 ${d.answers_gained.length} 题`];
  if (d.paper_meta_changed.length) lines.push(`卷级元数据变化 ${d.paper_meta_changed.length} 卷：${d.paper_meta_changed.slice(0, 5).map(x => `${x.paper_id}(${x.fields.join('/')})`).join('、')}`);
  if (d.blocking) lines.push(`需人工确认：移除 ${d.removed_papers.length} 卷、${d.removed_questions.length} 题；已上线题内容变化 ${d.changed_questions.length} 题`,
    ...d.removed_papers.slice(0, 10).map(id => `  - 移除卷 ${id}`), ...d.removed_questions.slice(0, 10).map(id => `  - 移除题 ${id}`),
    ...d.changed_questions.slice(0, 10).map(x => `  - 变化 ${x.id}（${x.fields.join('/')}）`));
  return lines;
}

export const diffSummary = d => ({ ...Object.fromEntries(['added_papers', 'removed_papers', 'paper_meta_changed', 'changed_questions'].map(k => [k, d[k]])), added_question_count: d.added_questions.length, removed_questions: d.removed_questions, answers_gained_count: d.answers_gained.length, blocking: d.blocking, totals: d.totals });

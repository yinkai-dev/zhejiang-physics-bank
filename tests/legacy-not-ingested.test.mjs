import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_NOT_INGESTED_PREFIX, effectiveAnswerStatus, isLegacyNotIngested } from '../scripts/lib/common.mjs';
import { diffPublic } from '../scripts/lib/diff.mjs';

test('effectiveAnswerStatus preserves not_ingested for legacy unanswered base rows while keeping explicit missing', () => {
  assert.equal(effectiveAnswerStatus(undefined), 'not_ingested');
  assert.equal(effectiveAnswerStatus(null), 'not_ingested');
  assert.equal(effectiveAnswerStatus({ status: 'source', key: 'A', body: [] }), 'source');

  const explicitMissing = { status: 'missing', key: null, body: [], missing_reason: '原配套答案缺失；source_pages 为原题卷占位，非答案来源。' };
  assert.equal(isLegacyNotIngested(explicitMissing), false);
  assert.equal(effectiveAnswerStatus(explicitMissing), 'missing');

  const legacyRow = { status: 'missing', key: null, body: [], missing_reason: `${LEGACY_NOT_INGESTED_PREFIX}历史基线未入库答案包` };
  assert.equal(isLegacyNotIngested(legacyRow), true);
  assert.equal(effectiveAnswerStatus(legacyRow), 'not_ingested');
});

test('expanding a collection with legacy_not_ingested placeholders keeps published questions byte-identical (blocking=false)', () => {
  const oldPaperMeta = {
    paper_id: 'zj-25-erkao--hangzhou-ermo-2504',
    collection_id: 'zj-25-erkao',
    source_document_id: 'hangzhou-ermo-2504',
    title: '物理卷-2504杭州二模',
    target_year: 2025,
    target_session: 'second',
    exam_year: 2025,
    exam_month: 4,
    exam_date: null,
    date_basis: 'source_title_yymm',
    exam_kind: 'practice',
    official_session: null,
    original_classification: '2025 二考',
    question_count: 1,
    source_answer_count: 0,
    metadata_review_status: 'classification_preserved_date_inferred',
  };
  const oldQuestionIndex = {
    id: 'zj-25-erkao--hangzhou-ermo-2504-q01',
    paper_id: oldPaperMeta.paper_id,
    source_question_id: 'hangzhou-ermo-2504-q01',
    number: '1',
    order: 1,
    type: '单选题',
    topics: ['力学'],
    answer_status: 'not_ingested',
    fingerprint: 'a'.repeat(64),
    search_text: '达因',
  };
  const oldQuestionDetail = {
    id: oldQuestionIndex.id,
    paper_id: oldPaperMeta.paper_id,
    source_question_id: oldQuestionIndex.source_question_id,
    number: '1',
    order: 1,
    type: '单选题',
    topics: ['力学'],
    answer_status: 'not_ingested',
    fingerprint: 'a'.repeat(64),
    body: [{ type: 'text', value: '1. 达因' }],
    choices: [[{ type: 'text', value: 'A. 力' }]],
    answer: { status: 'not_ingested', key: null, body: [] },
  };

  const prev = {
    catalog: { version: 'v1', papers: [oldPaperMeta] },
    index: [oldQuestionIndex],
    paper: id => (id === oldPaperMeta.paper_id ? [oldQuestionDetail] : null),
  };

  const legacyRow = { status: 'missing', key: null, body: [], missing_reason: `${LEGACY_NOT_INGESTED_PREFIX}历史基线未入库答案包` };
  const projectedStatus = effectiveAnswerStatus(legacyRow);
  const nextPaperMeta = { ...oldPaperMeta, paper_id: 'zj-25-erkao--new-2505', source_document_id: 'new-2505', title: '物理卷-2505新卷', source_answer_count: 1 };
  const nextNewIndex = { ...oldQuestionIndex, id: 'zj-25-erkao--new-2505-q01', paper_id: nextPaperMeta.paper_id, source_question_id: 'new-2505-q01', answer_status: 'source' };
  const nextNewDetail = { ...oldQuestionDetail, id: nextNewIndex.id, paper_id: nextPaperMeta.paper_id, source_question_id: 'new-2505-q01', answer_status: 'source', answer: { status: 'source', key: 'A', body: [] } };

  const next = {
    catalog: { version: 'v2', papers: [oldPaperMeta, nextPaperMeta] },
    index: [{ ...oldQuestionIndex, answer_status: projectedStatus }, nextNewIndex],
    paper: id => {
      if (id === oldPaperMeta.paper_id) {
        return [{ ...oldQuestionDetail, answer_status: projectedStatus, answer: { status: projectedStatus, key: null, body: [] } }];
      }
      if (id === nextPaperMeta.paper_id) return [nextNewDetail];
      return null;
    },
  };

  const diff = diffPublic(prev, next);
  assert.equal(diff.blocking, false);
  assert.deepEqual(diff.changed_questions, []);
  assert.deepEqual(diff.added_papers, ['zj-25-erkao--new-2505']);
  assert.equal(diff.added_questions.length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { choosePdfSample } from '../scripts/lib/pdf-sample.mjs';

test('one PDF job samples distinct changed banks and exercises source answers when available', () => {
  const papers = new Map(['a', 'b', 'c'].map(id => [id, { collection_id: id }]));
  const questions = [...papers.keys()].flatMap(paper_id =>
    ['单选题', '实验题', '计算题'].map(type => ({ paper_id, type, answer_status: 'source' })));
  const chosen = choosePdfSample(questions, papers);
  assert.deepEqual(chosen.map(q => q.paper_id), ['a', 'b', 'c']);
  assert.deepEqual(chosen.map(q => q.type), ['单选题', '实验题', '计算题']);

  const missing = { paper_id: 'a', type: '多选题', answer_status: 'missing' };
  const withAnswer = { ...missing, paper_id: 'b', answer_status: 'source' };
  assert.deepEqual(choosePdfSample([missing], papers), [missing]);
  assert.deepEqual(choosePdfSample([missing, withAnswer], papers), [missing, withAnswer]);
});

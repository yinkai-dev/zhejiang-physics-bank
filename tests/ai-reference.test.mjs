import assert from 'node:assert/strict';
import test from 'node:test';
import {validateReference} from '../scripts/lib/ai-reference.mjs';

test('AI reference keeps a conditional key separate and binds to the published question', () => {
  const fingerprint = 'a'.repeat(64);
  const q = {id:'example', fingerprint, answer_status:'missing'};
  const ref = {
    question_sha256:fingerprint, review_sha256:'b'.repeat(64),
    label:'AI 参考答案 · 经 AI 核验 · 未教师复核', key:null,
    condition:{key:'C', text:'更正流量单位'}, note:'原印无正确项',
    body:[{type:'text', value:'参考解答'}],
  };
  validateReference(ref, q);
  assert.throws(() => validateReference({...ref,key:'C'}, q), /conditional key/);
  assert.throws(() => validateReference(ref, {...q,fingerprint:'c'.repeat(64)}), /fingerprint/);
  assert.throws(() => validateReference(ref, {...q,answer_status:'source'}), /original answer/);
});

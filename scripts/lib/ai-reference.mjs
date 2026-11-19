import assert from 'node:assert/strict';

export function validateReference(ref, question) {
  const allowed = ['question_sha256', 'review_sha256', 'label', 'key', 'condition', 'note', 'body'];
  assert.deepEqual(Object.keys(ref).sort(), allowed.sort(), 'Unexpected AI reference fields');
  assert.equal(ref.question_sha256, question.fingerprint, 'AI reference fingerprint differs: ' + question.id);
  assert.equal(question.answer_status, 'missing', 'AI reference requires a missing original answer: ' + question.id);
  assert(/^[a-f0-9]{64}$/.test(ref.review_sha256), 'Missing AI review digest');
  assert(typeof ref.label === 'string' && ref.label.startsWith('AI 参考答案') &&
    ref.label.includes('未教师复核'), 'AI reference must disclose its origin and review status');
  assert(ref.key === null || /^[A-J]+$/.test(ref.key), 'Invalid AI reference key');
  assert(ref.note === null || typeof ref.note === 'string');
  if (ref.condition !== null) {
    assert.deepEqual(Object.keys(ref.condition).sort(), ['key', 'text']);
    assert(ref.key === null && /^[A-J]+$/.test(ref.condition.key) &&
      typeof ref.condition.text === 'string' && ref.condition.text.trim(), 'Invalid conditional key');
  }
  assert(Array.isArray(ref.body) && ref.body.length, 'Empty AI reference body');
}

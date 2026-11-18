export function choosePdfSample(pool, papers) {
  const usedBanks = new Set();
  const bankOf = question => papers.get(question.paper_id).collection_id;
  const chosen = [];
  for (const type of ['单选题', '实验题', '计算题']) {
    const candidates = pool.filter(q => q.type === type);
    const next = candidates.find(q => !usedBanks.has(bankOf(q))) ?? candidates[0];
    if (next) {
      chosen.push(next);
      usedBanks.add(bankOf(next));
    }
  }
  if (!chosen.length && pool.length) chosen.push(pool[0]);
  if (!chosen.some(q => q.answer_status === 'source')) {
    const withAnswer = pool.find(q => q.answer_status === 'source');
    if (withAnswer) chosen.push(withAnswer);
  }
  return chosen;
}

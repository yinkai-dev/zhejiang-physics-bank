import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNewPaper } from '../scripts/lib/paper-meta.mjs';

const shoukao = {
  collection_id: 'zj-27-shoukao',
  label: '2027 首考',
  target_year: 2027,
  target_session: 'first',
};

test('practice paper derives year/month from standard and non-prefixed YYMM titles', () => {
  const std = buildNewPaper(shoukao, { document_id: 'hz-2611', title: '物理卷-2611杭州一模' }, 18, 18);
  assert.equal(std.exam_kind, 'practice');
  assert.equal(std.exam_year, 2026);
  assert.equal(std.exam_month, 11);
  assert.equal(std.target_year, 2027);

  const custom = buildNewPaper(shoukao, { document_id: 'jiyang-2612', title: '2612稽阳联考物理试题卷' }, 18, 18);
  assert.equal(custom.exam_year, 2026);
  assert.equal(custom.exam_month, 12);
  assert.equal(custom.date_basis, 'source_title_yymm');
});

test('official exam merges into target preparation collection and never silently defaults to practice', () => {
  assert.throws(
    () => buildNewPaper(shoukao, { document_id: 'zj-202601', title: '2026年1月浙江物理选考真题' }, 18, 18, {}),
    /looks like an official exam/
  );
  assert.throws(
    () => buildNewPaper(shoukao, { document_id: 'zj-202601', title: '2026年1月浙江物理选考真题' }, 18, 18, {
      'zj-27-shoukao--zj-202601': { exam_kind: 'official', exam_year: 2026, exam_month: 1, date_basis: 'source_paper_header' },
    }),
    /requires explicit official_session/
  );
  const official = buildNewPaper(shoukao, { document_id: 'zj-202601', title: '2026年1月浙江物理选考真题' }, 18, 18, {
    'zj-27-shoukao--zj-202601': {
      exam_kind: 'official',
      official_session: 'first',
      exam_year: 2026,
      exam_month: 1,
      date_basis: 'source_paper_header',
    },
  });
  assert.equal(official.collection_id, 'zj-27-shoukao');
  assert.equal(official.target_year, 2027);
  assert.equal(official.exam_kind, 'official');
  assert.equal(official.official_session, 'first');
  assert.equal(official.exam_year, 2026);
  assert.equal(official.exam_month, 1);
  assert.equal(official.metadata_review_status, 'official_source_verified');
});

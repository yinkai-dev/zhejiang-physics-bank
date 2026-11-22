import assert from 'node:assert/strict';

const LIKELY_OFFICIAL_TITLE = /真题|普通高校招生选考|选考科目考试/;

// Only collections explicitly registered before their first release may lack a pointer.
export function awaitingFirstRelease(collection, papers) {
  if (collection.pending_first_release !== true) return false;
  assert(collection.paper_count === 0 && collection.question_count === 0 &&
    !papers.some(paper => paper.collection_id === collection.collection_id),
    `Pending first release has catalogued papers: ${collection.collection_id}`);
  return true;
}

export function buildNewPaper(collection, doc, questionCount, sourceAnswers, paperMeta = {}) {
  const paperId = `${collection.collection_id}--${doc.document_id}`;
  const override = paperMeta[paperId] || paperMeta[doc.document_id] || {};
  const isOfficialCollection = collection.target_year === null;
  const kind = override.exam_kind || (isOfficialCollection ? 'official' : 'practice');
  assert(['practice', 'official'].includes(kind), `Invalid exam_kind "${kind}" for ${paperId}`);
  assert(!isOfficialCollection || kind === 'official', `Official collection "${collection.collection_id}" only accepts official papers: ${paperId}`);

  if (!override.exam_kind && !isOfficialCollection && LIKELY_OFFICIAL_TITLE.test(doc.title)) {
    assert.fail(
      `Title "${doc.title}" looks like an official exam, which must not silently default to practice. ` +
      `Provide --paper-meta with {"${paperId}":{"exam_kind":"official","official_session":"first|second","exam_year":…,"exam_month":…,"date_basis":"…"}}`
    );
  }

  let derived = null;
  if (kind === 'official') {
    assert(
      ['first', 'second'].includes(override.official_session),
      `Official paper "${paperId}" requires explicit official_session ("first" or "second") in --paper-meta`
    );
    assert(
      typeof override.exam_year === 'number' && typeof override.exam_month === 'number' && override.date_basis,
      `Official paper "${paperId}" requires explicit exam_year, exam_month and date_basis verified from the source paper`
    );
  } else {
    const m = /^(?:物理卷-)?(\d{2})(0[1-9]|1[0-2])(?!\d)/.exec(doc.title)
      || /(?<!\d)(2[4-9])(0[1-9]|1[0-2])(?!\d)/.exec(doc.title);
    derived = m
      ? { exam_year: 2000 + Number(m[1]), exam_month: Number(m[2]), date_basis: 'source_title_yymm' }
      : null;
    assert(
      derived || ('exam_year' in override && 'exam_month' in override && override.date_basis),
      `Cannot derive exam year/month from title "${doc.title}". Provide --paper-meta with {"${paperId}":{"exam_year":…,"exam_month":…,"date_basis":"…"}}`
    );
  }

  return {
    paper_id: paperId,
    collection_id: collection.collection_id,
    source_document_id: doc.document_id,
    title: doc.title,
    target_year: collection.target_year ?? null,
    target_session: collection.target_session ?? null,
    exam_year: null,
    exam_month: null,
    exam_date: null,
    date_basis: null,
    exam_kind: kind,
    official_session: null,
    original_classification: collection.label,
    question_count: questionCount,
    source_answer_count: sourceAnswers,
    metadata_review_status: kind === 'official' ? 'official_source_verified' : 'classification_preserved_date_inferred',
    ...derived,
    ...override,
  };
}

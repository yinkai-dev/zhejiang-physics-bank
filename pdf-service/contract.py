"""Only public, fingerprint-bound question references cross the HTTP boundary."""
import hashlib
import json
from pathlib import Path

ALLOWED_BANKS = frozenset({'zj-25-erkao', 'zj-26-erkao', 'zj-27-shoukao'})
MAX_QUESTIONS = 50


class RequestError(ValueError):
    pass


class PublicCatalog:
    def __init__(self, directory):
        root = Path(directory)
        self.catalog = json.loads((root / 'catalog.json').read_text(encoding='utf8'))
        self.index = json.loads((root / 'questions-index.json').read_text(encoding='utf8'))
        if self.catalog['version'] != self.index['version']:
            raise ValueError('Public catalog/index mismatch')
        self.papers = {p['paper_id']: p for p in self.catalog['papers']}
        self.questions = {q['id']: q for q in self.index['questions']}
        self.releases = self.catalog['source_releases']
        if set(self.releases) != ALLOWED_BANKS or len(self.questions) != 666:
            raise ValueError('Unexpected public scope')

    def request(self, value):
        if not isinstance(value, dict) or set(value) != {'title', 'answers', 'items'}:
            raise RequestError('仅接受标题、答案开关和已选题目引用。')
        title = value['title']
        if not isinstance(title, str) or not 1 <= len(title.strip()) <= 60 or any(ord(c) < 32 or c in '/\\' for c in title):
            raise RequestError('标题需为1–60字，不能含换行或斜杠。')
        if type(value['answers']) is not bool:
            raise RequestError('答案开关无效。')
        items = value['items']
        if not isinstance(items, list) or not 1 <= len(items) <= MAX_QUESTIONS:
            raise RequestError(f'每次请选择1–{MAX_QUESTIONS}题；题量较多时请分批导出。')
        rows, seen = [], set()
        for item in items:
            if not isinstance(item, dict) or set(item) != {'id', 'fingerprint'} or not isinstance(item.get('id'), str):
                raise RequestError('题目引用无效。')
            q = self.questions.get(item['id'])
            if not q or q['id'] in seen:
                raise RequestError('题目不存在或重复，请重新选题。')
            if item['fingerprint'] != q['fingerprint']:
                raise RequestError('题目来源版本已变化，请刷新并核对清单。')
            p = self.papers[q['paper_id']]
            if p['collection_id'] not in ALLOWED_BANKS:
                raise RequestError('题目不在公开范围内。')
            rows.append({'ref':p['collection_id']+'/'+q['source_question_id'], 'fingerprint':q['fingerprint']})
            seen.add(q['id'])
        return {'title':title.strip(), 'answers':value['answers'], 'items':rows, 'releases':self.releases,
                'public_version':self.catalog['version'], 'layout_version':'xelatex-v0.1.2'}


def request_hash(request):
    return hashlib.sha256(json.dumps(request, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()

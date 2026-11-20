import copy
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest

from starlette.testclient import TestClient
from app import create_app
from compile_job import _raise_package_capacity as raise_compile_capacity, sanitize_math_for_xelatex, sanitize_spec_for_xelatex
from contract import PublicCatalog, RequestError
from deploy_remote import _raise_package_capacity as raise_deploy_capacity

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT/'public'/'data'
ORIGIN = {'Origin':'https://yinkai-dev.github.io'}


class ServiceTests(unittest.TestCase):
    def setUp(self):
        (ROOT/'.local').mkdir(exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(dir=ROOT/'.local',prefix='pdf-test-')
        self.assertTrue(Path(self.temp.name).resolve().is_relative_to((ROOT/'.local').resolve()))
        self.app = create_app(DATA,self.temp.name,ROOT/'.local'/'banks',run_worker=False)
        self.client = TestClient(self.app)
        self.catalog = PublicCatalog(DATA)
        self.public_banks = [c['collection_id'] for c in self.catalog.catalog['collections']]
        ids = [next(q['id'] for q in self.catalog.questions.values() if self.catalog.papers[q['paper_id']]['collection_id'] == c)
               for c in self.public_banks]
        self.body = {'title':'跨库专项练习','answers':True,'items':[
            {'id':id,'fingerprint':self.catalog.questions[id]['fingerprint']} for id in ids]}

    def tearDown(self):
        self.client.close()
        self.temp.cleanup()

    def post(self, body):
        return self.client.post('/bank-pdf/jobs',json=body,headers=ORIGIN)

    def test_public_scope_order_and_fingerprints(self):
        r = self.post(self.body)
        self.assertEqual(r.status_code,202)
        job = r.json()
        self.assertEqual(job['status'],'queued')
        saved = json.loads((Path(self.temp.name)/job['job_id']/'request.json').read_text(encoding='utf8'))
        self.assertEqual([x['ref'].split('/')[0] for x in saved['items']], self.public_banks)
        self.assertEqual(self.post(self.body).json()['job_id'],job['job_id'])
        self.assertNotIn('releases',job)

    def test_rejects_text_injection_other_banks_duplicates_and_drift(self):
        for change in ['body','other-bank','duplicate','fingerprint','unknown-field','too-many','title']:
            body = copy.deepcopy(self.body)
            if change=='body':body['items'][0]['body']=[{'type':'text','value':'injected'}]
            elif change=='other-bank':body['items'][0]['id']='qiangji--private'
            elif change=='duplicate':body['items'].append(body['items'][0])
            elif change=='fingerprint':body['items'][0]['fingerprint']='old'
            elif change=='unknown-field':body['compiler']='arbitrary'
            elif change=='too-many':body['items']*=18
            else:body['title']='bad\ntitle'
            self.assertEqual(self.post(body).status_code,400,change)

    def test_origin_body_limit_and_unknown_jobs(self):
        self.assertEqual(self.client.post('/bank-pdf/jobs',json=self.body).status_code,403)
        self.assertEqual(self.client.post('/bank-pdf/jobs',json=self.body,headers={'Origin':'https://example.com'}).status_code,403)
        self.assertEqual(self.client.post('/bank-pdf/jobs',content=b'x'*40000,headers={**ORIGIN,'Content-Type':'application/json'}).status_code,413)
        self.assertEqual(self.client.get('/bank-pdf/jobs/invalid').status_code,404)
        self.assertEqual(self.client.get('/bank-pdf/files/'+'a'*32+'/source').status_code,404)
        preflight=self.client.options('/bank-pdf/jobs',headers={**ORIGIN,'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type'})
        self.assertEqual(preflight.headers['access-control-allow-origin'],ORIGIN['Origin'])

    def test_health_reports_data_size_from_catalog(self):
        health = self.client.get('/bank-pdf/healthz').json()
        catalog = json.loads((DATA/'catalog.json').read_text(encoding='utf8'))
        self.assertEqual(health['public_version'],catalog['version'])
        self.assertEqual(health['papers'],len(catalog['papers']))
        self.assertEqual(health['questions'],sum(p['question_count'] for p in catalog['papers']))
        self.assertTrue(health['bundle'])

    def test_rejects_inconsistent_or_out_of_scope_catalog(self):
        catalog = json.loads((DATA/'catalog.json').read_text(encoding='utf8'))
        index = json.loads((DATA/'questions-index.json').read_text(encoding='utf8'))
        def load(catalog_value,index_value):
            with tempfile.TemporaryDirectory(dir=ROOT/'.local',prefix='pdf-test-') as d:
                (Path(d)/'catalog.json').write_text(json.dumps(catalog_value),encoding='utf8')
                (Path(d)/'questions-index.json').write_text(json.dumps(index_value),encoding='utf8')
                return PublicCatalog(d)
        self.assertEqual(len(load(catalog,index).questions),len(index['questions']))
        dropped = copy.deepcopy(index);dropped['questions'].pop()
        duplicated = copy.deepcopy(index);duplicated['questions'][-1] = duplicated['questions'][0]
        orphan = copy.deepcopy(index);orphan['questions'][0]['paper_id'] = 'zj-27-shoukao--unknown'
        other = copy.deepcopy(catalog);other['source_releases']['qiangji'] = {'release_id':'rel-0','release_sums_sha256':'0'*64}
        private = copy.deepcopy(other)
        private['collections'].append({'collection_id':'qiangji'})
        private['papers'][0]['collection_id'] = 'qiangji'
        stale = copy.deepcopy(index);stale['version'] = 'old'
        for name,(c,i) in {'dropped':(catalog,dropped),'duplicated':(catalog,duplicated),'orphan':(catalog,orphan),
                           'other-bank':(other,index),'private-bank':(private,index),'version':(catalog,stale)}.items():
            with self.assertRaises(ValueError,msg=name):load(c,i)

    def test_queue_bound_and_expiration(self):
        ids=[]
        for i in range(4):
            body=copy.deepcopy(self.body);body['title']=str(i)
            ids.append(self.post(body).json()['job_id'])
        body=copy.deepcopy(self.body);body['title']='overflow'
        self.assertEqual(self.post(body).status_code,429)
        with self.app.state.store.connect() as db:
            db.execute("UPDATE jobs SET status='failed',created=?",(time.time()-90000,))
        self.app.state.store.cleanup(time.time())
        for id in ids:self.assertFalse((Path(self.temp.name)/id).exists())

    def test_pdf_only_download_checks_hash_and_expiry(self):
        id=self.post(self.body).json()['job_id']
        data=b'%PDF-1.4 test fixture'
        directory=Path(self.temp.name)/id
        (directory/'worksheet.pdf').write_bytes(data)
        result={'files':[{'kind':'worksheet','sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data),'pages':1}],
                'question_count':3,'answers':{'requested':True,'with_source_answer':2,'missing':0,'banks_without_package':['zj-25-erkao']}}
        with self.app.state.store.connect() as db:
            db.execute("UPDATE jobs SET status='succeeded',result=? WHERE id=?",(json.dumps(result),id))
        response=self.client.get('/bank-pdf/jobs/'+id)
        self.assertEqual(response.json()['files'][0]['url'],f'/bank-pdf/files/{id}/worksheet')
        download=self.client.get(f'/bank-pdf/files/{id}/worksheet')
        self.assertEqual(download.content,data)
        self.assertEqual(download.headers['content-type'],'application/pdf')
        self.assertEqual(self.client.get(f'/bank-pdf/files/{id}/answers').status_code,404)
        (directory/'worksheet.pdf').write_bytes(b'corrupted')
        self.assertEqual(self.client.get(f'/bank-pdf/files/{id}/worksheet').status_code,404)

    def test_sanitize_math_for_xelatex(self):
        cases = [
            (r"v_{皮}=\frac{mg\sin\theta}{6k}", r"v_{\text{皮}}=\frac{mg\sin\theta}{6k}"),
            (r"v_{\text{皮}}", r"v_{\text{皮}}"),
            (r"v_皮", r"v_{\text{皮}}"),
            (r"\mathrm{综上可得:} v _ {\mathrm{皮I}}", r"\mathrm{\text{综上可得}:} v _ {\mathrm{\text{皮}I}}"),
            (r"\mathrm{W = Q + \Delta E_k}", r"\mathrm{W = Q + }\Delta\mathrm{ E_k}"),
            (r"\mathrm{W = Q + \Delta_1 E_k}", r"\mathrm{W = Q + \Delta_1 E_k}"),
            (r"F_{\mathrm{\text{合}}}", r"F_{\mathrm{\text{合}}}"),
            (r"\mathrm { V } , 6 \mathrm { W } ^ { ' ' } .", r"\mathrm{ V } , 6 \mathrm{ W } '' ."),
            (r"t_{1}^{'}+t_{2}^{'}", r"t_{1}^{'}+t_{2}^{'}"),
        ]
        for raw, expected in cases:
            with self.subTest(raw=raw):
                once = sanitize_math_for_xelatex(raw)
                self.assertEqual(once, expected)
                self.assertEqual(sanitize_math_for_xelatex(once), expected)
        spec = {'questions': [{'body': [{'type': 'math', 'value': 'v_{皮}'}],
                               'choices': [[{'type': 'math', 'value': r"6\mathrm{W}^{''}"}]],
                               'answer': {'body': [{'type': 'math', 'value': r'\mathrm{W+\Delta E}'}]}}]}
        sanitize_spec_for_xelatex(spec)
        self.assertEqual(spec['questions'][0]['body'][0]['value'], r'v_{\text{皮}}')
        self.assertEqual(spec['questions'][0]['choices'][0][0]['value'], r"6\mathrm{W}''")
        self.assertEqual(spec['questions'][0]['answer']['body'][0]['value'], r'\mathrm{W+}\Delta\mathrm{ E}')

    def test_raise_package_capacity_preserves_image_bounds(self):
        class DummyPackage:
            MAX_PACKAGE_BYTES = 64 * 1024 * 1024
            MAX_FILE_BYTES = 10 * 1024 * 1024
            MAX_IMAGE_BYTES = 8 * 1024 * 1024
            MAX_RECORDS = 5000

        for fn in (raise_compile_capacity, raise_deploy_capacity):
            dummy = DummyPackage()
            fn(dummy)
            self.assertEqual(dummy.MAX_PACKAGE_BYTES, 256 * 1024 * 1024)
            self.assertEqual(dummy.MAX_FILE_BYTES, 32 * 1024 * 1024)
            self.assertEqual(dummy.MAX_IMAGE_BYTES, 8 * 1024 * 1024)
            self.assertEqual(dummy.MAX_RECORDS, 20_000)


if __name__=='__main__':unittest.main()

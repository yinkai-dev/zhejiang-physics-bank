import copy
import hashlib
import json
from pathlib import Path
import tempfile
import time
import unittest

from starlette.testclient import TestClient
from app import create_app
from contract import PublicCatalog, RequestError

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
        ids = [next(q['id'] for q in self.catalog.questions.values() if q['id'].startswith(c))
               for c in ['zj-25-erkao','zj-26-erkao','zj-27-shoukao']]
        self.body = {'title':'三库专项练习','answers':True,'items':[
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
        self.assertEqual([x['ref'].split('/')[0] for x in saved['items']],['zj-25-erkao','zj-26-erkao','zj-27-shoukao'])
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
        stale = copy.deepcopy(index);stale['version'] = 'old'
        for name,(c,i) in {'dropped':(catalog,dropped),'duplicated':(catalog,duplicated),'orphan':(catalog,orphan),
                           'other-bank':(other,index),'version':(catalog,stale)}.items():
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


if __name__=='__main__':unittest.main()

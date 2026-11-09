"""Small public PDF boundary with independent jobs, process and storage."""
import asyncio
from contextlib import asynccontextmanager, contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sqlite3
import subprocess
import sys
import threading
import time

from starlette.applications import Starlette
from starlette.middleware.cors import CORSMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse, FileResponse
from starlette.routing import Route
from contract import PublicCatalog, RequestError, request_hash

TTL = 86400
JOB_ID = re.compile(r'^[a-f0-9]{32}$')


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript('''PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, hash TEXT, ip TEXT, status TEXT,
              created REAL, updated REAL, result TEXT);
            CREATE INDEX IF NOT EXISTS job_request_hash ON jobs(hash,created);
            ''')
            db.execute("UPDATE jobs SET status='failed',updated=? WHERE status='running'", (time.time(),))

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.root/'jobs.sqlite3', timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def get(self, id):
        if not JOB_ID.fullmatch(id):
            return None
        with self.connect() as db:
            row = db.execute('SELECT * FROM jobs WHERE id=? AND created>?', (id,time.time()-TTL)).fetchone()
            return dict(row) if row else None

    def submit(self, request, ip):
        now, digest = time.time(), request_hash(request)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            cached = db.execute("SELECT id FROM jobs WHERE hash=? AND created>? AND status IN ('queued','running','succeeded') ORDER BY created DESC LIMIT 1", (digest,now-TTL)).fetchone()
            if cached:
                return cached['id']
            if db.execute("SELECT COUNT(*) FROM jobs WHERE status IN ('queued','running')").fetchone()[0] >= 4:
                raise RequestError('当前生成任务较多，请稍后重试。')
            if db.execute('SELECT COUNT(*) FROM jobs WHERE ip=? AND created>?', (ip,now-600)).fetchone()[0] >= 6:
                raise RequestError('请求较频繁，请稍后再试。')
            if db.execute('SELECT COUNT(*) FROM jobs WHERE ip=? AND created>?', (ip,now-TTL)).fetchone()[0] >= 30:
                raise RequestError('今日生成次数已达上限，请明日再试。')
            id = secrets.token_hex(16)
            job = self.root/id
            job.mkdir(mode=0o700)
            (job/'request.json').write_text(json.dumps(request,ensure_ascii=False), encoding='utf8')
            db.execute('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)', (id,digest,ip,'queued',now,now,None))
            return id

    def worker(self, stop, banks):
        last_cleanup = 0
        while not stop.wait(.5):
            now = time.time()
            if now-last_cleanup > 3600:
                self.cleanup(now)
                last_cleanup = now
            with self.connect() as db:
                db.execute('BEGIN IMMEDIATE')
                row = db.execute("SELECT id FROM jobs WHERE status='queued' ORDER BY created LIMIT 1").fetchone()
                if not row:
                    continue
                id = row['id']
                db.execute("UPDATE jobs SET status='running',updated=? WHERE id=?", (time.time(),id))
            directory = self.root/id
            status, result = 'failed', None
            env = {k:v for k,v in os.environ.items() if k in {'PATH','SystemRoot','WINDIR','LD_LIBRARY_PATH'}}
            env.update({'LANG':'C.UTF-8','LC_ALL':'C.UTF-8','OPENBLAS_NUM_THREADS':'1','OMP_NUM_THREADS':'1','PHYSICS_MANAGED_JOB':'1'})
            try:
                with (directory/'process.log').open('wb') as log:
                    process = subprocess.Popen([sys.executable,'-I',str(Path(__file__).with_name('compile_job.py')),
                        '--job',str(directory),'--banks',str(banks)], stdout=log, stderr=subprocess.STDOUT,
                        env=env, start_new_session=os.name=='posix')
                    try:
                        code = process.wait(timeout=180)
                    except subprocess.TimeoutExpired:
                        if os.name == 'posix': os.killpg(process.pid,signal.SIGKILL)
                        else: process.kill()
                        process.wait()
                        code = 1
                if code == 0:
                    result = json.loads((directory/'result.json').read_text(encoding='utf8'))
                    status = 'succeeded'
            except Exception as exc:
                (directory/'worker-failure.txt').write_text(type(exc).__name__, encoding='utf8')
            with self.connect() as db:
                db.execute('UPDATE jobs SET status=?,result=?,updated=? WHERE id=?',
                    (status,json.dumps(result,ensure_ascii=False) if result else None,time.time(),id))

    def cleanup(self, now):
        import shutil
        with self.connect() as db:
            expired = db.execute("SELECT id FROM jobs WHERE created<? AND status NOT IN ('queued','running')",(now-TTL,)).fetchall()
            for row in expired:
                # IDs come only from the database, but still verify the deletion target.
                if JOB_ID.fullmatch(row['id']):
                    target = (self.root/row['id']).resolve()
                    if target.parent == self.root.resolve(): shutil.rmtree(target,ignore_errors=True)
            db.execute("DELETE FROM jobs WHERE created<? AND status NOT IN ('queued','running')",(now-TTL,))


def create_app(data_dir=None, state_dir=None, banks_dir=None, run_worker=True):
    public = PublicCatalog(data_dir or os.environ['ZJPDF_DATA'])
    store = Store(state_dir or os.environ['ZJPDF_STATE'])
    banks = Path(banks_dir or os.environ.get('ZJPDF_BANKS','/srv/pwmcp/banks'))
    stopped = threading.Event()
    origins = os.environ.get('ZJPDF_ORIGINS','https://yinkai-dev.github.io').split(',')
    salt = os.environ.get('ZJPDF_IP_SALT') or secrets.token_hex(32)

    @asynccontextmanager
    async def lifespan(app):
        worker = None
        if run_worker:
            worker = threading.Thread(target=store.worker,args=(stopped,banks),daemon=True)
            worker.start()
        yield
        stopped.set()

    def public_job(row):
        result = {'job_id':row['id'], 'status':row['status'], 'expires_at':int(row['created']+TTL)}
        if row['status']=='succeeded' and row['result']:
            value = json.loads(row['result'])
            result.update(value)
            result['files'] = [{**f,'url':f"/bank-pdf/files/{row['id']}/{f['kind']}"} for f in value['files']]
        elif row['status']=='failed':
            result['message']='LaTeX 排版生成失败，请减少题量重试，或携任务编号反馈。'
        return result

    async def health(request):
        return JSONResponse({'status':'ok','renderer':'XeLaTeX','max_questions':50,'retention_hours':24,'public_version':public.catalog['version']})

    async def submit(request:Request):
        # Caddy overwrites the real client IP; Uvicorn listens on loopback only.
        if request.headers.get('origin') not in origins:
            return JSONResponse({'message':'请从题库网站发起生成。'},status_code=403)
        if request.headers.get('content-type','').split(';')[0] != 'application/json':
            return JSONResponse({'message':'请求格式无效。'},status_code=415)
        data = bytearray()
        async for chunk in request.stream():
            data.extend(chunk)
            if len(data)>32768:return JSONResponse({'message':'请求内容过大。'},status_code=413)
        try:
            value = public.request(json.loads(data))
            addr = request.headers.get('x-real-ip') or (request.client.host if request.client else 'unknown')
            ip = hashlib.sha256((salt+time.strftime('%Y-%m-%d',time.gmtime())+addr).encode()).hexdigest()
            id = store.submit(value,ip)
        except (ValueError,TypeError) as exc:
            message = str(exc) if isinstance(exc,RequestError) else '请求格式无效。'
            status = 429 if '稍后' in message or '上限' in message else 400
            return JSONResponse({'message':message},status_code=status)
        return JSONResponse(public_job(store.get(id)),status_code=202)

    async def job(request):
        row = store.get(request.path_params['id'])
        return JSONResponse(public_job(row)) if row else JSONResponse({'message':'任务不存在或已过期，请重新生成。'},status_code=404)

    async def download(request):
        id,kind = request.path_params['id'],request.path_params['kind']
        row = store.get(id)
        if not row or row['status']!='succeeded' or kind not in {'worksheet','answers'}:
            return JSONResponse({'message':'文件不存在或已过期。'},status_code=404)
        result = json.loads(row['result'])
        record = next((f for f in result['files'] if f['kind']==kind),None)
        path = store.root/id/(kind+'.pdf')
        if not record or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=record['sha256']:
            return JSONResponse({'message':'文件暂不可用，请重新生成。'},status_code=404)
        return FileResponse(path,media_type='application/pdf',filename='physics-'+kind+'.pdf',headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'})

    app = Starlette(routes=[Route('/bank-pdf/healthz',health),Route('/bank-pdf/jobs',submit,methods=['POST']),
        Route('/bank-pdf/jobs/{id}',job),Route('/bank-pdf/files/{id}/{kind}',download)],lifespan=lifespan)
    app.add_middleware(CORSMiddleware,allow_origins=origins,allow_methods=['GET','POST'],allow_headers=['Content-Type'])
    app.state.store = store
    return app


def application():
    return create_app()

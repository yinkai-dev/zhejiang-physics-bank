import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../scripts/lib/http.mjs';
import { createServer } from 'node:http';
import { once } from 'node:events';

const disconnected = () => new TypeError('fetch failed', { cause: Object.assign(new Error('peer closed'), { code: 'ECONNRESET' }) });
test('publication GET survives a transient connection failure', async () => {
  let calls = 0;
  const notices = [];
  const fetcher = async () => { if (++calls === 1) throw disconnected(); return new Response('{"status":"ok"}'); };
  const r = await request('https://example.invalid/health', {}, { fetcher, sleep: async () => {}, log: s => notices.push(s) });
  assert.equal(calls, 2);
  assert.equal(r.value, '{"status":"ok"}');
  assert.match(notices[0], /GET.*health.*ECONNRESET/);
});

test('persistent disconnect stops after three attempts with endpoint and cause', async () => {
  let calls = 0;
  await assert.rejects(request('https://example.invalid/health?secret=hidden', {}, {
    fetcher: async () => { calls++; throw disconnected(); }, sleep: async () => {},
  }), e => /GET.*health.*第 3 次.*ECONNRESET/.test(e.message) && !e.message.includes('secret'));
  assert.equal(calls, 3);
});

test('POST is retried only with explicit idempotence and an identical body', async () => {
  let calls = 0;
  const bodies = [];
  const fetcher = async (_url, init) => {
    calls++; bodies.push(init.body);
    if (calls % 2) throw disconnected();
    return new Response('{"job_id":"same-job"}');
  };
  const init = { method: 'POST', body: '{"title":"stable","items":[]}' };
  await assert.rejects(request('https://example.invalid/jobs', init, { fetcher }), /ECONNRESET/);
  assert.equal(calls, 1);
  calls = 0; bodies.length = 0;
  await request('https://example.invalid/jobs', init, { fetcher, idempotent: true, sleep: async () => {} });
  assert.equal(calls, 2);
  assert.deepEqual(bodies, [init.body, init.body]);
});

test('schema, certificate and client errors are not retried', async () => {
  for (const error of [new SyntaxError('invalid JSON'), Object.assign(new Error('certificate expired'), { code: 'CERT_HAS_EXPIRED' })]) {
    let calls = 0;
    await assert.rejects(request('https://example.invalid/health', {}, { fetcher: async () => { calls++; throw error; } }));
    assert.equal(calls, 1);
  }
  let calls = 0;
  const r = await request('https://example.invalid/jobs', {}, { fetcher: async () => { calls++; return new Response('bad selection', { status: 400 }); } });
  assert.equal(r.response.status, 400);
  assert.equal(calls, 1);
});

test('temporary gateway errors and truncated downloads retry the complete request', async () => {
  let calls = 0;
  const r = await request('https://example.invalid/worksheet.pdf', {}, {
    fetcher: async () => {
      calls++;
      if (calls === 1) return new Response('restarting', { status: 503 });
      if (calls === 2) return { status: 200, text: async () => { throw disconnected(); } };
      return new Response('%PDF-complete');
    }, sleep: async () => {},
  });
  assert.equal(r.value, '%PDF-complete');
  assert.equal(calls, 3);
});

test('real HTTP connection drop recovers without restarting the service', async t => {
  let calls = 0;
  const server = createServer((req, res) => {
    if (++calls === 1) { req.socket.destroy(); return; }
    res.end('{"status":"ok"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const r = await request(`http://127.0.0.1:${server.address().port}/health`, {}, { sleep: async () => {} });
  assert.equal(r.value, '{"status":"ok"}');
  assert.equal(calls, 2);
});

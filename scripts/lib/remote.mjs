// Transport to the PDF server. Each call is ONE ssh connection (a connection costs many seconds on
// this route): stdin carries the helper script, one JSON argument line and, for uploads, the raw
// chunk bytes. Commands are built only from validated path characters, so nothing needs shell
// quoting. A `local` transport runs the same helper against a directory on this machine, which is
// how installs are rehearsed without a server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { sha } from './common.mjs';

const CHUNK_BYTES = 2 * 1024 * 1024;
const SAFE_PATH = /^\/[A-Za-z0-9._/-]+$/;

// entries: [{path, sha256, bytes, read: () => Buffer}] -> one concatenated, chunked payload.
export function buildBlob(entries) {
  const data = Buffer.concat(entries.map(e => { const b = e.read(); assert(b.length === e.bytes && sha(b) === e.sha256, `Local content changed: ${e.path}`); return b; }));
  const chunks = [];
  for (let offset = 0, i = 0; offset < data.length || i === 0; offset += CHUNK_BYTES, i++) {
    const buf = data.subarray(offset, offset + CHUNK_BYTES);
    chunks.push({ name: `chunk-${String(i).padStart(4, '0')}`, sha256: sha(buf), bytes: buf.length, buf });
  }
  return { id: sha(data).slice(0, 16), bytes: data.length, chunks, entries: entries.map(e => [e.path, e.sha256, e.bytes]) };
}
export const blobSpec = b => ({ id: b.id, chunks: b.chunks.map(c => [c.name, c.sha256, c.bytes]), entries: b.entries });
// Chunks the server does not hold yet, given the `chunks` map returned by a probe.
export const pendingChunks = (blob, staged = {}) => blob.chunks.filter(c => staged[blob.id]?.[c.name] !== c.sha256);
export const fileEntry = (root, relative, sha256, bytes) => ({ path: relative, sha256, bytes, read: () => fs.readFileSync(path.join(root, relative)) });

export class Remote {
  constructor(config, scriptPath) {
    this.config = config;
    this.remote = config.remote;
    this.local = config.transport === 'local';
    this.script = fs.readFileSync(scriptPath);
    if (!this.local) for (const key of ['python', 'banks_root', 'service_root', 'staging']) assert(SAFE_PATH.test(this.remote[key]), `Unsafe remote path: ${key}`);
    this.scriptFile = `${this.remote.staging}/deploy_remote-${sha(this.script).slice(0, 16)}.py`;
    this.connections = 0;
  }

  // Run one process, feeding `parts` to stdin in order and reporting upload progress.
  async exec(program, argv, parts, { timeout, log, env } = {}) {
    const child = spawn(program, argv, { stdio: ['pipe', 'pipe', 'pipe'], env });
    const out = [], err = [];
    child.stdout.on('data', d => out.push(d));
    child.stderr.on('data', d => err.push(d));
    child.stdin.on('error', () => { /* the far side exited early; its RESULT line explains why */ });
    let failure = null;
    const closed = new Promise(resolve => { child.on('error', e => { failure = e; resolve(null); }); child.on('close', resolve); });
    const timer = setTimeout(() => { failure = Error(`timed out after ${Math.round(timeout / 1000)}s`); child.kill(); }, timeout);
    const total = parts.reduce((s, p) => s + p.length, 0);
    let sent = 0, reported = 0;
    try {
      for (const part of parts) for (let o = 0; o < part.length && !child.stdin.destroyed; o += 1 << 20) {
        const piece = part.subarray(o, o + (1 << 20));
        if (!child.stdin.write(piece)) await Promise.race([once(child.stdin, 'drain'), closed]);
        sent += piece.length;
        if (log && total > 4 << 20 && sent - reported >= total / 10) { reported = sent; log(`  已发送 ${(sent / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`); }
      }
      if (!child.stdin.destroyed) child.stdin.end();
    } catch { /* reported through the exit status below */ }
    const status = await closed;
    clearTimeout(timer);
    return { status, failure, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  }

  // stream: chunks ({name, sha256, bytes, buf}) whose bytes follow the argument line.
  async call(action, args = {}, { stream = [], log, timeout = 1800000 } = {}) {
    const line = Buffer.from(JSON.stringify({ action, remote: this.remote, ...args, stream: stream.map(c => [c.name, c.sha256, c.bytes]) }) + '\n');
    const payload = [line, ...stream.map(c => c.buf)];
    let r;
    this.connections++;
    if (this.local) {
      fs.mkdirSync(this.remote.staging, { recursive: true });
      fs.writeFileSync(this.scriptFile, this.script);
      r = await this.exec(this.remote.python, [this.scriptFile], payload, { timeout, log, env: { ...process.env, ...(this.config.local_env || {}) } });
    } else {
      // `dd bs=1` takes exactly the helper's bytes off stdin; the interpreter then reads the rest.
      const command = `mkdir -p ${this.remote.staging} && chmod 700 ${this.remote.staging} && dd bs=1 count=${this.script.length} of=${this.scriptFile} status=none && ${this.remote.python} -I ${this.scriptFile}`;
      assert(/^[A-Za-z0-9._/ &=-]+$/.test(command), `Unsafe remote command: ${command}`);
      r = await this.exec('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', this.config.ssh_host, command], [this.script, ...payload], { timeout, log });
    }
    const found = r.stdout.split(/\r?\n/).reverse().find(l => l.startsWith('RESULT '));
    if (!found) throw Error(`Remote ${action} gave no result (exit ${r.status}): ${(r.failure?.message || r.stderr || r.stdout).trim().slice(-1500)}`);
    const result = JSON.parse(found.slice(7));
    if (!result.ok) throw Object.assign(Error(`Remote ${action} failed: ${result.error}`), { result });
    return result;
  }
}

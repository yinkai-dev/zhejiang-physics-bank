import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sha } from '../scripts/lib/common.mjs';
import { verifySnapshot } from '../scripts/lib/snapshot.mjs';

test('export validates the complete active release, and archive auditing is explicit', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const report = { releases: {}, files: [] };
  for (const id of ['rel-a', 'rel-b']) {
    const dir = 'bank/releases/' + id;
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    const sums = sha(id) + '  paper.txt\n';
    for (const [name, data] of [['paper.txt', id], ['SHA256SUMS', sums]]) {
      const relative = dir + '/' + name;
      fs.writeFileSync(path.join(root, relative), data);
      report.files.push({ path: relative, sha256: sha(data), bytes: Buffer.byteLength(data) });
    }
    report.releases.bank = { release_id: id, release_sums_sha256: sha(sums) };
  }
  const verify = (history = false) => verifySnapshot(root, report.releases, report, history);
  assert.deepEqual(verify(true), { current: 2, archived: 2 });
  fs.writeFileSync(path.join(root, 'bank/releases/rel-a/paper.txt'), 'archived change');
  assert.deepEqual(verify(), { current: 2, archived: 0 });
  assert.throws(() => verify(true), /Archive drift/);
  const manifest = report.files.pop();
  assert.throws(() => verify(), /Import record mismatch/);
  report.files.push(manifest);
  fs.writeFileSync(path.join(root, 'bank/releases/rel-b/paper.txt'), 'active change');
  assert.throws(() => verify(), /Checksum mismatch/);
});

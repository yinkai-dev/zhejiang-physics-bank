import assert from 'node:assert/strict';
import fs from 'node:fs';
import { confined, sha, validPointer, verifyReleaseTree } from './common.mjs';

export function verifySnapshot(root, pointers, report, verifyHistory = false) {
  assert.deepEqual(pointers, report.releases, 'Import report release mismatch');
  const recorded = new Map(report.files.map(row => [row.path, row]));
  assert.equal(recorded.size, report.files.length, 'Duplicate path in import report');
  const current = new Set();
  for (const [bank, pointer] of Object.entries(pointers)) {
    assert(validPointer(pointer), 'Invalid release pointer: ' + bank);
    const directory = bank + '/releases/' + pointer.release_id;
    for (const file of verifyReleaseTree(confined(root, directory), pointer.release_sums_sha256)) {
      const relative = directory + '/' + file.path;
      const record = recorded.get(relative);
      assert(record && record.sha256 === file.sha256 && record.bytes === file.bytes, 'Import record mismatch: ' + relative);
      current.add(relative);
    }
  }
  let archived = 0;
  for (const record of report.files) {
    if (current.has(record.path)) continue;
    const [bank, releases, id] = record.path.split('/');
    assert(releases === 'releases' && id !== pointers[bank]?.release_id, 'Unexpected current release record: ' + record.path);
    if (!verifyHistory) continue;
    const bytes = fs.readFileSync(confined(root, record.path));
    assert(bytes.length === record.bytes && sha(bytes) === record.sha256, 'Archive drift: ' + record.path);
    archived++;
  }
  return { current: current.size, archived };
}

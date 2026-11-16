import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyStatus} from '../scripts/lib/gitstate.mjs';

const DATA=['public/data','public/images','metadata/paper-catalog.json'];
test('first line keeps its leading status space',()=>{
  // An unstaged data change on the very first line must not be mistaken for a code change.
  const s=classifyStatus(' M public/data/catalog.json\n M src/main.ts\n',DATA);
  assert.equal(s.data_changes,1);assert.deepEqual(s.other_changes,['src/main.ts']);
  assert.deepEqual(classifyStatus(' M .github/workflows/pages.yml\n',DATA).other_changes,['.github/workflows/pages.yml']);
});
test('data paths: new images, catalog file, and look-alike prefixes',()=>{
  const s=classifyStatus('?? public/images/abc.png\n M metadata/paper-catalog.json\nA  public/data/papers/x.json\n M public/database.json\n M metadata/paper-catalog.json.bak\n',DATA);
  assert.equal(s.data_changes,3);
  assert.deepEqual(s.other_changes,['public/database.json','metadata/paper-catalog.json.bak']);
});
test('untracked files elsewhere are ignored, staged code is reported',()=>{
  const s=classifyStatus('?? "docs/\\351\\224\\231.md"\n?? scripts/new.mjs\nM  pdf-service/app.py\nR  old.mjs -> scripts/renamed.mjs\n',DATA);
  assert.equal(s.data_changes,0);
  assert.deepEqual(s.other_changes,['pdf-service/app.py','scripts/renamed.mjs']);
  assert.deepEqual(s.staged_other,['pdf-service/app.py','scripts/renamed.mjs']);
});
test('clean tree',()=>{assert.deepEqual(classifyStatus('',DATA),{data_changes:0,other_changes:[],staged_other:[]});});

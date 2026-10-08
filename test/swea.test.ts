import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSweaState } from '../src/swea.js';

test('compact progress retains the last results but cannot establish completion without a fresh collection', () => {
  const complete = { enabled: true, loaded: true, completed: true, paused: false, pauseReason: '', pendingFiles: 0, totalFiles: 2,
    issues: [{ file: '/B.cs', message: 'Dependent error', severity: 'ERROR', startOffset: 1, endOffset: 2 }] };
  const initial = parseSweaState(JSON.stringify(complete));
  const { issues: _issues, ...progress } = { ...complete, completed: false, pendingFiles: 1 };
  const updating = parseSweaState(JSON.stringify(progress), initial);
  assert.equal(updating.completed, false);
  assert.deepEqual(updating.issues, initial.issues);
  assert.throws(() => parseSweaState(JSON.stringify({ ...progress, completed: true }), updating), /must include issues/);
  assert.deepEqual(parseSweaState(JSON.stringify({ ...complete, issues: [] }), updating).issues, []);
});

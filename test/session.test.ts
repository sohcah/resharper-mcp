import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ReSharperSession } from '../src/session.js';

test('LSP waits for registration, didOpen, and settled diagnostics; rereads saved content', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-lsp-'));
  const project = join(root, 'App.csproj'), file = join(root, 'A.cs');
  await writeFile(project, ''); await writeFile(file, 'broken');
  const session = new ReSharperSession(resolve('test/fake-backend.mjs'), project, 8000, root);
  try {
    await session.start();
    const started = Date.now();
    assert.equal((await session.diagnostics(file))[0].message, 'Broken sample');
    assert.ok(Date.now() - started >= 4500, 'Must wait for all progress streams, even after diagnostics arrive');
    await writeFile(file, 'fixed');
    assert.deepEqual(await session.diagnostics(file), []);
    await writeFile(file, 'silent clean');
    assert.deepEqual(await session.diagnostics(file), [], 'Daemon completion without a diagnostic publication establishes a clean file');
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('unfinished background work times out instead of returning an empty report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-lsp-'));
  const project = join(root, 'App.csproj'), file = join(root, 'A.cs');
  await writeFile(project, ''); await writeFile(file, 'stuck');
  const session = new ReSharperSession(resolve('test/fake-backend.mjs'), project, 2500, root);
  try {
    await session.start();
    await assert.rejects(session.diagnostics(file), /ReSharper analysis did not finish/);
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('cached empty diagnostics cannot complete a read before delayed per-file analysis and caches are ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-lsp-'));
  const project = join(root, 'App.csproj'), file = join(root, 'A.cs');
  await writeFile(project, ''); await writeFile(file, 'late broken');
  const session = new ReSharperSession(resolve('test/fake-backend.mjs'), project, 8000, root);
  try {
    await session.start();
    let started = Date.now();
    assert.equal((await session.diagnostics(file))[0].message, 'Broken sample');
    assert.ok(Date.now() - started >= 5500, 'Cached empty reports and global inactivity must not bypass daemon/cache readiness');
    // A genuinely clean file must also finish analysis before returning [].
    await writeFile(file, 'late clean'); started = Date.now();
    assert.deepEqual(await session.diagnostics(file), []);
    assert.ok(Date.now() - started >= 5500);
    // An unchanged open file reuses its current analysis without another didOpen.
    assert.deepEqual(await session.diagnostics(file), []);
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

test('SWEA waits for global completion and watches changed open files between calls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-swea-'));
  const project = join(root, 'App.csproj'), file = join(root, 'A.cs');
  await writeFile(project, ''); await writeFile(file, 'fixed');
  const executable = resolve('test/fake-backend.mjs');
  const progress: string[] = [];
  const session = new ReSharperSession(executable, project, 8000, root, { executable, args: ['--fake-swea'], cwd: root, swea: true }, message => progress.push(message));
  try {
    await session.start();
    const started = Date.now();
    assert.deepEqual(await session.diagnostics(file), []);
    assert.ok(Date.now() - started >= 5000, 'File daemon completion cannot bypass pending SWEA work');
    await writeFile(file, 'broken');
    const deadline = Date.now() + 2000;
    while ((session.status().swea?.completed ?? true) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const state = await session.solutionDiagnostics();
    assert.equal(state.issues[0].message, 'Dependent error', 'Watcher must synchronize the saved edit without another read_lint');
    assert.ok(progress.some(message => message.includes('files pending')));
    assert.ok(progress.includes('Solution-wide analysis complete'));
  } finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectManager, projectPath } from '../src/projects.js';
import { archivePath, platformId, extractZip } from '../src/installer.js';

test('project discovery, ambiguity, and canonical paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-test-'));
  try {
    await writeFile(join(root, 'App.csproj'), '');
    assert.equal(await projectPath(root), await realpath(join(root, 'App.csproj')));
    await writeFile(join(root, 'Other.csproj'), '');
    await assert.rejects(projectPath(root), /2 candidates/);
    await writeFile(join(root, 'App.slnx'), '');
    assert.equal(await projectPath(root), await realpath(join(root, 'App.slnx')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('concurrent loads share one session; busy work prevents idle closing; reads serialize', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-test-'));
  await writeFile(join(root, 'App.csproj'), ''); await writeFile(join(root, 'A.cs'), '');
  let clock = 0, starts = 0, closes = 0, running = 0, maxRunning = 0;
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const manager = new ProjectManager(async () => ({
    async start() { starts++; }, async close() { closes++; },
    async diagnostics() { running++; maxRunning = Math.max(running, maxRunning); await blocked; running--; return []; },
  }), 1000, () => clock);
  try {
    await Promise.all([manager.load(root), manager.load(root)]); assert.equal(starts, 1);
    const reads = [manager.diagnostics(root, 'A.cs'), manager.diagnostics(root, 'A.cs')];
    await new Promise(resolve => setTimeout(resolve, 20));
    clock = 2000; await manager.reap(); assert.equal(closes, 0);
    release(); await Promise.all(reads); assert.equal(maxRunning, 1);
    clock = 2999; await manager.reap(); assert.equal(closes, 0);
    clock = 3000; await manager.reap(); assert.equal(closes, 1);
    await manager.load(root); assert.equal(starts, 2);
    await assert.rejects(manager.diagnostics(root, '../outside.cs'));
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
test('load during close waits and creates a fresh session; failed starts can retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-test-'));
  await writeFile(join(root, 'App.csproj'), '');
  let starts = 0;
  let release!: () => void;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const manager = new ProjectManager(async () => ({
    async start() { starts++; if (starts === 1) throw new Error('failed'); },
    async close() { if (starts === 2) await closing; }, async diagnostics() { return []; },
  }));
  try {
    await assert.rejects(manager.load(root), /failed/);
    await manager.load(root);
    const close = manager.close(root);
    await new Promise(resolve => setTimeout(resolve, 20));
    const load = manager.load(root);
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(starts, 2);
    release(); await close; await load; assert.equal(starts, 3);
  } finally { release(); await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});
test('platform mapping and archive traversal protection', () => {
  assert.equal(platformId('darwin', 'arm64'), 'macos-arm64');
  assert.equal(platformId('win32', 'x64'), 'windows-x64');
  assert.throws(() => platformId('linux', 'ia32'));
  for (const name of ['../escape', '/escape', 'C:/escape', '..\\escape']) assert.throws(() => archivePath('/tmp/root', name));
  assert.equal(archivePath('/tmp/root', 'extension/package.json'), '/tmp/root/extension/package.json');
});
test('ZIP extraction preserves content and executable permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-zip-'));
  try {
    // Minimal ZIP fixture, stored entry with POSIX executable mode.
    const name = Buffer.from('bin/server'); const data = Buffer.from('hello');
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(3 << 8, 4); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + data.length, 16);
    await writeFile(join(root, 'test.zip'), Buffer.concat([local, name, data, central, name, end]));
    await mkdir(join(root, 'out'));
    await extractZip(join(root, 'test.zip'), join(root, 'out'));
    const { readFile, stat } = await import('node:fs/promises');
    assert.equal(await readFile(join(root, 'out/bin/server'), 'utf8'), 'hello');
    if (process.platform !== 'win32') assert.equal((await stat(join(root, 'out/bin/server'))).mode & 0o111, 0o111);
  } finally { await rm(root, { recursive: true, force: true }); }
});

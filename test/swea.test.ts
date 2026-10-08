import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSweaState } from '../src/swea.js';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

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

test('host SDK discovery and compilation ignore the caller repository global.json', { skip: process.platform === 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'resharper-sdk-cwd-'));
  const repository = join(root, 'repository'), backend = join(root, 'backend'), platform = join(backend, 'platform');
  const sdk = join(root, 'sdk'), log = join(root, 'commands.jsonl');
  try {
    await mkdir(repository); await mkdir(join(platform, 'dotnet'), { recursive: true });
    await writeFile(join(repository, 'global.json'), '{"sdk":{"version":"1.0.0"}}');
    await writeFile(join(backend, 'JetBrains.VsCode.Backend.deps.json'), '{}');
    await writeFile(join(backend, 'JetBrains.VsCode.Backend.runtimeconfig.json'), '{}');
    const script = `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === '--list-runtimes') { console.log('Microsoft.NETCore.App 10.0.0 [runtime]'); process.exit(); }
for (let dir = process.cwd(); ; dir = path.dirname(dir)) {
 if (fs.existsSync(path.join(dir, 'global.json'))) { console.error('Requested SDK is not installed'); process.exit(1); }
 if (path.dirname(dir) === dir) break;
}
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args[0] === '--version') console.log('10.0.300');
else if (args[0] === 'build') fs.writeFileSync(path.join(args[args.indexOf('-o') + 1], 'ReSharperMcpHost.dll'), 'host fixture');
else process.exit(1);
`;
    await writeFile(sdk, script); await chmod(sdk, 0o755);
    await writeFile(join(platform, 'dotnet/dotnet'), script); await chmod(join(platform, 'dotnet/dotnet'), 0o755);
    const module = pathToFileURL(resolve('src/swea.ts')).href;
    const loader = pathToFileURL(resolve('node_modules/tsx/dist/loader.mjs')).href;
    await promisify(execFile)(process.execPath, ['--import', loader, '--input-type=module', '-e', `import { prepareBackend } from ${JSON.stringify(module)}; await prepareBackend(${JSON.stringify(join(platform, 'JetBrains.VsCode.Backend'))});`], {
      cwd: repository, env: { ...process.env, RESHARPER_MCP_DOTNET: sdk }, timeout: 30_000,
    });
    const commands = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(commands.length, 2);
    assert.equal(commands[0].args[0], '--version');
    assert.equal(commands[1].args[0], 'build');
    assert.equal(dirname(commands[1].cwd), await realpath(backend));
    assert.equal(await readFile(join(backend, 'ReSharperMcpHost.dll'), 'utf8'), 'host fixture');
  } finally { await rm(root, { recursive: true, force: true }); }
});

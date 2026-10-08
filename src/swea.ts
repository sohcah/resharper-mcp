import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

export interface SweaIssue {
  file: string | null; message: string; severity: string; startOffset: number | null; endOffset: number | null;
}
export interface SweaState {
  enabled: boolean; loaded: boolean; completed: boolean; paused: boolean; pauseReason: string;
  pendingFiles: number; totalFiles: number; issues: SweaIssue[];
}
const sweaStateSchema = z.object({
  enabled: z.boolean(), loaded: z.boolean(), completed: z.boolean(), paused: z.boolean(), pauseReason: z.string(),
  pendingFiles: z.number().int().nonnegative(), totalFiles: z.number().int().nonnegative(),
  issues: z.array(z.object({ file: z.string().nullable(), message: z.string(), severity: z.string(), startOffset: z.number().int().nonnegative().nullable(), endOffset: z.number().int().nonnegative().nullable() })).optional(),
}).refine(state => !state.completed || state.issues !== undefined, 'Completed SWEA snapshots must include issues');
export function parseSweaState(line: string, previous?: SweaState): SweaState {
  const state = sweaStateSchema.parse(JSON.parse(line));
  return { ...state, issues: state.issues ?? previous?.issues ?? [] };
}
export interface BackendLaunch { executable: string; args: string[]; cwd: string }
export type ProgressListener = (message: string) => void;
const run = promisify(execFile);
const preparations = new Map<string, Promise<BackendLaunch>>();

export function prepareBackend(executable: string): Promise<BackendLaunch> {
  let preparation = preparations.get(executable);
  if (!preparation) {
    preparation = buildHost(executable).catch(error => { preparations.delete(executable); throw error; });
    preparations.set(executable, preparation);
  }
  return preparation;
}

async function buildHost(executable: string): Promise<BackendLaunch> {
  const cwd = dirname(executable), root = dirname(cwd);
  const source = fileURLToPath(new URL('../backend-host/', import.meta.url));
  const names = ['ReSharperMcpHost.csproj', 'Program.cs', 'SweaBridge.cs', 'NuGet.Config'];
  const hash = createHash('sha256');
  for (const name of names) hash.update(await readFile(join(source, name)));
  hash.update(await readFile(join(root, 'JetBrains.VsCode.Backend.deps.json')));
  const signature = hash.digest('hex');
  const host = join(root, 'ReSharperMcpHost.dll');
  const marker = join(root, 'resharper-mcp-swea.json');
  const launch = { executable: join(cwd, 'dotnet', process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'), args: [host], cwd };
  await access(launch.executable);
  try { if (await readFile(marker, 'utf8') === signature) { await access(host); return launch; } } catch { /* build on first use or source update */ }
  const dotnet = process.env.RESHARPER_MCP_DOTNET ?? 'dotnet';
  let version: string;
  try { version = (await run(dotnet, ['--version'], { timeout: 30_000 })).stdout.trim(); }
  catch { throw new Error('The managed host needs a .NET SDK (8 or newer) on PATH. Set RESHARPER_MCP_DOTNET to its absolute dotnet path.'); }
  const major = Number(version.split('.')[0]);
  if (!Number.isInteger(major) || major < 8) throw new Error(`The managed host needs .NET SDK 8 or newer; found ${version}`);
  const runtimes = (await run(launch.executable, ['--list-runtimes'], { timeout: 30_000 })).stdout;
  const runtimeMajors = [...runtimes.matchAll(/Microsoft\.NETCore\.App (\d+)\./g)].map(match => Number(match[1]));
  if (!runtimeMajors.length) throw new Error('The downloaded backend contains no usable .NET runtime.');
  const targetMajor = Math.min(major, Math.max(...runtimeMajors));
  const stage = await mkdtemp(join(root, '.mcp-host-'));
  try {
    for (const name of names) await copyFile(join(source, name), join(stage, name));
    const output = join(stage, 'out');
    await mkdir(output);
    console.error('Building standalone ReSharper SWEA host...');
    try {
      await run(dotnet, ['build', join(stage, names[0]), '--nologo', '-v:q', '--configfile', join(stage, 'NuGet.Config'),
        `-p:BackendRoot=${root}`, `-p:TargetFramework=net${targetMajor}.0`, '-o', output], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) { throw new Error(`Cannot build SWEA host for this backend: ${error instanceof Error ? error.message : String(error)}`); }
    // Retain JetBrains' dependency map and runtime policy (including its platform
    // shims), and add our assembly without changing any distributed binary.
    await copyFile(join(output, 'ReSharperMcpHost.dll'), host);
    await copyFile(join(root, 'JetBrains.VsCode.Backend.deps.json'), join(root, 'ReSharperMcpHost.deps.json'));
    await copyFile(join(root, 'JetBrains.VsCode.Backend.runtimeconfig.json'), join(root, 'ReSharperMcpHost.runtimeconfig.json'));
    await writeFile(marker, signature);
    return launch;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

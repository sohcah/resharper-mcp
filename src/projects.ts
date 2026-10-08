import { readdir, realpath, stat, mkdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Diagnostic } from 'vscode-languageserver-protocol';
import { ensureBackend, cacheDirectory } from './installer.js';
import { ReSharperSession, type ProjectSession } from './session.js';
import { prepareBackend, type ProgressListener } from './swea.js';

export async function projectPath(input: string): Promise<string> {
  let path = await realpath(resolve(input));
  if ((await stat(path)).isDirectory()) {
    const files = await readdir(path);
    const solutions = files.filter(file => /\.(sln|slnx|slnf)$/i.test(file));
    const candidates = solutions.length ? solutions : files.filter(file => /\.(csproj|fsproj|vbproj)$/i.test(file));
    if (candidates.length !== 1) throw new Error(`Specify a solution or project file; ${path} contains ${candidates.length} candidates.`);
    path = await realpath(join(path, candidates[0]));
  }
  if (!/\.(sln|slnx|slnf|csproj|fsproj|vbproj)$/i.test(path)) throw new Error('Expected a .sln, .slnx, .slnf, .csproj, .fsproj, or .vbproj file');
  return path;
}
interface Entry { session: Promise<ProjectSession>; instance?: ProjectSession; ready: boolean; tail: Promise<unknown>; active: number; lastUsed: number; closing: boolean; listeners: Set<ProgressListener> }
export class ProjectManager {
  private readonly projects = new Map<string, Entry>();
  private readonly timer: NodeJS.Timeout;
  private stopped = false;
  constructor(
    private readonly factory: (project: string, onProgress: ProgressListener) => Promise<ProjectSession> = async (project, onProgress) => {
      onProgress('Preparing ReSharper backend');
      const executable = await ensureBackend();
      const launch = await prepareBackend(executable);
      const logs = join(cacheDirectory, 'logs', basename(project));
      await mkdir(logs, { recursive: true });
      return new ReSharperSession(launch, project, 1_800_000, logs, onProgress);
    },
    private readonly idleMs = 30 * 60_000,
    private readonly now = Date.now,
  ) {
    this.timer = setInterval(() => { void this.reap().catch(error => console.error('Idle cleanup:', error)); }, Math.min(idleMs, 60_000));
    this.timer.unref();
  }
  private entry(path: string): Entry {
    if (this.stopped) throw new Error('MCP server is shutting down');
    let entry = this.projects.get(path);
    if (!entry) {
      entry = { session: Promise.resolve(undefined as never), ready: false, tail: Promise.resolve(), active: 0, lastUsed: this.now(), closing: false, listeners: new Set() };
      const current = entry;
      this.projects.set(path, current);
      current.session = (async () => {
        const session = await this.factory(path, message => { for (const listener of current.listeners) listener(message); });
        current.instance = session;
        try { await session.start(); current.ready = true; return session; }
        catch (error) { await session.close(); throw error; }
      })().catch(error => { if (this.projects.get(path) === current) this.projects.delete(path); throw error; });
    }
    return entry;
  }
  private async use<T>(path: string, action: (session: ProjectSession) => Promise<T>, onProgress?: ProgressListener): Promise<T> {
    const entry = this.entry(path);
    if (entry.closing) { await entry.tail; return this.use(path, action, onProgress); }
    if (onProgress) entry.listeners.add(onProgress);
    entry.active++;
    const operation = entry.tail.then(async () => {
      const session = await entry.session;
      try { return await action(session); }
      catch (error) {
        entry.closing = true;
        try { await session.close(); }
        finally { if (this.projects.get(path) === entry) this.projects.delete(path); }
        throw error;
      }
    });
    entry.tail = operation.catch(() => {});
    try { return await operation; }
    finally { entry.active--; entry.lastUsed = this.now(); if (onProgress) entry.listeners.delete(onProgress); }
  }
  async load(input: string, onProgress?: ProgressListener) {
    const project = await projectPath(input);
    await this.use(project, async () => {}, onProgress);
    return { project, loaded: true, idleTimeoutMs: this.idleMs };
  }
  async diagnostics(input: string, inputFile: string, onProgress?: ProgressListener): Promise<{ project: string; file: string; diagnostics: Diagnostic[] }> {
    const project = await projectPath(input);
    const file = await realpath(resolve(dirname(project), inputFile));
    const rel = relative(dirname(project), file);
    if (rel === '..' || rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(rel)) throw new Error('File must be inside the project/solution directory');
    return this.use(project, async session => ({ project, file, diagnostics: await session.diagnostics(file) }), onProgress);
  }
  async solutionDiagnostics(input: string, onProgress?: ProgressListener) {
    const project = await projectPath(input);
    return this.use(project, async session => {
      if (!session.solutionDiagnostics) throw new Error('Solution-wide diagnostics are not available for this backend.');
      return { project, ...await session.solutionDiagnostics() };
    }, onProgress);
  }
  async status(input: string) {
    const project = await projectPath(input), entry = this.projects.get(project);
    if (!entry || entry.closing) return { project, loaded: false };
    // Status must be observable while a load/read is waiting in the queue.
    entry.lastUsed = this.now();
    return { project, loaded: entry.ready, loading: !entry.ready, ...(entry.instance?.status?.() as object ?? {}) };
  }
  async close(input: string) {
    return this.closeCanonical(await projectPath(input));
  }
  private async closeCanonical(project: string) {
    const entry = this.projects.get(project);
    if (!entry) return { project, closed: false };
    if (entry.closing) { await entry.tail; return { project, closed: true }; }
    entry.closing = true;
    // Reserve a close operation in the same queue, so loads cannot overlap teardown.
    entry.active++;
    const closing = entry.tail.then(async () => {
      try { await (await entry.session).close(); }
      finally { if (this.projects.get(project) === entry) this.projects.delete(project); }
    });
    entry.tail = closing.catch(() => {});
    try { await closing; return { project, closed: true }; }
    finally { entry.active--; }
  }
  async reap() {
    for (const [project, entry] of this.projects) {
      if (!entry.active && this.now() - entry.lastUsed >= this.idleMs) await this.closeCanonical(project);
    }
  }
  async shutdown() {
    this.stopped = true; clearInterval(this.timer);
    await Promise.allSettled([...this.projects.values()].map(async entry => { await entry.tail; await (await entry.session).close(); }));
    this.projects.clear();
  }
}

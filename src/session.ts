import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { dirname, basename, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter, CancellationTokenSource, type MessageConnection } from 'vscode-jsonrpc/node.js';
import type { Diagnostic, InitializeResult, PublishDiagnosticsParams } from 'vscode-languageserver-protocol';

export function timeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
export interface ProjectSession {
  start(): Promise<void>;
  diagnostics(file: string): Promise<Diagnostic[]>;
  close(): Promise<void>;
}
export class ReSharperSession implements ProjectSession {
  private child?: ChildProcess;
  private socket?: Socket;
  private connection?: MessageConnection;
  private readonly events = new EventEmitter();
  private failure?: Error;
  private readonly reports = new Map<string, PublishDiagnosticsParams>();
  private closed = false;
  private solutionAvailable = false;
  private backgroundTaskCount = 0;
  private cachesReady = false;
  private readonly daemonIdle = new Map<string, boolean>();
  private readonly documents = new Map<string, { text: string; version: number }>();
  private readonly progressIndicators = new Set<string | number>();
  private readonly workDoneTokens = new Set<string | number>();
  private readonly registeredMethods = new Set<string>();
  constructor(private readonly executable: string, readonly project: string, private readonly waitMs = 300_000, private readonly logDirectory = dirname(project)) {}

  private waitFor<T>(event: string): { promise: Promise<T>; dispose: () => void } {
    let listener: (value: T) => void;
    let failure: (error: Error) => void;
    const promise = new Promise<T>((resolve, reject) => {
      listener = resolve; failure = reject;
      this.events.once(event, listener); this.events.once('failure', failure);
      if (this.failure) reject(this.failure);
    });
    return { promise, dispose: () => { this.events.off(event, listener); this.events.off('failure', failure); } };
  }
  private fail(error: Error) {
    this.failure = error; this.events.emit('failure', error);
  }
  private async request<T>(method: string, params?: unknown): Promise<T> {
    if (this.failure) throw this.failure;
    const cancellation = new CancellationTokenSource();
    try { return await timeout(this.connection!.sendRequest<T>(method, params, cancellation.token), this.waitMs, method); }
    finally { cancellation.cancel(); cancellation.dispose(); }
  }
  async start(): Promise<void> {
    const server = createServer();
    const connected = new Promise<Socket>((resolve, reject) => { server.once('connection', resolve); server.once('error', reject); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = (server.address() as { port: number }).port;
    try {
      this.child = spawn(this.executable, [`--socket=${port}`, `--ParentPid=${process.pid}`, '--ClientName=VSCode', '--IsRemDev=false', `--LogFolder=${this.logDirectory}`], { cwd: dirname(this.executable), stdio: ['ignore', 'pipe', 'pipe'] });
      this.child.stdout?.on('data', chunk => process.stderr.write(chunk));
      this.child.stderr?.on('data', chunk => process.stderr.write(chunk));
      const failed = this.waitFor<never>('never');
      this.child.on('error', error => this.fail(error));
      this.child.on('exit', (code, signal) => { if (!this.closed) this.fail(new Error(`ReSharper exited (${signal ?? code}). Check backend logs and licensing.`)); });
      try { this.socket = await timeout(Promise.race([connected, failed.promise]), this.waitMs, 'Backend connection'); }
      finally { failed.dispose(); }
      this.connection = createMessageConnection(new StreamMessageReader(this.socket), new StreamMessageWriter(this.socket));
      this.connection.onClose(() => { if (!this.closed) this.fail(new Error('ReSharper LSP connection closed')); });
      this.connection.onNotification('textDocument/publishDiagnostics', (report: PublishDiagnosticsParams) => {
        if (process.env.RESHARPER_MCP_TRACE === '1') console.error('ReSharper diagnostics:', JSON.stringify(report));
        const document = this.documents.get(report.uri);
        if (!document || (report.version != null && report.version !== document.version)) return;
        this.reports.set(report.uri, report); this.events.emit(report.uri, report);
      });
      this.connection.onNotification('resharper/solution/didOpen', value => this.events.emit('loaded', value));
      this.connection.onNotification('resharper/caches/stateChanged', (params: { isReady: boolean }) => {
        if (process.env.RESHARPER_MCP_TRACE === '1') console.error('ReSharper caches:', JSON.stringify(params));
        this.cachesReady = params.isReady; this.events.emit('activity');
      });
      this.connection.onNotification('resharper/daemon/stateChanged', (params: { uri: string; isIdle: boolean }) => {
        if (process.env.RESHARPER_MCP_TRACE === '1') console.error('ReSharper daemon:', JSON.stringify(params));
        this.daemonIdle.set(params.uri, params.isIdle); this.events.emit(`daemon:${params.uri}`);
      });
      // This snapshot drives the ReSharper status-bar indicator in VS Code.
      this.connection.onNotification('resharper/backgroundTasks/didChangeStatus', (params: { taskProgresses: { title: string; progress: number | null }[] }) => {
        this.backgroundTaskCount = params.taskProgresses.length;
        this.events.emit('activity');
      });
      this.connection.onNotification('resharper/progressIndicator/start', (params: { id: string | number }) => {
        this.progressIndicators.add(params.id); this.events.emit('activity');
      });
      this.connection.onNotification('resharper/progressIndicator/update', () => this.events.emit('activity'));
      // ReSharper sends the ID directly as the stop notification's payload.
      this.connection.onNotification('resharper/progressIndicator/stop', (id: string | number) => {
        this.progressIndicators.delete(id); this.events.emit('activity');
      });
      this.connection.onNotification('$/progress', (params: { token: string | number; value: { kind?: string } }) => {
        if (params.value.kind === 'begin') this.workDoneTokens.add(params.token);
        else if (params.value.kind === 'end') this.workDoneTokens.delete(params.token);
        else if (params.value.kind !== 'report') return; // Ignore partial-result progress.
        this.events.emit('activity');
      });
      this.connection.onNotification('window/logMessage', value => console.error('ReSharper:', value));
      this.connection.onNotification('window/showMessage', value => console.error('ReSharper:', value));
      this.connection.onRequest('window/showMessageRequest', () => null);
      this.connection.onRequest('window/workDoneProgress/create', () => null);
      this.connection.onRequest('client/registerCapability', (params: { registrations: { method: string }[] }) => {
        for (const item of params.registrations) { this.registeredMethods.add(item.method); this.events.emit(item.method, true); }
        return null;
      });
      this.connection.onRequest('client/unregisterCapability', () => null);
      this.connection.onRequest('resharper/capability/register', (params: { registrations: { name: string }[] }) => {
        if (params.registrations.some(item => item.name === 'resharper/solution')) { this.solutionAvailable = true; this.events.emit('solutionAvailable', true); }
        return null;
      });
      this.connection.onRequest('resharper/capability/unregister', () => null);
      this.connection.onRequest('resharper/capability/refresh', () => null);
      const folder = { uri: pathToFileURL(dirname(this.project)).href, name: basename(dirname(this.project)) };
      this.connection.onRequest('workspace/workspaceFolders', () => [folder]);
      this.connection.onRequest('workspace/configuration', (params: { items: unknown[] }) => params.items.map(() => null));
      this.connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'This MCP server only reads diagnostics.' }));
      this.connection.onRequest('window/showDocument', () => ({ success: false }));
      this.connection.listen();
      const initialized = await this.request<InitializeResult>('initialize', {
        processId: process.pid, clientInfo: { name: 'resharper-mcp', version: '0.1.0' }, locale: 'en', rootUri: folder.uri, rootPath: dirname(this.project), workspaceFolders: [folder],
        capabilities: {
          workspace: { workspaceFolders: true, configuration: true },
          window: { workDoneProgress: true },
          general: { positionEncodings: ['utf-16'] },
          textDocument: { synchronization: { dynamicRegistration: true, didSave: true }, publishDiagnostics: { relatedInformation: true, versionSupport: true } },
        },
      });
      if (initialized.capabilities.positionEncoding && initialized.capabilities.positionEncoding !== 'utf-16') throw new Error('Unsupported LSP position encoding');
      await this.connection.sendNotification('initialized', {});
      if (!this.solutionAvailable) {
        const available = this.waitFor('solutionAvailable');
        try { await timeout(available.promise, this.waitMs, 'ReSharper solution capability (check licensing if unavailable)'); } finally { available.dispose(); }
      }
      const loaded = this.waitFor<unknown>('loaded');
      // Install the waiter before sending open: didOpen can arrive before the response.
      try {
        await Promise.all([
          this.request('resharper/solution/open', { solutionOrProjectFileUri: pathToFileURL(this.project).href }),
          timeout(loaded.promise, this.waitMs, 'Project loading'),
        ]);
      } finally { loaded.dispose(); }
      await this.waitUntilIdle();
    } catch (error) { await this.close(); throw error; }
    finally { server.close(); }
  }
  async diagnostics(file: string): Promise<Diagnostic[]> {
    if (this.failure) throw this.failure;
    if (!this.registeredMethods.has('textDocument/didOpen')) {
      const ready = this.waitFor('textDocument/didOpen');
      try { await timeout(ready.promise, this.waitMs, 'Document synchronization registration'); } finally { ready.dispose(); }
    }
    const uri = pathToFileURL(file).href;
    const text = await readFile(file, 'utf8');
    const languageId = ({ '.cs': 'csharp', '.razor': 'aspnetcorerazor', '.cshtml': 'aspnetcorerazor', '.xaml': 'xaml', '.vb': 'vb', '.fs': 'fsharp' } as Record<string, string>)[extname(file).toLowerCase()];
    if (!languageId) throw new Error(`Unsupported source file type: ${extname(file)}`);
    const previous = this.documents.get(uri);
    if (!previous || previous.text !== text) {
      const document = { text, version: (previous?.version ?? 0) + 1 };
      this.documents.set(uri, document);
      this.reports.delete(uri);
      // A fresh analysis-completion event must follow this open/change. Neither
      // cached diagnostics nor a previous daemon's idle state prove completion.
      this.daemonIdle.delete(uri);
      if (previous) {
        await this.connection!.sendNotification('textDocument/didChange', {
          textDocument: { uri, version: document.version }, contentChanges: [{ text }],
        });
      } else {
        await this.connection!.sendNotification('textDocument/didOpen', { textDocument: { uri, languageId, ...document } });
      }
    }
    await this.connection!.sendNotification('resharper/textDocument/didFocus', { textDocument: { uri } });
    await this.waitUntilIdle(uri);
    return this.reports.get(uri)?.diagnostics ?? [];
  }
  private async waitUntilIdle(uri?: string): Promise<void> {
    if (this.failure) throw this.failure;
    return new Promise((resolve, reject) => {
      let quiet: NodeJS.Timeout | undefined;
      const cleanup = () => {
        clearTimeout(quiet); clearTimeout(deadline);
        if (uri) { this.events.off(uri, update); this.events.off(`daemon:${uri}`, update); }
        this.events.off('activity', update); this.events.off('failure', failed);
      };
      const update = () => {
        clearTimeout(quiet);
        if (!this.cachesReady || this.backgroundTaskCount || this.progressIndicators.size || this.workDoneTokens.size) return;
        if (uri && !this.daemonIdle.get(uri)) return;
        // The daemon reports UP_TO_DATE before the diagnostics publisher's
        // 200 ms grouping event finishes. Drain those final notifications.
        quiet = setTimeout(() => { cleanup(); resolve(); }, 2_000);
      };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const deadline = setTimeout(() => failed(new Error('ReSharper analysis did not finish: waiting for caches ready, file daemon idle, and background work to settle. The backend must support resharper/caches/stateChanged and resharper/daemon/stateChanged.')), this.waitMs);
      if (uri) { this.events.on(uri, update); this.events.on(`daemon:${uri}`, update); }
      this.events.on('activity', update); this.events.once('failure', failed); update();
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fail(new Error('Project session closed'));
    if (this.connection) {
      try {
        await timeout(this.connection.sendRequest('resharper/solution/close'), 2_000, 'Close project');
        await timeout(this.connection.sendRequest('shutdown'), 2_000, 'LSP shutdown');
        await this.connection.sendNotification('exit');
      } catch { /* terminate an unresponsive backend below */ }
      this.connection.dispose();
    }
    this.socket?.destroy();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill();
      try { await timeout(exited, 2_000, 'Backend exit'); } catch { child.kill('SIGKILL'); await timeout(exited, 2_000, 'Backend kill').catch(() => {}); }
    }
  }
}

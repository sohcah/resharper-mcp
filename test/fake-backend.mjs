#!/usr/bin/env node
import { connect } from 'node:net';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node.js';
const port = Number(process.argv.find(arg => arg.startsWith('--socket=')).split('=')[1]);
const socket = connect(port, '127.0.0.1');
const rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
const swea = process.argv.includes('--fake-swea');
const sweaState = (overrides = {}) => console.log('RESHARPER_MCP_SWEA:' + JSON.stringify({ enabled: true, loaded: true, completed: true, paused: false, pauseReason: '', pendingFiles: 0, totalFiles: 2, issues: [], ...overrides }));
rpc.onRequest('initialize', () => ({ capabilities: { positionEncoding: 'utf-16' } }));
rpc.onNotification('initialized', () => {
  setTimeout(async () => {
    await rpc.sendRequest('resharper/capability/register', { registrations: [{ name: 'resharper/solution' }] });
  }, 20);
});
rpc.onRequest('resharper/solution/open', async () => {
  await rpc.sendNotification('resharper/solution/didOpen', {});
  await rpc.sendNotification('resharper/caches/stateChanged', { isReady: true });
  if (swea) sweaState();
  setTimeout(() => { void rpc.sendRequest('client/registerCapability', { registrations: [{ method: 'textDocument/didOpen' }, { method: 'textDocument/didChange' }] }); }, 50);
  return null;
});
const analyze = async (textDocument) => {
  if (swea) {
    sweaState({ completed: false, pendingFiles: 2 });
    // Even a premature completed flag must not ignore remaining pending files.
    setTimeout(() => sweaState({ pendingFiles: 1 }), 600);
    setTimeout(() => sweaState({ issues: textDocument.text.includes('broken') ? [{ file: '/B.cs', message: 'Dependent error', severity: 'ERROR', startOffset: 0, endOffset: 1 }] : [] }), 3100);
  }
  const late = textDocument.text.includes('late');
  const stuck = textDocument.text.includes('stuck');
  const busy = !late && (textDocument.text.includes('broken') || stuck);
  await rpc.sendNotification('resharper/daemon/stateChanged', { uri: textDocument.uri, isIdle: false });
  // A cached empty report can arrive long before analysis starts, with no
  // status-bar task reporting that the file is still pending.
  if (late) await rpc.sendNotification('resharper/caches/stateChanged', { isReady: false });
  if (!stuck) {
    setTimeout(() => { void rpc.sendNotification('resharper/daemon/stateChanged', { uri: textDocument.uri, isIdle: true }); }, late ? 3100 : 150);
    if (late) setTimeout(() => { void rpc.sendNotification('resharper/caches/stateChanged', { isReady: true }); }, 3600);
  }
  if (busy) {
    await rpc.sendNotification('resharper/backgroundTasks/didChangeStatus', { taskProgresses: [{ title: 'Analyzing', progress: null }] });
    await rpc.sendNotification('resharper/progressIndicator/start', { id: 'one' });
    await rpc.sendNotification('resharper/progressIndicator/start', { id: 'two' });
    await rpc.sendNotification('$/progress', { token: 42, value: { kind: 'begin', title: 'Indexing' } });
    setTimeout(() => {
      void rpc.sendNotification('resharper/progressIndicator/stop', 'one');
      void rpc.sendNotification('resharper/backgroundTasks/didChangeStatus', { taskProgresses: [] });
    }, 100);
    if (!textDocument.text.includes('stuck')) {
      setTimeout(() => { void rpc.sendNotification('resharper/progressIndicator/stop', 'two'); }, 2300);
      setTimeout(() => { void rpc.sendNotification('$/progress', { token: 42, value: { kind: 'end' } }); }, 2600);
    }
  }
  if (textDocument.text.includes('silent')) return;
  await rpc.sendNotification('textDocument/publishDiagnostics', { uri: textDocument.uri, diagnostics: [] });
  setTimeout(() => {
    void rpc.sendNotification('textDocument/publishDiagnostics', { uri: textDocument.uri, version: null, diagnostics: textDocument.text.includes('broken') ? [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, severity: 1, message: 'Broken sample' }] : [] });
  }, late ? 3400 : 100);
};
rpc.onNotification('textDocument/didOpen', ({ textDocument }) => analyze(textDocument));
rpc.onNotification('textDocument/didChange', ({ textDocument, contentChanges }) => analyze({ ...textDocument, text: contentChanges[0].text }));
rpc.onRequest('resharper/solution/close', () => null);
rpc.onRequest('shutdown', () => null);
rpc.onNotification('exit', () => { rpc.dispose(); socket.destroy(); });
rpc.listen();

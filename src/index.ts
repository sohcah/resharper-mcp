#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ensureBackend } from './installer.js';
import { ProjectManager } from './projects.js';

const projects = new ProjectManager();
const server = new McpServer({ name: 'resharper-mcp', version: '0.1.0' });
const project = z.string().min(1).describe('Absolute path to a solution/project file, or a directory containing exactly one.');
const result = async (operation: () => Promise<unknown>) => {
  try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(), null, 2) }] }; }
  catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
};
server.registerTool('load_project', {
  description: 'Load a ReSharper solution/project and wait until loading finishes. Reuses the live session. Projects close after 30 minutes of inactivity.',
  inputSchema: { project },
}, args => result(() => projects.load(args.project)));
server.registerTool('close_project', {
  description: 'Close a loaded project and terminate its ReSharper backend. An already closed project is a no-op.',
  inputSchema: { project },
}, args => result(() => projects.close(args.project)));
server.registerTool('read_lint', {
  description: 'Read ReSharper diagnostics for a saved source file. Automatically loads the project and waits for diagnostics. Ranges use zero-based lines and UTF-16 character offsets; severity 1=error, 2=warning, 3=information, 4=hint.',
  inputSchema: { project, file: z.string().min(1).describe('Absolute file path, or a path relative to the solution/project directory.') },
  annotations: { readOnlyHint: true, destructiveHint: false },
}, args => result(() => projects.diagnostics(args.project, args.file)));
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await projects.shutdown(); await server.close();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
process.stdin.once('end', () => { void shutdown(); });
// Connect immediately so clients can initialize while the first-boot download runs.
await server.connect(new StdioServerTransport());
void ensureBackend().catch(error => console.error('ReSharper installation failed; tool calls will retry:', error));

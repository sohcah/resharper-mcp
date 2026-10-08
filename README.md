# ReSharper MCP

A stateful TypeScript MCP server that runs the language server used by JetBrains' **C# by ReSharper** extension. It communicates with MCP clients over stdio and with each ReSharper backend over a private localhost TCP connection.

## Install

Prerequisites:

- **Node.js 22 or later** and npm.
- A **.NET SDK** compatible with your projects and the bundled backend (8 or newer; tested with .NET 10), available on `PATH`. It also compiles our managed host on first use. ReSharper supplies its own backend runtime.
- Network access to Open VSX and JetBrains' download CDN for the first installation.
- ReSharper licensing configured through the official extension where required (see below).

Supported backend targets are macOS, Windows, and Linux on x64 or arm64; Linux requires glibc. Real-backend verification has been performed on macOS arm64.

```sh
git clone https://github.com/sohcah/resharper-mcp.git
cd resharper-mcp
npm ci
npm run build
```

This builds `dist/index.js`. Your MCP client launches that entrypoint; you do not need to keep a separate `npm start` process running. For manual stdio use, `npm start` launches the server and waits for MCP requests on stdin.

## Set up in Codex

Add the following to `~/.codex/config.toml`, replacing the checkout path with your own absolute path:

```toml
[mcp_servers.resharper]
command = "node"
args = ["/absolute/path/to/resharper-mcp/dist/index.js"]
startup_timeout_sec = 30
tool_timeout_sec = 1800
```

If Codex cannot find Node, use the absolute path to the Node executable for `command`. Run `node -p 'process.execPath'` in your terminal to find it. Node and your .NET SDK must be accessible in the environment that launches the server; desktop apps may have a different `PATH` from your shell.

The longer tool timeout allows for the first backend download and project loading. MCP startup itself responds while the download runs. Backend operations allow up to 30 minutes for loading and solution-wide analysis.

Restart Codex after changing the configuration. In the Codex CLI, use `/mcp` to confirm that `resharper` is connected. You can also inspect the saved configuration:

```sh
codex mcp get resharper
```

Then ask Codex:

> Use ReSharper to read lint for `/work/MyApp/src/MyApp/Program.cs` in `/work/MyApp/MyApp.slnx`.

`read_lint` loads the project automatically, so you do not need to call `load_project` first. `load_project`, `close_project`, and `get_project_status` manage and inspect the live session. `read_solution_lint` returns solution-wide errors and warnings from the same session.

Codex also supports project-scoped configuration in `.codex/config.toml` for trusted projects. See the [official Codex MCP documentation](https://developers.openai.com/codex/mcp/) for configuration and timeout options.

## Continuous solution-wide analysis (experimental)

**SWEA runs by default**, keeping errors and warnings updated across the solution, including unopened files. It runs independently of Rider or Visual Studio; no opt-in setting is required.

If your desktop app cannot find the .NET SDK, set its absolute path:

```toml
[mcp_servers.resharper.env]
RESHARPER_MCP_DOTNET = "/absolute/path/to/dotnet"
```

A compatible .NET SDK (**8 or newer; tested with .NET 10**) is needed to compile the small managed host on first use; builds are cached and need no additional NuGet downloads. The SDK must provide reference assemblies compatible with the downloaded backend runtime. Keep `backend-host/` beside `dist/` when moving the installation. The backend must be writable so our host can be added alongside its assemblies. JetBrains' existing executables and assemblies are retained unchanged.

The host loads the bundled SWEA engine, enables its live session and warning analysis, and publishes real pending-file counts, pause reasons, completion, and solution issues. Initial analysis is followed by incremental updates. Saved changes under the solution/project directory are watched automatically, including synchronization of documents opened through `read_lint`. Unsaved editor buffers are not synchronized. C# and VB are the SWEA languages documented by JetBrains.

- `read_solution_lint({ project })` loads/reuses the session and waits for SWEA to complete before returning its current solution-wide errors and warnings.
- `get_project_status({ project })` returns immediately with loading state and the latest analysis snapshot. It never starts a project. During SWEA it includes `pendingFiles`, `totalFiles`, `completed`, `paused`, and `issues`.
- While `completed` is false, `issues` retains the last completed snapshot and may be stale. `read_solution_lint` waits for a fresh completed snapshot.
- `load_project` and `read_lint` also wait for SWEA completion. Backend operations allow up to 30 minutes.
- Load/read calls send MCP `notifications/progress` when the caller supplies a progress token. Clients decide how to display them. Progress messages include the backend's loading tasks and SWEA counts; notification numbers are monotonically increasing event counts, not percentages. Between calls, the backend continues analyzing; query `get_project_status` for its latest state.

Solution issues contain `file`, `message`, textual `severity`, and nullable `startOffset`/`endOffset` measured in UTF-16 code units from the start of the file. This is the SWEA errors/warnings collection, not every suggestion and hint from per-file inspection. Use `read_lint` for the full LSP diagnostic list of a file.

The host uses backend component APIs that JetBrains does not document as a standalone VS Code extension contract. It is **experimental**, verified with backend **2026.2.3 on macOS arm64**. A future backend may require host changes; host compilation or missing completion signals produce an error, never a clean result. The server still uses JetBrains' normal host and licensing mechanisms. See [research and verification notes](docs/research/continuous-swea-official-sources.md).

## First boot and backend updates

On first boot, the server fetches the latest `JetBrains.resharper-code` release from Open VSX. The current extension does **not** bundle the LSP executable: it includes a backend archive name, JetBrains CDN location, and platform-specific SHA-256 digest. This server downloads the VSIX, verifies its registry checksum, extracts its manifest/digests, downloads the matching backend, verifies that digest, and extracts the complete backend with executable permissions. The executable needs the accompanying assemblies/runtime, so they are retained together.

Installation is cached in `~/.cache/resharper-mcp/<platform>/`. Later boots reuse that version without network access. To update, stop the server and remove the platform cache directory; the next boot resolves the latest release again. Downloads/extraction use a temporary directory and become visible only after installation completes. Logs go to stderr, leaving stdout exclusively for MCP messages.

This project is an unofficial integration and is not affiliated with JetBrains. ReSharper's license and usage terms apply. Configure licensing through the official ReSharper extension where required. This server does not implement a licensing UI or accept agreements on your behalf. Backend availability depends on its licensing state. The backend uses JetBrains' own persistent settings, outside this server's installation cache.

## Other MCP clients

```json
{
  "mcpServers": {
    "resharper": {
      "command": "node",
      "args": ["/absolute/path/to/resharper-mcp/dist/index.js"]
    }
  }
}
```

Keep the MCP process running to preserve sessions. Each process owns its sessions; restarting it closes them. First-boot installation starts immediately, but MCP initialization is available while installation runs. The first project request waits for the installation.

## Tools

- `load_project({ project })`: load a `.sln`, `.slnx`, `.slnf`, `.csproj`, `.fsproj`, or `.vbproj`; wait for ReSharper's solution capability, `resharper/solution/didOpen` notification, and reported background work to become idle. A directory is accepted when it contains exactly one solution, or (if no solutions) one project. Multiple candidates require an explicit file path.
- `read_lint({ project, file })`: automatically load/reuse the project, open the saved file, focus it for analysis, wait for cache readiness and that file's daemon to finish, then collect the final `textDocument/publishDiagnostics` updates. Documents remain open in the session; subsequent reads synchronize changed saved contents with `textDocument/didChange`. `file` can be absolute or relative to the solution/project directory and must lie inside that directory. Initially accepts `.cs`, `.razor`, `.cshtml`, `.xaml`, `.vb`, and `.fs`; actual language support depends on ReSharper. C# has been verified against the real backend.
- `close_project({ project })`: close the solution and shut down its backend process. Repeated closes are safe.
- `get_project_status({ project })`: inspect an existing session without waiting for loading or analysis; includes live SWEA state when enabled.
- `read_solution_lint({ project })`: read the completed SWEA errors/warnings snapshot. See above for its output format.

Example `read_lint` arguments:

```json
{ "project": "/work/MyApp/MyApp.slnx", "file": "src/MyApp/Program.cs" }
```

Results contain canonical project/file paths and raw LSP diagnostics. Ranges use **zero-based** lines and UTF-16 character offsets. Severities: `1` error, `2` warning, `3` information, `4` hint. An empty list means the backend finished analyzing that file with no diagnostics. Missing analysis-completion signals time out and return a tool error.

Each project gets a separate backend, reused across calls. Concurrent loads share startup; operations on one project are serialized. Projects close after **30 minutes of inactivity**, checked at most once per minute. Queued/running calls prevent idle closure, and inactivity starts when the last call finishes. Different projects can run independently. SIGINT, SIGTERM, and MCP stdin EOF shut down owned sessions; unresponsive backends are forcibly terminated.

## Configuration

- `RESHARPER_MCP_CACHE_DIR`: installation and log directory; default `~/.cache/resharper-mcp`.
- `RESHARPER_MCP_TRACE=1`: log incoming cache, daemon, and diagnostic notifications to stderr for troubleshooting (includes file paths and diagnostic messages).
- `RESHARPER_MCP_BACKEND`: absolute path to an existing platform launcher, such as `backend/macos-arm64/JetBrains.VsCode.Backend`. Skips downloads. Keep its original backend directory structure intact.
- `RESHARPER_MCP_DOTNET`: path to the .NET SDK's `dotnet` executable used to compile the managed host. Defaults to `dotnet` on `PATH`; execution uses the downloaded backend runtime.

## Development

After changing TypeScript code, run `npm run build`, then restart the MCP server in your client so it picks up the rebuilt code. For development without compiling first, use `npm run dev` as a stdio server.

To update an existing checkout:

```sh
git pull --ff-only
npm ci
npm run build
```

Restart the MCP server afterward. Updating this repository does not automatically replace the cached ReSharper backend; see the cache removal instructions above.

## Troubleshooting

- **Server not connected:** confirm `dist/index.js` exists, the absolute path in your client configuration is correct, and Node can be found. Restart the client after configuration changes.
- **First call takes a while:** the first installation downloads and extracts the backend (the macOS arm64 archive verified here was about 237 MB). Keep the tool timeout longer than the default 60 seconds.
- **Ambiguous project directory:** pass an explicit solution or project file when the directory contains multiple candidates.
- **Project loading fails:** check the .NET SDK, project dependencies, licensing, and backend logs under `<cache-directory>/logs/`.
- **SDK discovery:** `RESHARPER_MCP_DOTNET` selects the SDK installation for compiling our managed host. Host SDK discovery and compilation run in the backend cache, independently of the analyzed repository's `global.json`. That repository keeps its own SDK selection for its projects. Restart the MCP connection after updating the server or its configuration.
- **Analysis times out:** the server did not receive cache-ready/file-analysis-complete signals or background work remained active. An excluded or unsupported file may not be analyzed. A timeout is reported as an error, rather than a clean file.
- **Investigating diagnostics:** enable `RESHARPER_MCP_TRACE=1`. In Codex, add this environment table under the server configuration and restart:

  ```toml
  [mcp_servers.resharper.env]
  RESHARPER_MCP_TRACE = "1"
  ```

  Notification traces go to stderr and include source paths and diagnostic messages. Backend logs are also available in the cache directory. Disable tracing after troubleshooting.

## Verification and limits

```sh
npm run check
npm run build
```

Tests cover discovery, shared startup, serialized reads, idle expiration, retry after failed startup, load during close, archive path protection, extraction permissions, and a fake LSP exercising delayed capability registration, diagnostic updates, overlapping progress streams, stuck analysis, and cached empty reports followed by delayed per-file analysis. The LSP test needs permission to listen on localhost.

SWEA tests cover waiting for global completion and pending files, saved-file synchronization between calls, progress callbacks, and status queries during startup. Real-backend verification changed a public property from `int` to `string`, observed the resulting type error in an unopened dependent file, then repaired the property and observed the error clear in the same process. Both unopened and already-opened edited files were exercised through automatic filesystem watching.

Verified on macOS arm64 with Open VSX extension **2026.2.3**: full installation/checksums, project loading, and C# diagnostics. Windows/Linux launchers and other source languages have not been exercised here.

ReSharper's extension-specific protocol is not a documented stable standalone API. The implementation follows the distributed extension's launcher and solution lifecycle. Projects and file analysis have 30-minute timeouts and require SWEA completion. The server requires `resharper/caches/stateChanged` to report caches ready and `resharper/daemon/stateChanged` to report the target file up to date. These signals are provided by the verified 2026.2.3 backend. It also tracks the status-bar notification `resharper/backgroundTasks/didChangeStatus`, ReSharper `progressIndicator` start/stop notifications, and standard LSP work-done progress. Loading waits for ready caches and idle reported work. Diagnostics additionally require the target file's daemon to be idle for the current open/change. A completed clean analysis may publish no report at all. After those conditions are met, **two quiet seconds** drain the backend's delayed diagnostic publisher. Cached or empty reports alone never establish completion. If readiness/completion signals do not arrive, the call returns a timeout error rather than treating the file as clean. Older backends without these notifications are not supported. The server watches saved changes automatically. It does not synchronize unsaved editor buffers or restore/build projects itself.

References: [Open VSX extension](https://open-vsx.org/extension/JetBrains/resharper-code), [JetBrains ReSharper for VS Code](https://www.jetbrains.com/resharper/vscode/), [LSP specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/), [MCP server guide](https://modelcontextprotocol.io/docs/develop/build-server).

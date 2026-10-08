# Continuous solution-wide analysis: official-source boundaries

Research date: 2026-10-08. This note covers public JetBrains documentation, not the locally downloaded backend's implementation.

## What continuous SWEA means

Rider explicitly documents two features: a persistent solution-wide errors/warnings monitor, and inspections that need whole-solution information (for example unused public members). Its initial global calculation can take seconds to minutes; subsequent changes trigger necessary incremental analysis. The status bar reports analysis progress. Only C# and VB are supported, and projects outside the active build configuration are excluded. This describes the desired long-lived service behavior, rather than repeatedly running a batch inspector. [Rider solution-wide analysis](https://www.jetbrains.com/help/rider/Code_Analysis__Solution-Wide_Analysis.html)

ReSharper for Visual Studio also documents persistent monitoring and incremental updates after initial analysis, so SWEA is not inherently exclusive to Rider. [ReSharper solution-wide analysis](https://www.jetbrains.com/help/resharper/Code_Analysis__Solution-Wide_Analysis.html)

## What VS Code's public contract establishes

The VS Code documentation promises on-the-fly inspection of each C# file opened in the editor. It does not describe a SWEA enable switch, solution-wide result subscription, or solution-wide completion API on that page. That absence does **not** prove the binaries lack the underlying engine. [VS Code inspect and fix code](https://www.jetbrains.com/help/resharper-vscode/Inspect_and_fix_CSharp.html)

The frontend extension and backend are separately updated: a backend corresponding to an updated extension is downloaded when opening a solution. Any experimental adapter therefore needs compatibility checks against the actual backend version, not only the VSIX version. [VS Code updates](https://www.jetbrains.com/help/resharper-vscode/Update_disable_uninstall.html)

I found no public JetBrains documentation for loading third-party managed extensions into the VS Code LSP host, or for a supported SWEA LSP endpoint. Treat such a route as an implementation feasibility experiment until verified, not as a supported SDK feature.

## Documented SDK routes

The official plugin template produces ReSharper and Rider projects, run configurations, packaging, and dependencies. Its documented runtime hosts are Visual Studio/ReSharper and Rider; the template does not establish VS Code LSP hosting. [Creating a plugin](https://www.jetbrains.com/help/resharper/sdk/creating_plugin.html), [running a plugin](https://www.jetbrains.com/help/resharper/sdk/running_plugin.html)

Rider uses a ReSharper backend process. Its SDK supports backend plugin code and an extensible protocol between backend and IntelliJ frontend, with generated C# and Kotlin models. This is a supported host for a bridge accessing continuously maintained analysis; it requires a Rider plugin/runtime rather than demonstrating a standalone LSP server. [Rider plugins](https://www.jetbrains.com/help/resharper/sdk/Rider.html)

ReSharper services participate in a component model with constructor injection. Solution components live until solution close, while shell components live with the host. These are suitable lifetimes for a solution-wide subscription, but the documentation is not a guarantee that a particular SWEA service can be replaced or resolved in the LSP host. [Component model](https://www.jetbrains.com/help/resharper/sdk/Platform_ComponentModel.html)

An official example uses `ISolutionLoadTasksScheduler` and a `SolutionLoadTaskKinds.Done` task to observe solution loading, then closes subscriptions with solution lifetime. This distinguishes host loading from analysis completion; it does not provide SWEA completion. [Track solution loading status](https://www.jetbrains.com/help/resharper/sdk/TrackSolutionLoadingStatus.html)

## Batch route and prototype decision

InspectCode documents `--swea`, SARIF output after analysis finishes, extension installation with `--eXtensions`, and local package sources. It is a supported batch fallback. No documented watch mode or indefinitely running incremental session appears in its command-line interface. [InspectCode command-line tool](https://www.jetbrains.com/help/resharper/InspectCode.html)

The actionable standalone feasibility test is therefore: prove that the downloaded LSP host can load a small managed component; prove that continuous SWEA can be enabled despite host policy; subscribe to both progress and the complete results collection; then verify a change in file A updates an unopened dependent file B without recreating the process. Those steps are **inferred prototype criteria**, not a JetBrains-supported recipe. If the host prevents any step, a Rider-hosted backend bridge has a documented plugin/protocol foundation, at the cost of requiring Rider.

## Local feasibility result and implementation

The standalone experiment subsequently passed on macOS arm64 with extension/backend 2026.2.3. These are observations from the downloaded binaries and execution, rather than claims from JetBrains' public documentation:

1. The distributed `JetBrains.ReSharper.SolutionAnalysis.dll` includes the real SWEA implementation. The LSP host's locked settings select `AnalysisScope.VISIBLE_FILES`, so changing a project's ordinary settings is insufficient.
2. A small managed host can initialize the existing VS Code environment and discover our own components by building a catalog from the root assemblies. Restricting the catalog to that directory avoids duplicate runtime/localized assemblies. JetBrains' original dependency map and runtime configuration are essential to resolve its platform shims.
3. Normal zone activation of `SweaZone` resolves `SolutionAnalysisServiceImpl`. Its `RunAnalysisCookie` maintains enabled analysis for the solution lifetime; the bridge also selects warning analysis. No JetBrains executable or assembly is patched, and the normal host's zone/licensing machinery remains in use.
4. `SolutionAnalysisConfiguration` exposes loaded/completed/paused state. `HighlightingResultsMap` exposes pending/total files and the errors/warnings collection. Subscriptions yield progress during initial and incremental work.
5. A test solution contained A (an `int` property) and B (a method returning that property as `int`). With B never opened, changing A's property to `string` produced a type error in B. Changing it back removed the error in the same backend process. The integrated filesystem watcher repeated this successfully both before A was opened and after `read_lint` opened A.

The default managed host is in `backend-host/` and `src/swea.ts`, with session integration in `src/session.ts`. It exposes `read_solution_lint`, live `get_project_status`, and request-scoped MCP progress notifications. File reads also wait for global SWEA completion. Automatic analysis does not reset the project's inactivity timer; user calls do. The session still closes after 30 minutes without calls.

This establishes feasibility for the tested version and platform. It does not turn these component APIs into a documented VS Code SDK. Windows/Linux and VB remain unverified. Builds are performed against the installed backend, and incompatible APIs or absent readiness signals must produce errors rather than empty successful results. Unsaved buffers and linked source files outside the watched solution directory are not synchronized by the MCP watcher.

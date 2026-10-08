using JetBrains.Application.BuildScript.Application.Zones;
using JetBrains.Application.Environment;
using JetBrains.Application.Parts;
using JetBrains.Application.Threading;
using JetBrains.Lifetimes;
using JetBrains.ProjectModel;
using JetBrains.ReSharper.Daemon;
using JetBrains.ReSharper.Daemon.SolutionAnalysis;
using JetBrains.ReSharper.Feature.Services.Daemon;
using JetBrains.ReSharper.Psi;
using JetBrains.VsCode.Backend.Env;

[ZoneMarker]
[ZoneActivator]
public class SweaActivation : IRequire<IVsCodePluginEnvironmentZone>, IActivate<SweaZone> { }

[SolutionComponent(Instantiation.ContainerAsyncPrimaryThread)]
public class SweaBridge
{
    private static readonly object OutputLock = new();

    public SweaBridge(Lifetime lifetime, SolutionAnalysisService service, IShellLocks locks, HighlightingResultsMap results)
    {
        locks.ExecuteOrQueueEx(lifetime, "ReSharper MCP SWEA", () => {
            var configuration = service.Configuration;
            if (configuration == null || service is not SolutionAnalysisServiceImpl)
                throw new InvalidOperationException("The backend did not provide its real SWEA service.");
            var cookie = service.RunAnalysisCookie();
            lifetime.OnTermination(cookie.Dispose);
            configuration.WarningsMode.Value = SweaWarningsMode.ShowAndRun;

            void Snapshot()
            {
                var snapshot = new Dictionary<string, object> {
                    ["enabled"] = configuration.Enabled.Value,
                    ["loaded"] = configuration.Loaded.Value,
                    ["completed"] = configuration.Completed.Value,
                    ["paused"] = configuration.Paused.Value,
                    ["pauseReason"] = configuration.PauseReason,
                    ["pendingFiles"] = results.FilesToBeReanalyzedCount,
                    ["totalFiles"] = results.TotalFilesToBeAnalyzed,
                };
                // Progress is frequent. Only transfer the full issue collection
                // when complete, rather than once for every analyzed file.
                if (configuration.Completed.Value)
                    snapshot["issues"] = results.AllIssues.GetIssues(false).Select(issue => new {
                        file = issue.File.File?.GetLocation().FullPath,
                        message = issue.Message,
                        severity = issue.GetSeverity().ToString(),
                        startOffset = issue.Range?.StartOffset,
                        endOffset = issue.Range?.EndOffset,
                    }).ToArray();
                lock (OutputLock)
                {
                    Console.WriteLine("RESHARPER_MCP_SWEA:" + System.Text.Json.JsonSerializer.Serialize(snapshot));
                    Console.Out.Flush();
                }
            }
            results.AllIssues.Changed.Advise(lifetime, _ => Snapshot());
            results.FilesToBeReanalyzedChanged.Advise(lifetime, _ => Snapshot());
            configuration.Completed.Change.Advise(lifetime, _ => Snapshot());
            configuration.Loaded.Change.Advise(lifetime, _ => Snapshot());
            configuration.Paused.Change.Advise(lifetime, _ => Snapshot());
            Snapshot();
        });
    }
}

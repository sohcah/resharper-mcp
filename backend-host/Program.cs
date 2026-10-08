using System.Reflection;
using JetBrains.Application.BuildScript;
using JetBrains.Application.BuildScript.Application;
using JetBrains.Application.Environment;
using JetBrains.Application.Environment.HostParameters;
using JetBrains.Util;
using JetBrains.Util.Concurrency;
using JetBrains.VsCode.Backend.Env;
using JetBrains.VsCode.Backend.Product;

public static class Program
{
    [STAThread]
    public static int Main(string[] args)
    {
        PlatformUtil.ShouldBeSimilarToUnixExecution = true;
        JetThreadApartment.STAThread();
        var root = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location)!;
        var host = new HostInfo("VsCodeExtension.Backend", "", WaveInfo.Current.Number, supportSideBySide: true);
        return JetHost.New.OnConsoleEngine()
            // Reflect root assemblies to include our own components. Runtime and
            // localized assemblies in subdirectories must not enter this catalog.
            .OnScatteredFilesInFlatFolder(new ProductBinariesDirArtifact(FileSystemPath.Parse(root)),
                path => !path.ToString().Contains('/') && !path.ToString().Contains('\\'))
            .HostedWithoutConsole(host)
            .InEnvironmentZone<IVsCodePluginEnvironmentZone>()
            .CreateAndRun().IsWithErrors() ? 1 : 0;
    }
}

using System;
using System.Diagnostics;
using System.IO;

// Compiled as a Windows application: neither this launcher nor its child
// creates a console or a Windows Terminal tab. Wait to retain task supervision.
internal static class DashboardBackgroundLauncher
{
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length != 1 || !File.Exists(args[0]) || args[0].Contains("\"")) return 2;
        try
        {
            string script = Path.GetFullPath(args[0]);
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
                @"WindowsPowerShell\v1.0\powershell.exe");
            var start = new ProcessStartInfo(powershell,
                "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + script + "\"");
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WorkingDirectory = Path.GetDirectoryName(script);
            using (var child = Process.Start(start))
            {
                child.WaitForExit();
                return child.ExitCode;
            }
        }
        catch { return 3; }
    }
}

// "Fieldbook.exe": kleine Startdatei für den Hauptordner.
// Sucht app\Start.bat neben sich selbst und startet sie. Funktioniert deshalb auch,
// wenn der Ordner verschoben wird oder auf einem USB-Stick liegt.
//
// Mit "--aktualisieren pruefen|laden" startet sie die automatische Aktualisierung unsichtbar
// (aufgerufen von der Windows-Aufgabenplanung). Wird die Aufgabe beendet, enden auch alle
// Unterprozesse (Job-Objekt), damit nichts im Hintergrund weiterläuft.
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Fieldbook")]
[assembly: System.Reflection.AssemblyProduct("Fieldbook")]
[assembly: System.Reflection.AssemblyDescription("Startet Fieldbook: Bibliothek, KI, Karten und Notfall")]

static class Starter
{
    [STAThread]
    static int Main(string[] args)
    {
        string ordner = AppDomain.CurrentDomain.BaseDirectory;
        if (args.Length >= 2 && args[0] == "--aktualisieren") return Aktualisieren(ordner, args[1] == "laden" ? "laden" : "pruefen");

        string bat = Path.Combine(ordner, "app", "Start.bat");
        if (!File.Exists(bat))
        {
            MessageBox.Show("Der Unterordner \"app\" wurde nicht gefunden.\n\nBitte den kompletten Ordner von Fieldbook entpacken und die Startdatei nicht einzeln verschieben.",
                "Fieldbook", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + bat + "\"\"")
        {
            WorkingDirectory = Path.Combine(ordner, "app"),
            UseShellExecute = false
        };
        Process.Start(psi);
        return 0;
    }

    static int Aktualisieren(string ordner, string modus)
    {
        // Nichts freigegeben? Dann sofort beenden (kostet praktisch nichts).
        if (modus == "laden" && !File.Exists(Path.Combine(ordner, "daten", "aktualisierung-bereit"))) return 0;
        string skript = Path.Combine(ordner, "app", "aktualisieren.ps1");
        if (!File.Exists(skript)) return 1;
        var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + skript + "\" -Modus " + modus)
        {
            WorkingDirectory = Path.Combine(ordner, "app"),
            UseShellExecute = false,
            CreateNoWindow = true
        };
        IntPtr job = JobMitAutoEnde();
        using (var p = Process.Start(psi))
        {
            try { AssignProcessToJobObject(job, p.Handle); } catch { }
            try { p.PriorityClass = ProcessPriorityClass.Idle; } catch { }
            p.WaitForExit();
            return p.ExitCode;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct BASIC { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
    [StructLayout(LayoutKind.Sequential)]
    struct IOC { public ulong a, b, c, d, e, f; }
    [StructLayout(LayoutKind.Sequential)]
    struct EXT { public BASIC Basic; public IOC Io; public UIntPtr a, b, c, d; }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

    static IntPtr JobMitAutoEnde()
    {
        IntPtr h = CreateJobObject(IntPtr.Zero, null);
        var info = new EXT();
        info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        int len = Marshal.SizeOf(typeof(EXT));
        IntPtr p = Marshal.AllocHGlobal(len);
        Marshal.StructureToPtr(info, p, false);
        SetInformationJobObject(h, 9, p, (uint)len);
        Marshal.FreeHGlobal(p);
        return h;
    }
}

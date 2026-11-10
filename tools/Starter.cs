// "Fieldbook.exe": kleine Startdatei für den Hauptordner.
// Sucht app\Start.bat neben sich selbst und startet sie. Funktioniert deshalb auch,
// wenn der Ordner verschoben wird oder auf einem USB-Stick liegt.
//
// Mit "--aktualisieren pruefen|laden" startet sie die automatische Aktualisierung unsichtbar
// (aufgerufen von der Windows-Aufgabenplanung). Wird die Aufgabe beendet, enden auch alle
// Unterprozesse (Job-Objekt), damit nichts im Hintergrund weiterläuft.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Text;
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
        // Konsolenfenster minimiert starten; bei Fehlern holt start.ps1 es selbst nach vorne
        var psi = new ProcessStartInfo("cmd.exe", "/c \"\"" + bat + "\"\"")
        {
            WorkingDirectory = Path.Combine(ordner, "app"),
            UseShellExecute = true,
            WindowStyle = ProcessWindowStyle.Minimized
        };
        // Läuft Fieldbook schon, holt es den offenen Browser-Tab nach vorne; das darf es nur mit dieser Erlaubnis
        try { AllowSetForegroundWindow(-1); } catch { }
        // Statusdatei vorbereiten: start.ps1 und Server schreiben hier den Fortschritt hinein
        string statusDatei = Path.Combine(ordner, "daten", "cache", "startstatus.txt");
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(statusDatei));
            File.WriteAllText(statusDatei, "Wird gestartet " + (char)0x2026, new UTF8Encoding(false));
        }
        catch { }
        // Erst starten, dann das Fenster zeigen: der Start wird nicht verzögert
        Process proc;
        try { proc = Process.Start(psi); }
        catch (Exception e)
        {
            // z. B. cmd.exe oder Start.bat per Richtlinie gesperrt
            MessageBox.Show(T("Fieldbook konnte nicht gestartet werden.\nWindows hat den Start blockiert (" + e.Message + ").\n\nAuf Firmen- und Schulrechnern ist das oft so eingestellt.\nBitte frag im Zweifel die IT."),
                "Fieldbook", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return 1;
        }
        try { SetProcessDPIAware(); } catch { }
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try { Application.Run(new Startfenster(proc, statusDatei, ordner)); } catch { }
        // Hat das Startfenster einen Fehler erkannt, jetzt (nach dem Schließen) erklären
        if (Meldung != null) MessageBox.Show(Meldung, "Fieldbook", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        return 0;
    }

    // Meldung, die nach dem Schließen des Startfensters gezeigt wird (null = alles gut)
    static string Meldung;

    // csc liest diese Datei ohne BOM als ANSI: Umlaute in Meldungen deshalb als Platzhalter schreiben
    static string T(string s)
    {
        return s.Replace("{ae}", ((char)0xE4).ToString()).Replace("{oe}", ((char)0xF6).ToString())
            .Replace("{ue}", ((char)0xFC).ToString()).Replace("{Ue}", ((char)0xDC).ToString())
            .Replace("{ss}", ((char)0xDF).ToString())
            .Replace("{<}", ((char)0x201E).ToString()).Replace("{>}", ((char)0x201C).ToString());
    }

    const string TextEingeschraenkt =
        "Fieldbook kann auf diesem Rechner nicht starten.\n" +
        "PowerShell ist hier eingeschr{ae}nkt, das ist auf Firmen- und Schulrechnern oft so.\n\n" +
        "Bitte frag die IT, ob Fieldbook erlaubt werden kann.\n" +
        "Auf einem privaten Rechner l{ae}uft es ohne Einschr{ae}nkung.";

    const string TextKeinFortschritt =
        "Fieldbook startet nicht.\n" +
        "Wahrscheinlich verhindert eine Einstellung auf diesem Rechner, dass PowerShell-Skripte laufen.\n" +
        "Das ist auf Firmen- und Schulrechnern oft so.\n\n" +
        "Genaueres steht im Fenster der Eingabeaufforderung in der Taskleiste.\n" +
        "Bitte frag im Zweifel die IT.";

    // Kleines Startfenster: Logo, Statuszeile und Laufbalken, bis Fieldbook offen ist
    class Startfenster : Form
    {
        static readonly Color Hintergrund = Color.FromArgb(0x1C, 0x1D, 0x1B);
        static readonly Color Rahmen = Color.FromArgb(0x33, 0x35, 0x2F);
        static readonly Color Spur = Color.FromArgb(0x26, 0x29, 0x25);
        static readonly Color Moos = Color.FromArgb(0x9F, 0xB7, 0x8F);
        int BalkenX, BalkenY, BalkenBreite, BalkenHoehe, StueckBreite, Schritt;
        float k = 1f; // Skalierung für 125/150 % Anzeige

        Process proc;
        string statusDatei;
        Label status;
        Image logo;
        Timer timer = new Timer();
        DateTime letzteAenderung = DateTime.Now;
        bool gemeldet; // hat start.ps1 schon etwas in die Statusdatei geschrieben?
        int pos;
        int takt = 0;
        string zuletzt = "";

        public Startfenster(Process p, string datei, string ordner)
        {
            proc = p;
            statusDatei = datei;
            DoubleBuffered = true;
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = false;
            AutoScaleMode = AutoScaleMode.None;
            try { using (var gr = CreateGraphics()) k = gr.DpiX / 96f; } catch { }
            ClientSize = new Size(S(440), S(190));
            BalkenX = S(24); BalkenY = S(134); BalkenBreite = S(392); BalkenHoehe = Math.Max(S(4), 2);
            StueckBreite = S(110); Schritt = S(6); pos = -StueckBreite;
            BackColor = Hintergrund;

            logo = LogoLaden(ordner);

            string titelSchrift = "Segoe UI Semibold";
            try
            {
                foreach (FontFamily f in FontFamily.Families)
                    if (f.Name == "Barlow Semi Condensed") { titelSchrift = f.Name; break; }
            }
            catch { }

            // Sonderzeichen als Zeichencode: csc liest diese Datei ohne BOM als ANSI
            Beschriftung("Fieldbook", new Font(titelSchrift, 20f), Color.FromArgb(0xF7, 0xF5, 0xF1), 94, 12, 322, 48);
            Beschriftung("Wissen, wo kein Netz ist", new Font("Segoe UI", 10f), Color.FromArgb(0xE6, 0xE2, 0xDC), 98, 57, 318, 26);
            status = Beschriftung("Wird gestartet " + (char)0x2026, new Font("Segoe UI", 10f), Color.FromArgb(0xE6, 0xE2, 0xDC), 24, 102, 392, 26);
            status.AutoEllipsis = true;

            string version = VersionLesen(ordner);
            if (version != null)
                Beschriftung(version, new Font("Segoe UI", 8f), Color.FromArgb(0xA9, 0xA6, 0x9F), 24, 156, 392, 18);

            timer.Interval = 30;
            timer.Tick += Takt;
            timer.Start();
        }

        int S(int wert) { return (int)Math.Round(wert * k); }

        Label Beschriftung(string text, Font schrift, Color farbe, int x, int y, int b, int h)
        {
            var l = new Label();
            l.Text = text; l.Font = schrift; l.ForeColor = farbe; l.BackColor = Color.Transparent;
            l.AutoSize = false; l.Location = new Point(S(x), S(y)); l.Size = new Size(S(b), S(h));
            Controls.Add(l);
            return l;
        }

        // Logo in großer Auflösung aus dem Symbol der eigenen exe holen
        // (256 px als Bild: DrawImage verkleinert sauberer als DrawIcon)
        static Image LogoLaden(string ordner)
        {
            try
            {
                string exe = Process.GetCurrentProcess().MainModule.FileName;
                IntPtr[] icons = new IntPtr[1];
                int[] ids = new int[1];
                if (PrivateExtractIcons(exe, 0, 256, 256, icons, ids, 1, 0) > 0 && icons[0] != IntPtr.Zero)
                    using (var ic = Icon.FromHandle(icons[0])) return ic.ToBitmap();
            }
            catch { }
            return null;
        }

        // Version aus app\Server.cs lesen; ohne Treffer keine Anzeige
        static string VersionLesen(string ordner)
        {
            try
            {
                string text = File.ReadAllText(Path.Combine(ordner, "app", "Server.cs"));
                var m = System.Text.RegularExpressions.Regex.Match(text, "Version\\s*=\\s*\"(\\d+(?:\\.\\d+)+[^\"]*)\"");
                if (m.Success) return "Version " + m.Groups[1].Value;
            }
            catch { }
            return null;
        }

        protected override bool ShowWithoutActivation { get { return true; } }

        void Takt(object s, EventArgs e)
        {
            pos += Schritt;
            if (pos > BalkenBreite) pos = -StueckBreite;
            Invalidate(new Rectangle(BalkenX, BalkenY, BalkenBreite, BalkenHoehe));
            takt++;
            if (takt % 7 != 0) return; // etwa alle 200 ms
            try { if (proc != null && proc.HasExited) { Close(); return; } } catch { }
            string z = StatusLesen();
            if (z == null || z == zuletzt)
            {
                double still = (DateTime.Now - letzteAenderung).TotalSeconds;
                // Das Startskript hat sich nach einer Minute noch nie gemeldet: PowerShell läuft hier wohl nicht
                if (!gemeldet && still > 60) { Meldung = T(TextKeinFortschritt); Close(); return; }
                // Sonst wie bisher: nach drei Minuten ohne Änderung still schließen
                if (still > 180) Close();
                return;
            }
            zuletzt = z;
            letzteAenderung = DateTime.Now;
            string klein = z.ToLowerInvariant();
            // "fehler:eingeschraenkt" schreibt start.ps1 bei eingeschränkter PowerShell; schlichtes "fehler" zeigt
            // start.ps1 selbst im Konsolenfenster (z. B. fehlgeschlagenes Update, das danach weiterstartet)
            if (klein.StartsWith("fehler:eingeschr")) { Meldung = T(TextEingeschraenkt); Close(); return; }
            if (klein == "fertig" || klein.StartsWith("fehler")) { Close(); return; }
            // Der Anfangstext stammt von dieser exe selbst und zählt nicht als Lebenszeichen
            if (!klein.StartsWith("wird gestartet")) gemeldet = true;
            if (z.Length > 0) status.Text = z;
        }

        string StatusLesen()
        {
            try
            {
                using (var fs = new FileStream(statusDatei, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                using (var sr = new StreamReader(fs, Encoding.UTF8))
                    return sr.ReadToEnd().Trim();
            }
            catch { return null; }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            var g = e.Graphics;
            using (var stift = new Pen(Rahmen))
                g.DrawRectangle(stift, 0, 0, Width - 1, Height - 1);
            if (logo != null)
            {
                g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
                g.DrawImage(logo, new Rectangle(S(24), S(20), S(56), S(56)));
            }
            using (var b = new SolidBrush(Spur))
                g.FillRectangle(b, BalkenX, BalkenY, BalkenBreite, BalkenHoehe);
            int von = Math.Max(pos, 0), bis = Math.Min(pos + StueckBreite, BalkenBreite);
            if (bis > von)
                using (var b = new SolidBrush(Moos))
                    g.FillRectangle(b, BalkenX + von, BalkenY, bis - von, BalkenHoehe);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) timer.Dispose();
            base.Dispose(disposing);
        }
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

    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(int processId);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint PrivateExtractIcons(string datei, int index, int bx, int by, IntPtr[] icons, int[] ids, uint anzahl, uint flags);
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

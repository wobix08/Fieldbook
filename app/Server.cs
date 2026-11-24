// Fieldbook: kleiner lokaler Server.
// Wird von start.ps1 zur Laufzeit kompiliert (C# 5, .NET Framework 4.x, auf jedem Windows 10/11 vorhanden).
// Aufgaben: Dashboard ausliefern, Kiwix und llama-server starten und weiterleiten,
// Downloads für das Setup erledigen, Hardware erkennen, Ortssuche für die Karten.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace OfflineWissen
{
    public class Job
    {
        public string Art, Titel, Url, Ziel, Status = "wartet", Fehler = "", Extra;
        public long Bytes, Gesamt;
        public string[] Liste;
    }

    // Moderne Windows-Ordnerauswahl (IFileOpenDialog). Nur die benutzten Methoden, in der Reihenfolge der Schnittstelle.
    [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
    class OrdnerDialogKlasse { }

    [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IOrdnerDialog
    {
        [PreserveSig] int Show(IntPtr eltern);
        void SetFileTypes(uint anzahl, IntPtr typen);
        void SetFileTypeIndex(uint i);
        void GetFileTypeIndex(out uint i);
        void Advise(IntPtr ereignisse, out uint kennung);
        void Unadvise(uint kennung);
        void SetOptions(uint optionen);
        void GetOptions(out uint optionen);
        void SetDefaultFolder(IShellEintrag ordner);
        void SetFolder(IShellEintrag ordner);
        void GetFolder(out IShellEintrag ordner);
        void GetCurrentSelection(out IShellEintrag eintrag);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string titel);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void GetResult(out IShellEintrag eintrag);
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellEintrag
    {
        void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellEintrag eltern);
        void GetDisplayName(uint art, out IntPtr name);
    }

    public class Ort
    {
        public string Name, Alt, Land, Code;
        // Gemeinde-Schlüssel aus der Ortsliste (DE: admin4, AT/CH: admin3), nur bei bewohnten Orten.
        // Damit findet ein Stadtteil seine Stadt.
        public string Gemeinde;
        // Beim Laden einmal vereinfacht (klein, ohne Akzente), damit die Suche nicht bei jedem Tastendruck rechnet
        public string NormName;
        public string[] NormAlt;
        public double Lat, Lon;
        public long Pop;
        public char Klasse;
    }

    public static class App
    {
        public const string Version = "0.8.8.4";
        static string Root, AppDir, Web, Config, Daten, Prog, Logs;
        static int Port, KiwixPort, LlmPort, SuchPort, RoutePort;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
        static readonly object Lk = new object();
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        static Process kiwix, llama, brouter, suchhilfe;
        // Womit die KI gerade rechnet ("cpu", "vulkan", …); die Suchhilfe folgt ihr auf die Grafikkarte
        static string kiBackend = "cpu";
        static string llmStatus = "aus", llmFehler = "", llmModell = "";
        static int llmGen = 0;

        static List<Job> jobs = new List<Job>();
        static Thread worker;
        static volatile bool abbrechen;
        // Fieldbook wird beendet oder neu gestartet: laufende Downloads gelten nicht als Fehler und bleiben gemerkt
        static volatile bool beenden;
        static readonly HashSet<Process> jobProzesse = new HashSet<Process>();

        static void ProzessMerken(Process p, bool an) { lock (jobProzesse) { if (an) jobProzesse.Add(p); else jobProzesse.Remove(p); } }

        static void AlleDownloadsStoppen()
        {
            lock (jobProzesse) foreach (var p in jobProzesse) try { if (!p.HasExited) p.Kill(); } catch { }
        }

        // Vor dem Beenden: Warteschlange ein letztes Mal merken (laufende als offen), danach bleibt die Datei unverändert
        static void BeendenVorbereiten()
        {
            lock (Lk)
            {
                if (beenden) return;
                WarteschlangeMerken();
                beenden = true;
            }
        }

        static Dictionary<string, object> einst;
        static Dictionary<string, Dictionary<string, object>> katalog;
        static bool katalogOnline;
        static string planetUrl;

        static List<Ort> orte;
        static readonly object OrteLk = new object();
        static readonly object MeineOrteLk = new object();
        static readonly object SperrungenLk = new object();

        // ------------------------------------------------------------------ Start

        static void Init(string root)
        {
            Root = root;
            AppDir = Path.Combine(root, "app");
            Web = Path.Combine(AppDir, "web");
            Config = Path.Combine(AppDir, "config");
            Daten = Path.Combine(root, "daten");
            Prog = Path.Combine(root, "programme");
            Logs = Path.Combine(Daten, "logs");
            foreach (var d in new[] { Daten, Prog, Logs, Path.Combine(Daten, "wissen"), Path.Combine(Daten, "modelle"), Path.Combine(Daten, "karten"), Path.Combine(Daten, "orte"), Path.Combine(Daten, "cache"), Path.Combine(Daten, "routen"), Path.Combine(Daten, "routen", "profile") })
                Directory.CreateDirectory(d);

            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072; // TLS 1.2
            ServicePointManager.DefaultConnectionLimit = 64;
            ServicePointManager.Expect100Continue = false;
            ThreadPool.SetMinThreads(32, 32);
            ChildJob.Init();

            einst = LadeJson(Path.Combine(Daten, "einstellungen.json")) ?? new Dictionary<string, object>();
            ProxySetzen();
        }

        public static void Start(string root, int port)
        {
            Init(root);
            Port = port;
            FensterSymbol();
            KiwixPort = FreierPort();
            LlmPort = FreierPort();
            SuchPort = FreierPort();
            RoutePort = FreierPort();

            listener = new HttpListener();
            listener.Prefixes.Add("http://localhost:" + Port + "/");
            listener.Start();
            // Benutzten Anschluss merken (start.ps1 und die Windows-Aufgabe finden Fieldbook so auch auf 8091 usw.)
            try { Directory.CreateDirectory(Path.Combine(Daten, "cache")); File.WriteAllText(PortDatei, Port.ToString(CultureInfo.InvariantCulture)); } catch { }

            StartStatus("Browser wird geöffnet …");
            Log("Fieldbook " + Version + " läuft.");
            try { NeuigkeitenBeimStart(); } catch (Exception e) { Log("Neuigkeiten: " + e.Message); }

            // Ungefangene Fehler beenden den Prozess trotzdem, aber die Ursache steht dann im Log
            AppDomain.CurrentDomain.UnhandledException += delegate (object s, UnhandledExceptionEventArgs e)
            {
                string text = Convert.ToString(e.ExceptionObject);
                Log("Unerwarteter Fehler: " + text);
                try { File.AppendAllText(Path.Combine(Logs, "absturz.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + text + Environment.NewLine, Utf8); } catch { }
            };

            // Die KI startet erst nach Bibliothek und Routenplanung. Bis dahin soll oben nicht „KI aus“ stehen, sondern
            // „KI lädt …“, wenn eine KI eingerichtet und der Sparmodus aus ist. StarteKi setzt danach den echten Stand.
            try
            {
                var km = Bool(einst, "sparmodus") ? null : AktuellesModell();
                if (km != null && File.Exists(Path.Combine(Daten, "modelle", Str(km, "datei"))))
                {
                    llmModell = Str(km, "name") + " (" + Str(km, "modell") + ")";
                    llmStatus = "laedt";
                }
            }
            catch { }

            // Jeder Schritt einzeln abgesichert: scheitert einer, laufen die anderen trotzdem
            new Thread(delegate ()
            {
                try { Aufraeumen(true); } catch (Exception e) { Log("Aufräumen: " + e.Message); }
                try { AufgabenPfadPruefen(); } catch (Exception e) { Log("Aufgabenplanung: " + e.Message); }
                try { DesktopSymbolPruefen(); } catch { }
                try { ProtokollPruefen(); } catch (Exception e) { Log("Adresse fieldbook://: " + e.Message); }
                StarteKiwix();
                StarteRouting();
                if (!Bool(einst, "sparmodus")) StarteKi();
                try { FortsetzenBeimStart(); } catch (Exception e) { Log("Fortsetzen: " + e.Message); }
                // Einmal beim Start kurz nach einer neuen Fieldbook-Version fragen (eine kleine Anfrage, abschaltbar)
                try { if (UpdateBeimStart() && UpdateApi() != null && !IstEntwicklungsordner()) ProgrammUpdateSuchen(); }
                catch (Exception e) { AktLog("Programm-Update-Suche beim Start fehlgeschlagen: " + e.Message); }
            }) { IsBackground = true }.Start();
            // Gemerkte Rückmeldungen verschicken, sobald Internet da ist
            new Thread(FeedbackHintergrund) { IsBackground = true }.Start();
            // Wochenpaket der Nutzungsstatistik (nur mit Zustimmung)
            new Thread(StatHintergrund) { IsBackground = true }.Start();
            // Kiwix-Katalog vorladen, damit Inhalte, Einstellungen und Assistent nicht darauf warten
            new Thread(delegate ()
            {
                try { LadeKiwixKatalog(false); } catch (Exception e) { Log("Katalog vorladen: " + e.Message); }
            }) { IsBackground = true, Priority = ThreadPriority.BelowNormal }.Start();

            // Nach einem Neustart durch das Programm-Update ist der Browser schon offen
            string neustartMarke = Path.Combine(Daten, "cache", "neustart");
            bool nachNeustart = File.Exists(neustartMarke);
            if (nachNeustart) try { File.Delete(neustartMarke); } catch { }
            // Ist vom letzten Mal noch ein Fieldbook-Tab offen, meldet er sich gleich wieder (alle 5 s).
            // Dann diesen Tab nutzen statt einen neuen zu öffnen.
            // Offene Tabs fragen bei nicht erreichbarem Server jede Sekunde nach, daher reichen etwa 2,5 s Warten.
            if (Environment.GetEnvironmentVariable("OW_KEIN_BROWSER") == null && !nachNeustart)
                new Thread(delegate ()
                {
                    // Nur warten, wenn sich vor Kurzem ein Tab gemeldet hat (daten/cache/tab.txt), sonst gleich öffnen
                    if (TabKuerzlich()) for (int i = 0; i < 25 && !TabOffen(10); i++) Thread.Sleep(100);
                    if (TabOffen(10) && BrowserNachVorne()) Log("Der offene Fieldbook-Tab im Browser wird weiter benutzt.");
                    else BrowserOeffnen();
                    StartStatus("fertig");
                }) { IsBackground = true }.Start();
            else StartStatus("fertig");

            while (listener.IsListening)
            {
                HttpListenerContext ctx;
                try { ctx = listener.GetContext(); } catch { break; }
                ThreadPool.QueueUserWorkItem(delegate (object o) { Bearbeite((HttpListenerContext)o); }, ctx);
            }
            // Beim Neustart wartet dieser Prozess, bis die neue Instanz gestartet ist
            if (neustartAktiv) Thread.Sleep(Timeout.Infinite);
        }

        static void Log(string s) { try { Console.WriteLine(s); } catch { } }

        // Startfortschritt für das Startfenster (eine Zeile Text); Fehler werden ignoriert
        static void StartStatus(string text)
        {
            try
            {
                string ordner = Path.Combine(Daten, "cache");
                Directory.CreateDirectory(ordner);
                File.WriteAllText(Path.Combine(ordner, "startstatus.txt"), text, new UTF8Encoding(false));
            }
            catch { }
        }

        [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr ExtractIcon(IntPtr inst, string datei, int nr);
        [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);

        // Fieldbook-Logo statt des Konsolen-Symbols im Fenster und unten in der Taskleiste (aus Fieldbook.exe)
        static void FensterSymbol()
        {
            try
            {
                string exe = Path.Combine(Root, "Fieldbook.exe");
                IntPtr fenster = GetConsoleWindow();
                if (!File.Exists(exe) || fenster == IntPtr.Zero) return;
                IntPtr symbol = ExtractIcon(IntPtr.Zero, exe, 0);
                if ((long)symbol <= 1) return;
                SendMessage(fenster, 0x80, new IntPtr(0), symbol); // WM_SETICON, klein
                SendMessage(fenster, 0x80, new IntPtr(1), symbol); // WM_SETICON, groß
            }
            catch { }
        }

        // ------------------------------------------------------------------ Browser-Tab wiederverwenden

        static long tabZuletzt; // letzte Status-Anfrage aus einem Fieldbook-Tab (UTC-Ticks)
        static readonly string StartKennung = DateTime.Now.Ticks.ToString(); // ändert sich bei jedem Start; offene Tabs laden dann neu

        static bool TabOffen(int sekunden)
        {
            long t = Interlocked.Read(ref tabZuletzt);
            return t > 0 && (DateTime.UtcNow - new DateTime(t, DateTimeKind.Utc)).TotalSeconds < sekunden;
        }

        // Letzter Tab-Kontakt wird in daten/cache/tab.txt gemerkt (höchstens alle 30 s geschrieben), damit der
        // nächste Start weiß, ob ein alter Tab noch offen sein kann
        static string TabDatei { get { return Path.Combine(Daten, "cache", "tab.txt"); } }
        static string PortDatei { get { return Path.Combine(Daten, "cache", "port.txt"); } }
        static long tabGemerkt; // wann tab.txt zuletzt geschrieben wurde (UTC-Ticks)

        static void TabMelden()
        {
            long jetzt = DateTime.UtcNow.Ticks;
            Interlocked.Exchange(ref tabZuletzt, jetzt);
            long alt = Interlocked.Read(ref tabGemerkt);
            if (jetzt - alt < 30 * TimeSpan.TicksPerSecond || Interlocked.CompareExchange(ref tabGemerkt, jetzt, alt) != alt) return;
            try { File.WriteAllText(TabDatei, jetzt.ToString(CultureInfo.InvariantCulture), Encoding.ASCII); } catch { }
        }

        // Hat sich in der letzten Minute ein Tab gemeldet? (Datei bis zu 30 s alt, dazu Spielraum für den Neustart)
        static bool TabKuerzlich()
        {
            try
            {
                long t;
                if (!File.Exists(TabDatei) || !long.TryParse(File.ReadAllText(TabDatei).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out t)) return false;
                double alter = (DateTime.UtcNow - new DateTime(t, DateTimeKind.Utc)).TotalSeconds;
                return alter >= -60 && alter < 60;
            }
            catch { return false; }
        }

        static void BrowserOeffnen()
        {
            Interlocked.Exchange(ref tabMarke, DateTime.UtcNow.Ticks);
            try { Process.Start(new ProcessStartInfo("http://localhost:" + Port + "/") { UseShellExecute = true }); } catch { }
        }

        // Welcher Tab ist der, den Fieldbook gerade geöffnet hat? Ein vom Browser wiederhergestellter alter Tab sieht genauso
        // aus (Startseite, ohne Verlauf, gerade geladen). Darum holt sich der erste frische Tab diese Marke einmal ab
        // (index.html, /api/tab/marke); wer sie bekommt, hat Vorrang, alle anderen geben ab. Höchstens 2 Minuten gültig.
        static long tabMarke;
        static bool TabMarkeAbholen()
        {
            long t = Interlocked.Exchange(ref tabMarke, 0);
            return t > 0 && (DateTime.UtcNow - new DateTime(t, DateTimeKind.Utc)).TotalSeconds < 120;
        }

        delegate bool FensterRueckruf(IntPtr h, IntPtr l);
        [DllImport("user32.dll")] static extern bool EnumWindows(FensterRueckruf f, IntPtr l);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
        [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);

        // Holt ein Browserfenster nach vorne, dessen aktiver Tab Fieldbook zeigt (Fenstertitel beginnt mit „Fieldbook“).
        // Liegt Fieldbook nur in einem Hintergrund-Tab, findet Windows das Fenster nicht: dann false.
        static bool BrowserNachVorne()
        {
            IntPtr gefunden = IntPtr.Zero;
            EnumWindows(delegate (IntPtr h, IntPtr l)
            {
                if (!IsWindowVisible(h)) return true;
                var titel = new StringBuilder(256); GetWindowText(h, titel, 256);
                var klasse = new StringBuilder(256); GetClassName(h, klasse, 256);
                string k = klasse.ToString();
                bool browser = k == "Chrome_WidgetWin_1" || k == "MozillaWindowClass";
                if (browser && titel.ToString().StartsWith("Fieldbook")) { gefunden = h; return false; }
                return true;
            }, IntPtr.Zero);
            if (gefunden == IntPtr.Zero) return false;
            if (IsIconic(gefunden)) ShowWindow(gefunden, 9);
            // Windows lässt Hintergrundprogramme sonst nicht nach vorne; ein kurzer Alt-Tastendruck erlaubt es
            keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
            SetForegroundWindow(gefunden);
            return true;
        }

        static int FreierPort()
        {
            var l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            int p = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return p;
        }

        // ------------------------------------------------------------------ Anfragen

        static void Bearbeite(HttpListenerContext ctx)
        {
            try
            {
                // Im try: ohne gültige Adresse (Url == null) sonst Absturz im ThreadPool
                string pfad = ctx.Request.Url.AbsolutePath;
                string roh = ctx.Request.RawUrl ?? "";
                // Nur Anfragen von diesem Rechner (nicht aus dem Netzwerk)
                if (!ctx.Request.IsLocal) { SendeText(ctx, 403, "Zugriff nur von diesem Rechner aus."); return; }
                // Fremde Webseiten dürfen Fieldbook nicht unsichtbar einbetten (sonst könnten sie zu Klicks verleiten)
                ctx.Response.AddHeader("X-Frame-Options", "SAMEORIGIN");
                // Fremde Webseiten dürfen weder die Schnittstelle noch die Dienste dahinter benutzen
                bool geschuetzt = pfad.StartsWith("/api/") || pfad.StartsWith("/llm/") || pfad.StartsWith("/suchhilfe/") || pfad.StartsWith("/route/");
                if (geschuetzt && FremdeHerkunft(ctx.Request)) { SendeText(ctx, 403, "Zugriff von einer fremden Webseite abgelehnt."); return; }
                // Rundgang (Übungsmodus): Beispieldaten statt der echten Inhalte
                if (Uebung(ctx, pfad)) return;

                if (pfad == "/kiwix" || pfad.StartsWith("/kiwix/"))
                {
                    // RawUrl muss wirklich mit dem Präfix beginnen, sonst könnte das Ziel der Weiterleitung verfälscht werden
                    if (!(roh == "/kiwix" || roh.StartsWith("/kiwix/", StringComparison.Ordinal) || roh.StartsWith("/kiwix?", StringComparison.Ordinal))) { SendeText(ctx, 400, "Ungültige Adresse."); return; }
                    // Abgestürzt (Prozess beendet, ohne dass Fieldbook ihn gestoppt hat): gleich neu starten
                    var k = kiwix;
                    if (k != null && k.HasExited)
                    {
                        // Neustart läuft im Hintergrund; die Anfrage wartet nicht darauf
                        if (KiwixWiederbeleben()) { SendeText(ctx, 503, "Die Bibliothek startet neu, bitte gleich noch einmal versuchen."); return; }
                        k = kiwix;
                    }
                    if (k == null || k.HasExited) { SendeText(ctx, 503, "Die Bibliothek ist nicht gestartet (keine Wissenspakete installiert?)."); return; }
                    // RawUrl statt Url.PathAndQuery: Url entschlüsselt "%25" zu "%", dann findet Kiwix
                    // Dateien mit Sonderzeichen im Namen nicht mehr (z. B. "%252C" für ein Komma)
                    if (IfixitUmleiten(ctx)) return;
                    Weiterleiten(ctx, KiwixPort, roh);
                }
                else if (pfad.StartsWith("/route/"))
                {
                    if (!roh.StartsWith("/route/", StringComparison.Ordinal)) { SendeText(ctx, 400, "Ungültige Adresse."); return; }
                    var b = brouter;
                    if (b == null || b.HasExited) { SendeText(ctx, 503, "Die Routenplanung ist nicht eingerichtet."); return; }
                    Weiterleiten(ctx, RoutePort, roh.Substring(6));
                }
                else if (pfad.StartsWith("/llm/"))
                {
                    if (!roh.StartsWith("/llm/", StringComparison.Ordinal)) { SendeText(ctx, 400, "Ungültige Adresse."); return; }
                    if (llmStatus != "bereit") { SendeJson(ctx, new Dictionary<string, object> { { "error", "KI ist nicht bereit (" + llmStatus + ")" } }, 503); return; }
                    Weiterleiten(ctx, LlmPort, roh.Substring(4));
                }
                else if (pfad.StartsWith("/suchhilfe/"))
                {
                    if (!roh.StartsWith("/suchhilfe/", StringComparison.Ordinal)) { SendeText(ctx, 400, "Ungültige Adresse."); return; }
                    var s = suchhilfe;
                    if (s == null || s.HasExited) { SendeJson(ctx, new Dictionary<string, object> { { "error", "Suchhilfe läuft nicht" } }, 503); return; }
                    Weiterleiten(ctx, SuchPort, roh.Substring(10));
                }
                else if (pfad.StartsWith("/api/")) Api(ctx, pfad.Substring(5));
                else if (pfad.StartsWith("/karten/")) SendeDatei(ctx, SichererPfad(Path.Combine(Daten, "karten"), pfad.Substring(8)));
                else if (pfad.StartsWith("/karten-assets/")) SendeDatei(ctx, SichererPfad(Path.Combine(Prog, "karten-assets"), pfad.Substring(15)));
                else if (pfad.StartsWith("/config/")) SendeDatei(ctx, SichererPfad(Config, pfad.Substring(8)));
                else if (pfad.StartsWith("/gesichert/"))
                {
                    // Gesicherte Webseiten: nie Programmcode ausführen (CSP sandbox ohne Skripte), keine Liste und keine Teilergebnisse
                    string rel = pfad.Substring(11);
                    ctx.Response.AddHeader("Content-Security-Policy", WebCsp);
                    ctx.Response.AddHeader("Referrer-Policy", "no-referrer");
                    SendeDatei(ctx, rel.EndsWith(".json", StringComparison.OrdinalIgnoreCase) || rel.EndsWith(".part", StringComparison.OrdinalIgnoreCase) ? null : SichererPfad(WebseitenOrdner, rel));
                }
                else if (pfad.StartsWith("/uebersetzer/")) SendeDatei(ctx, SichererPfad(UebersetzerDir, pfad.Substring(13)));
                else
                {
                    string rel = pfad == "/" ? "index.html" : pfad.Substring(1);
                    SendeDatei(ctx, SichererPfad(Web, rel));
                }
            }
            catch (Exception e)
            {
                try { SendeText(ctx, 500, "Fehler: " + e.Message); } catch { }
            }
            finally
            {
                try { ctx.Response.Close(); } catch { }
            }
        }

        // Schutz vor fremden Webseiten (CSRF): Browser schicken Origin und/oder Sec-Fetch-Site mit.
        // Anfragen ohne diese Kopfzeilen (PowerShell-Skripte, Fieldbook.exe) werden angenommen.
        static bool FremdeHerkunft(HttpListenerRequest rq)
        {
            int port = rq.Url.Port;
            string origin = rq.Headers["Origin"];
            if (origin != null)
            {
                string o = origin.Trim().TrimEnd('/');
                bool gleich = false;
                foreach (string host in new[] { "localhost", "127.0.0.1" })
                {
                    if (string.Equals(o, "http://" + host + ":" + port, StringComparison.OrdinalIgnoreCase)) gleich = true;
                    if (port == 80 && string.Equals(o, "http://" + host, StringComparison.OrdinalIgnoreCase)) gleich = true;
                }
                if (!gleich) return true;
            }
            string site = rq.Headers["Sec-Fetch-Site"];
            if (site != null)
            {
                site = site.Trim().ToLowerInvariant();
                if (site != "same-origin" && site != "none") return true;
            }
            return false;
        }

        static string SichererPfad(string basis, string rel)
        {
            rel = Uri.UnescapeDataString(rel).Replace('/', '\\');
            string voll = Path.GetFullPath(Path.Combine(basis, rel));
            string b = Path.GetFullPath(basis).TrimEnd('\\') + "\\";
            if (!voll.StartsWith(b, StringComparison.OrdinalIgnoreCase)) return null;
            return voll;
        }

        static readonly Dictionary<string, string> Mime = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            {".html","text/html; charset=utf-8"},{".js","text/javascript; charset=utf-8"},{".css","text/css; charset=utf-8"},
            {".json","application/json; charset=utf-8"},{".png","image/png"},{".svg","image/svg+xml"},{".ico","image/x-icon"},
            {".pbf","application/x-protobuf"},{".pmtiles","application/octet-stream"},{".woff2","font/woff2"},{".txt","text/plain; charset=utf-8"},
            {".md","text/plain; charset=utf-8"},{".jpg","image/jpeg"},{".webp","image/webp"},{".wasm","application/wasm"},
            {".jpeg","image/jpeg"},{".gif","image/gif"},{".pdf","application/pdf"},{".avif","image/avif"},{".bmp","image/bmp"},
            {".woff","font/woff"},{".ttf","font/ttf"},{".otf","font/otf"},
            {".docx","application/vnd.openxmlformats-officedocument.wordprocessingml.document"},{".doc","application/msword"}
        };

        // ------------------------------------------------------------------ Übungsmodus (Rundgang)
        // Während des Rundgangs (Cookie „fb-uebung=1“, gesetzt von js/rundgang.js) beantwortet Fieldbook die Schnittstelle
        // und die Bibliothek mit Beispieldaten aus app/web/uebung. Echte Inhalte werden dabei weder gezeigt noch verändert:
        // Schreibende Anfragen landen nirgends, lesende nur bei wenigen Abfragen ohne persönliche Daten beim echten Server.
        // Ortsnamen auf der Karte und „nächster Ort“ kommen aus der echten Ortsliste (keine persönlichen Daten)
        static readonly HashSet<string> UebungEcht = new HashSet<string> { "hardware", "katalog", "beenden", "fortschritt", "ortnah", "ortsnamen" };
        static readonly object UebungLk = new object();
        static List<Dictionary<string, object>> uebungZuletzt, uebungMerk;
        static Dictionary<string, object> uebungOrte, uebungSperrungen;
        // Kapitel KI: In der Übung antwortet eine Beispiel-KI mit vorbereiteten Antworten (uebung/ki, js/fragen.js),
        // ganz ohne Modell. Ausschalten (Sparmodus) gilt nur für sie.
        static bool uebungKiAus;
        static void UebungKi(Dictionary<string, object> s)
        {
            bool aus;
            lock (UebungLk) aus = uebungKiAus;
            s["modell"] = "beispiel";
            s["sparmodus"] = aus;
            s["ki"] = new Dictionary<string, object> { { "status", aus ? "aus" : "bereit" }, { "fehler", null }, { "modell", "Beispiel-KI" }, { "kontext", 0 }, { "suchhilfe", false } };
        }

        // Beispielkarte des Kapitels Karten: kommt nicht in die ZIP, sondern wird vor dem ersten Start geladen
        // (POST /api/uebung/beispielkarte), auf dieselbe Weise wie eine echte Karte. Ausschnitt in uebung/status.json.
        static string BeispielKartenOrdner { get { return Path.Combine(Daten, "cache", "uebung"); } }
        static readonly object BeispielKarteLk = new object();

        static Dictionary<string, object> BeispielKarteInfo()
        {
            var s = UebungJson(Path.Combine(Web, "uebung", "status.json"));
            var k = s != null ? Arr(s, "karten") : new object[0];
            return k.Length > 0 ? k[0] as Dictionary<string, object> : null;
        }

        static string BeispielKartePfad()
        {
            var info = BeispielKarteInfo();
            return info == null ? null : SichererPfad(BeispielKartenOrdner, Str(info, "id") + ".pmtiles");
        }

        static Dictionary<string, object> BeispielKarteLaden()
        {
            string ziel = BeispielKartePfad();
            if (ziel == null) return new Dictionary<string, object> { { "fehler", "Die Beispielkarte ist nicht eingetragen." } };
            lock (BeispielKarteLk)
            {
                if (File.Exists(ziel) && ProgrammPfad("karten-assets") != null) return new Dictionary<string, object> { { "ok", true } };
                try
                {
                    Directory.CreateDirectory(BeispielKartenOrdner);
                    if (SicherstellenProgramm("karten-assets") == null) throw new Exception("Kartenschriften fehlen");
                    StatusCacheLeeren();
                    if (!File.Exists(ziel))
                    {
                        string exe = SicherstellenProgramm("pmtiles");
                        if (exe == null) throw new Exception("pmtiles fehlt");
                        string tmp = ziel.Replace(".pmtiles", ".tmp.pmtiles");
                        var j = new Job { Art = "karte", Titel = "Beispielkarte", Ziel = ziel };
                        string fehler = KarteVersuch(j, exe, new[] { BboxText(BeispielKarteInfo()), "15" }, tmp);
                        if (fehler != null) { try { File.Delete(tmp); } catch { } throw new Exception(fehler); }
                        File.Move(tmp, ziel);
                    }
                    return new Dictionary<string, object> { { "ok", true } };
                }
                catch (Exception e)
                {
                    Log("Beispielkarte: " + e.Message);
                    return new Dictionary<string, object> { { "fehler", "Die Beispielkarte konnte nicht geladen werden." }, { "technisch", e.Message } };
                }
            }
        }

        // Route im Rundgang: Es gibt nur die vorbereitete Beispielroute (uebung/routen), BRouter läuft dafür nicht
        static void UebungRoute(HttpListenerContext ctx, string ordner, Dictionary<string, string> q)
        {
            string rOrdner = Path.Combine(ordner, "routen");
            var info = UebungJson(Path.Combine(rOrdner, "routen.json"));
            string ll, profil, alt;
            q.TryGetValue("lonlats", out ll);
            if (!q.TryGetValue("profile", out profil)) profil = "";
            if (!q.TryGetValue("alternativeidx", out alt)) alt = "0";
            bool passt = false;
            var p = (ll ?? "").Split('|');
            if (info != null && p.Length == 2)
            {
                Func<string, object[], bool> nah = (text, soll) =>
                {
                    var t = text.Split(',');
                    double lon, lat;
                    return t.Length == 2 && soll.Length == 2
                        && double.TryParse(t[0], NumberStyles.Float, CultureInfo.InvariantCulture, out lon)
                        && double.TryParse(t[1], NumberStyles.Float, CultureInfo.InvariantCulture, out lat)
                        && Math.Abs(lon - Convert.ToDouble(soll[0], CultureInfo.InvariantCulture)) < 0.003
                        && Math.Abs(lat - Convert.ToDouble(soll[1], CultureInfo.InvariantCulture)) < 0.003;
                };
                passt = nah(p[0], Arr(info, "start")) && nah(p[1], Arr(info, "ziel"));
            }
            // Mit Zusatzwerten fürs Profil („Möglichst wenig bergauf“) gibt es eine eigene Datei
            bool extra = q.Keys.Any(k => k.StartsWith("profile:"));
            string datei = SichererPfad(rOrdner, profil + "-" + alt + (extra ? "-flach" : "") + ".json");
            // Sperrung an der Beispielstelle (routen.json „sperrung“): Umweg aus <…>-gesperrt.json, wo die Route dort entlangführt
            string nogos;
            var sp = info != null && info.ContainsKey("sperrung") ? Arr(info, "sperrung") : null;
            if (passt && sp != null && sp.Length == 2 && q.TryGetValue("nogos", out nogos))
            {
                double sLon = Convert.ToDouble(sp[0], CultureInfo.InvariantCulture), sLat = Convert.ToDouble(sp[1], CultureInfo.InvariantCulture);
                bool trifft = nogos.Split('|').Any(n =>
                {
                    var t = n.Split(',');
                    double lon, lat;
                    return t.Length >= 2 && double.TryParse(t[0], NumberStyles.Float, CultureInfo.InvariantCulture, out lon)
                        && double.TryParse(t[1], NumberStyles.Float, CultureInfo.InvariantCulture, out lat)
                        && Math.Abs(lon - sLon) < 0.002 && Math.Abs(lat - sLat) < 0.0013;
                });
                string umweg = SichererPfad(rOrdner, profil + "-" + alt + (extra ? "-flach" : "") + "-gesperrt.json");
                if (trifft && umweg != null && File.Exists(umweg)) datei = umweg;
            }
            if (passt && datei != null && File.Exists(datei)) SendeUebung(ctx, File.ReadAllBytes(datei), "application/json; charset=utf-8");
            else SendeText(ctx, 400, (info != null ? Str(info, "fehler") : null) ?? "Im Beispiel gibt es nur eine Route.");
        }

        // ------------------------------------------------------------------ Rundgang: Eigene Unterlagen
        // Im Kapitel „Eigene Unterlagen“ liegen die hinzugefügte Beispieldatei, Notizen und gesicherte Webseiten nur hier
        // im Speicher, nie in daten/eigene. Beispieldatei und die einzige Beispiel-Webseite: uebung/eigene/daten.json.
        // Den Text für Suche und KI liest die Seite selbst aus (wie sonst auch) und schickt ihn an eigene/text.
        class UebungEintrag
        {
            public string Datei, Html, Url, Name, Ordner, Datum;
            public bool Web;
            public long Groesse;
            public int Stand = 1;
            public string[] Seiten;
            public DateTime Geaendert = DateTime.Now;
            public string Schluessel { get { return Web ? "web:" + Ordner : Datei; } }
            public string Kennung { get { return "uebung-" + Stand; } }
        }
        static List<UebungEintrag> uebungEigene;

        static List<UebungEintrag> UebungEigeneListe()
        {
            if (uebungEigene == null) uebungEigene = new List<UebungEintrag>();
            return uebungEigene;
        }

        static void UebungWebSenden(HttpListenerContext ctx, string html)
        {
            ctx.Response.AddHeader("Content-Security-Policy", WebCsp);
            ctx.Response.AddHeader("Referrer-Policy", "no-referrer");
            SendeUebung(ctx, Utf8.GetBytes(html), "text/html; charset=utf-8");
        }

        // /gesichert/<ordner>/index.html im Rundgang
        static void UebungGesichert(HttpListenerContext ctx, string pfad)
        {
            string rel;
            try { rel = Uri.UnescapeDataString(pfad.Substring(11)); } catch { rel = ""; }
            UebungEintrag e = null;
            if (rel.EndsWith("/index.html"))
            {
                string o = rel.Substring(0, rel.Length - 11);
                lock (UebungLk) e = UebungEigeneListe().FirstOrDefault(x => x.Web && x.Ordner == o);
            }
            if (e == null) { SendeText(ctx, 404, "Nicht gefunden"); return; }
            UebungWebSenden(ctx, e.Html);
        }

        static bool UebungEigene(HttpListenerContext ctx, string was, Dictionary<string, string> q, string ordner)
        {
            if (!was.StartsWith("eigene") && !was.StartsWith("web/") && was != "uebung/beispieldatei" && was != "pdftext/suche") return false;
            string eo = Path.Combine(ordner, "eigene");
            var info = UebungJson(Path.Combine(eo, "daten.json")) ?? new Dictionary<string, object>();
            string beispiel = Str(info, "datei") ?? "";
            var webInfo = info.ContainsKey("webseite") ? info["webseite"] as Dictionary<string, object> : null;
            Uri webUrl = webInfo != null ? WebUri(Str(webInfo, "url")) : null;
            string webFehler = "Im Rundgang gibt es nur eine Beispielseite. Schreib „" + (webInfo != null ? Str(webInfo, "anzeige") : "") + "“ in die Adresszeile.";
            Func<string, Uri> beispielSeite = s =>
            {
                var u = WebUri(s);
                return u != null && webUrl != null && WebOrdnerVon(u) == WebOrdnerVon(webUrl) ? webUrl : null;
            };
            Func<string> beispielHtml = () => File.ReadAllText(Path.Combine(eo, Str(webInfo, "datei")), Utf8);
            var ok = new Dictionary<string, object> { { "ok", true } };
            Func<string, Dictionary<string, object>> fehler = t => new Dictionary<string, object> { { "fehler", t } };

            if (was.StartsWith("eigene/datei/"))
            {
                string roh = ctx.Request.RawUrl ?? "";
                int i = roh.IndexOf("/eigene/datei/", StringComparison.Ordinal);
                string n = i < 0 ? "" : roh.Substring(i + 14);
                int ende = n.IndexOfAny(new[] { '?', '#' });
                if (ende >= 0) n = n.Substring(0, ende);
                string name;
                try { name = Uri.UnescapeDataString(n); } catch { name = ""; }
                UebungEintrag e;
                lock (UebungLk) e = UebungEigeneListe().FirstOrDefault(x => !x.Web && x.Datei == name);
                if (e == null) SendeText(ctx, 404, "Nicht gefunden");
                else if (e.Html != null) UebungWebSenden(ctx, NotizHtml(Path.GetFileNameWithoutExtension(e.Datei), e.Html));
                else SendeDatei(ctx, SichererPfad(eo, beispiel));
                return true;
            }
            if (was == "pdftext/suche")
            {
                if (!q.ContainsKey("buch") || q["buch"] != EigenePaket) return false;
                var b = new PdfBuch { Stand = DateTime.Now };
                long zeichen = 0, seiten = 0;
                lock (UebungLk)
                    foreach (var e in UebungEigeneListe().Where(x => x.Seiten != null))
                    {
                        b.Dateien.Add(new PdfDatei { Datei = e.Schluessel, Titel = e.Web ? e.Name : Path.GetFileNameWithoutExtension(e.Datei), Seiten = e.Seiten });
                        foreach (var s in e.Seiten) zeichen += s.Length;
                        seiten += e.Seiten.Length;
                    }
                if (seiten > 0) b.Schnitt = Math.Max(1.0, (double)zeichen / seiten);
                int anzahl;
                if (!q.ContainsKey("n") || !int.TryParse(q["n"], out anzahl)) anzahl = 5;
                SendeJson(ctx, PdfSuche(EigenePaket, q.ContainsKey("q") ? q["q"] : "", Math.Min(20, Math.Max(1, anzahl)), b));
                return true;
            }
            // Online-Ansicht im Browser von Fieldbook: nur die Beispielseite, sonst eine Meldung wie bei einer echten Seite
            if (was == "web/ansehen")
            {
                var u = beispielSeite(q.ContainsKey("url") ? q["url"] : "");
                if (u != null) UebungWebSenden(ctx, WebZumAnsehen(beispielHtml(), u));
                else UebungWebSenden(ctx, "<!doctype html><meta charset=\"utf-8\"><meta name=\"fieldbook-fehler\" content=\"1\"><title>Nicht geöffnet</title>" +
                    "<body style=\"font:16px Segoe UI,sans-serif;padding:32px;color:#ddd;background:#1b1d1a\"><p>" +
                    Regex.Replace(HtmlAttr(webFehler), @"([.?!]) (?=[A-ZÄÖÜ])", "$1<br>") + "</p>");
                return true;
            }

            var body = ctx.Request.HttpMethod == "POST" ? LeseBody(ctx) : new Dictionary<string, object>();
            object antwort;
            lock (UebungLk)
            {
                var liste = UebungEigeneListe();
                Func<string, UebungEintrag> datei = d => liste.FirstOrDefault(x => !x.Web && x.Datei == d);
                Func<string, UebungEintrag> seite = o => liste.FirstOrDefault(x => x.Web && x.Ordner == o);
                switch (was)
                {
                    case "eigene":
                        antwort = new Dictionary<string, object> {
                            { "dateien", liste.Select(e => (object)(e.Web
                                ? new Dictionary<string, object> { { "datei", e.Schluessel }, { "web", true }, { "name", e.Name }, { "url", e.Url },
                                    { "ordner", e.Ordner }, { "adresse", WebAdresseVonOrdner(e.Ordner) }, { "datum", e.Datum }, { "gruppe", "" },
                                    { "groesse", e.Html.Length }, { "geaendert", e.Geaendert.ToString("s") }, { "kennung", e.Kennung },
                                    { "auslesen", e.Seiten == null }, { "text", e.Seiten != null && e.Seiten.Any(s => !string.IsNullOrWhiteSpace(s)) } }
                                : new Dictionary<string, object> { { "datei", e.Datei }, { "groesse", e.Html != null ? e.Html.Length : e.Groesse },
                                    { "geaendert", e.Geaendert.ToString("s") }, { "gruppe", "" }, { "kennung", e.Kennung },
                                    { "auslesen", e.Seiten == null }, { "text", e.Seiten != null && e.Seiten.Any(s => !string.IsNullOrWhiteSpace(s)) } })).ToList() },
                            { "gruppen", new object[0] } };
                        break;
                    // „Datei hinzufügen“ im Rundgang: die Beispieldatei statt der Dateiauswahl von Windows
                    case "uebung/beispieldatei":
                        if (datei(beispiel) == null)
                        {
                            var fi = new FileInfo(Path.Combine(eo, beispiel));
                            liste.Add(new UebungEintrag { Datei = beispiel, Groesse = fi.Exists ? fi.Length : 0 });
                        }
                        antwort = new Dictionary<string, object> { { "ok", true }, { "datei", beispiel } };
                        break;
                    case "eigene/hochladen":
                        antwort = fehler("Im Rundgang nimmst du die Beispieldatei.");
                        break;
                    case "eigene/ordner":
                        antwort = ok;
                        break;
                    case "eigene/text":
                        {
                            string d = Str(body, "datei") ?? "";
                            var e = liste.FirstOrDefault(x => x.Schluessel == d);
                            if (e != null && e.Kennung == Str(body, "kennung")) e.Seiten = Arr(body, "seiten").Select(x => x as string ?? "").ToArray();
                            antwort = ok;
                            break;
                        }
                    case "eigene/umbenennen":
                        {
                            var e = datei(Str(body, "datei") ?? "");
                            if (e == null) { antwort = fehler("Datei nicht gefunden."); break; }
                            string ext = Path.GetExtension(e.Datei);
                            string neu = EigenerName(Str(body, "neu"));
                            if (neu.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) neu = neu.Substring(0, neu.Length - ext.Length).TrimEnd('.', ' ');
                            if (neu.Length == 0) { antwort = fehler("Bitte einen Namen eingeben."); break; }
                            neu += ext;
                            if (liste.Any(x => x != e && !x.Web && string.Equals(x.Datei, neu, StringComparison.OrdinalIgnoreCase))) { antwort = fehler("Es gibt schon eine Datei mit diesem Namen."); break; }
                            e.Datei = neu;
                            antwort = new Dictionary<string, object> { { "ok", true }, { "datei", neu } };
                            break;
                        }
                    case "eigene/loeschen":
                        liste.RemoveAll(x => !x.Web && x.Datei == (Str(body, "datei") ?? ""));
                        antwort = ok;
                        break;
                    case "eigene/notiz/neu":
                        {
                            string titel = EigenerName(Str(body, "titel") ?? "");
                            if (titel.Length == 0) titel = "Neue Notiz";
                            string n = titel + ".html";
                            for (int i = 2; datei(n) != null; i++) n = titel + " (" + i + ").html";
                            liste.Add(new UebungEintrag { Datei = n, Html = "<p><br></p>" });
                            antwort = new Dictionary<string, object> { { "ok", true }, { "datei", n } };
                            break;
                        }
                    case "eigene/notiz/speichern":
                        {
                            var e = datei(Str(body, "datei") ?? "");
                            if (e == null || e.Html == null) { antwort = fehler("Diese Notiz gibt es nicht mehr."); break; }
                            e.Html = Str(body, "html") ?? "";
                            e.Stand++;
                            e.Seiten = null;
                            e.Geaendert = DateTime.Now;
                            antwort = new Dictionary<string, object> { { "ok", true }, { "kennung", e.Kennung } };
                            break;
                        }
                    // Rundgang „Zurück“ (js/rundgang.js): nimmt zurück, was man im Schritt angelegt hat
                    case "eigene/uebung-zurueck":
                        {
                            string z = Str(body, "was") ?? "";
                            if (z == "datei") liste.RemoveAll(x => !x.Web && x.Html == null);
                            if (z == "notiz") liste.RemoveAll(x => x.Html != null && !x.Web);
                            if (z == "webseite") liste.RemoveAll(x => x.Web);
                            var notiz = liste.FirstOrDefault(x => !x.Web && x.Html != null);
                            if (notiz != null && z == "notizName") notiz.Datei = "Neue Notiz.html";
                            if (notiz != null && z == "notizText") { notiz.Html = "<p><br></p>"; notiz.Stand++; notiz.Seiten = null; }
                            antwort = ok;
                            break;
                        }
                    case "web/holen":
                        {
                            var u = beispielSeite(Str(body, "url"));
                            antwort = u == null ? fehler(webFehler) : new Dictionary<string, object> { { "html", beispielHtml() }, { "url", u.AbsoluteUri }, { "gerendert", true } };
                            break;
                        }
                    case "web/dateien":
                        {
                            var u = WebUri(Str(body, "url"));
                            antwort = u == null ? fehler("Ungültige Adresse.") : new Dictionary<string, object> { { "karte", new Dictionary<string, object>() }, { "ordner", WebOrdnerVon(u) } };
                            break;
                        }
                    case "web/speichern":
                        {
                            var u = WebUri(Str(body, "url"));
                            string html = Str(body, "html");
                            if (u == null || string.IsNullOrEmpty(html)) { antwort = fehler("Die Seite ließ sich nicht speichern."); break; }
                            string o = WebOrdnerVon(u);
                            string name = (Str(body, "name") ?? "").Trim();
                            var e = seite(o);
                            if (e == null) { e = new UebungEintrag { Web = true, Ordner = o, Url = u.AbsoluteUri, Name = name.Length > 0 ? name : u.Host }; liste.Add(e); }
                            else if (name.Length > 0) e.Name = name;
                            e.Html = html;
                            e.Datum = DateTime.Now.ToString("s");
                            e.Stand++;
                            e.Seiten = null;
                            antwort = new Dictionary<string, object> { { "ok", true }, { "ordner", o } };
                            break;
                        }
                    case "web/html":
                        {
                            var e = seite(Str(body, "ordner") ?? "");
                            if (e != null && !string.IsNullOrEmpty(Str(body, "html"))) { e.Html = Str(body, "html"); e.Stand++; e.Seiten = null; }
                            antwort = ok;
                            break;
                        }
                    case "web/liste":
                        antwort = new Dictionary<string, object> { { "seiten", liste.Where(x => x.Web).Select(e => (object)new Dictionary<string, object> {
                            { "ordner", e.Ordner }, { "url", e.Url }, { "name", e.Name }, { "datum", e.Datum }, { "adresse", WebAdresseVonOrdner(e.Ordner) }, { "gruppe", "" } }).ToList() } };
                        break;
                    case "web/umbenennen":
                        {
                            var e = seite(Str(body, "ordner") ?? "");
                            string name = (Str(body, "name") ?? "").Trim();
                            if (e != null && name.Length > 0) e.Name = name;
                            antwort = ok;
                            break;
                        }
                    case "web/loeschen":
                        liste.RemoveAll(x => x.Web && x.Ordner == (Str(body, "ordner") ?? ""));
                        antwort = ok;
                        break;
                    case "web/fenster":
                        antwort = new Dictionary<string, object> { { "offen", false }, { "seiten", new object[0] } };
                        break;
                    case "web/gruppen":
                        antwort = fehler("Ordner zum Sortieren gibt es im Rundgang nicht.");
                        break;
                    default:
                        // Ordner, Browserfenster und alles andere: im Rundgang nicht
                        antwort = was.StartsWith("web/fenster") ? (object)fehler(webFehler) : ok;
                        break;
                }
            }
            SendeJson(ctx, antwort);
            return true;
        }

        static bool Uebung(HttpListenerContext ctx, string pfad)
        {
            var c = ctx.Request.Cookies["fb-uebung"];
            if (c == null || c.Value != "1") return false;
            // Gesicherte Webseiten kommen im Rundgang nur aus dem Speicher (Kapitel Eigene Unterlagen)
            if (pfad.StartsWith("/gesichert/")) { UebungGesichert(ctx, pfad); return true; }
            bool api = pfad.StartsWith("/api/"), karte = pfad.StartsWith("/karten/"), route = pfad.StartsWith("/route/");
            if (!api && !karte && !route && !(pfad == "/kiwix" || pfad.StartsWith("/kiwix/"))) return false;
            // Statt der installierten Karten nur die Beispielkarte
            if (karte) { SendeDatei(ctx, SichererPfad(BeispielKartenOrdner, pfad.Substring(8))); return true; }
            string ordner = Path.Combine(Web, "uebung");
            var q = new Dictionary<string, string>();
            foreach (var teil in ctx.Request.Url.Query.TrimStart('?').Split('&'))
            {
                if (teil.Length == 0) continue;
                int i = teil.IndexOf('=');
                string k = Uri.UnescapeDataString((i < 0 ? teil : teil.Substring(0, i)).Replace('+', ' '));
                q[k] = i < 0 ? "" : Uri.UnescapeDataString(teil.Substring(i + 1).Replace('+', ' '));
            }
            if (route) { UebungRoute(ctx, ordner, q); return true; }

            if (api)
            {
                string was = pfad.Substring(5);
                // KI ein- und ausschalten (Kapitel KI): nur die Beispiel-KI der Übung, die echte bleibt, wie sie ist.
                // Die Antwort ist wie beim echten Schalter der neue Status.
                if (was == "ki" && ctx.Request.HttpMethod == "POST")
                {
                    var b = LeseBody(ctx);
                    lock (UebungLk) uebungKiAus = !Bool(b, "an");
                    was = "status";
                }
                if (was == "status")
                {
                    // Echter Status (Akku, Version), Bibliothek und KI sind die der Übung
                    var s = Status();
                    var extra = UebungJson(Path.Combine(ordner, "status.json"));
                    if (extra != null) foreach (var kv in extra) s[kv.Key] = kv.Value;
                    // Beispielkarte noch nicht geladen: dann gibt es in der Übung keine Karte
                    string bk = BeispielKartePfad();
                    if (bk == null || !File.Exists(bk)) s["karten"] = new object[0];
                    UebungKi(s);
                    SendeJson(ctx, s);
                    return true;
                }
                if (ctx.Request.HttpMethod == "GET" && UebungEcht.Contains(was)) return false;
                if (was == "uebung/beispielkarte") return false;
                if (UebungEigene(ctx, was, q, ordner)) return true;
                // Ortssuche: nur Orte im Ausschnitt der Beispielkarte (uebung/api/orte.json), Name enthält den Suchtext
                if (was == "orte")
                {
                    string such = q.ContainsKey("q") ? q["q"].Trim() : "";
                    var alle = UebungJson(Path.Combine(ordner, "api", "orte.json"));
                    var treffer = (alle != null ? Arr(alle, "liste") : new object[0]).OfType<Dictionary<string, object>>()
                        .Where(o => such.Length >= 2 && (Str(o, "name") ?? "").IndexOf(such, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
                    SendeJson(ctx, treffer);
                    return true;
                }
                // Straßensuche: Orte und Postleitzahl der Beispielkarte aus uebung/api/adresse.json
                if (was == "adresse")
                {
                    SendeJson(ctx, UebungAdresse(q.ContainsKey("q") ? q["q"] : "", UebungJson(Path.Combine(ordner, "api", "adresse.json"))));
                    return true;
                }
                // Einrichtungen (Apotheke, Trinkwasser …) und Straßen liest die Karte selbst aus den Kacheln; nichts davon speichern
                if (was == "einrichtungen" || was == "strassen")
                {
                    if (ctx.Request.HttpMethod == "POST") SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    else SendeText(ctx, 200, "");
                    return true;
                }
                // Gemerkte Orte: wie die Merkliste nur im Speicher (Beispiel aus uebung/api/meineorte.json)
                if (was == "meineorte")
                {
                    lock (UebungLk)
                    {
                        if (uebungOrte == null) uebungOrte = UebungJson(Path.Combine(ordner, "api", "meineorte.json")) ?? new Dictionary<string, object> { { "orte", new object[0] } };
                        if (ctx.Request.HttpMethod == "POST")
                        {
                            var b = LeseBody(ctx);
                            if (b.ContainsKey("orte")) uebungOrte = b;
                            SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        }
                        else SendeJson(ctx, uebungOrte);
                    }
                    return true;
                }
                // Sperrungen: genauso nur im Speicher, beim Start leer
                if (was == "sperrungen")
                {
                    lock (UebungLk)
                    {
                        if (uebungSperrungen == null) uebungSperrungen = new Dictionary<string, object> { { "sperrungen", new object[0] } };
                        if (ctx.Request.HttpMethod == "POST")
                        {
                            var b = LeseBody(ctx);
                            if (b.ContainsKey("sperrungen")) uebungSperrungen = b;
                            SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        }
                        else SendeJson(ctx, uebungSperrungen);
                    }
                    return true;
                }
                // Vorlesen spricht nur den mitgeschickten Text, das darf in der Übung echt laufen
                if (was == "vorlesen") return false;
                // Merkliste und „Zuletzt gelesen“ reagieren in der Übung echt, aber nur im Speicher (beim Start des Rundgangs leer bzw. Beispiel)
                if (was == "uebung/neu" || was == "zuletzt" || was == "zuletzt/merken" || was == "zuletzt/leeren" || was == "merkliste" || was == "merkliste/aendern")
                {
                    var b = ctx.Request.HttpMethod == "POST" ? LeseBody(ctx) : new Dictionary<string, object>();
                    lock (UebungLk)
                    {
                        if (was == "uebung/neu" || uebungZuletzt == null)
                        {
                            var z = UebungJson(Path.Combine(ordner, "api", "zuletzt.json"));
                            uebungZuletzt = z != null && z.ContainsKey("liste") ? Arr(z, "liste").OfType<Dictionary<string, object>>().ToList() : new List<Dictionary<string, object>>();
                            uebungMerk = new List<Dictionary<string, object>>();
                            uebungOrte = null;
                            uebungSperrungen = null;
                            uebungEigene = null;
                            uebungKiAus = false;
                        }
                        if (was == "zuletzt/merken" && !string.IsNullOrEmpty(Str(b, "url")))
                        {
                            uebungZuletzt.RemoveAll(x => Str(x, "url") == Str(b, "url"));
                            uebungZuletzt.Insert(0, new Dictionary<string, object> { { "url", Str(b, "url") }, { "titel", Kuerzen(Str(b, "titel"), 200) }, { "paket", Str(b, "paket") ?? "" } });
                            if (uebungZuletzt.Count > 10) uebungZuletzt.RemoveRange(10, uebungZuletzt.Count - 10);
                        }
                        if (was == "zuletzt/leeren") uebungZuletzt.Clear();
                        if (was == "merkliste/aendern")
                        {
                            string url = Str(b, "url") ?? "", id = Str(b, "id") ?? "";
                            // Seiten in Fieldbook (z. B. eine Lektion der Ersten Hilfe) merkt die Übung auch, mit „link“ statt „url“
                            string link = Str(b, "link") ?? "";
                            bool seitenLink = url.Length == 0 && Regex.IsMatch(link, "^#(erstehilfe|vorsorge|kochen)\\?[^\\s]{1,300}$");
                            if (Str(b, "aktion") == "setzen" && (url.StartsWith("/kiwix/") || seitenLink))
                            {
                                // Ganzer Artikel und gemerkte Textstellen sind eigene Einträge
                                string stelle = Kuerzen(Str(b, "stelle"), 1500);
                                uebungMerk.RemoveAll(x => (Str(x, "url") ?? "") == url && (Str(x, "link") ?? "") == link && (Str(x, "stelle") ?? "") == stelle);
                                if (Bool(b, "an"))
                                {
                                    var neu = new Dictionary<string, object> { { "id", MerkId() }, { "titel", Kuerzen(Str(b, "titel"), 200) },
                                        { "bereich", seitenLink ? link.Substring(1, link.IndexOf('?') - 1) : "bibliothek" }, { "ordner", "" }, { "paket", Str(b, "paket") ?? "" }, { "pdf", false }, { "zeit", DateTime.Now.ToString("s") } };
                                    if (seitenLink) neu["link"] = link; else neu["url"] = url;
                                    if (stelle.Length > 0) neu["stelle"] = stelle;
                                    uebungMerk.Insert(0, neu);
                                }
                            }
                            else if (Str(b, "aktion") == "entfernen") uebungMerk.RemoveAll(x => Str(x, "id") == id);
                        }
                        if (was.StartsWith("zuletzt")) SendeJson(ctx, new Dictionary<string, object> { { "liste", uebungZuletzt.ToList() } });
                        else SendeJson(ctx, new Dictionary<string, object> { { "ordner", new object[0] }, { "liste", uebungMerk.ToList() } });
                    }
                    return true;
                }
                string datei = SichererPfad(Path.Combine(ordner, "api"), was + ".json");
                if (datei != null && File.Exists(datei)) SendeUebung(ctx, File.ReadAllBytes(datei), "application/json; charset=utf-8");
                else SendeJson(ctx, new Dictionary<string, object>());
                return true;
            }

            string rest = pfad.Length > 7 ? pfad.Substring(7) : "";
            var buecher = UebungBuecher(ordner);
            if (rest.StartsWith("catalog/"))
            {
                string xml = Path.Combine(ordner, "kiwix", "katalog.xml");
                if (rest.StartsWith("catalog/v2/entries") && File.Exists(xml)) SendeUebung(ctx, File.ReadAllBytes(xml), "application/atom+xml; charset=utf-8");
                else SendeText(ctx, 404, "Nicht gefunden");
                return true;
            }
            if (rest == "viewer") { SendeUebung(ctx, File.ReadAllBytes(Path.Combine(ordner, "kiwix", "viewer.html")), "text/html; charset=utf-8"); return true; }
            if (rest == "suggest" || rest == "search")
            {
                string buch = q.ContainsKey("books.name") ? q["books.name"] : q.ContainsKey("content") ? q["content"] : "";
                string begriff = q.ContainsKey("term") ? q["term"] : q.ContainsKey("pattern") ? q["pattern"] : "";
                int anzahl = 10;
                string n;
                if (q.TryGetValue(rest == "suggest" ? "count" : "pageLength", out n)) int.TryParse(n, out anzahl);
                var treffer = UebungSuche(buecher, buch, begriff, rest == "suggest").Take(Math.Max(1, anzahl)).ToList();
                if (rest == "suggest")
                {
                    SendeJson(ctx, treffer.Select(t => new Dictionary<string, object> { { "value", t["titel"] }, { "label", t["titel"] }, { "kind", "path" }, { "path", t["pfad"] } }).ToList());
                }
                else if (q.ContainsKey("format") && q["format"] == "xml")
                {
                    var sb = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?><rss><channel>");
                    foreach (var t in treffer)
                        sb.Append("<item><title>" + System.Security.SecurityElement.Escape(Str(t, "titel")) + "</title><link>/kiwix/content/" + Uri.EscapeDataString(buch) + "/" + System.Security.SecurityElement.Escape(Str(t, "pfad")) +
                            "</link><description>" + System.Security.SecurityElement.Escape(Str(t, "auszug")) + "</description></item>");
                    sb.Append("</channel></rss>");
                    SendeUebung(ctx, Utf8.GetBytes(sb.ToString()), "application/rss+xml; charset=utf-8");
                }
                else
                {
                    // Trefferliste im Lesefenster (Suche oben im Lesefenster), aufgebaut wie die von Kiwix (Vorlage suche.html)
                    var b = buecher.ContainsKey(buch) ? buecher[buch] as Dictionary<string, object> : null;
                    string buchTitel = (b != null ? Str(b, "buchTitel") : null) ?? buch;
                    var sb = new StringBuilder();
                    foreach (var t in treffer)
                    {
                        sb.Append("          <li>\n            <a href=\"/kiwix/content/" + Uri.EscapeDataString(buch) + "/" + WebUtility.HtmlEncode(Str(t, "pfad")) + "\">\n              " +
                            WebUtility.HtmlEncode(Str(t, "titel")) + "\n            </a>\n              <cite>..." + WebUtility.HtmlEncode(Str(t, "auszug")) + "...</cite>\n" +
                            "              <div class=\"book-title\">from " + WebUtility.HtmlEncode(buchTitel) + "</div>\n");
                        if (t.ContainsKey("woerter")) sb.Append("              <div class=\"informations\">" + Convert.ToInt32(t["woerter"]).ToString("N0", CultureInfo.InvariantCulture) + " words</div>\n");
                        sb.Append("          </li>\n");
                    }
                    string kopf = treffer.Count == 0 ? "No results were found for <b>\"" + WebUtility.HtmlEncode(begriff) + "\"</b>"
                        : "Results <b>1-" + treffer.Count + "</b> of <b>" + treffer.Count + "</b> for <b>\"" + WebUtility.HtmlEncode(begriff) + "\"</b>";
                    string html = File.ReadAllText(Path.Combine(ordner, "kiwix", "suche.html"), Utf8)
                        .Replace("{{BEGRIFF}}", WebUtility.HtmlEncode(begriff)).Replace("{{KOPF}}", kopf).Replace("{{TREFFER}}", sb.ToString());
                    SendeUebung(ctx, ArtikelDesign(Utf8.GetBytes(html)), "text/html; charset=utf-8");
                }
                return true;
            }
            if (rest.StartsWith("content/"))
            {
                string r2 = rest.Substring(8);
                int i = r2.IndexOf('/');
                string id = Uri.UnescapeDataString(i < 0 ? r2 : r2.Substring(0, i));
                string artikel = i < 0 ? "" : r2.Substring(i + 1);
                var b = buecher.ContainsKey(id) ? buecher[id] as Dictionary<string, object> : null;
                if (b == null) { SendeText(ctx, 404, "Nicht gefunden"); return true; }
                if (artikel == "")
                {
                    // Wie Kiwix: das Paket selbst leitet zur Startseite weiter
                    ctx.Response.StatusCode = 302;
                    ctx.Response.RedirectLocation = "/kiwix/content/" + Uri.EscapeDataString(id) + "/" + Str(b, "start");
                    return true;
                }
                string datei = UebungDatei(Path.Combine(ordner, "kiwix", "inhalt", id), artikel);
                // Beispielartikel einzelner Kapitel liegen in uebung/<kapitel>/kiwix/inhalt (z. B. Kochen)
                foreach (var kap in Directory.GetDirectories(ordner))
                    if (datei == null || !File.Exists(datei)) datei = UebungDatei(Path.Combine(kap, "kiwix", "inhalt", id), artikel) ?? datei;
                if (datei == null || !File.Exists(datei))
                {
                    // Artikel, die im Beispielpaket fehlen (Links in echten Seiten): freundliche Seite statt „Nicht gefunden“
                    if (artikel.StartsWith("_") || Path.HasExtension(artikel)) { SendeText(ctx, 404, "Nicht gefunden"); return true; }
                    string seite = "<!DOCTYPE html><html lang=\"de\"><head><meta charset=\"utf-8\"><title>Nicht im Beispielpaket</title></head><body>" +
                        "<h1>Nicht im Beispielpaket</h1><p>Dieser Artikel gehört nicht zum Beispiel des Rundgangs.<br>Im echten Paket steht er hier.</p>" +
                        "<p><a href=\"javascript:history.back()\">Zurück</a></p></body></html>";
                    SendeUebung(ctx, ArtikelDesign(Utf8.GetBytes(seite)), "text/html; charset=utf-8");
                    return true;
                }
                if (datei.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
                    SendeUebung(ctx, ctx.Request.HttpMethod == "HEAD" ? new byte[0] : ArtikelDesign(File.ReadAllBytes(datei)), "text/html; charset=utf-8");
                else SendeDatei(ctx, datei);
                return true;
            }
            SendeText(ctx, 404, "Nicht gefunden");
            return true;
        }

        // Datei eines Beispielartikels (auch ohne „.html“ in der Adresse); null, wenn die Adresse aus dem Ordner führt
        static string UebungDatei(string basis, string artikel)
        {
            string datei = SichererPfad(basis, artikel);
            if (datei != null && !File.Exists(datei) && File.Exists(datei + ".html")) datei += ".html";
            return datei;
        }

        // Bücher der Übung aus uebung/kiwix/artikel.json; Kapitel mit eigenen Beispielartikeln (uebung/<kapitel>/kiwix/artikel.json)
        // hängen ihre Artikel an dasselbe Paket an
        static Dictionary<string, object> UebungBuecher(string ordner)
        {
            var buecher = UebungJson(Path.Combine(ordner, "kiwix", "artikel.json")) ?? new Dictionary<string, object>();
            foreach (var kap in Directory.GetDirectories(ordner))
            {
                var dazu = UebungJson(Path.Combine(kap, "kiwix", "artikel.json"));
                if (dazu == null) continue;
                foreach (var kv in dazu)
                {
                    var neu = kv.Value as Dictionary<string, object>;
                    if (neu == null) continue;
                    var alt = buecher.ContainsKey(kv.Key) ? buecher[kv.Key] as Dictionary<string, object> : null;
                    if (alt == null) { buecher[kv.Key] = neu; continue; }
                    var liste = new List<object>();
                    foreach (var name in new[] { alt, neu })
                    {
                        var a = name.ContainsKey("artikel") ? name["artikel"] as System.Collections.IEnumerable : null;
                        if (a != null) foreach (var x in a) liste.Add(x);
                    }
                    alt["artikel"] = liste;
                }
            }
            return buecher;
        }

        static Dictionary<string, object> UebungJson(string datei)
        {
            try { return File.Exists(datei) ? Json.DeserializeObject(File.ReadAllText(datei, Utf8)) as Dictionary<string, object> : null; }
            catch { return null; }
        }

        // Artikel der Übungs-Bibliothek, in denen jedes Suchwort vorkommt (Vorschläge: nur im Titel)
        static IEnumerable<Dictionary<string, object>> UebungSuche(Dictionary<string, object> buecher, string buch, string begriff, bool nurTitel)
        {
            var b = buecher.ContainsKey(buch) ? buecher[buch] as Dictionary<string, object> : null;
            var liste = b != null && b.ContainsKey("artikel") ? b["artikel"] as System.Collections.IEnumerable : null;
            var woerter = (begriff ?? "").ToLowerInvariant().Split(new[] { ' ', ',', '?', '!', '.' }, StringSplitOptions.RemoveEmptyEntries).Where(w => w.Length >= 2).ToArray();
            if (liste == null || woerter.Length == 0) yield break;
            foreach (var o in liste)
            {
                var a = o as Dictionary<string, object>;
                if (a == null) continue;
                string text = (Str(a, "titel") + " " + (nurTitel ? "" : Str(a, "auszug") + " " + Str(a, "stichwoerter"))).ToLowerInvariant();
                if (woerter.All(w => text.Contains(w))) yield return a;
            }
        }

        static void SendeUebung(HttpListenerContext ctx, byte[] b, string typ)
        {
            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = typ;
            ctx.Response.AddHeader("Cache-Control", "no-store");
            ctx.Response.ContentLength64 = b.Length;
            if (ctx.Request.HttpMethod != "HEAD") ctx.Response.OutputStream.Write(b, 0, b.Length);
        }

        static void SendeDatei(HttpListenerContext ctx, string pfad)
        {
            var res = ctx.Response;
            if (pfad == null || !File.Exists(pfad)) { SendeText(ctx, 404, "Nicht gefunden"); return; }
            var fi = new FileInfo(pfad);
            string typ;
            res.ContentType = Mime.TryGetValue(fi.Extension, out typ) ? typ : "application/octet-stream";
            res.AddHeader("Accept-Ranges", "bytes");
            // Der Browser soll den Dateityp nicht erraten (z. B. eine Textdatei mit HTML darin nie als Webseite öffnen)
            res.AddHeader("X-Content-Type-Options", "nosniff");
            // Immer nachfragen (no-cache), aber mit ETag/Last-Modified: unverändert gibt es nur ein kurzes 304.
            // Auch Karten (.pmtiles/.pbf): nach einem Karten-Update sonst alte Kacheln aus dem Browser-Cache.
            DateTime geaendert = fi.LastWriteTimeUtc;
            string etag = "\"" + geaendert.Ticks.ToString("x") + "-" + fi.Length.ToString("x") + "\"";
            res.AddHeader("Cache-Control", "no-cache");
            res.AddHeader("ETag", etag);
            res.AddHeader("Last-Modified", geaendert.ToString("r", CultureInfo.InvariantCulture));
            // Länge 0 setzen: sonst schickt HttpListener evtl. einen leeren Chunked-Rumpf, den der Browser bei 304 nicht liest
            if (NichtGeaendert(ctx.Request, etag, geaendert)) { res.StatusCode = 304; res.ContentLength64 = 0; return; }
            long start = 0, ende = fi.Length - 1;
            string range = ctx.Request.Headers["Range"];
            if (range != null)
            {
                var m = Regex.Match(range, @"bytes=(\d*)-(\d*)");
                // Ungültige Angaben ("bytes=-", zu große Zahlen) werden ignoriert: dann die ganze Datei
                long von = 0, bis = ende, zahl;
                bool gueltig;
                if (!m.Success) gueltig = false;
                else if (m.Groups[1].Value == "")
                {
                    gueltig = long.TryParse(m.Groups[2].Value, out zahl);
                    if (gueltig) von = Math.Max(0, fi.Length - zahl);
                }
                else
                {
                    gueltig = long.TryParse(m.Groups[1].Value, out zahl);
                    von = zahl;
                    if (gueltig && m.Groups[2].Value != "")
                    {
                        gueltig = long.TryParse(m.Groups[2].Value, out zahl);
                        bis = Math.Min(ende, zahl);
                    }
                }
                if (gueltig)
                {
                    start = von; ende = bis;
                    if (start > ende || start >= fi.Length)
                    {
                        res.StatusCode = 416;
                        res.AddHeader("Content-Range", "bytes */" + fi.Length);
                        return;
                    }
                    res.StatusCode = 206;
                    res.AddHeader("Content-Range", "bytes " + start + "-" + ende + "/" + fi.Length);
                }
            }
            long laenge = ende - start + 1;
            res.ContentLength64 = laenge;
            if (ctx.Request.HttpMethod == "HEAD") return;
            using (var fs = new FileStream(pfad, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                fs.Seek(start, SeekOrigin.Begin);
                var buf = new byte[65536];
                while (laenge > 0)
                {
                    int n = fs.Read(buf, 0, (int)Math.Min(buf.Length, laenge));
                    if (n <= 0) break;
                    res.OutputStream.Write(buf, 0, n);
                    laenge -= n;
                }
            }
        }

        // Bedingte Anfrage: hat der Browser diesen Stand schon? If-None-Match hat Vorrang vor If-Modified-Since.
        static bool NichtGeaendert(HttpListenerRequest rq, string etag, DateTime geaendertUtc)
        {
            if (rq.HttpMethod != "GET" && rq.HttpMethod != "HEAD") return false;
            string inm = rq.Headers["If-None-Match"];
            if (inm != null)
            {
                foreach (var teil in inm.Split(','))
                {
                    string e = teil.Trim();
                    if (e.StartsWith("W/")) e = e.Substring(2);
                    if (e == "*" || e == etag) return true;
                }
                return false;
            }
            string ims = rq.Headers["If-Modified-Since"];
            DateTime d;
            if (ims == null || !DateTime.TryParse(ims, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out d)) return false;
            // Last-Modified kennt nur ganze Sekunden
            return geaendertUtc.AddTicks(-(geaendertUtc.Ticks % TimeSpan.TicksPerSecond)) <= d;
        }

        static readonly HashSet<string> NichtKopieren = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "Content-Length", "Transfer-Encoding", "Connection", "Keep-Alive", "Server", "Date", "Content-Type", "Location" };

        // .NET schneidet Punkte am Ende eines Pfadteils ab ("verdura./176032" → "verdura/176032"), dann findet
        // Kiwix den Artikel nicht (iFixit-Titel enden oft mit Punkt). Als %2E kodiert bleiben sie erhalten.
        static string PunkteSchuetzen(string pfadUndQuery)
        {
            int q = pfadUndQuery.IndexOf('?');
            string pfad = q < 0 ? pfadUndQuery : pfadUndQuery.Substring(0, q);
            pfad = Regex.Replace(pfad, @"(?<=[^/])\.+(?=/|$)", m => m.Value.Replace(".", "%2E"));
            return q < 0 ? pfad : pfad + pfadUndQuery.Substring(q);
        }

        static void Weiterleiten(HttpListenerContext ctx, int port, string pfadUndQuery)
        {
            var rq = ctx.Request;
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + PunkteSchuetzen(pfadUndQuery));
            req.Method = rq.HttpMethod;
            req.AllowAutoRedirect = false;
            req.Proxy = null;
            // Kiwix antwortet schnell, hängt es, nicht 15 Minuten warten. KI und Suchhilfe brauchen für lange Antworten mehr Zeit.
            bool istKiwix = port == KiwixPort;
            int frist = istKiwix ? 60 * 1000 : 15 * 60 * 1000;
            req.Timeout = frist;
            req.ReadWriteTimeout = frist;
            req.AutomaticDecompression = DecompressionMethods.None;
            if (rq.Headers["Accept"] != null) req.Accept = rq.Headers["Accept"];
            if (rq.Headers["Range"] != null)
            {
                // Ungültige Angaben (zu große Zahlen, Ende vor Anfang) werden ignoriert
                var m = Regex.Match(rq.Headers["Range"], @"bytes=(\d+)-(\d*)");
                long von, bis;
                if (m.Success && long.TryParse(m.Groups[1].Value, out von))
                {
                    if (m.Groups[2].Value == "") req.AddRange(von);
                    else if (long.TryParse(m.Groups[2].Value, out bis) && bis >= von) req.AddRange(von, bis);
                }
            }
            // Bedingte Anfragen an Kiwix weitergeben (unverändert: kurzes 304). Nicht bei Seiten, die Fieldbook verändert
            // (HTML mit Artikel-Design/iFixit-Filter, Zusätze): dort darf nie ein 304 auf einen alten Stand kommen.
            if (istKiwix && rq.HttpMethod == "GET" && KiwixZusatz(rq.Url.AbsolutePath) == null)
            {
                string accept = rq.Headers["Accept"] ?? "", ziel = (rq.Headers["Sec-Fetch-Dest"] ?? "").ToLowerInvariant();
                bool seite = accept.IndexOf("text/html", StringComparison.OrdinalIgnoreCase) >= 0 || ziel == "document" || ziel == "iframe" || ziel == "frame";
                if (!seite)
                {
                    string inm = rq.Headers["If-None-Match"], ims = rq.Headers["If-Modified-Since"];
                    DateTime d;
                    if (inm != null) req.Headers["If-None-Match"] = inm;
                    if (ims != null && DateTime.TryParse(ims, CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out d))
                        req.IfModifiedSince = d;
                }
            }
            if (rq.HasEntityBody)
            {
                req.ContentType = rq.ContentType;
                using (var s = req.GetRequestStream()) rq.InputStream.CopyTo(s);
            }
            HttpWebResponse resp;
            try { resp = (HttpWebResponse)req.GetResponse(); }
            catch (WebException we)
            {
                resp = we.Response as HttpWebResponse;
                if (resp == null) { SendeText(ctx, 502, "Dienst nicht erreichbar: " + we.Message); return; }
            }
            using (resp)
            {
                var res = ctx.Response;
                res.StatusCode = (int)resp.StatusCode;
                if (resp.ContentType != null) res.ContentType = resp.ContentType;
                foreach (string h in resp.Headers.AllKeys)
                {
                    if (NichtKopieren.Contains(h)) continue;
                    // CORS-Freigaben der Dienste (z. B. llama-server) nicht weitergeben: fremde Seiten sollen nichts mitlesen
                    if (h.StartsWith("Access-Control-", StringComparison.OrdinalIgnoreCase)) continue;
                    try { res.AddHeader(h, resp.Headers[h]); } catch { }
                }
                string loc = resp.Headers["Location"];
                if (loc != null) res.RedirectLocation = loc.Replace("http://127.0.0.1:" + port, "");
                // 304 (nur auf weitergereichte bedingte Anfragen): ohne Inhalt, der Browser nimmt seinen Cache
                if (resp.StatusCode == HttpStatusCode.NotModified) { res.ContentLength64 = 0; return; }
                byte[] zusatz = resp.StatusCode == HttpStatusCode.OK ? KiwixZusatz(rq.Url.AbsolutePath) : null;
                if (zusatz != null) { res.Headers.Remove("ETag"); res.Headers.Remove("Last-Modified"); res.Headers.Set("Cache-Control", "no-cache"); }
                // Artikel aus Kiwix bekommen das Fieldbook-Design (Schriften, dunkle Farben), schon vor dem ersten Zeichnen
                if (rq.HttpMethod != "HEAD" && rq.Url.AbsolutePath.StartsWith("/kiwix/")
                    && resp.ContentType != null && resp.ContentType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase))
                {
                    byte[] html;
                    using (var s = resp.GetResponseStream())
                    using (var ms = new MemoryStream()) { s.CopyTo(ms); html = ArtikelDesign(IfixitSeiteFiltern(rq, ms.ToArray())); }
                    // Keine Prüfmerkmale: der Browser soll für veränderte Seiten nie bedingt nachfragen
                    res.Headers.Remove("ETag");
                    res.Headers.Remove("Last-Modified");
                    res.Headers.Set("Cache-Control", "no-cache");
                    res.ContentLength64 = html.Length;
                    res.OutputStream.Write(html, 0, html.Length);
                    return;
                }
                if (resp.ContentLength >= 0) res.ContentLength64 = resp.ContentLength + (zusatz == null ? 0 : zusatz.Length);
                else res.SendChunked = true;
                if (rq.HttpMethod == "HEAD") return;
                using (var s = resp.GetResponseStream())
                {
                    var buf = new byte[16384];
                    int n;
                    while ((n = s.Read(buf, 0, buf.Length)) > 0)
                    {
                        res.OutputStream.Write(buf, 0, n);
                        res.OutputStream.Flush();
                    }
                }
                if (zusatz != null) res.OutputStream.Write(zusatz, 0, zusatz.Length);
            }
        }

        // Stylesheet und Skript des Artikel-Designs direkt hinter <head> einsetzen (vor dem Doctype ginge die Seite
        // in den Quirks-Modus). Ohne <head> bleibt die Seite unverändert. Das kleine Skript vorne setzt Design und
        // Farbschema sofort, noch bevor ein Stylesheet geladen ist: sonst malt Chrome beim Seitenwechsel im
        // Lesefenster kurz eine weiße Fläche (neue Seite noch „hell“, Fenster drumherum dunkel).
        static readonly byte[] ArtikelKopf = Encoding.UTF8.GetBytes(
            "<script>(function(){var t='dark';try{t=localStorage.getItem('thema')||'dark';}catch(e){}" +
            "if(t==='system')t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';" +
            "var h=document.documentElement;h.setAttribute('data-fb',t==='light'?'hell':'dunkel');h.style.colorScheme=t==='light'?'light':'dark';" +
            "h.style.background=t==='light'?'#fff':'#161715';})();</script>" +
            "<link rel=\"stylesheet\" href=\"/artikel/design.css\"><script src=\"/artikel/design.js\"></script>");
        static byte[] ArtikelDesign(byte[] html)
        {
            int ende = Math.Min(html.Length, 8192);
            for (int i = 0; i + 5 < ende; i++)
            {
                if (html[i] != '<' || (html[i + 1] | 32) != 'h' || (html[i + 2] | 32) != 'e' || (html[i + 3] | 32) != 'a' || (html[i + 4] | 32) != 'd') continue;
                if (html[i + 5] != '>' && html[i + 5] != ' ') continue;
                int zu = Array.IndexOf(html, (byte)'>', i);
                if (zu < 0) break;
                var neu = new byte[html.Length + ArtikelKopf.Length];
                Buffer.BlockCopy(html, 0, neu, 0, zu + 1);
                Buffer.BlockCopy(ArtikelKopf, 0, neu, zu + 1, ArtikelKopf.Length);
                Buffer.BlockCopy(html, zu + 1, neu, zu + 1 + ArtikelKopf.Length, html.Length - zu - 1);
                return neu;
            }
            return html;
        }

        // Ergänzungen für fehlerhafte Kiwix-Pakete, an bestimmte Dateien angehängt (Dateien in app/web/kiwix-zusatz)
        static byte[] KiwixZusatz(string pfad)
        {
            string datei = null;
            if (Regex.IsMatch(pfad, @"^/kiwix/content/gutenberg_de_[^/]+/js/l10n\.js$")) datei = "gutenberg-de.js";
            if (datei == null) return null;
            try { return File.ReadAllBytes(Path.Combine(Web, "kiwix-zusatz", datei)); } catch { return null; }
        }

        // ------------------------------------------------------------------ iFixit-Übersicht
        // Das iFixit-Paket hat einen Geräte-Baum (Device/...), in dem viele Zweige keine einzige Anleitung
        // enthalten. Der Baum wird einmal im Hintergrund ausgelesen (daten/cache/ifixit-<paket>.json), danach
        // zeigt Fieldbook nur Zweige mit Anleitungen. Geräteseiten ohne Anleitung (nur Text und Datenblatt)
        // blendet Fieldbook auch in Suche, Vorschlägen, Zufall und Links aus (IfixitUmleiten, IfixitSeiteFiltern).
        // Die Liste gehört zur Paketversion: Nach einem Update wird sie für das neue Paket neu erstellt.

        public class IfixitKnoten
        {
            public string Titel, Pfad;
            public List<string> Kinder = new List<string>();
            public List<string[]> Anleitungen = new List<string[]>(); // { Titel, Pfad }
            public int Anzahl;
            // Leere Geräteseiten darunter, für die dieses Gerät das nächste mit Anleitungen ist (Ziel der Umleitung)
            public List<string> Leer = new List<string>();
            public int Version; // nur an der Wurzel: Aufbau des Caches, ältere werden neu erstellt
        }
        const int IfixitVersion = 3;

        // Schnelle Nachschlage-Tabellen für den Filter (Pfade entschlüsselt verglichen)
        class IfixitFilter
        {
            public string Buch;
            public Dictionary<string, string> Leer = new Dictionary<string, string>(); // leeres Gerät → Ziel
            public List<string> Anleitungen = new List<string>();
            public bool IstLeer(string pfad) { return Leer.ContainsKey(Entschluesseln(pfad)); }
        }

        static readonly object IfixitLk = new object();
        static string ifixitBuch, ifixitStatus = "", ifixitFehler = "";
        static DateTime ifixitFehlerZeit; // nach einem Fehler 10 Minuten warten, nicht bei jeder iFixit-Seite neu einlesen
        static Dictionary<string, IfixitKnoten> ifixitBaum;
        static IfixitFilter ifixitFilter;
        static int ifixitGelesen;

        static string Entschluesseln(string pfad)
        {
            try { return Uri.UnescapeDataString(pfad); } catch { return pfad; }
        }

        static void IfixitFilterBauen(string buch, Dictionary<string, IfixitKnoten> baum)
        {
            var f = new IfixitFilter { Buch = buch };
            var anleitungen = new HashSet<string>();
            foreach (var k in baum.Values)
            {
                foreach (var l in k.Leer) f.Leer[Entschluesseln(l)] = k.Pfad;
                foreach (var a in k.Anleitungen) if (anleitungen.Add(a[1])) f.Anleitungen.Add(a[1]);
            }
            ifixitFilter = f;
        }

        // Filter für ein iFixit-Paket; null, solange die Übersicht noch entsteht (dann wird nichts ausgeblendet)
        static IfixitFilter IfixitFilterFuer(string buch)
        {
            if (string.IsNullOrEmpty(buch) || !buch.StartsWith("ifixit_")) return null;
            var f = ifixitFilter;
            if (f != null && f.Buch == buch) return f;
            if (!Regex.IsMatch(buch, @"^ifixit_[\w.-]+$") || !File.Exists(Path.Combine(Daten, "wissen", buch + ".zim"))) return null;
            Ifixit(buch, "");
            f = ifixitFilter;
            return f != null && f.Buch == buch ? f : null;
        }

        // Beim Start der Bibliothek: Listen alter Paketversionen löschen, für das installierte Paket gleich erstellen
        static void IfixitAufraeumen()
        {
            try
            {
                string cache = Path.Combine(Daten, "cache");
                if (!Directory.Exists(cache)) return;
                foreach (var d in Directory.GetFiles(cache, "ifixit-*.json"))
                {
                    string buch = Path.GetFileNameWithoutExtension(d).Substring("ifixit-".Length);
                    if (!File.Exists(Path.Combine(Daten, "wissen", buch + ".zim"))) { SicherLoeschen(d); Log("iFixit-Übersicht der alten Version gelöscht: " + buch); }
                }
                // Ebenso die Artikellisten (artikel-<paket>.json) nicht mehr vorhandener Pakete, auch im Speicher
                foreach (var d in Directory.GetFiles(cache, "artikel-*.json"))
                {
                    string buch = Path.GetFileNameWithoutExtension(d).Substring("artikel-".Length);
                    if (File.Exists(Path.Combine(Daten, "wissen", buch + ".zim"))) continue;
                    try { SicherLoeschen(d); Log("Artikelliste der alten Version gelöscht: " + buch); } catch (Exception e) { Log("Artikelliste löschen: " + e.Message); }
                }
                lock (ArtikelLk)
                    foreach (var buch in artikelListen.Keys.ToList())
                        if (!File.Exists(Path.Combine(Daten, "wissen", buch + ".zim"))) { artikelListen.Remove(buch); artikelFehler.Remove(buch); }
            }
            catch (Exception e) { Log("iFixit-Übersicht aufräumen: " + e.Message); }
        }

        static void IfixitVorbereiten()
        {
            try
            {
                if (!KiwixAktiv()) return;
                foreach (var z in Directory.GetFiles(Path.Combine(Daten, "wissen"), "ifixit_*.zim"))
                {
                    Ifixit(Path.GetFileNameWithoutExtension(z), "");
                    break;
                }
            }
            catch { }
        }

        // Zufall nur aus Anleitungen, leere Geräteseiten zum nächsten Gerät mit Anleitungen, Vorschläge ohne leere Geräte
        static readonly Random IfixitZufall = new Random();
        static bool IfixitUmleiten(HttpListenerContext ctx)
        {
            var rq = ctx.Request;
            string pfad = rq.RawUrl.Split('?')[0];
            if (pfad == "/kiwix/random" || pfad == "/kiwix/suggest")
            {
                var f = IfixitFilterFuer(rq.QueryString["content"] ?? rq.QueryString["books.name"]);
                if (f == null) return false;
                if (pfad == "/kiwix/suggest") return IfixitVorschlaege(ctx, f);
                if (f.Anleitungen.Count == 0) return false;
                string ziel;
                lock (IfixitZufall) ziel = f.Anleitungen[IfixitZufall.Next(f.Anleitungen.Count)];
                IfixitUmleitung(ctx, f.Buch, ziel);
                return true;
            }
            var m = Regex.Match(pfad, "^/kiwix/content/(ifixit_[^/]+)/(Device/.+)$");
            if (!m.Success) return false;
            var f2 = IfixitFilterFuer(m.Groups[1].Value);
            string oben;
            if (f2 == null || !f2.Leer.TryGetValue(Entschluesseln(m.Groups[2].Value), out oben)) return false;
            IfixitUmleitung(ctx, f2.Buch, oben == "" ? "home/home" : oben);
            return true;
        }

        static void IfixitUmleitung(HttpListenerContext ctx, string buch, string pfad)
        {
            // Nur ASCII im Location-Kopf: Umlaute aus den Links prozentkodieren
            var sb = new StringBuilder();
            foreach (byte b in Utf8.GetBytes("/kiwix/content/" + buch + "/" + pfad))
                if (b < 128 && b > 32) sb.Append((char)b); else sb.Append("%" + b.ToString("X2"));
            ctx.Response.StatusCode = 302;
            ctx.Response.Headers.Set("Cache-Control", "no-store");
            ctx.Response.RedirectLocation = sb.ToString();
        }

        static bool IfixitVorschlaege(HttpListenerContext ctx, IfixitFilter f)
        {
            int anzahl;
            if (!int.TryParse(ctx.Request.QueryString["count"], out anzahl) || anzahl <= 0) anzahl = 10;
            // Mehr anfragen als gewünscht, weil leere Geräte herausfallen
            string raw = ctx.Request.RawUrl;
            string url = Regex.IsMatch(raw, "[?&]count=") ? Regex.Replace(raw, "([?&]count=)\\d*", "${1}" + (anzahl + 20)) : raw + "&count=" + (anzahl + 20);
            object[] liste;
            try { liste = Json.Deserialize<object[]>(KiwixHolen(url)); } catch { return false; }
            var raus = new List<object>();
            int n = 0;
            foreach (var o in liste)
            {
                var d = o as Dictionary<string, object>;
                if (d == null) continue;
                object p;
                if (d.TryGetValue("path", out p) && p is string)
                {
                    if (n >= anzahl || f.IstLeer((string)p)) continue;
                    n++;
                }
                raus.Add(d);
            }
            SendeJson(ctx, raus);
            return true;
        }

        // Leere Geräte aus Seiten entfernen: Kacheln in Gerätelisten und Treffer der Volltextsuche weg, andere Links nur noch Text
        static byte[] IfixitSeiteFiltern(HttpListenerRequest rq, byte[] daten)
        {
            string pfad = rq.RawUrl.Split('?')[0];
            bool suche = pfad == "/kiwix/search";
            var m = Regex.Match(pfad, "^/kiwix/content/(ifixit_[^/]+)/");
            var f = IfixitFilterFuer(suche ? (rq.QueryString["books.name"] ?? rq.QueryString["content"]) : (m.Success ? m.Groups[1].Value : null));
            if (f == null) return daten;
            string html = Utf8.GetString(daten);
            if (suche)
                html = Regex.Replace(html, "<li>\\s*<a href=\"/kiwix/content/" + Regex.Escape(f.Buch) + "/(Device/[^\"#?]+)\"[\\s\\S]*?</li>",
                    t => f.IstLeer(t.Groups[1].Value) ? "" : t.Value);
            else
            {
                int weg = 0;
                html = Regex.Replace(html, "<div class=\"categoryListCell\">\\s*<a href=\"\\.\\./(Device/[^\"#?]+)\"[\\s\\S]*?</div>",
                    t => { if (!f.IstLeer(t.Groups[1].Value)) return t.Value; weg++; return ""; });
                if (weg > 0)
                    html = Regex.Replace(html, "(<h2 id=['\"]Section_Childrens['\"][^>]*>\\s*)(\\d+)([\\s\\S]*?</h2>)", t =>
                    {
                        int alt;
                        int.TryParse(t.Groups[2].Value, out alt);
                        return alt - weg > 0 ? t.Groups[1].Value + (alt - weg) + t.Groups[3].Value : "";
                    });
                html = Regex.Replace(html, "<a\\s[^>]*href=\"\\.\\./(Device/[^\"#?]+)\"[^>]*>([\\s\\S]*?)</a>",
                    t => f.IstLeer(t.Groups[1].Value) ? "<span>" + t.Groups[2].Value + "</span>" : t.Value);
            }
            return Utf8.GetBytes(html);
        }

        static Dictionary<string, object> Ifixit(string buch, string pfad)
        {
            if (string.IsNullOrEmpty(buch) || !Regex.IsMatch(buch, @"^ifixit_[\w.-]+$")) return new Dictionary<string, object> { { "fehler", "Unbekanntes Paket" } };
            lock (IfixitLk)
            {
                if (ifixitBuch != buch)
                {
                    ifixitBuch = buch; ifixitBaum = null; ifixitFilter = null; ifixitStatus = ""; ifixitFehler = "";
                    string cache = Path.Combine(Daten, "cache", "ifixit-" + buch + ".json");
                    if (File.Exists(cache))
                        try
                        {
                            var b = Json.Deserialize<Dictionary<string, IfixitKnoten>>(File.ReadAllText(cache, Utf8));
                            if (b.ContainsKey("") && b[""].Version >= IfixitVersion) { ifixitBaum = b; ifixitStatus = "fertig"; IfixitFilterBauen(buch, b); }
                        }
                        catch { ifixitBaum = null; }
                }
                bool warten = ifixitStatus == "fehler" && (DateTime.UtcNow - ifixitFehlerZeit).TotalMinutes < 10;
                if (ifixitBaum == null && ifixitStatus != "laeuft" && !warten)
                {
                    ifixitStatus = "laeuft"; ifixitGelesen = 0;
                    new Thread(delegate () { IfixitEinlesen(buch); }) { IsBackground = true, Priority = ThreadPriority.BelowNormal }.Start();
                }
                if (ifixitBaum == null)
                    return new Dictionary<string, object> { { "status", ifixitStatus == "fehler" ? "fehler" : "laeuft" }, { "gelesen", ifixitGelesen }, { "fehler", ifixitFehler } };

                IfixitKnoten k;
                if (!ifixitBaum.TryGetValue(pfad ?? "", out k)) return new Dictionary<string, object> { { "fehler", "Kategorie nicht gefunden" } };
                var kinder = k.Kinder.Where(x => ifixitBaum.ContainsKey(x) && ifixitBaum[x].Anzahl > 0).Select(x => ifixitBaum[x])
                    .OrderByDescending(x => x.Anzahl).Select(x => (object)new Dictionary<string, object> { { "titel", x.Titel }, { "pfad", x.Pfad }, { "anzahl", x.Anzahl } }).ToList();
                // Weg von oben bis hierher (für die Brotkrumen-Navigation)
                var weg = new List<object>();
                var eltern = new Dictionary<string, string>();
                foreach (var e in ifixitBaum.Values) foreach (var c in e.Kinder) if (!eltern.ContainsKey(c)) eltern[c] = e.Pfad;
                string p = k.Pfad;
                while (p != null && p != "" && ifixitBaum.ContainsKey(p)) { weg.Insert(0, new Dictionary<string, object> { { "titel", ifixitBaum[p].Titel }, { "pfad", p } }); p = eltern.ContainsKey(p) ? eltern[p] : null; }
                return new Dictionary<string, object>
                {
                    { "status", "fertig" }, { "titel", k.Titel }, { "pfad", k.Pfad }, { "anzahl", k.Anzahl }, { "weg", weg }, { "kinder", kinder },
                    { "anleitungen", k.Anleitungen.Select(a => (object)new Dictionary<string, object> { { "titel", a[0] }, { "pfad", a[1] } }).ToList() }
                };
            }
        }

        static string KiwixSeite(string buch, string pfad)
        {
            return KiwixHolen("/kiwix/content/" + buch + "/" + pfad);
        }

        static string KiwixHolen(string pfadUndQuery)
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + KiwixPort + PunkteSchuetzen(pfadUndQuery));
            req.Proxy = null;
            req.Timeout = 30000;
            using (var r = req.GetResponse())
            using (var s = new StreamReader(r.GetResponseStream(), Encoding.UTF8)) return s.ReadToEnd();
        }

        // Links einer Seite: Geräte (Device/...) und Anleitungen (Anleitung/...), jeweils mit sichtbarem Text
        static List<string[]> IfixitLinks(string html, string art)
        {
            var liste = new List<string[]>();
            var gesehen = new HashSet<string>();
            foreach (Match m in Regex.Matches(html, "<a\\s[^>]*href=\"\\.\\./(" + art + "/[^\"#?]+)\"[^>]*>([\\s\\S]*?)</a>"))
            {
                string pfad = m.Groups[1].Value;
                string text = WebUtility.HtmlDecode(Regex.Replace(m.Groups[2].Value, "<[^>]+>", " ")).Trim();
                // Die Startseite schreibt die Anzahl vor den Namen ("6602 Elektrogeräte")
                text = Regex.Replace(Regex.Replace(text, @"\s+", " "), @"^\d[\d.,]*\s+(?=\D)", "");
                if (text == "") continue;
                if (gesehen.Add(pfad)) liste.Add(new[] { text, pfad });
            }
            return liste;
        }

        static void IfixitEinlesen(string buch)
        {
            try
            {
                var baum = new Dictionary<string, IfixitKnoten>();
                var wurzel = new IfixitKnoten { Titel = "iFixit", Pfad = "", Version = IfixitVersion };
                var nichtGelesen = new HashSet<string>();
                baum[""] = wurzel;
                foreach (var l in IfixitLinks(KiwixSeite(buch, "home/home"), "Device"))
                    if (!baum.ContainsKey(l[1])) { baum[l[1]] = new IfixitKnoten { Titel = l[0], Pfad = l[1] }; wurzel.Kinder.Add(l[1]); }
                // Ebene für Ebene; wer ein Gerät zuerst verlinkt, ist sein Elternteil (Brotkrumen zeigen nach oben und werden übersprungen)
                var ebene = wurzel.Kinder.ToList();
                int fehlgeschlagen = 0;
                while (ebene.Count > 0)
                {
                    var naechste = new List<string>();
                    // Mehr als 3 gleichzeitige Anfragen lassen kiwix-serve abstürzen
                    var opt = new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 3 };
                    System.Threading.Tasks.Parallel.ForEach(ebene, opt, pfad =>
                    {
                        string html;
                        try { html = KiwixSeite(buch, pfad); } catch { Interlocked.Increment(ref fehlgeschlagen); lock (baum) nichtGelesen.Add(pfad); return; }
                        var geraete = IfixitLinks(html, "Device");
                        var anleitungen = IfixitLinks(html, "Anleitung");
                        lock (baum)
                        {
                            var k = baum[pfad];
                            k.Anleitungen = anleitungen;
                            foreach (var g in geraete)
                            {
                                if (baum.ContainsKey(g[1])) continue;
                                baum[g[1]] = new IfixitKnoten { Titel = g[0], Pfad = g[1] };
                                k.Kinder.Add(g[1]);
                                naechste.Add(g[1]);
                            }
                            ifixitGelesen++;
                        }
                    });
                    ebene = naechste;
                }
                // Anleitungen je Zweig zählen (ohne doppelte)
                Func<IfixitKnoten, HashSet<string>> zaehle = null;
                zaehle = (k) =>
                {
                    var menge = new HashSet<string>(k.Anleitungen.Select(a => a[1]));
                    foreach (var c in k.Kinder) menge.UnionWith(zaehle(baum[c]));
                    k.Anzahl = menge.Count;
                    return menge;
                };
                zaehle(wurzel);
                // Leere Geräteseiten dem nächsten Gerät darüber mit Anleitungen zuordnen. Nicht lesbare Seiten
                // gelten nicht als leer (könnten Anleitungen haben), ebenso alles darunter.
                int leer = 0;
                Action<IfixitKnoten, IfixitKnoten> ordne = null;
                ordne = (k, oben) =>
                {
                    if (nichtGelesen.Contains(k.Pfad)) return;
                    if (k.Anzahl > 0) oben = k; else { oben.Leer.Add(k.Pfad); leer++; }
                    foreach (var c in k.Kinder) ordne(baum[c], oben);
                };
                ordne(wurzel, wurzel);
                // Leere Zweige gar nicht erst speichern
                var voll = baum.Values.Where(x => x.Anzahl > 0).ToDictionary(x => x.Pfad);
                foreach (var k in voll.Values) k.Kinder = k.Kinder.Where(voll.ContainsKey).ToList();
                // Nur (fast) vollständig gelesene Bäume dauerhaft merken (z. B. nicht, wenn Kiwix zwischendurch neu startete)
                // Scheitert das Speichern, gilt das Ergebnis trotzdem (im Speicher bis zum nächsten Start)
                if (fehlgeschlagen <= baum.Count / 100)
                    try
                    {
                        Directory.CreateDirectory(Path.Combine(Daten, "cache"));
                        SicherSchreiben(Path.Combine(Daten, "cache", "ifixit-" + buch + ".json"), Json.Serialize(voll));
                    }
                    catch (Exception e) { Log("iFixit-Übersicht nicht gespeichert: " + e.Message); }
                lock (IfixitLk) if (ifixitBuch == buch) { ifixitBaum = voll; ifixitStatus = "fertig"; IfixitFilterBauen(buch, voll); }
                Log("iFixit-Übersicht: " + baum.Count + " Geräteseiten (" + leer + " ohne Anleitung), " + wurzel.Anzahl + " Anleitungen, " + fehlgeschlagen + " Seiten nicht lesbar.");
            }
            catch (Exception e)
            {
                lock (IfixitLk) if (ifixitBuch == buch) { ifixitStatus = "fehler"; ifixitFehler = e.Message; ifixitFehlerZeit = DateTime.UtcNow; }
                Log("iFixit-Übersicht: " + e.Message);
            }
        }

        // ------------------------------------------------------------------ Externe Links in Artikeln
        // Klickt man in einem Artikel auf einen Link ins Internet, fragt die Seite hier nach, ob die Adresse
        // erreichbar ist (die Seiten selbst dürfen wegen der Sicherheitsregeln von Kiwix nichts von außen laden).
        // Jede Antwort des Servers, auch ein Fehlercode, heißt: Internet ist da. Nur die Adresse wird angefragt.
        static Dictionary<string, object> InternetDa(string url)
        {
            Uri u;
            if (url == null || !Uri.TryCreate(url, UriKind.Absolute, out u) || (u.Scheme != "http" && u.Scheme != "https") || u.IsLoopback)
                return new Dictionary<string, object> { { "fehler", "Ungültige Adresse" } };
            // Antwortet die Zielseite nicht, kann auch nur die Seite kaputt sein (z. B. Domain abgelaufen).
            // Dann eine Adresse prüfen, die Fieldbook ohnehin benutzt: Geht die, gibt es Internet.
            if (AdresseAntwortet(u)) return new Dictionary<string, object> { { "online", true }, { "erreichbar", true } };
            bool netz = AdresseAntwortet(new Uri("https://library.kiwix.org/")) || AdresseAntwortet(new Uri("https://github.com/"));
            return new Dictionary<string, object> { { "online", netz }, { "erreichbar", false } };
        }

        // Antwortet die Adresse überhaupt (auch mit Fehlercode)?  HEAD, höchstens 4 Sekunden
        static bool AdresseAntwortet(Uri u)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(u);
                req.Method = "HEAD";
                req.Timeout = 4000;
                req.AllowAutoRedirect = false;
                using (req.GetResponse()) return true;
            }
            catch (WebException we) { bool da = we.Response != null; if (da) we.Response.Close(); return da; }
            catch { return false; }
        }

        // ------------------------------------------------------------------ Artikelliste (Klexikon-Startseite)
        // Kiwix kann die Artikel eines Pakets nicht auflisten, und die Vorschlagsliste ist unvollständig. Deshalb
        // werden alle Seiten einmal im Hintergrund über ihre Links eingelesen (Titel, Pfad, erstes Bild) und in
        // daten/cache/artikel-<paket>.json gespeichert. Nur Seiten im Hauptbereich (ohne "Datei:", "Klexikon:" …).

        public class ArtikelEintrag { public string T, P, B; }

        static readonly object ArtikelLk = new object();
        static readonly Dictionary<string, List<ArtikelEintrag>> artikelListen = new Dictionary<string, List<ArtikelEintrag>>();
        static readonly Dictionary<string, int> artikelGelesen = new Dictionary<string, int>();
        // Nach einem Fehler beim Einlesen 10 Minuten warten (Zeitpunkt, Meldung), statt bei jedem Aufruf neu zu beginnen
        static readonly Dictionary<string, Tuple<DateTime, string>> artikelFehler = new Dictionary<string, Tuple<DateTime, string>>();

        static Dictionary<string, object> Artikelliste(string buch)
        {
            if (!PdfPaketOk(buch)) return new Dictionary<string, object> { { "fehler", "Unbekanntes Paket" } };
            lock (ArtikelLk)
            {
                List<ArtikelEintrag> liste;
                if (!artikelListen.TryGetValue(buch, out liste))
                {
                    string cache = Path.Combine(Daten, "cache", "artikel-" + buch + ".json");
                    if (File.Exists(cache))
                        try { liste = Json.Deserialize<List<ArtikelEintrag>>(File.ReadAllText(cache, Utf8)); artikelListen[buch] = liste; } catch { liste = null; }
                }
                if (liste != null) return new Dictionary<string, object> { { "status", "fertig" }, { "artikel", liste } };
                Tuple<DateTime, string> fehler;
                if (!artikelGelesen.ContainsKey(buch) && artikelFehler.TryGetValue(buch, out fehler) && (DateTime.UtcNow - fehler.Item1).TotalMinutes < 10)
                    return new Dictionary<string, object> { { "status", "fehler" }, { "fehler", fehler.Item2 } };
                if (!artikelGelesen.ContainsKey(buch))
                {
                    artikelGelesen[buch] = 0;
                    new Thread(delegate () { ArtikelEinlesen(buch); }) { IsBackground = true, Priority = ThreadPriority.BelowNormal }.Start();
                }
                return new Dictionary<string, object> { { "status", "laeuft" }, { "gelesen", artikelGelesen[buch] } };
            }
        }

        // Seite holen; liefert den Pfad nach Weiterleitungen (z. B. "Hund" → "Hunde")
        static string KiwixSeiteMitPfad(string buch, string pfad, out string endPfad)
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + KiwixPort + "/kiwix/content/" + buch + "/" + pfad);
            req.Proxy = null;
            req.Timeout = 30000;
            using (var r = req.GetResponse())
            using (var s = new StreamReader(r.GetResponseStream(), Encoding.UTF8))
            {
                string p = r.ResponseUri.AbsolutePath, vorne = "/kiwix/content/" + buch + "/";
                endPfad = p.StartsWith(vorne) ? Uri.UnescapeDataString(p.Substring(vorne.Length)) : pfad;
                return s.ReadToEnd();
            }
        }

        static void ArtikelEinlesen(string buch)
        {
            try
            {
                var gefunden = new Dictionary<string, ArtikelEintrag>();
                var bilder = new Dictionary<string, List<string>>();
                var besucht = new HashSet<string>();
                string start;
                string html = KiwixSeiteMitPfad(buch, "", out start);
                besucht.Add(start);
                var ebene = ArtikelLinks(html).Where(besucht.Add).ToList();
                int fehlgeschlagen = 0;
                while (ebene.Count > 0)
                {
                    var naechste = new List<string>();
                    // Höchstens 4 gleichzeitig: bei 6 parallelen Anfragen ist kiwix-serve schon abgestürzt
                    var opt = new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 4 };
                    System.Threading.Tasks.Parallel.ForEach(ebene, opt, pfad =>
                    {
                        string seite, ziel;
                        try { seite = KiwixSeiteMitPfad(buch, Uri.EscapeDataString(pfad), out ziel); } catch { Interlocked.Increment(ref fehlgeschlagen); return; }
                        var links = ArtikelLinks(seite);
                        var t = Regex.Match(seite, "<h1[^>]*>([\\s\\S]*?)</h1>");
                        string titel = WebUtility.HtmlDecode(Regex.Replace(t.Success ? t.Groups[1].Value : ziel.Replace('_', ' '), "<[^>]+>", "")).Trim();
                        var seitenBilder = Regex.Matches(seite, "<img[^>]+src=\"\\.?/?(_assets_/[^\"]+)\"[^>]*>").Cast<Match>().Take(4)
                            .Select(m => WebUtility.HtmlDecode(m.Groups[1].Value)).ToList();
                        lock (gefunden)
                        {
                            if (!ziel.Contains(":") && !gefunden.ContainsKey(ziel) && titel != "")
                            {
                                gefunden[ziel] = new ArtikelEintrag { T = titel, P = ziel };
                                bilder[ziel] = seitenBilder;
                            }
                            besucht.Add(ziel);
                            foreach (var l in links) if (besucht.Add(l)) naechste.Add(l);
                        }
                        lock (ArtikelLk) artikelGelesen[buch] = gefunden.Count;
                    });
                    ebene = naechste;
                }
                var liste = gefunden.Values.OrderBy(x => x.T, StringComparer.Create(new CultureInfo("de-DE"), true)).ToList();
                // Bilder, die in vielen Artikeln vorkommen, sind Symbole (z. B. das Klexikon-„K“): das erste andere nehmen
                var haeufig = new HashSet<string>(bilder.Values.SelectMany(b => b.Distinct()).GroupBy(b => b).Where(g => g.Count() > 5).Select(g => g.Key));
                foreach (var a in liste) a.B = bilder[a.P].FirstOrDefault(b => !haeufig.Contains(b));
                // Scheitert das Speichern, gilt die Liste trotzdem (im Speicher bis zum nächsten Start)
                if (fehlgeschlagen <= gefunden.Count / 100)
                    try
                    {
                        Directory.CreateDirectory(Path.Combine(Daten, "cache"));
                        SicherSchreiben(Path.Combine(Daten, "cache", "artikel-" + buch + ".json"), Json.Serialize(liste));
                    }
                    catch (Exception e) { Log("Artikelliste " + buch + " nicht gespeichert: " + e.Message); }
                lock (ArtikelLk) { artikelListen[buch] = liste; artikelGelesen.Remove(buch); artikelFehler.Remove(buch); }
                Log("Artikelliste " + buch + ": " + liste.Count + " Artikel, " + fehlgeschlagen + " Seiten nicht lesbar.");
            }
            catch (Exception e)
            {
                lock (ArtikelLk) { artikelGelesen.Remove(buch); artikelFehler[buch] = Tuple.Create(DateTime.UtcNow, e.Message); }
                Log("Artikelliste " + buch + ": " + e.Message);
            }
        }

        // Links auf andere Seiten im Hauptbereich des Pakets (gleiche Ebene, ohne Namensraum, ohne Dateien)
        static List<string> ArtikelLinks(string html)
        {
            var liste = new List<string>();
            foreach (Match m in Regex.Matches(html, "<a\\s[^>]*href=\"(?:\\./)?([^\"#?/]+)\""))
            {
                string pfad;
                try { pfad = Uri.UnescapeDataString(WebUtility.HtmlDecode(m.Groups[1].Value)); } catch { continue; }
                if (pfad.Contains(":") || pfad.StartsWith(".") || Regex.IsMatch(pfad, @"\.(css|js|png|jpe?g|svg|webp|gif|pdf)$", RegexOptions.IgnoreCase)) continue;
                liste.Add(pfad);
            }
            return liste;
        }

        // ------------------------------------------------------------------ Text aus PDF-Büchern
        // Manche Pakete (Medizin-Handbücher, Ratgeber nach Katastrophen) bestehen aus PDF-Büchern, in denen
        // Kiwix nichts findet. Die Seite liest jedes Buch einmal mit pdf.js aus und schickt den Text hierher.
        // Er bleibt dauerhaft beim Paket: daten/wissen/pdf-texte/<Paket>.json, solange noch Bücher fehlen
        // <Paket>.teil.jsonl (eine Zeile je Buch). Verschwindet das Paket, wird der Text mit gelöscht.

        class PdfDatei { public string Datei; public string Titel; public string[] Seiten; }
        class PdfBuch { public List<PdfDatei> Dateien = new List<PdfDatei>(); public DateTime Stand; public double Schnitt = 1; }

        static readonly object PdfLk = new object();
        static readonly Dictionary<string, PdfBuch> pdfBuecher = new Dictionary<string, PdfBuch>();

        static string TexteOrdner { get { return Path.Combine(Daten, "wissen", "pdf-texte"); } }
        static string PdfFertigDatei(string buch) { return Path.Combine(TexteOrdner, buch + ".json"); }
        static string PdfTeilDatei(string buch) { return Path.Combine(TexteOrdner, buch + ".teil.jsonl"); }

        // Nur Namen installierter Pakete (Dateiname ohne .zim, so heißen sie auch in Kiwix), keine Pfade
        static bool PdfPaketOk(string buch)
        {
            if (buch == EigenePaket) return true;   // eigene Unterlagen (daten/eigene), siehe unten
            return !string.IsNullOrEmpty(buch) && Regex.IsMatch(buch, @"^[A-Za-z0-9._-]+$") && File.Exists(Path.Combine(Daten, "wissen", buch + ".zim"));
        }

        // Pakete mit ausgelesenem Text: Name → fertig (true) oder erst teilweise (false)
        static Dictionary<string, object> PdfTexte()
        {
            var d = new Dictionary<string, object>();
            if (!Directory.Exists(TexteOrdner)) return d;
            foreach (var f in Directory.GetFiles(TexteOrdner))
            {
                string n = Path.GetFileName(f);
                if (n.EndsWith(".teil.jsonl")) { string b = n.Substring(0, n.Length - 11); if (!d.ContainsKey(b)) d[b] = false; }
                // Unvollständige fertige Datei: als „teilweise“ melden, dann liest die Seite das Paket neu aus
                else if (n.EndsWith(".json")) d[n.Substring(0, n.Length - 5)] = PdfFertigLesbar(f);
            }
            return d;
        }

        // Ist die fertige Datei vollständig? Eine bei Stromausfall halb geschriebene (früher direkt geschrieben)
        // endet nicht mit "}". Nur das Ende wird gelesen, das geht auch bei großen Dateien schnell.
        static bool PdfFertigLesbar(string f)
        {
            try
            {
                if (!File.Exists(f)) return false;
                using (var fs = new FileStream(f, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                {
                    if (fs.Length < 2) return false;
                    int n = (int)Math.Min(64, fs.Length), gelesen = 0;
                    var buf = new byte[n];
                    fs.Seek(-n, SeekOrigin.End);
                    while (gelesen < n) { int r = fs.Read(buf, gelesen, n - gelesen); if (r <= 0) break; gelesen += r; }
                    for (int i = gelesen - 1; i >= 0; i--)
                    {
                        if (buf[i] == ' ' || buf[i] == '\r' || buf[i] == '\n' || buf[i] == '\t') continue;
                        return buf[i] == '}';
                    }
                    return false;
                }
            }
            catch { return false; }
        }

        // Bücher aus der Teil-Datei (eine JSON-Zeile je Buch)
        static List<Dictionary<string, object>> PdfTeilLesen(string buch)
        {
            var liste = new List<Dictionary<string, object>>();
            string f = PdfTeilDatei(buch);
            if (!File.Exists(f)) return liste;
            foreach (var z in File.ReadAllLines(f, Utf8))
            {
                if (z.Trim().Length == 0) continue;
                try { var d = Json.DeserializeObject(z) as Dictionary<string, object>; if (d != null) liste.Add(d); } catch { }
            }
            // Doppelt ausgelesene Bücher nur einmal (das zuletzt gespeicherte gilt)
            return liste.Where((d, i) => !liste.Skip(i + 1).Any(x => Str(x, "datei") == Str(d, "datei"))).ToList();
        }

        // Lädt den Text eines Pakets (fertig oder teilweise) und hält ihn im Speicher, bis sich die Datei ändert
        static PdfBuch PdfLaden(string buch)
        {
            if (buch == EigenePaket) return EigeneBuchLaden();
            string f = PdfFertigDatei(buch);
            bool fertig = PdfFertigLesbar(f); // halb geschriebene fertige Datei: lieber die Teil-Datei
            if (!fertig) f = PdfTeilDatei(buch);
            if (!File.Exists(f)) return null;
            DateTime stand = File.GetLastWriteTimeUtc(f);
            lock (PdfLk)
            {
                PdfBuch b;
                if (pdfBuecher.TryGetValue(buch, out b) && b.Stand == stand) return b;
                b = new PdfBuch { Stand = stand };
                var dateien = fertig ? Arr(LadeJson(f), "dateien").OfType<Dictionary<string, object>>().ToList() : PdfTeilLesen(buch);
                long zeichen = 0, seiten = 0;
                foreach (var d in dateien)
                {
                    var s = Arr(d, "seiten").Select(x => x as string ?? "").ToArray();
                    b.Dateien.Add(new PdfDatei { Datei = Str(d, "datei"), Titel = Str(d, "titel") ?? Str(d, "datei"), Seiten = s });
                    foreach (var x in s) zeichen += x.Length;
                    seiten += s.Length;
                }
                if (seiten > 0) b.Schnitt = Math.Max(1.0, (double)zeichen / seiten);
                pdfBuecher[buch] = b;
                return b;
            }
        }

        // Welche Bücher eines Pakets schon ausgelesen sind (zum Weitermachen nach einer Unterbrechung)
        static Dictionary<string, object> PdfStand(string buch)
        {
            if (!PdfPaketOk(buch)) return new Dictionary<string, object> { { "fehler", "Unbekanntes Paket." } };
            if (PdfFertigLesbar(PdfFertigDatei(buch))) return new Dictionary<string, object> { { "fertig", true }, { "dateien", new string[0] } };
            lock (PdfLk)
                return new Dictionary<string, object> { { "fertig", false }, { "dateien", PdfTeilLesen(buch).Select(d => Str(d, "datei")).ToArray() } };
        }

        // Ein Buch anhängen ({buch, datei, titel, seiten}) oder das Paket abschließen ({buch, fertig: true})
        static Dictionary<string, object> PdfSpeichern(Dictionary<string, object> b)
        {
            string buch = Str(b, "buch");
            if (!PdfPaketOk(buch)) return new Dictionary<string, object> { { "fehler", "Unbekanntes Paket." } };
            lock (PdfLk)
            {
                Directory.CreateDirectory(TexteOrdner);
                if (Bool(b, "fertig"))
                {
                    // Mit schon fertigem Text zusammenführen (falls zwei Tabs gleichzeitig ausgelesen haben)
                    var alle = File.Exists(PdfFertigDatei(buch)) ? Arr(LadeJson(PdfFertigDatei(buch)), "dateien").OfType<Dictionary<string, object>>().ToList() : new List<Dictionary<string, object>>();
                    var neu = PdfTeilLesen(buch);
                    alle = alle.Where(a => !neu.Any(n => Str(n, "datei") == Str(a, "datei"))).Concat(neu).ToList();
                    // Sicher schreiben: bei Stromausfall bleibt keine halbe Datei, die Teil-Datei erst danach löschen
                    SicherSchreiben(PdfFertigDatei(buch), Json.Serialize(new Dictionary<string, object> { { "buch", buch }, { "dateien", alle } }));
                    try { File.Delete(PdfTeilDatei(buch)); } catch { }
                    StatusCacheLeeren();
                    Log("PDF-Text für " + buch + ": " + alle.Count + " Bücher ausgelesen.");
                    return new Dictionary<string, object> { { "ok", true } };
                }
                string datei = Str(b, "datei");
                if (string.IsNullOrEmpty(datei)) return new Dictionary<string, object> { { "fehler", "Datei fehlt." } };
                var zeile = new Dictionary<string, object> { { "datei", datei }, { "titel", Str(b, "titel") ?? datei }, { "seiten", Arr(b, "seiten") } };
                bool erstes = !File.Exists(PdfTeilDatei(buch));
                File.AppendAllText(PdfTeilDatei(buch), Json.Serialize(zeile) + "\n", Utf8);
                if (erstes) StatusCacheLeeren(); // pdfTexte im Status: Paket jetzt „teilweise“
                return new Dictionary<string, object> { { "ok", true } };
            }
        }

        // Text gelöschter oder ersetzter Pakete entfernen (beim Start der Bibliothek, also nach jeder Änderung)
        static void PdfTexteAufraeumen()
        {
            try
            {
                foreach (var kv in PdfTexte())
                {
                    if (File.Exists(Path.Combine(Daten, "wissen", kv.Key + ".zim"))) continue;
                    lock (PdfLk)
                    {
                        try { SicherLoeschen(PdfFertigDatei(kv.Key)); } catch { }
                        try { File.Delete(PdfTeilDatei(kv.Key)); } catch { }
                        pdfBuecher.Remove(kv.Key);
                    }
                    Log("PDF-Text von " + kv.Key + " gelöscht (Paket nicht mehr da).");
                }
            }
            catch { }
        }

        static readonly Regex PdfWort = new Regex(@"[\p{L}\p{N}]{3,}");
        static readonly HashSet<string> PdfStopp = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        { "the", "and", "for", "with", "without", "from", "that", "this", "how", "what", "when", "your", "der", "die", "das", "und", "mit", "ohne", "von", "wie", "was" };

        // Wie oft ein Wort auf der Seite vorkommt (nur am Wortanfang: "bleed" zählt in "bleeding", nicht "art" in "heart")
        static int PdfVorkommen(string text, string wort)
        {
            int n = 0, i = 0;
            while (n < 20 && (i = text.IndexOf(wort, i, StringComparison.OrdinalIgnoreCase)) >= 0)
            {
                if (i == 0 || !char.IsLetterOrDigit(text[i - 1])) n++;
                i += wort.Length;
            }
            return n;
        }

        // Volltextsuche über die Seiten (BM25). Seiten mit allen Suchwörtern zählen mehr; Inhalts- und
        // Stichwortverzeichnisse weniger; von zwei
        // benachbarten Seiten derselben Stelle kommt nur die bessere, die nächste Seite liest die KI ohnehin mit.
        static List<object> PdfSuche(string buch, string q, int max)
        {
            if (!PdfPaketOk(buch) || string.IsNullOrWhiteSpace(q)) return new List<object>();
            return PdfSuche(buch, q, max, PdfLaden(buch));
        }

        // Suche in einem schon geladenen Buch (auch die eigenen Unterlagen im Rundgang, die nur im Speicher liegen)
        static List<object> PdfSuche(string buch, string q, int max, PdfBuch b)
        {
            var erg = new List<object>();
            if (b == null || string.IsNullOrWhiteSpace(q)) return erg;
            var woerter = PdfWort.Matches(q).Cast<Match>().Select(m => m.Value).Where(w => !PdfStopp.Contains(w))
                .Distinct(StringComparer.OrdinalIgnoreCase).Take(6).ToList();
            if (woerter.Count == 0) return erg;
            int gesamt = 0;
            var stellen = new List<int[]>();   // {Buch, Seite, Anzahl je Wort …}
            var df = new int[woerter.Count];
            for (int di = 0; di < b.Dateien.Count; di++)
                for (int si = 0; si < b.Dateien[di].Seiten.Length; si++)
                {
                    gesamt++;
                    int[] z = null;
                    for (int w = 0; w < woerter.Count; w++)
                    {
                        int n = PdfVorkommen(b.Dateien[di].Seiten[si], woerter[w]);
                        if (n == 0) continue;
                        if (z == null) { z = new int[woerter.Count + 2]; z[0] = di; z[1] = si; }
                        z[w + 2] = n;
                        df[w]++;
                    }
                    if (z != null) stellen.Add(z);
                }
            string satz = string.Join(" ", woerter);
            var wertung = new List<KeyValuePair<double, int[]>>();
            foreach (var z in stellen)
            {
                string s = b.Dateien[z[0]].Seiten[z[1]];
                // k1 = 3 statt üblich 1,2: Ein Wort, das nur einmal nebenbei fällt, zählt weniger gegen eine
                // Seite, die von diesem Thema handelt ("self" im Vorwort gegen 31-mal "tooth")
                const double k1 = 3;
                double norm = k1 * (0.25 + 0.75 * s.Length / b.Schnitt);
                double p = 0;
                double abgedeckt = 0;
                for (int w = 0; w < woerter.Count; w++)
                {
                    int tf = z[w + 2];
                    if (tf == 0) continue;
                    abgedeckt += tf == 1 ? 0.5 : 1;
                    double idf = Math.Log(1 + (gesamt - df[w] + 0.5) / (df[w] + 0.5));
                    p += idf * tf * (k1 + 1) / (tf + norm);
                }
                p *= 0.5 + 0.5 * abgedeckt / woerter.Count;
                if (woerter.Count > 1 && s.IndexOf(satz, StringComparison.OrdinalIgnoreCase) >= 0) p *= 1.5;
                // Inhaltsverzeichnisse und Stichwortlisten nennen das Wort, erklären aber nichts
                if (Regex.Matches(s, @"(\. ?){5,}").Count > 4 || Regex.Matches(s, @"\p{L}\)?,\s*\d{1,3}\b").Count > 20) p *= 0.3;
                wertung.Add(new KeyValuePair<double, int[]>(p, z));
            }
            var genommen = new List<int[]>();
            foreach (var kv in wertung.OrderByDescending(x => x.Key))
            {
                var z = kv.Value;
                if (genommen.Any(g => g[0] == z[0] && Math.Abs(g[1] - z[1]) <= 1)) continue;
                genommen.Add(z);
                var d = b.Dateien[z[0]];
                int seite = z[1] + 1;
                // Eigene Word- und Textdateien haben keine echten Seiten (nur Stücke des Texts): ohne Seitenzahl
                bool seiten = MitSeiten(buch, d.Datei);
                erg.Add(new Dictionary<string, object> {
                    { "titel", d.Titel + (seiten ? ", Seite " + seite : "") },
                    { "url", "/api/pdftext/seite/" + buch + "/" + z[0] + "/" + seite },
                    { "pdf", buch == EigenePaket && d.Datei.StartsWith("web:") ? WebAdresseVonOrdner(d.Datei.Substring(4))
                                                 : buch == EigenePaket ? "/api/eigene/datei/" + Uri.EscapeDataString(d.Datei) + (seiten ? "#page=" + seite : "")
                                                 : "/kiwix/content/" + buch + "/files/" + Uri.EscapeDataString(d.Datei) + "#page=" + seite },
                    { "auszug", PdfAuszug(d.Seiten[z[1]], woerter) },
                    { "punkte", Math.Round(kv.Key, 2) } });
                if (erg.Count >= max) break;
            }
            return erg;
        }

        static string PdfAuszug(string s, List<string> woerter)
        {
            int i = -1;
            foreach (var w in woerter) { int k = s.IndexOf(w, StringComparison.OrdinalIgnoreCase); if (k >= 0 && (i < 0 || k < i)) i = k; }
            int start = Math.Max(0, i - 80);
            return Regex.Replace(s.Substring(start, Math.Min(300, s.Length - start)), @"\s+", " ").Trim();
        }

        // Zeilen einer PDF-Seite zu Absätzen zusammensetzen: getrennte Wörter am Zeilenende verbinden,
        // nach einem Satzende ab etwa 400 Zeichen einen neuen Absatz beginnen
        static List<string> PdfAbsaetze(string seite)
        {
            var erg = new List<string>();
            var sb = new StringBuilder();
            var zeilen = seite.Split('\n').Select(x => x.Trim()).Where(x => x.Length > 0).ToList();
            for (int i = 0; i < zeilen.Count; i++)
            {
                string z = zeilen[i];
                // Kurze Zeilen ohne Satzzeichen (Überschriften, Kopfzeilen) stehen für sich, aber nur, wenn danach
                // etwas Neues beginnt; sonst ist es eine Zeile aus einem schmalen Kasten mitten im Satz
                bool neu = i + 1 >= zeilen.Count || char.IsUpper(zeilen[i + 1][0]) || char.IsDigit(zeilen[i + 1][0]);
                bool fuerSich = z.Length < 60 && neu && (char.IsUpper(z[0]) || char.IsDigit(z[0])) && !Regex.IsMatch(z, @"[.,;:!?\-]$");
                if (fuerSich && sb.Length > 0) { erg.Add(sb.ToString()); sb.Clear(); }
                if (sb.Length > 0 && sb[sb.Length - 1] == '-' && char.IsLower(z[0])) sb.Length--;
                else if (sb.Length > 0) sb.Append(' ');
                sb.Append(z);
                if (fuerSich || (sb.Length > 400 && Regex.IsMatch(z, @"[.!?]$"))) { erg.Add(sb.ToString()); sb.Clear(); }
            }
            if (sb.Length > 0) erg.Add(sb.ToString());
            return erg;
        }

        // Eine Fundstelle als einfache HTML-Seite (diese Seite und die nächste), damit die KI sie wie einen Artikel liest
        static void PdfSeite(HttpListenerContext ctx, string rest)
        {
            var t = rest.Split('/');
            int di = -1, seite = 0;
            PdfBuch b = null;
            if (t.Length == 3 && PdfPaketOk(t[0]) && int.TryParse(t[1], out di) && int.TryParse(t[2], out seite)) b = PdfLaden(t[0]);
            if (b == null || di < 0 || di >= b.Dateien.Count || seite < 1 || seite > b.Dateien[di].Seiten.Length) { SendeText(ctx, 404, "Nicht gefunden"); return; }
            var d = b.Dateien[di];
            var html = new StringBuilder("<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>");
            string titel = WebUtility.HtmlEncode(d.Titel + (MitSeiten(t[0], d.Datei) ? ", Seite " + seite : ""));
            html.Append(titel).Append("</title></head><body><h1>").Append(titel).Append("</h1>");
            for (int s = seite; s <= Math.Min(seite + 1, d.Seiten.Length); s++)
                foreach (var a in PdfAbsaetze(d.Seiten[s - 1])) html.Append("<p>").Append(WebUtility.HtmlEncode(a)).Append("</p>");
            html.Append("</body></html>");
            var bytes = Utf8.GetBytes(html.ToString());
            ctx.Response.ContentType = "text/html; charset=utf-8";
            ctx.Response.AddHeader("Cache-Control", "no-store");
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes, 0, bytes.Length);
        }

        // ------------------------------------------------------------------ Eigene Unterlagen
        // Eigene Dateien (Anleitungen, Pläne, Fotos) liegen in daten/eigene und wandern mit dem Ordner mit.
        // Man legt sie über die Bibliothek ab (Hochladen) oder direkt mit dem Explorer. Den Text von PDF, Word und
        // Textdateien liest die Seite einmal aus (wie bei den PDF-Büchern) und schickt ihn hierher; er steht in
        // daten/cache/eigene-texte.json, je Datei mit einer Kennung aus Größe und Änderungszeit. Ändert sich die
        // Datei, wird neu ausgelesen. Suche und KI laufen über PdfSuche/PdfSeite mit dem Namen "eigene".

        const string EigenePaket = "eigene";
        static string EigeneOrdner { get { return Path.Combine(Daten, "eigene"); } }
        static string EigeneTexteDatei { get { return Path.Combine(Daten, "cache", "eigene-texte.json"); } }
        // .html = Notizen aus Fieldbook (js/notizen.js); angezeigt werden sie nur gefiltert, nie mit Programmcode
        static readonly string[] EigeneEndungen = { ".pdf", ".docx", ".doc", ".txt", ".md", ".jpg", ".jpeg", ".png", ".webp", ".gif", ".html" };
        static readonly string[] EigeneMitText = { ".pdf", ".docx", ".txt", ".md", ".html" };
        static readonly object EigeneLk = new object();

        // Nur PDFs haben echte Seiten; bei Word und Text sind die "Seiten" Stücke des Texts
        static bool MitSeiten(string buch, string datei)
        {
            return buch != EigenePaket || datei.EndsWith(".pdf", StringComparison.OrdinalIgnoreCase);
        }

        static string EigeneKennung(FileInfo f) { return f.Length + "-" + f.LastWriteTimeUtc.Ticks; }

        // Pfad zu einer eigenen Datei: nur ein Dateiname (kein Ordner), nicht versteckt, bekannte Endung
        static string EigenePfad(string name)
        {
            if (string.IsNullOrWhiteSpace(name) || name != Path.GetFileName(name) || name.StartsWith(".") ||
                name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return null;
            if (!EigeneEndungen.Contains(Path.GetExtension(name).ToLowerInvariant())) return null;
            return Path.Combine(EigeneOrdner, name);
        }

        static List<FileInfo> EigeneDateien()
        {
            if (!Directory.Exists(EigeneOrdner)) return new List<FileInfo>();
            return new DirectoryInfo(EigeneOrdner).GetFiles()
                .Where(f => EigenePfad(f.Name) != null && (f.Attributes & (FileAttributes.Hidden | FileAttributes.System)) == 0)
                .OrderBy(f => f.Name, StringComparer.CurrentCultureIgnoreCase).ToList();
        }

        // Ausgelesene Texte: Dateiname → { kennung, seiten }
        static Dictionary<string, object> EigeneTexte()
        {
            var d = LadeJson(EigeneTexteDatei);
            var t = d != null && d.ContainsKey("dateien") ? d["dateien"] as Dictionary<string, object> : null;
            return t ?? new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
        }

        static Dictionary<string, object> EigeneListe()
        {
            var liste = new List<object>();
            Dictionary<string, object> dateiGruppen;
            lock (WebLk) dateiGruppen = DateiGruppenLaden();
            lock (EigeneLk)
            {
                var texte = EigeneTexte();
                foreach (var f in EigeneDateien())
                {
                    string ext = f.Extension.ToLowerInvariant();
                    object o;
                    var t = texte.TryGetValue(f.Name, out o) ? o as Dictionary<string, object> : null;
                    bool fertig = t != null && Str(t, "kennung") == EigeneKennung(f);
                    liste.Add(new Dictionary<string, object> {
                        { "datei", f.Name }, { "groesse", f.Length }, { "geaendert", f.LastWriteTime.ToString("s") },
                        { "gruppe", dateiGruppen.ContainsKey(f.Name) ? dateiGruppen[f.Name] as string ?? "" : "" },
                        { "kennung", EigeneKennung(f) },
                        // Text fehlt noch (oder die Datei hat sich geändert): die Seite liest ihn aus
                        { "auslesen", EigeneMitText.Contains(ext) && !fertig },
                        { "text", fertig && Arr(t, "seiten").Any(s => !string.IsNullOrWhiteSpace(s as string)) } });
                }
                // Gesicherte Webseiten: Schlüssel "web:<ordner>", Text liest die Seite aus wie bei Word
                foreach (var kv in WebSeiten())
                {
                    string key = "web:" + Str(kv.Key, "ordner");
                    object o;
                    var t = texte.TryGetValue(key, out o) ? o as Dictionary<string, object> : null;
                    bool fertig = t != null && Str(t, "kennung") == EigeneKennung(kv.Value);
                    liste.Add(new Dictionary<string, object> {
                        { "datei", key }, { "web", true }, { "name", Str(kv.Key, "name") }, { "url", Str(kv.Key, "url") },
                        { "ordner", Str(kv.Key, "ordner") }, { "adresse", WebAdresseVonOrdner(Str(kv.Key, "ordner")) },
                        { "datum", Str(kv.Key, "datum") }, { "gruppe", Str(kv.Key, "gruppe") ?? "" },
                        { "groesse", kv.Value.Length }, { "geaendert", kv.Value.LastWriteTime.ToString("s") },
                        { "kennung", EigeneKennung(kv.Value) }, { "auslesen", !fertig },
                        { "text", fertig && Arr(t, "seiten").Any(s => !string.IsNullOrWhiteSpace(s as string)) } });
                }
            }
            List<Dictionary<string, object>> gruppen;
            lock (WebLk) gruppen = WebGruppenLaden();
            return new Dictionary<string, object> { { "dateien", liste }, { "gruppen", gruppen } };
        }

        // Text einer Datei speichern ({datei, kennung, seiten}); Einträge gelöschter Dateien fallen dabei weg
        static Dictionary<string, object> EigeneTextSpeichern(Dictionary<string, object> b)
        {
            string datei = Str(b, "datei") ?? "";
            var webSeiten = WebSeiten();
            FileInfo fi;
            if (datei.StartsWith("web:"))
            {
                var w = webSeiten.FirstOrDefault(kv => "web:" + Str(kv.Key, "ordner") == datei);
                if (w.Key == null) return new Dictionary<string, object> { { "fehler", "Seite nicht gefunden." } };
                fi = w.Value;
            }
            else
            {
                string pfad = EigenePfad(datei);
                if (pfad == null || !File.Exists(pfad)) return new Dictionary<string, object> { { "fehler", "Datei nicht gefunden." } };
                fi = new FileInfo(pfad);
                datei = fi.Name;
            }
            // Inzwischen geändert: nicht speichern, die Seite liest beim nächsten Mal neu aus
            if (Str(b, "kennung") != EigeneKennung(fi)) return new Dictionary<string, object> { { "ok", false } };
            lock (EigeneLk)
            {
                var texte = EigeneTexte();
                var da = new HashSet<string>(EigeneDateien().Select(f => f.Name), StringComparer.OrdinalIgnoreCase);
                foreach (var kv in webSeiten) da.Add("web:" + Str(kv.Key, "ordner"));
                var neu = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                foreach (var kv in texte) if (da.Contains(kv.Key) && !string.Equals(kv.Key, datei, StringComparison.OrdinalIgnoreCase)) neu[kv.Key] = kv.Value;
                neu[datei] = new Dictionary<string, object> { { "kennung", EigeneKennung(fi) }, { "seiten", Arr(b, "seiten").Select(x => x as string ?? "").ToArray() } };
                Directory.CreateDirectory(Path.GetDirectoryName(EigeneTexteDatei));
                SicherSchreiben(EigeneTexteDatei, Json.Serialize(new Dictionary<string, object> { { "dateien", neu } }));
            }
            return new Dictionary<string, object> { { "ok", true } };
        }

        // Alle aktuellen Texte als ein "Buch" für die Suche (Titel = Dateiname ohne Endung)
        static PdfBuch EigeneBuchLaden()
        {
            if (!File.Exists(EigeneTexteDatei)) return null;
            DateTime stand = File.GetLastWriteTimeUtc(EigeneTexteDatei);
            if (Directory.Exists(EigeneOrdner)) { var s = Directory.GetLastWriteTimeUtc(EigeneOrdner); if (s > stand) stand = s; }
            lock (PdfLk)
            {
                PdfBuch b;
                if (pdfBuecher.TryGetValue(EigenePaket, out b) && b.Stand == stand) return b;
                b = new PdfBuch { Stand = stand };
                Dictionary<string, object> texte;
                List<FileInfo> dateien;
                lock (EigeneLk) { texte = EigeneTexte(); dateien = EigeneDateien(); }
                long zeichen = 0, seiten = 0;
                foreach (var f in dateien)
                {
                    object o;
                    var t = texte.TryGetValue(f.Name, out o) ? o as Dictionary<string, object> : null;
                    if (t == null || Str(t, "kennung") != EigeneKennung(f)) continue;
                    var s = Arr(t, "seiten").Select(x => x as string ?? "").ToArray();
                    b.Dateien.Add(new PdfDatei { Datei = f.Name, Titel = Path.GetFileNameWithoutExtension(f.Name), Seiten = s });
                    foreach (var x in s) zeichen += x.Length;
                    seiten += s.Length;
                }
                foreach (var kv in WebSeiten())
                {
                    object o;
                    string key = "web:" + Str(kv.Key, "ordner");
                    var t = texte.TryGetValue(key, out o) ? o as Dictionary<string, object> : null;
                    if (t == null || Str(t, "kennung") != EigeneKennung(kv.Value)) continue;
                    var s = Arr(t, "seiten").Select(x => x as string ?? "").ToArray();
                    b.Dateien.Add(new PdfDatei { Datei = key, Titel = Str(kv.Key, "name") ?? key, Seiten = s });
                    foreach (var x in s) zeichen += x.Length;
                    seiten += s.Length;
                }
                if (seiten > 0) b.Schnitt = Math.Max(1.0, (double)zeichen / seiten);
                pdfBuecher[EigenePaket] = b;
                return b;
            }
        }

        // Dateinamen säubern: keine Ordner, keine verbotenen Zeichen, nicht mit Punkt beginnen
        static string EigenerName(string name)
        {
            name = Path.GetFileName((name ?? "").Replace('/', '\\').Split('\\').Last()).Trim();
            foreach (char c in Path.GetInvalidFileNameChars()) name = name.Replace(c, '_');
            return name.TrimStart('.', ' ').TrimEnd('.', ' ');
        }

        // Freier Name im Ordner: "Plan.pdf", sonst "Plan (2).pdf" usw.
        static string EigenerFreierName(string name)
        {
            string ohne = Path.GetFileNameWithoutExtension(name), ext = Path.GetExtension(name);
            string kandidat = name;
            for (int i = 2; File.Exists(Path.Combine(EigeneOrdner, kandidat)); i++) kandidat = ohne + " (" + i + ")" + ext;
            return kandidat;
        }

        // Datei hochladen: der Rumpf ist die Datei selbst, der Name steht in ?name=
        static Dictionary<string, object> EigeneHochladen(HttpListenerContext ctx, string name)
        {
            name = EigenerName(name);
            if (Path.GetFileNameWithoutExtension(name).Length == 0) return new Dictionary<string, object> { { "fehler", "Der Dateiname fehlt." } };
            if (!EigeneEndungen.Contains(Path.GetExtension(name).ToLowerInvariant()))
                return new Dictionary<string, object> { { "fehler", "Diese Dateiart kann Fieldbook nicht anzeigen." } };
            Directory.CreateDirectory(EigeneOrdner);
            string tmp = Path.Combine(EigeneOrdner, "." + Guid.NewGuid().ToString("N") + ".part");
            try
            {
                using (var fs = new FileStream(tmp, FileMode.CreateNew, FileAccess.Write))
                    ctx.Request.InputStream.CopyTo(fs, 65536);
                string ziel;
                lock (EigeneLk)
                {
                    ziel = EigenerFreierName(name);
                    File.Move(tmp, Path.Combine(EigeneOrdner, ziel));
                }
                // Ohne Dateinamen: Logs können mit einer Rückmeldung verschickt werden, die Namen sind privat
                Log("Eigene Unterlage hinzugefügt (" + Path.GetExtension(ziel).ToLowerInvariant() + ").");
                return new Dictionary<string, object> { { "ok", true }, { "datei", ziel } };
            }
            catch (Exception e)
            {
                try { File.Delete(tmp); } catch { }
                Log("Eigene Unterlage hochladen: " + e.GetType().Name);
                return new Dictionary<string, object> { { "fehler", "Die Datei ließ sich nicht speichern." }, { "technisch", e.Message } };
            }
        }

        // Umbenennen ({datei, neu}): die Endung bleibt, der Text wandert mit
        static Dictionary<string, object> EigeneUmbenennen(Dictionary<string, object> b)
        {
            string alt = EigenePfad(Str(b, "datei"));
            if (alt == null || !File.Exists(alt)) return new Dictionary<string, object> { { "fehler", "Datei nicht gefunden." } };
            string ext = Path.GetExtension(alt);
            string neu = EigenerName(Str(b, "neu"));
            if (neu.EndsWith(ext, StringComparison.OrdinalIgnoreCase)) neu = neu.Substring(0, neu.Length - ext.Length).TrimEnd('.', ' ');
            if (neu.Length == 0) return new Dictionary<string, object> { { "fehler", "Bitte einen Namen eingeben." } };
            neu += ext;
            string altName = Path.GetFileName(alt);
            if (neu == altName) return new Dictionary<string, object> { { "ok", true }, { "datei", neu } };
            lock (EigeneLk)
            {
                // Nur Groß-/Kleinschreibung geändert: unter Windows dieselbe Datei, das ist erlaubt
                if (File.Exists(Path.Combine(EigeneOrdner, neu)) && !string.Equals(neu, altName, StringComparison.OrdinalIgnoreCase))
                    return new Dictionary<string, object> { { "fehler", "Es gibt schon eine Datei mit diesem Namen." } };
                try { File.Move(alt, Path.Combine(EigeneOrdner, neu)); }
                catch (Exception e) { return new Dictionary<string, object> { { "fehler", "Umbenennen ging nicht. Ist die Datei gerade in einem anderen Programm offen?" }, { "technisch", e.Message } }; }
                try
                {
                    var texte = EigeneTexte();
                    object t;
                    if (texte.TryGetValue(altName, out t))
                    {
                        var kopie = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
                        foreach (var kv in texte) if (!string.Equals(kv.Key, altName, StringComparison.OrdinalIgnoreCase)) kopie[kv.Key] = kv.Value;
                        kopie[neu] = t;
                        SicherSchreiben(EigeneTexteDatei, Json.Serialize(new Dictionary<string, object> { { "dateien", kopie } }));
                    }
                }
                catch { }
            }
            try { DateiGruppeUmziehen(altName, neu); } catch (Exception e) { Log("Ordner der Datei umbenennen: " + e.Message); }
            return new Dictionary<string, object> { { "ok", true }, { "datei", neu } };
        }

        static Dictionary<string, object> EigeneLoeschen(Dictionary<string, object> b)
        {
            string pfad = EigenePfad(Str(b, "datei"));
            if (pfad == null || !File.Exists(pfad)) return new Dictionary<string, object> { { "fehler", "Datei nicht gefunden." } };
            lock (EigeneLk)
            {
                try { File.Delete(pfad); }
                catch (Exception e) { return new Dictionary<string, object> { { "fehler", "Löschen ging nicht. Ist die Datei gerade in einem anderen Programm offen?" }, { "technisch", e.Message } }; }
            }
            try { DateiGruppeUmziehen(Path.GetFileName(pfad), null); } catch (Exception e) { Log("Ordner der Datei löschen: " + e.Message); }
            Log("Eigene Unterlage gelöscht (" + Path.GetExtension(pfad).ToLowerInvariant() + ").");
            return new Dictionary<string, object> { { "ok", true } };
        }

        // ------------------------------------------------------------------ Notizen
        // Eine Notiz ist eine kleine HTML-Datei in daten/eigene (Titel = Dateiname). Die Oberfläche schickt nur den
        // Inhalt (schon gefiltert); hier kommt der Rahmen dazu, damit sie auch per Doppelklick ordentlich aussieht.

        static string NotizHtml(string titel, string inhalt)
        {
            return "<!DOCTYPE html>\n<html lang=\"de\"><head><meta charset=\"utf-8\"><meta name=\"fieldbook-notiz\" content=\"1\"><title>" +
                HtmlAttr(titel).Replace(">", "&gt;") + "</title><style>body{font-family:'Segoe UI',sans-serif;max-width:780px;margin:2em auto;padding:0 1em;line-height:1.55}" +
                "table{border-collapse:collapse;margin:1em 0;max-width:100%}td,th{border:1px solid #999;padding:5px 9px;vertical-align:top;overflow-wrap:anywhere}th{background:#eee}" +
                ".klein{font-size:.85em}</style></head>\n<body>\n" + inhalt + "\n</body></html>\n";
        }

        static Dictionary<string, object> NotizNeu(Dictionary<string, object> b)
        {
            string titel = EigenerName(Str(b, "titel") ?? "");
            if (titel.Length == 0) titel = "Neue Notiz";
            if (titel.Length > 120) titel = titel.Substring(0, 120).TrimEnd('.', ' ');
            Directory.CreateDirectory(EigeneOrdner);
            string datei;
            lock (EigeneLk)
            {
                datei = EigenerFreierName(titel + ".html");
                File.WriteAllText(Path.Combine(EigeneOrdner, datei), NotizHtml(Path.GetFileNameWithoutExtension(datei), "<p><br></p>"), new UTF8Encoding(false));
            }
            Log("Notiz angelegt.");
            return new Dictionary<string, object> { { "ok", true }, { "datei", datei } };
        }

        static Dictionary<string, object> NotizSpeichern(Dictionary<string, object> b)
        {
            string pfad = EigenePfad(Str(b, "datei"));
            if (pfad == null || !pfad.EndsWith(".html", StringComparison.OrdinalIgnoreCase) || !File.Exists(pfad))
                return new Dictionary<string, object> { { "fehler", "Diese Notiz gibt es nicht mehr." } };
            string inhalt = Str(b, "html") ?? "";
            if (inhalt.Length > 5000000) return new Dictionary<string, object> { { "fehler", "Die Notiz ist zu lang." } };
            try
            {
                lock (EigeneLk)
                {
                    string tmp = pfad + ".part";
                    File.WriteAllText(tmp, NotizHtml(Path.GetFileNameWithoutExtension(pfad), inhalt), new UTF8Encoding(false));
                    File.Copy(tmp, pfad, true);
                    File.Delete(tmp);
                }
            }
            catch (Exception e) { return new Dictionary<string, object> { { "fehler", "Die Notiz ließ sich nicht speichern." }, { "technisch", e.Message } }; }
            var fi = new FileInfo(pfad);
            return new Dictionary<string, object> { { "ok", true }, { "kennung", EigeneKennung(fi) } };
        }

        // ------------------------------------------------------------------ Webseiten sichern
        // Gesicherte Webseiten liegen in daten/eigene/webseiten, geordnet wie die Website:
        //   landkreis-beispiel.de/buerger/notfall/index.html, Bilder und Schriften gemeinsam in landkreis-beispiel.de/_dateien.
        // Die Seite selbst (HTML) baut die Oberfläche zusammen (js/webseiten.js): Server holt die Seite (mit Edge
        // fertig aufgebaut, sonst roh), lädt Bilder/CSS/Schriften und schreibt die Dateien. Programmcode (JavaScript)
        // wird nie mitgespeichert; ausgeliefert wird unter /gesichert/ mit CSP ohne Skripte.
        // Liste mit Namen und Adresse: webseiten/webseiten.json ({ seiten: [{ ordner, url, name, datum }] }).

        static string WebseitenOrdner { get { return Path.Combine(EigeneOrdner, "webseiten"); } }
        static string WebseitenListeDatei { get { return Path.Combine(WebseitenOrdner, "webseiten.json"); } }
        static readonly object WebLk = new object();
        const string WebBrowserKennung = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
        const string WebCsp = "sandbox allow-same-origin; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri *";

        static string WebKurz(string s, int n)
        {
            using (var sha = System.Security.Cryptography.SHA1.Create())
            {
                var h = sha.ComputeHash(Utf8.GetBytes(s));
                return string.Concat(h.Select(x => x.ToString("x2"))).Substring(0, n);
            }
        }

        // Nur http(s) und keine Adressen dieses Rechners (sonst könnte man über Fieldbook lokale Dienste abfragen)
        static Uri WebUri(string s)
        {
            Uri u;
            if (string.IsNullOrWhiteSpace(s) || !Uri.TryCreate(s.Trim(), UriKind.Absolute, out u)) return null;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps) return null;
            string h = u.Host.ToLowerInvariant();
            if (u.IsLoopback || h == "localhost" || h.EndsWith(".localhost") || h == "0.0.0.0" || h == "[::]") return null;
            return u;
        }

        // Ein Teil des Ordnerpfads: ohne verbotene Zeichen, nicht zu lang, nicht wie reservierte Windows-Namen
        static string WebTeil(string s)
        {
            var sb = new StringBuilder();
            foreach (char c in s) sb.Append(c < 32 || "<>:\"/\\|?*".IndexOf(c) >= 0 ? '_' : c);
            string t = sb.ToString().Trim().TrimEnd('.', ' ');
            if (t.Length == 0) t = "seite";
            if (t.StartsWith("_") || t.StartsWith(".")) t = "x" + t;   // "_dateien" ist für Bilder reserviert
            if (Regex.IsMatch(t, @"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", RegexOptions.IgnoreCase)) t += "_";
            if (t.Length > 50) t = t.Substring(0, 40).TrimEnd('.', ' ') + "-" + WebKurz(t, 8);
            return t;
        }

        // Adresse → Ordner (mit "/"): Rechnername ohne "www.", dann die Teile des Pfads. Abfragen (?id=5) und sehr
        // lange Pfade bekommen eine kurze Prüfsumme, damit jede Seite einen eigenen Ordner hat und Windows-Pfade kurz bleiben.
        static string WebOrdnerVon(Uri u)
        {
            string host = u.Host.ToLowerInvariant();
            if (host.StartsWith("www.")) host = host.Substring(4);
            if (!u.IsDefaultPort) host += "_" + u.Port;
            var teile = new List<string> { WebTeil(host) };
            foreach (var s in u.AbsolutePath.Split('/'))
            {
                if (s.Length == 0) continue;
                string d;
                try { d = Uri.UnescapeDataString(s); } catch { d = s; }
                teile.Add(WebTeil(d));
            }
            if (u.Query.Length > 1)
            {
                if (teile.Count == 1) teile.Add("seite-" + WebKurz(u.Query, 8));
                else teile[teile.Count - 1] = WebTeil(teile[teile.Count - 1] + "-" + WebKurz(u.Query, 8));
            }
            string erg = string.Join("/", teile);
            if (erg.Length > 140)
            {
                var kurz = new List<string>();
                int laenge = 0;
                foreach (var t in teile) { if (laenge + t.Length > 100) break; kurz.Add(t); laenge += t.Length + 1; }
                kurz.Add("seite-" + WebKurz(erg, 10));
                erg = string.Join("/", kurz);
            }
            return erg;
        }

        static string WebOrdnerPfad(string ordner)
        {
            if (string.IsNullOrWhiteSpace(ordner) || ordner.Contains("..") || ordner.Contains("\\")) return null;
            return SichererPfad(WebseitenOrdner, ordner.Replace("%", "%25"));
        }

        static string WebAdresseVonOrdner(string ordner)
        {
            return "/gesichert/" + string.Join("/", ordner.Split('/').Select(Uri.EscapeDataString)) + "/index.html";
        }

        static List<Dictionary<string, object>> WebSeitenLaden()
        {
            var d = LadeJson(WebseitenListeDatei);
            var liste = new List<Dictionary<string, object>>();
            if (d != null) foreach (var o in Arr(d, "seiten")) { var e = o as Dictionary<string, object>; if (e != null && Str(e, "ordner") != null) liste.Add(e); }
            return liste;
        }

        // Eigene Ordner zum Sortieren in Fieldbook (nur in der Liste, die Dateien bleiben nach Website geordnet):
        // { gruppen: [{ id, name }] }, jede Seite mit "gruppe" = id
        static List<Dictionary<string, object>> WebGruppenLaden()
        {
            var d = LadeJson(WebseitenListeDatei);
            var liste = new List<Dictionary<string, object>>();
            if (d != null) foreach (var o in Arr(d, "gruppen")) { var g = o as Dictionary<string, object>; if (g != null && Str(g, "id") != null) liste.Add(g); }
            return liste;
        }

        // Eigene Dateien in Ordnern: { dateiGruppen: { "Plan.pdf": id } } (in derselben Datei wie die Ordner)
        static Dictionary<string, object> DateiGruppenLaden()
        {
            var d = LadeJson(WebseitenListeDatei);
            var m = d != null && d.ContainsKey("dateiGruppen") ? d["dateiGruppen"] as Dictionary<string, object> : null;
            var erg = new Dictionary<string, object>(StringComparer.OrdinalIgnoreCase);
            if (m != null) foreach (var kv in m) erg[kv.Key] = kv.Value;
            return erg;
        }

        static void WebSeitenSchreiben(List<Dictionary<string, object>> liste, List<Dictionary<string, object>> gruppen = null, Dictionary<string, object> dateiGruppen = null)
        {
            Directory.CreateDirectory(WebseitenOrdner);
            SicherSchreiben(WebseitenListeDatei, Json.Serialize(new Dictionary<string, object> {
                { "seiten", liste }, { "gruppen", gruppen ?? WebGruppenLaden() }, { "dateiGruppen", dateiGruppen ?? DateiGruppenLaden() } }));
        }

        // Ordner einer eigenen Datei beim Umbenennen mitnehmen (neu == null: beim Löschen entfernen)
        static void DateiGruppeUmziehen(string alt, string neu)
        {
            lock (WebLk)
            {
                var m = DateiGruppenLaden();
                object g;
                if (!m.TryGetValue(alt, out g)) return;
                m.Remove(alt);
                if (neu != null) m[neu] = g;
                WebSeitenSchreiben(WebSeitenLaden(), null, m);
            }
        }

        // {aktion: neu|umbenennen|loeschen|verschieben, id, name, ordner (Seite), gruppe}
        static Dictionary<string, object> WebGruppen(Dictionary<string, object> b)
        {
            string aktion = Str(b, "aktion"), id = Str(b, "id"), name = (Str(b, "name") ?? "").Trim();
            if (name.Length > 100) name = name.Substring(0, 100);
            lock (WebLk)
            {
                var seiten = WebSeitenLaden();
                var gruppen = WebGruppenLaden();
                var g = gruppen.FirstOrDefault(x => Str(x, "id") == id);
                switch (aktion)
                {
                    case "neu":
                        if (name.Length == 0) return new Dictionary<string, object> { { "fehler", "Bitte einen Namen eingeben." } };
                        if (gruppen.Count >= 100) return new Dictionary<string, object> { { "fehler", "Es gibt schon sehr viele Ordner." } };
                        string neu = "g" + DateTime.Now.Ticks.ToString("x");
                        gruppen.Add(new Dictionary<string, object> { { "id", neu }, { "name", name } });
                        WebSeitenSchreiben(seiten, gruppen.OrderBy(x => Str(x, "name"), StringComparer.CurrentCultureIgnoreCase).ToList());
                        return new Dictionary<string, object> { { "ok", true }, { "neu", neu } };
                    case "umbenennen":
                        if (g == null) return new Dictionary<string, object> { { "fehler", "Ordner nicht gefunden." } };
                        if (name.Length == 0) return new Dictionary<string, object> { { "fehler", "Bitte einen Namen eingeben." } };
                        g["name"] = name;
                        WebSeitenSchreiben(seiten, gruppen.OrderBy(x => Str(x, "name"), StringComparer.CurrentCultureIgnoreCase).ToList());
                        break;
                    case "loeschen":
                        // Die Seiten bleiben, sie stehen dann ohne Ordner da
                        if (g == null) return new Dictionary<string, object> { { "fehler", "Ordner nicht gefunden." } };
                        gruppen.Remove(g);
                        foreach (var s in seiten) if (Str(s, "gruppe") == id) s.Remove("gruppe");
                        var dg = DateiGruppenLaden();
                        foreach (var k in dg.Where(kv => kv.Value as string == id).Select(kv => kv.Key).ToList()) dg.Remove(k);
                        WebSeitenSchreiben(seiten, gruppen, dg);
                        break;
                    case "verschieben":
                        // Webseite ({ordner}) oder eigene Datei ({datei})
                        string ziel = Str(b, "gruppe") ?? "";
                        if (ziel.Length > 0 && !gruppen.Any(x => Str(x, "id") == ziel)) return new Dictionary<string, object> { { "fehler", "Ordner nicht gefunden." } };
                        if (Str(b, "datei") != null)
                        {
                            string pfad = EigenePfad(Str(b, "datei"));
                            if (pfad == null || !File.Exists(pfad)) return new Dictionary<string, object> { { "fehler", "Datei nicht gefunden." } };
                            var m = DateiGruppenLaden();
                            if (ziel.Length > 0) m[Path.GetFileName(pfad)] = ziel; else m.Remove(Path.GetFileName(pfad));
                            WebSeitenSchreiben(seiten, gruppen, m);
                            break;
                        }
                        var seite = seiten.FirstOrDefault(x => Str(x, "ordner") == Str(b, "ordner"));
                        if (seite == null) return new Dictionary<string, object> { { "fehler", "Seite nicht gefunden." } };
                        if (ziel.Length > 0) seite["gruppe"] = ziel; else seite.Remove("gruppe");
                        WebSeitenSchreiben(seiten, gruppen);
                        break;
                    default: return new Dictionary<string, object> { { "fehler", "Unbekannte Aktion." } };
                }
            }
            return new Dictionary<string, object> { { "ok", true } };
        }

        // Gesicherte Seiten, deren index.html noch da ist (im Explorer gelöschte fallen weg)
        static List<KeyValuePair<Dictionary<string, object>, FileInfo>> WebSeiten()
        {
            var erg = new List<KeyValuePair<Dictionary<string, object>, FileInfo>>();
            List<Dictionary<string, object>> liste;
            lock (WebLk) liste = WebSeitenLaden();
            foreach (var e in liste)
            {
                string p = WebOrdnerPfad(Str(e, "ordner"));
                if (p == null) continue;
                var fi = new FileInfo(Path.Combine(p, "index.html"));
                if (fi.Exists) erg.Add(new KeyValuePair<Dictionary<string, object>, FileInfo>(e, fi));
            }
            return erg;
        }

        // Webseite für den Browser in Fieldbook: Antwort, Bytes, Zeichensatz, Ziel nach Weiterleitungen
        class WebAntwort { public byte[] Daten; public string Typ = ""; public Uri Ziel; }

        static WebAntwort WebLaden(Uri u, string referer, long max, int timeout)
        {
            var req = (HttpWebRequest)WebRequest.Create(u);
            req.UserAgent = WebBrowserKennung;
            req.Accept = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
            req.Headers["Accept-Language"] = "de-DE,de;q=0.9,en;q=0.7";
            req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            req.CookieContainer = new CookieContainer();
            req.Timeout = timeout;
            req.ReadWriteTimeout = timeout;
            req.MaximumAutomaticRedirections = 10;
            if (referer != null) req.Referer = referer;
            using (var resp = (HttpWebResponse)req.GetResponse())
            using (var s = resp.GetResponseStream())
            using (var ms = new MemoryStream())
            {
                // Weiterleitung auf eine Adresse dieses Rechners: ablehnen
                if (WebUri(resp.ResponseUri.AbsoluteUri) == null) throw new WebException("Ungültiges Ziel der Weiterleitung.");
                var buf = new byte[65536];
                int n;
                while ((n = s.Read(buf, 0, buf.Length)) > 0)
                {
                    ms.Write(buf, 0, n);
                    if (ms.Length > max) throw new WebException("Die Datei ist zu groß.");
                }
                return new WebAntwort { Daten = ms.ToArray(), Typ = resp.ContentType ?? "", Ziel = resp.ResponseUri };
            }
        }

        // Text dekodieren: Zeichensatz aus dem Kopf, sonst aus <meta charset>, sonst UTF-8
        static string WebText(WebAntwort a)
        {
            string cs = null;
            var m = Regex.Match(a.Typ, @"charset=[""']?([\w-]+)", RegexOptions.IgnoreCase);
            if (m.Success) cs = m.Groups[1].Value;
            if (cs == null)
            {
                string anfang = Encoding.ASCII.GetString(a.Daten, 0, Math.Min(a.Daten.Length, 4096));
                m = Regex.Match(anfang, @"<meta[^>]+charset=[""']?([\w-]+)", RegexOptions.IgnoreCase);
                if (m.Success) cs = m.Groups[1].Value;
            }
            Encoding enc = Utf8;
            if (cs != null) try { enc = Encoding.GetEncoding(cs); } catch { enc = Utf8; }
            string t = enc.GetString(a.Daten);
            return t.Length > 0 && t[0] == '﻿' ? t.Substring(1) : t;
        }

        // Verständliche Meldung, wenn eine Webseite nicht antwortet. Schutzdienste wie Cloudflare lassen nur Menschen im
        // normalen Browser durch (Antwort mit "cf-mitigated: challenge"); das umgeht Fieldbook bewusst nicht.
        const string WebSchutzText = "Diese Webseite lässt nur Besucher im normalen Browser herein (Schutz vor automatischen Abrufen).";
        static string WebFehlerText(WebException e)
        {
            var r = e.Response as HttpWebResponse;
            if (r == null) return "Die Webseite ist nicht erreichbar. Gibt es gerade Internet?";
            int code = (int)r.StatusCode;
            bool schutz = r.Headers["cf-mitigated"] != null || ((code == 403 || code == 429 || code == 503) &&
                Regex.IsMatch((r.Headers["Server"] ?? "") + " " + (r.Headers["X-Sucuri-ID"] ?? "") + " " + (r.Headers["X-DataDome"] ?? ""), @"cloudflare|sucuri|datadome|akamai", RegexOptions.IgnoreCase));
            if (schutz) return WebSchutzText + " Öffne sie im Browserfenster, dann kann Fieldbook sie von dort speichern.";
            if (code == 404) return "Diese Seite gibt es nicht (Fehler 404). Stimmt die Adresse?";
            if (code == 403 || code == 401) return "Die Webseite verweigert den Zugriff (Fehler " + code + ").";
            return "Die Webseite antwortet mit Fehler " + code + ".";
        }

        static string HtmlAttr(string s) { return (s ?? "").Replace("&", "&amp;").Replace("\"", "&quot;").Replace("<", "&lt;"); }

        // Seite fürs Anschauen in Fieldbook: Programmcode raus, <base> auf die echte Adresse (Bilder kommen direkt
        // aus dem Internet), Adresse als <meta> für die Oberfläche. Läuft in einem Rahmen ohne Skripte (CSP sandbox).
        static string WebZumAnsehen(string html, Uri ziel)
        {
            var o = RegexOptions.IgnoreCase | RegexOptions.Singleline;
            html = Regex.Replace(html, @"<script\b.*?</script\s*>", "", o);
            html = Regex.Replace(html, @"<script\b[^>]*/>", "", o);
            html = Regex.Replace(html, @"<iframe\b.*?</iframe\s*>", "", o);
            html = Regex.Replace(html, @"<base\b[^>]*>", "", o);
            html = Regex.Replace(html, @"<meta\b[^>]*http-equiv\s*=\s*[""']?(refresh|content-security-policy)[^>]*>", "", o);
            html = Regex.Replace(html, @"</?noscript\b[^>]*>", "", o);   // ohne Skripte gilt der Ersatzinhalt
            string kopf = "<base href=\"" + HtmlAttr(ziel.AbsoluteUri) + "\"><meta name=\"fieldbook-url\" content=\"" + HtmlAttr(ziel.AbsoluteUri) + "\">";
            var h = Regex.Match(html, @"<head\b[^>]*>", RegexOptions.IgnoreCase);
            if (h.Success) return html.Insert(h.Index + h.Length, kopf);
            return kopf + html;
        }

        static void WebAnsehen(HttpListenerContext ctx, string adresse)
        {
            var u = WebUri(adresse);
            string fehler = null, html = null;
            if (u == null) fehler = "Diese Adresse kann Fieldbook nicht öffnen.";
            else
            {
                try
                {
                    var a = WebLaden(u, null, 15000000, 20000);
                    if (!Regex.IsMatch(a.Typ, @"html|xml", RegexOptions.IgnoreCase) && a.Typ.Length > 0)
                        fehler = "Das ist keine Webseite, sondern eine Datei (" + a.Typ.Split(';')[0] + ").\nGesichert werden können nur Webseiten.";
                    else html = WebZumAnsehen(WebText(a), a.Ziel);
                }
                catch (WebException e) { fehler = WebFehlerText(e); }
                catch (Exception) { fehler = "Die Webseite ließ sich nicht öffnen."; }
            }
            if (html == null)
                html = "<!doctype html><meta charset=\"utf-8\"><meta name=\"fieldbook-fehler\" content=\"" + (fehler.StartsWith(WebSchutzText) ? "schutz" : "1") + "\"><title>Nicht geöffnet</title>" +
                    "<body style=\"font:16px Segoe UI,sans-serif;padding:32px;color:#ddd;background:#1b1d1a\"><p>" +
                    Regex.Replace(HtmlAttr(fehler).Replace("\n", " "), @"([.?!]) (?=[A-ZÄÖÜ])", "$1<br>") + "</p>";   // jeder Satz in eigener Zeile
            var b = Utf8.GetBytes(html);
            ctx.Response.ContentType = "text/html; charset=utf-8";
            ctx.Response.AddHeader("Content-Security-Policy", WebCsp);
            ctx.Response.AddHeader("Referrer-Policy", "no-referrer");
            ctx.Response.AddHeader("Cache-Control", "no-store");
            ctx.Response.ContentLength64 = b.Length;
            ctx.Response.OutputStream.Write(b, 0, b.Length);
        }

        // Edge (oder Chrome) unsichtbar starten und die fertig aufgebaute Seite holen. Eigenes Profil in daten/cache,
        // damit Fieldbook nicht in den Browser des Nutzers greift. null, wenn es nicht klappt.
        static string WebBrowserPfad()
        {
            var orte = new[] {
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) + @"\Microsoft\Edge\Application\msedge.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) + @"\Microsoft\Edge\Application\msedge.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\Microsoft\Edge\Application\msedge.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles) + @"\Google\Chrome\Application\chrome.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) + @"\Google\Chrome\Application\chrome.exe",
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData) + @"\Google\Chrome\Application\chrome.exe" };
            return orte.FirstOrDefault(File.Exists);
        }

        static string WebGerendert(Uri u)
        {
            string exe = WebBrowserPfad();
            if (exe == null) return null;
            string profil = Path.Combine(Daten, "cache", "browser-profil");
            Directory.CreateDirectory(profil);
            string proxy = ProxyFuer(u.AbsoluteUri);
            string args = "--headless=new --disable-gpu --no-first-run --no-default-browser-check --disable-extensions --disable-sync --mute-audio" +
                " --hide-scrollbars --window-size=1280,2000 --virtual-time-budget=8000 --lang=de-DE --user-data-dir=\"" + profil + "\"" +
                (proxy != null ? " --proxy-server=\"" + proxy + "\"" : "") + " --dump-dom \"" + u.AbsoluteUri.Replace("\"", "%22") + "\"";
            var psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, StandardOutputEncoding = Utf8 };
            var aus = new StringBuilder();
            try
            {
                using (var p = new Process { StartInfo = psi })
                {
                    p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (aus) aus.Append(e.Data).Append('\n'); };
                    p.ErrorDataReceived += (s, e) => { };
                    p.Start();
                    ChildJob.Add(p);
                    p.BeginOutputReadLine();
                    p.BeginErrorReadLine();
                    if (!p.WaitForExit(45000))
                    {
                        // Ganzen Baum beenden (Edge startet Unterprozesse)
                        try { Process.Start(new ProcessStartInfo("taskkill", "/T /F /PID " + p.Id) { UseShellExecute = false, CreateNoWindow = true }); } catch { }
                        Log("Webseite sichern: Browser hat nicht rechtzeitig geantwortet.");
                        return null;
                    }
                    p.WaitForExit();
                }
            }
            catch (Exception e) { Log("Webseite sichern: Browser ließ sich nicht starten (" + e.GetType().Name + ")."); return null; }
            string html;
            lock (aus) html = aus.ToString();
            return html.IndexOf("<body", StringComparison.OrdinalIgnoreCase) >= 0 ? html : null;
        }

        // Seite zum Speichern holen: {url} → {html, url (nach Weiterleitungen), gerendert}
        static Dictionary<string, object> WebHolen(Dictionary<string, object> b)
        {
            var u = WebUri(Str(b, "url"));
            if (u == null) return new Dictionary<string, object> { { "fehler", "Diese Adresse kann Fieldbook nicht sichern." } };
            WebAntwort a;
            try { a = WebLaden(u, null, 15000000, 20000); }
            catch (WebException e) { string t = WebFehlerText(e); return new Dictionary<string, object> { { "fehler", t }, { "schutz", t.StartsWith(WebSchutzText) }, { "technisch", e.Message } }; }
            catch (Exception e) { return new Dictionary<string, object> { { "fehler", "Die Webseite ließ sich nicht laden." }, { "technisch", e.Message } }; }
            if (a.Typ.Length > 0 && !Regex.IsMatch(a.Typ, @"html|xml", RegexOptions.IgnoreCase))
                return new Dictionary<string, object> { { "fehler", "Das ist keine Webseite, sondern eine Datei. Gesichert werden können nur Webseiten." } };
            string html = WebGerendert(a.Ziel);
            bool gerendert = html != null;
            if (html == null) html = WebText(a);
            return new Dictionary<string, object> { { "html", html }, { "url", a.Ziel.AbsoluteUri }, { "gerendert", gerendert } };
        }

        static readonly Dictionary<string, string> WebEndungen = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) {
            { "image/png", ".png" }, { "image/jpeg", ".jpg" }, { "image/jpg", ".jpg" }, { "image/gif", ".gif" }, { "image/webp", ".webp" },
            { "image/svg+xml", ".svg" }, { "image/avif", ".avif" }, { "image/x-icon", ".ico" }, { "image/vnd.microsoft.icon", ".ico" },
            { "image/bmp", ".bmp" }, { "text/css", ".css" }, { "font/woff2", ".woff2" }, { "font/woff", ".woff" }, { "application/font-woff", ".woff" },
            { "application/x-font-woff", ".woff" }, { "font/ttf", ".ttf" }, { "application/x-font-ttf", ".ttf" }, { "font/otf", ".otf" } };
        static readonly string[] WebErlaubt = { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".ico", ".bmp", ".css", ".woff2", ".woff", ".ttf", ".otf" };

        // Eine Datei (Bild, CSS, Schrift) nach _dateien laden; Name = Prüfsumme der Adresse, gleiche Dateien also nur einmal.
        // CSS wird umgeschrieben, damit Hintergrundbilder und Schriften ebenfalls lokal liegen. null, wenn es nicht geht.
        static string WebDateiLaden(string adresse, string ziel, string referer, int tiefe, long[] gesamt)
        {
            var u = WebUri(adresse);
            if (u == null) return null;
            string hash = WebKurz(u.AbsoluteUri, 16);
            try
            {
                var da = Directory.GetFiles(ziel, hash + ".*");
                if (da.Length > 0) return Path.GetFileName(da[0]);
            }
            catch (DirectoryNotFoundException) { }
            if (Interlocked.Read(ref gesamt[0]) > 300000000) return null;   // höchstens etwa 300 MB je Seite
            WebAntwort a;
            try { a = WebLaden(u, referer, 30000000, 30000); }
            catch { return null; }
            Interlocked.Add(ref gesamt[0], a.Daten.Length);
            string typ = a.Typ.Split(';')[0].Trim(), ext;
            if (!WebEndungen.TryGetValue(typ, out ext))
            {
                ext = Path.GetExtension(u.AbsolutePath).ToLowerInvariant();
                if (ext == ".jpeg") ext = ".jpg";
                if (!WebErlaubt.Contains(ext)) return null;   // HTML-Fehlerseiten, Skripte usw. nicht speichern
            }
            byte[] daten = a.Daten;
            if (ext == ".css") daten = Utf8.GetBytes(WebCssUmschreiben(WebText(a), a.Ziel, ziel, tiefe, gesamt));
            string name = hash + ext;
            Directory.CreateDirectory(ziel);
            string tmp = Path.Combine(ziel, "." + Guid.NewGuid().ToString("N") + ".part");
            try
            {
                File.WriteAllBytes(tmp, daten);
                if (!File.Exists(Path.Combine(ziel, name))) File.Move(tmp, Path.Combine(ziel, name));
            }
            catch { }
            finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
            return File.Exists(Path.Combine(ziel, name)) ? name : null;
        }

        static string WebCssUmschreiben(string css, Uri basis, string ziel, int tiefe, long[] gesamt)
        {
            if (tiefe >= 3) return css;
            MatchEvaluator ersetzen = m =>
            {
                string r = m.Groups[2].Value.Trim();
                if (r.Length == 0 || r.StartsWith("data:", StringComparison.OrdinalIgnoreCase) || r.StartsWith("#")) return m.Value;
                Uri abs;
                if (!Uri.TryCreate(basis, r, out abs)) return m.Value;
                string n = WebDateiLaden(abs.AbsoluteUri, ziel, basis.AbsoluteUri, tiefe + 1, gesamt);
                return m.Value.StartsWith("@") ? "@import url(\"" + (n ?? abs.AbsoluteUri) + "\")" : "url(\"" + (n ?? abs.AbsoluteUri) + "\")";
            };
            css = Regex.Replace(css, @"@import\s+(['""])(.*?)\1", ersetzen, RegexOptions.IgnoreCase);
            css = Regex.Replace(css, @"url\(\s*(['""]?)(.*?)\1\s*\)", ersetzen, RegexOptions.IgnoreCase);
            return css;
        }

        // {url (der Seite), dateien: [Adressen]} → {karte: {Adresse: Dateiname in _dateien}}
        static Dictionary<string, object> WebDateien(Dictionary<string, object> b)
        {
            var seite = WebUri(Str(b, "url"));
            if (seite == null) return new Dictionary<string, object> { { "fehler", "Ungültige Adresse." } };
            string host = WebOrdnerVon(seite).Split('/')[0];
            string ziel = Path.Combine(WebseitenOrdner, host, "_dateien");
            var adressen = Arr(b, "dateien").Select(x => x as string).Where(x => x != null).Distinct().Take(500).ToList();
            var karte = new System.Collections.Concurrent.ConcurrentDictionary<string, string>();
            var gesamt = new long[1];
            System.Threading.Tasks.Parallel.ForEach(adressen, new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 6 }, adr =>
            {
                string n = WebDateiLaden(adr, ziel, seite.AbsoluteUri, 0, gesamt);
                if (n != null) karte[adr] = n;
            });
            return new Dictionary<string, object> { { "karte", karte.ToDictionary(kv => kv.Key, kv => (object)kv.Value) }, { "ordner", WebOrdnerVon(seite) } };
        }

        static string WebIndexSchreiben(string ordner, string html)
        {
            string pfad = WebOrdnerPfad(ordner);
            if (pfad == null) return null;
            Directory.CreateDirectory(pfad);
            string datei = Path.Combine(pfad, "index.html"), tmp = datei + ".part";
            File.WriteAllText(tmp, html, new UTF8Encoding(false));
            if (File.Exists(datei)) File.Delete(datei);
            File.Move(tmp, datei);
            return datei;
        }

        // {url, name, html} → speichert index.html und trägt die Seite in die Liste ein
        static Dictionary<string, object> WebSpeichern(Dictionary<string, object> b)
        {
            var u = WebUri(Str(b, "url"));
            string html = Str(b, "html");
            if (u == null || string.IsNullOrEmpty(html)) return new Dictionary<string, object> { { "fehler", "Die Seite ließ sich nicht speichern." } };
            string name = (Str(b, "name") ?? "").Trim();
            if (name.Length > 200) name = name.Substring(0, 200);
            if (name.Length == 0) name = u.Host;
            string ordner = WebOrdnerVon(u);
            try
            {
                lock (WebLk)
                {
                    WebIndexSchreiben(ordner, html);
                    var alle = WebSeitenLaden();
                    var vorher = alle.FirstOrDefault(e => Str(e, "ordner") == ordner);
                    var liste = alle.Where(e => Str(e, "ordner") != ordner).ToList();
                    var eintrag = new Dictionary<string, object> { { "ordner", ordner }, { "url", u.AbsoluteUri }, { "name", name }, { "datum", DateTime.Now.ToString("s") } };
                    // Ordner in Fieldbook: gewählt beim Speichern, sonst der bisherige (bei „Neu holen“)
                    string gruppe = b.ContainsKey("gruppe") ? Str(b, "gruppe") : vorher != null ? Str(vorher, "gruppe") : null;
                    if (!string.IsNullOrEmpty(gruppe) && WebGruppenLaden().Any(g => Str(g, "id") == gruppe)) eintrag["gruppe"] = gruppe;
                    liste.Add(eintrag);
                    WebSeitenSchreiben(liste.OrderBy(e => Str(e, "ordner"), StringComparer.OrdinalIgnoreCase).ToList());
                }
            }
            catch (Exception e)
            {
                Log("Webseite sichern: " + e.GetType().Name);
                return new Dictionary<string, object> { { "fehler", "Die Seite ließ sich nicht speichern. Ist genug Platz auf dem Laufwerk?" }, { "technisch", e.Message } };
            }
            Log("Webseite gesichert.");
            return new Dictionary<string, object> { { "ok", true }, { "ordner", ordner } };
        }

        // {ordner, html}: Links einer schon gesicherten Seite neu setzen (nachdem eine andere Seite dazukam oder wegfiel)
        static Dictionary<string, object> WebHtmlErsetzen(Dictionary<string, object> b)
        {
            string ordner = Str(b, "ordner"), html = Str(b, "html");
            if (string.IsNullOrEmpty(html)) return new Dictionary<string, object> { { "fehler", "Leer." } };
            lock (WebLk)
            {
                if (!WebSeitenLaden().Any(e => Str(e, "ordner") == ordner)) return new Dictionary<string, object> { { "fehler", "Seite nicht gefunden." } };
                try { WebIndexSchreiben(ordner, html); }
                catch (Exception e) { return new Dictionary<string, object> { { "fehler", "Speichern ging nicht." }, { "technisch", e.Message } }; }
            }
            return new Dictionary<string, object> { { "ok", true } };
        }

        static Dictionary<string, object> WebUmbenennen(Dictionary<string, object> b)
        {
            string ordner = Str(b, "ordner"), name = (Str(b, "name") ?? "").Trim();
            if (name.Length == 0) return new Dictionary<string, object> { { "fehler", "Bitte einen Namen eingeben." } };
            if (name.Length > 200) name = name.Substring(0, 200);
            lock (WebLk)
            {
                var liste = WebSeitenLaden();
                var e = liste.FirstOrDefault(x => Str(x, "ordner") == ordner);
                if (e == null) return new Dictionary<string, object> { { "fehler", "Seite nicht gefunden." } };
                e["name"] = name;
                WebSeitenSchreiben(liste);
            }
            lock (PdfLk) pdfBuecher.Remove(EigenePaket);   // Titel in Suche und KI neu
            return new Dictionary<string, object> { { "ok", true } };
        }

        // Seite löschen: index.html weg, leere Ordner weg; Bilder, die keine Seite der Website mehr braucht, auch
        static Dictionary<string, object> WebLoeschen(Dictionary<string, object> b)
        {
            string ordner = Str(b, "ordner");
            string pfad = WebOrdnerPfad(ordner);
            if (pfad == null) return new Dictionary<string, object> { { "fehler", "Seite nicht gefunden." } };
            string host = ordner.Split('/')[0];
            string hostPfad = Path.Combine(WebseitenOrdner, host);
            lock (WebLk)
            {
                var liste = WebSeitenLaden();
                if (!liste.Any(e => Str(e, "ordner") == ordner)) return new Dictionary<string, object> { { "fehler", "Seite nicht gefunden." } };
                try
                {
                    string datei = Path.Combine(pfad, "index.html");
                    if (File.Exists(datei)) File.Delete(datei);
                    // Leere Ordner bis hinauf zum Rechnernamen entfernen
                    for (var d = new DirectoryInfo(pfad); d != null && d.FullName.Length > hostPfad.Length; d = d.Parent)
                        if (d.Exists && !d.EnumerateFileSystemInfos().Any()) d.Delete(); else break;
                }
                catch (Exception e) { return new Dictionary<string, object> { { "fehler", "Löschen ging nicht. Ist die Seite gerade in einem anderen Programm offen?" }, { "technisch", e.Message } }; }
                liste = liste.Where(e => Str(e, "ordner") != ordner).ToList();
                WebSeitenSchreiben(liste);
                try { WebDateienAufraeumen(host, liste); } catch (Exception e) { Log("Webseite löschen, aufräumen: " + e.Message); }
            }
            Log("Gesicherte Webseite gelöscht.");
            return new Dictionary<string, object> { { "ok", true } };
        }

        static void WebDateienAufraeumen(string host, List<Dictionary<string, object>> liste)
        {
            string hostPfad = Path.Combine(WebseitenOrdner, host), dateien = Path.Combine(hostPfad, "_dateien");
            var seiten = liste.Where(e => (Str(e, "ordner") ?? "").Split('/')[0] == host).ToList();
            if (!seiten.Any())
            {
                if (Directory.Exists(dateien)) Directory.Delete(dateien, true);
                if (Directory.Exists(hostPfad) && !Directory.EnumerateFileSystemEntries(hostPfad).Any()) Directory.Delete(hostPfad);
                return;
            }
            if (!Directory.Exists(dateien)) return;
            var name = new Regex(@"[0-9a-f]{16}\.[a-z0-9]{2,5}");
            var gebraucht = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var e in seiten)
            {
                string p = WebOrdnerPfad(Str(e, "ordner"));
                if (p == null || !File.Exists(Path.Combine(p, "index.html"))) continue;
                foreach (Match m in name.Matches(File.ReadAllText(Path.Combine(p, "index.html")))) gebraucht.Add(m.Value);
            }
            // Was die gebrauchten CSS-Dateien laden (Schriften, Hintergründe), bleibt auch
            var offen = new Queue<string>(gebraucht.Where(n => n.EndsWith(".css")));
            while (offen.Count > 0)
            {
                string css = Path.Combine(dateien, offen.Dequeue());
                if (!File.Exists(css)) continue;
                foreach (Match m in name.Matches(File.ReadAllText(css)))
                    if (gebraucht.Add(m.Value) && m.Value.EndsWith(".css")) offen.Enqueue(m.Value);
            }
            foreach (var f in Directory.GetFiles(dateien))
                if (!gebraucht.Contains(Path.GetFileName(f))) try { File.Delete(f); } catch { }
        }

        // ---------------- Seiten aus einem sichtbaren Edge-Fenster übernehmen
        // Für Seiten mit Roboterschutz (Cloudflare & Co.): Fieldbook öffnet ein normales, sichtbares Edge-Fenster
        // (eigenes Profil daten/cache/browser-fenster, Fernsteuerung nur auf 127.0.0.1). Der Nutzer besucht die Seite
        // dort selbst und geht selbst durch eine Prüfung. Beim Speichern liest Fieldbook die fertige Seite und die schon
        // geladenen Bilder aus diesem Fenster (wie „Speichern unter“). Es löst keine Prüfungen und verschleiert nichts.

        static int webFensterPort;
        static readonly object WebFensterLk = new object();

        static string WebFensterHttp(string pfad, string methode)
        {
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + webFensterPort + pfad);
            req.Proxy = null;
            req.Method = methode;
            req.Timeout = 5000;
            using (var resp = req.GetResponse())
            using (var r = new StreamReader(resp.GetResponseStream(), Utf8))
                return r.ReadToEnd();
        }

        static bool WebFensterLaeuft()
        {
            if (webFensterPort == 0) return false;
            try { WebFensterHttp("/json/version", "GET"); return true; } catch { return false; }
        }

        static Dictionary<string, object> WebFensterOeffnen(Dictionary<string, object> b)
        {
            var u = WebUri(Str(b, "url"));
            if (u == null) return new Dictionary<string, object> { { "fehler", "Diese Adresse kann Fieldbook nicht öffnen." } };
            lock (WebFensterLk)
            {
                if (WebFensterLaeuft())
                {
                    try { WebFensterHttp("/json/new?" + u.AbsoluteUri, "PUT"); return new Dictionary<string, object> { { "ok", true } }; }
                    catch (Exception e) { Log("Edge-Fenster, neuer Tab: " + e.Message); }
                }
                string exe = WebBrowserPfad();
                if (exe == null) return new Dictionary<string, object> { { "fehler", "Dafür braucht Fieldbook Microsoft Edge oder Google Chrome, beides ist auf diesem Rechner nicht zu finden." } };
                string profil = Path.Combine(Daten, "cache", "browser-fenster");
                Directory.CreateDirectory(profil);
                int port = FreierPort();
                string proxy = ProxyFuer(u.AbsoluteUri);
                string args = "--remote-debugging-port=" + port + " --user-data-dir=\"" + profil + "\" --no-first-run --no-default-browser-check --disable-sync" +
                    (proxy != null ? " --proxy-server=\"" + proxy + "\"" : "") + " --new-window \"" + u.AbsoluteUri.Replace("\"", "%22") + "\"";
                try
                {
                    var p = Process.Start(new ProcessStartInfo(exe, args) { UseShellExecute = false });
                    ChildJob.Add(p);
                }
                catch (Exception e)
                {
                    Log("Edge-Fenster ließ sich nicht starten (" + e.GetType().Name + ").");
                    return new Dictionary<string, object> { { "fehler", "Das Browserfenster ließ sich nicht öffnen." }, { "technisch", e.Message } };
                }
                webFensterPort = port;
                for (int i = 0; i < 60 && !WebFensterLaeuft(); i++) Thread.Sleep(250);
            }
            return new Dictionary<string, object> { { "ok", true } };
        }

        static List<Dictionary<string, object>> WebFensterTabs()
        {
            var liste = Json.DeserializeObject(WebFensterHttp("/json/list", "GET")) as object[] ?? new object[0];
            return liste.OfType<Dictionary<string, object>>()
                .Where(t => Str(t, "type") == "page" && WebUri(Str(t, "url")) != null).ToList();
        }

        static Dictionary<string, object> WebFensterStatus()
        {
            if (webFensterPort == 0) return new Dictionary<string, object> { { "offen", false } };
            try
            {
                var seiten = WebFensterTabs().Select(t => (object)new Dictionary<string, object> {
                    { "id", Str(t, "id") }, { "titel", Str(t, "title") }, { "url", Str(t, "url") } }).ToList();
                return new Dictionary<string, object> { { "offen", true }, { "seiten", seiten } };
            }
            catch { return new Dictionary<string, object> { { "offen", false } }; }
        }

        // Kleine Verbindung zum Browser (Chrome DevTools Protocol über WebSocket), nur für das Auslesen beim Speichern
        class Cdp : IDisposable
        {
            readonly System.Net.WebSockets.ClientWebSocket ws = new System.Net.WebSockets.ClientWebSocket();
            int nr;
            public Cdp(string adresse)
            {
                if (!ws.ConnectAsync(new Uri(adresse), CancellationToken.None).Wait(10000)) throw new TimeoutException("Keine Verbindung zum Browser.");
            }
            public Dictionary<string, object> Rufe(string methode, Dictionary<string, object> par, int frist)
            {
                int id = ++nr;
                var b = Utf8.GetBytes(Json.Serialize(new Dictionary<string, object> { { "id", id }, { "method", methode }, { "params", par ?? new Dictionary<string, object>() } }));
                ws.SendAsync(new ArraySegment<byte>(b), System.Net.WebSockets.WebSocketMessageType.Text, true, CancellationToken.None).Wait();
                var ende = DateTime.UtcNow.AddMilliseconds(frist);
                while (true)
                {
                    var d = Json.DeserializeObject(Empfange(ende)) as Dictionary<string, object>;
                    if (d == null || !d.ContainsKey("id") || Convert.ToInt32(d["id"]) != id) continue;   // Ereignisse überspringen
                    if (d.ContainsKey("error")) throw new InvalidOperationException(Json.Serialize(d["error"]));
                    return d.ContainsKey("result") ? d["result"] as Dictionary<string, object> ?? new Dictionary<string, object>() : new Dictionary<string, object>();
                }
            }
            string Empfange(DateTime ende)
            {
                var ms = new MemoryStream();
                var buf = new byte[65536];
                while (true)
                {
                    int rest = (int)(ende - DateTime.UtcNow).TotalMilliseconds;
                    if (rest <= 0) throw new TimeoutException("Der Browser antwortet nicht.");
                    var t = ws.ReceiveAsync(new ArraySegment<byte>(buf), new CancellationTokenSource(rest).Token);
                    t.Wait();
                    ms.Write(buf, 0, t.Result.Count);
                    if (t.Result.EndOfMessage) return Utf8.GetString(ms.ToArray());
                }
            }
            public void Dispose()
            {
                try { ws.CloseAsync(System.Net.WebSockets.WebSocketCloseStatus.NormalClosure, "", CancellationToken.None).Wait(2000); } catch { }
                ws.Dispose();
            }
        }

        // {id (Tab)} → {html, url, titel}; Bilder, CSS und Schriften der Seite landen gleich in _dateien
        static Dictionary<string, object> WebFensterHolen(Dictionary<string, object> b)
        {
            Dictionary<string, object> tab;
            try { tab = WebFensterTabs().FirstOrDefault(t => Str(t, "id") == Str(b, "id")); }
            catch { return new Dictionary<string, object> { { "fehler", "Das Browserfenster ist nicht mehr offen." } }; }
            if (tab == null) return new Dictionary<string, object> { { "fehler", "Diese Seite ist im Browserfenster nicht mehr offen." } };
            var u = WebUri(Str(tab, "url"));
            string wsAdresse = Str(tab, "webSocketDebuggerUrl");
            if (u == null || wsAdresse == null) return new Dictionary<string, object> { { "fehler", "Diese Seite lässt sich nicht übernehmen." } };
            try
            {
                using (var c = new Cdp(wsAdresse))
                {
                    Func<string, string> werte = (ausdruck) =>
                    {
                        var r = c.Rufe("Runtime.evaluate", new Dictionary<string, object> { { "expression", ausdruck }, { "returnByValue", true } }, 20000);
                        var w = r.ContainsKey("result") ? r["result"] as Dictionary<string, object> : null;
                        return w != null ? Str(w, "value") : null;
                    };
                    string html = werte("document.documentElement.outerHTML");
                    string titel = werte("document.title");
                    string adresse = werte("location.href");
                    var echt = WebUri(adresse) ?? u;
                    if (string.IsNullOrEmpty(html)) return new Dictionary<string, object> { { "fehler", "Die Seite ist noch nicht fertig geladen." } };
                    int dateien = 0;
                    try { dateien = WebFensterDateien(c, echt); } catch (Exception e) { Log("Edge-Fenster, Dateien: " + e.Message); }
                    try { dateien += WebFensterBildLinks(c, echt, werte); } catch (Exception e) { Log("Edge-Fenster, große Bilder: " + e.Message); }
                    Log("Webseite aus dem Browserfenster übernommen (" + dateien + " Dateien).");
                    return new Dictionary<string, object> { { "html", html }, { "url", echt.AbsoluteUri }, { "titel", titel ?? "" }, { "gerendert", true } };
                }
            }
            catch (Exception e)
            {
                Log("Edge-Fenster auslesen: " + e.GetType().Name + " " + e.Message);
                return new Dictionary<string, object> { { "fehler", "Die Seite ließ sich nicht aus dem Browserfenster übernehmen. Ist sie dort fertig geladen?" }, { "technisch", e.Message } };
            }
        }

        // Schon geladene Dateien des Tabs aus dem Zwischenspeicher des Browsers nach _dateien schreiben (kein neuer Abruf)
        static int WebFensterDateien(Cdp c, Uri seite)
        {
            var baum = c.Rufe("Page.getResourceTree", null, 10000);
            var ft = baum.ContainsKey("frameTree") ? baum["frameTree"] as Dictionary<string, object> : null;
            if (ft == null) return 0;
            var frame = ft["frame"] as Dictionary<string, object>;
            string frameId = Str(frame, "id");
            string ziel = Path.Combine(WebseitenOrdner, WebOrdnerVon(seite).Split('/')[0], "_dateien");
            Directory.CreateDirectory(ziel);
            var gesamt = new long[1];
            var res = Arr(ft, "resources").OfType<Dictionary<string, object>>()
                .Where(r => { string t = Str(r, "type"); return t == "Image" || t == "Font" || t == "Stylesheet"; })
                .OrderBy(r => Str(r, "type") == "Stylesheet" ? 1 : 0).Take(500).ToList();   // CSS zuletzt: Schriften liegen dann schon da
            int n = 0;
            foreach (var r in res)
            {
                var ru = WebUri(Str(r, "url"));
                if (ru == null) continue;
                string hash = WebKurz(ru.AbsoluteUri, 16);
                if (Directory.GetFiles(ziel, hash + ".*").Length > 0) continue;
                string ext;
                if (!WebEndungen.TryGetValue((Str(r, "mimeType") ?? "").Split(';')[0].Trim(), out ext))
                {
                    ext = Path.GetExtension(ru.AbsolutePath).ToLowerInvariant();
                    if (ext == ".jpeg") ext = ".jpg";
                    if (!WebErlaubt.Contains(ext)) continue;
                }
                Dictionary<string, object> inhalt;
                try { inhalt = c.Rufe("Page.getResourceContent", new Dictionary<string, object> { { "frameId", frameId }, { "url", Str(r, "url") } }, 15000); }
                catch { continue; }
                string text = Str(inhalt, "content") ?? "";
                byte[] daten = Bool(inhalt, "base64Encoded") ? Convert.FromBase64String(text) : Utf8.GetBytes(text);
                if (ext == ".css") daten = Utf8.GetBytes(WebCssUmschreiben(Bool(inhalt, "base64Encoded") ? Utf8.GetString(daten) : text, ru, ziel, 0, gesamt));
                string tmp = Path.Combine(ziel, "." + Guid.NewGuid().ToString("N") + ".part");
                try
                {
                    File.WriteAllBytes(tmp, daten);
                    if (!File.Exists(Path.Combine(ziel, hash + ext))) { File.Move(tmp, Path.Combine(ziel, hash + ext)); n++; }
                }
                catch { }
                finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
            }
            return n;
        }

        // Bilder, die nur verlinkt sind (Vorschaubild → großes Bild), im Fenster selbst abrufen: dort gilt die Freigabe
        // der Seite schon. Klappt es nicht (z. B. Bild von einem anderen Server), lädt sie später WebDateien.
        static int WebFensterBildLinks(Cdp c, Uri seite, Func<string, string> werte)
        {
            string ziel = Path.Combine(WebseitenOrdner, WebOrdnerVon(seite).Split('/')[0], "_dateien");
            Directory.CreateDirectory(ziel);
            var liste = Json.DeserializeObject(werte("JSON.stringify([...new Set([...document.querySelectorAll('a[href]')].map(a => a.href)" +
                ".filter(h => { try { return /^https?:/i.test(h) && /\\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(new URL(h).pathname); } catch (e) { return false; } }))].slice(0, 100))") ?? "[]") as object[];
            int n = 0;
            foreach (var o in liste ?? new object[0])
            {
                var u = WebUri(o as string);
                if (u == null) continue;
                string hash = WebKurz(u.AbsoluteUri, 16);
                if (Directory.GetFiles(ziel, hash + ".*").Length > 0) continue;
                Dictionary<string, object> r;
                try
                {
                    r = c.Rufe("Runtime.evaluate", new Dictionary<string, object> {
                        { "expression", "fetch(" + Json.Serialize(u.AbsoluteUri) + ", { credentials: 'include' }).then(r => r.ok ? r.blob() : null)" +
                            ".then(b => !b || b.size > 25000000 ? null : new Promise(ok => { const f = new FileReader(); f.onload = () => ok(f.result); f.onerror = () => ok(null); f.readAsDataURL(b); }))" +
                            ".catch(() => null)" },
                        { "awaitPromise", true }, { "returnByValue", true } }, 30000);
                }
                catch { continue; }
                var w = r.ContainsKey("result") ? r["result"] as Dictionary<string, object> : null;
                var m = Regex.Match(w != null ? Str(w, "value") ?? "" : "", @"^data:([^;,]*)(;base64)?,(.*)$", RegexOptions.Singleline);
                if (!m.Success || m.Groups[2].Length == 0) continue;
                string ext;
                if (!WebEndungen.TryGetValue(m.Groups[1].Value, out ext) || ext == ".css")
                {
                    ext = Path.GetExtension(u.AbsolutePath).ToLowerInvariant();
                    if (ext == ".jpeg") ext = ".jpg";
                    if (!WebErlaubt.Contains(ext) || ext == ".css") continue;
                }
                if (WebDateiSchreiben(ziel, hash + ext, Convert.FromBase64String(m.Groups[3].Value))) n++;
            }
            return n;
        }

        static bool WebDateiSchreiben(string ziel, string name, byte[] daten)
        {
            string tmp = Path.Combine(ziel, "." + Guid.NewGuid().ToString("N") + ".part");
            try
            {
                File.WriteAllBytes(tmp, daten);
                if (File.Exists(Path.Combine(ziel, name))) return false;
                File.Move(tmp, Path.Combine(ziel, name));
                return true;
            }
            catch { return false; }
            finally { try { if (File.Exists(tmp)) File.Delete(tmp); } catch { } }
        }

        static object WebListe()
        {
            return WebSeiten().Select(kv => new Dictionary<string, object> {
                { "ordner", Str(kv.Key, "ordner") }, { "url", Str(kv.Key, "url") }, { "name", Str(kv.Key, "name") },
                { "datum", Str(kv.Key, "datum") }, { "adresse", WebAdresseVonOrdner(Str(kv.Key, "ordner")) } }).ToList();
        }

        static void SendeText(HttpListenerContext ctx, int code, string text)
        {
            var b = Utf8.GetBytes(text);
            ctx.Response.StatusCode = code;
            ctx.Response.ContentType = "text/plain; charset=utf-8";
            ctx.Response.ContentLength64 = b.Length;
            ctx.Response.OutputStream.Write(b, 0, b.Length);
        }

        static void SendeJson(HttpListenerContext ctx, object o, int code = 200)
        {
            var b = Utf8.GetBytes(Json.Serialize(o));
            ctx.Response.StatusCode = code;
            ctx.Response.ContentType = "application/json; charset=utf-8";
            ctx.Response.AddHeader("Cache-Control", "no-store");
            ctx.Response.ContentLength64 = b.Length;
            ctx.Response.OutputStream.Write(b, 0, b.Length);
        }

        static Dictionary<string, object> LeseBody(HttpListenerContext ctx)
        {
            using (var r = new StreamReader(ctx.Request.InputStream, Encoding.UTF8))
            {
                string s = r.ReadToEnd();
                if (string.IsNullOrWhiteSpace(s)) return new Dictionary<string, object>();
                return Json.DeserializeObject(s) as Dictionary<string, object> ?? new Dictionary<string, object>();
            }
        }

        // ------------------------------------------------------------------ API

        static void Api(HttpListenerContext ctx, string was)
        {
            // Query selbst als UTF-8 lesen (HttpListener entschlüsselt Umlaute sonst falsch)
            var q = new Dictionary<string, string>();
            foreach (var teil in ctx.Request.Url.Query.TrimStart('?').Split('&'))
            {
                if (teil.Length == 0) continue;
                int i = teil.IndexOf('=');
                string k = Uri.UnescapeDataString((i < 0 ? teil : teil.Substring(0, i)).Replace('+', ' '));
                string v = i < 0 ? "" : Uri.UnescapeDataString(teil.Substring(i + 1).Replace('+', ' '));
                q[k] = v;
            }
            Func<string, string> Q = k => q.ContainsKey(k) ? q[k] : null;
            if (was.StartsWith("pdftext/seite/")) { PdfSeite(ctx, was.Substring(14)); return; }
            if (was.StartsWith("eigene/datei/"))
            {
                // Name aus RawUrl selbst entschlüsseln (wie bei Kiwix: "%25" darf nicht vorher zu "%" werden)
                string roh = ctx.Request.RawUrl ?? "";
                int i = roh.IndexOf("/eigene/datei/", StringComparison.Ordinal);
                string n = i < 0 ? "" : roh.Substring(i + 14);
                int ende = n.IndexOfAny(new[] { '?', '#' });
                if (ende >= 0) n = n.Substring(0, ende);
                string name;
                try { name = Uri.UnescapeDataString(n); } catch { name = null; }
                // Notizen (HTML) direkt geöffnet: ohne Programmcode
                if (name != null && name.EndsWith(".html", StringComparison.OrdinalIgnoreCase)) ctx.Response.AddHeader("Content-Security-Policy", WebCsp);
                SendeDatei(ctx, EigenePfad(name));
                return;
            }
            switch (was)
            {
                // Eigene Unterlagen (Bibliothek): Liste, Hochladen, ausgelesener Text, Umbenennen, Löschen, Ordner zeigen
                case "eigene": SendeJson(ctx, EigeneListe()); return;
                case "eigene/hochladen":
                    if (ctx.Request.HttpMethod != "POST") { SendeText(ctx, 405, "Nur POST"); return; }
                    SendeJson(ctx, EigeneHochladen(ctx, Q("name"))); return;
                case "eigene/text": SendeJson(ctx, EigeneTextSpeichern(LeseBody(ctx))); return;
                case "eigene/umbenennen": SendeJson(ctx, EigeneUmbenennen(LeseBody(ctx))); return;
                case "eigene/loeschen": SendeJson(ctx, EigeneLoeschen(LeseBody(ctx))); return;
                case "eigene/notiz/neu": SendeJson(ctx, NotizNeu(LeseBody(ctx))); return;
                case "eigene/notiz/speichern": SendeJson(ctx, NotizSpeichern(LeseBody(ctx))); return;
                // Webseiten sichern (Browser in Fieldbook, js/webseiten.js)
                case "web/ansehen": WebAnsehen(ctx, Q("url")); return;
                case "web/holen": SendeJson(ctx, WebHolen(LeseBody(ctx))); return;
                case "web/dateien": SendeJson(ctx, WebDateien(LeseBody(ctx))); return;
                case "web/speichern": SendeJson(ctx, WebSpeichern(LeseBody(ctx))); return;
                case "web/html": SendeJson(ctx, WebHtmlErsetzen(LeseBody(ctx))); return;
                case "web/umbenennen": SendeJson(ctx, WebUmbenennen(LeseBody(ctx))); return;
                case "web/loeschen": SendeJson(ctx, WebLoeschen(LeseBody(ctx))); return;
                case "web/liste": SendeJson(ctx, new Dictionary<string, object> { { "seiten", WebListe() } }); return;
                case "web/gruppen": SendeJson(ctx, WebGruppen(LeseBody(ctx))); return;
                case "web/fenster": SendeJson(ctx, WebFensterStatus()); return;
                case "web/fenster/oeffnen": SendeJson(ctx, WebFensterOeffnen(LeseBody(ctx))); return;
                case "web/fenster/holen": SendeJson(ctx, WebFensterHolen(LeseBody(ctx))); return;
                case "eigene/ordner":
                    try
                    {
                        Directory.CreateDirectory(EigeneOrdner);
                        Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"), "\"" + EigeneOrdner + "\"") { UseShellExecute = false });
                        SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    }
                    catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Der Ordner ließ sich nicht öffnen." }, { "technisch", e.Message } }); }
                    return;
                case "pdftext/stand": SendeJson(ctx, PdfStand(Q("buch"))); return;
                case "pdftext/speichern": SendeJson(ctx, PdfSpeichern(LeseBody(ctx))); return;
                case "pdftext/suche":
                    {
                        int n;
                        if (!int.TryParse(Q("n"), out n)) n = 5;                        SendeJson(ctx, PdfSuche(Q("buch"), Q("q"), Math.Min(20, Math.Max(1, n))));
                        return;
                    }
                case "status":
                    // Nur Anfragen aus einem Fieldbook-Tab zählen (der Browser schickt die Herkunftsseite mit)
                    if (ctx.Request.UrlReferrer != null) TabMelden();
                    SendeJson(ctx, Status()); return;
                case "zeigen":
                    // Fieldbook wurde nochmal gestartet: offenen Tab nach vorne holen, sonst einen neuen öffnen
                    {
                        bool vorne = TabOffen(70) && BrowserNachVorne();
                        if (!vorne) BrowserOeffnen();
                        SendeJson(ctx, new Dictionary<string, object> { { "vorhanden", vorne } });
                    }
                    return;
                case "hardware": SendeJson(ctx, Hardware()); return;
                case "katalog": SendeJson(ctx, Katalog(Q("neu") == "1")); return;
                case "kartengroesse": SendeJson(ctx, KartenGroesse(Q("id"), Q("maxzoom"))); return;
                case "fortschritt": SendeJson(ctx, Fortschritt()); return;
                case "uebersetzer/modelle": SendeJson(ctx, UebersetzerRegister()); return;
                case "orte": SendeJson(ctx, OrteSuchen(Q("q") ?? "", 25)); return;
                case "ortsnamen": SendeJson(ctx, OrteImAusschnitt(Q("bbox"), Q("stufe"))); return;
                case "ortnah": SendeJson(ctx, OrtNah(Q("lat"), Q("lon"))); return;
                case "einrichtungen":
                    if (ctx.Request.HttpMethod == "POST") SendeJson(ctx, EinrichtungenMerken(ctx, Q("v")));
                    else SendeText(ctx, 200, EinrichtungenLesen(Q("v")));
                    return;
                case "adresse": SendeJson(ctx, AdresseSuchen(Q("q"))); return;
                case "strassen":
                    if (ctx.Request.HttpMethod == "POST") SendeJson(ctx, KachelnMerken(ctx, StrassenDatei(Q("v"))));
                    else SendeText(ctx, 200, KachelnLesen(StrassenDatei(Q("v"))));
                    return;
                // Rundgang, Kapitel Karten: Beispielkarte da? (GET) bzw. jetzt laden (POST, dauert einige Sekunden)
                case "uebung/beispielkarte":
                    if (ctx.Request.HttpMethod == "POST") SendeJson(ctx, BeispielKarteLaden());
                    else
                    {
                        string bk = BeispielKartePfad();
                        SendeJson(ctx, new Dictionary<string, object> { { "da", bk != null && File.Exists(bk) && ProgrammPfad("karten-assets") != null } });
                    }
                    return;
                // Eigene Orte auf der Karte: ganze Liste lesen bzw. ersetzen (daten/orte/meine-orte.json)
                case "meineorte":
                    {
                        string datei = Path.Combine(Daten, "orte", "meine-orte.json");
                        if (ctx.Request.HttpMethod == "POST")
                        {
                            var b = LeseBody(ctx);
                            var liste = b.ContainsKey("orte") ? b["orte"] as System.Collections.IList : null;
                            if (liste == null) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Ungültige Liste." } }); return; }
                            try
                            {
                                // "kategorienAus": ausgeblendete Kategorien (Namen)
                                var aus = b.ContainsKey("kategorienAus") ? b["kategorienAus"] as System.Collections.IList : null;
                                lock (MeineOrteLk) SicherSchreiben(datei, Json.Serialize(new Dictionary<string, object> { { "orte", liste }, { "kategorienAus", aus ?? (System.Collections.IList)new object[0] } }));
                                SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                            }
                            catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Die Orte ließen sich nicht speichern." }, { "technisch", e.Message } }); }
                            return;
                        }
                        object d;
                        lock (MeineOrteLk) d = LadeJsonRoh(datei);
                        var dd = d as Dictionary<string, object>;
                        SendeJson(ctx, new Dictionary<string, object> {
                            { "orte", dd != null && dd.ContainsKey("orte") && dd["orte"] != null ? dd["orte"] : new object[0] },
                            { "kategorienAus", dd != null && dd.ContainsKey("kategorienAus") && dd["kategorienAus"] != null ? dd["kategorienAus"] : new object[0] } });
                        return;
                    }
                // Gesperrte Stellen und Abschnitte für die Routenplanung: ganze Liste lesen bzw. ersetzen
                // (daten/orte/sperrungen.json)
                case "sperrungen":
                    {
                        string datei = Path.Combine(Daten, "orte", "sperrungen.json");
                        if (ctx.Request.HttpMethod == "POST")
                        {
                            var b = LeseBody(ctx);
                            var liste = b.ContainsKey("sperrungen") ? b["sperrungen"] as System.Collections.IList : null;
                            if (liste == null) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Ungültige Liste." } }); return; }
                            try
                            {
                                lock (SperrungenLk) SicherSchreiben(datei, Json.Serialize(new Dictionary<string, object> { { "sperrungen", liste } }));
                                SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                            }
                            catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Die Sperrungen ließen sich nicht speichern." }, { "technisch", e.Message } }); }
                            return;
                        }
                        object d;
                        lock (SperrungenLk) d = LadeJsonRoh(datei);
                        var dd = d as Dictionary<string, object>;
                        SendeJson(ctx, new Dictionary<string, object> {
                            { "sperrungen", dd != null && dd.ContainsKey("sperrungen") && dd["sperrungen"] != null ? dd["sperrungen"] : new object[0] } });
                        return;
                    }
                case "ifixit": SendeJson(ctx, Ifixit(Q("buch"), Q("pfad") ?? "")); return;
                case "artikelliste": SendeJson(ctx, Artikelliste(Q("buch"))); return;
                case "internet": SendeJson(ctx, InternetDa(Q("url"))); return;
                case "verbindungstest": SendeJson(ctx, Verbindungstest()); return;
                case "fortsetzen": SendeJson(ctx, Fortsetzen()); return;
                case "import/ordner": { string o = OrdnerWaehlen(); SendeJson(ctx, new Dictionary<string, object> { { "ordner", o ?? "" } }); return; }
                case "import/pruefen": SendeJson(ctx, ImportPruefen(Q("ordner"))); return;
                case "import/uebernehmen": SendeJson(ctx, ImportUebernehmen(LeseBody(ctx))); return;
                case "aktualisierung":
                    if (ctx.Request.HttpMethod == "POST") SendeJson(ctx, AktualisierungSetzen(LeseBody(ctx)));
                    else SendeJson(ctx, AktualisierungStatus());
                    return;
                case "aktualisierung/pruefen":
                    try { Pruefen(false, false); SendeJson(ctx, AktualisierungStatus()); }
                    catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", e.Message } }); }
                    return;
                case "programmupdate":
                    // Aus den Einstellungen (Knopf „Nach Updates suchen“): frisch fragen; ?neu=0 nimmt den gemerkten Stand
                    try { SendeJson(ctx, ProgrammUpdateSuchen(Q("neu") != "0")); }
                    catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "version", Version }, { "fehler", e.Message }, { "bereit", BereitVersion() }, { "eingerichtet", UpdateApi() != null } }); }
                    return;
                case "programmupdate/installieren":
                    SendeJson(ctx, ProgrammUpdateJetzt());
                    return;
                case "neuigkeiten":
                    // ?offen=1 (beim Öffnen der Oberfläche): nur etwas holen, wenn die Seite nach einem Update noch fällig ist
                    SendeJson(ctx, Neuigkeiten(Q("offen") == "1"));
                    return;
                case "neuigkeiten/gesehen":
                    lock (Lk) { if (einst.Remove("neuigkeitenOffen")) SpeichereEinst(); }
                    SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    return;
                case "wiederholen":
                    lock (Lk)
                    {
                        if (worker != null && worker.IsAlive) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Es läuft bereits ein Download." } }); return; }
                        jobs = jobs.Where(x => x.Status != "fertig").ToList();
                        foreach (var x in jobs) { x.Status = "wartet"; x.Fehler = ""; }
                        abbrechen = false;
                        abschluss = false;
                        warteschlange = true;
                        worker = new Thread(Arbeiter) { IsBackground = true };
                        worker.Start();
                        WarteschlangeMerken();
                    }
                    SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    return;
                case "desktopsymbol":
                    SendeJson(ctx, DesktopSymbol(Bool(LeseBody(ctx), "an")));
                    return;
                case "tab/marke":
                    SendeJson(ctx, new Dictionary<string, object> { { "neu", ctx.Request.HttpMethod == "POST" && TabMarkeAbholen() } });
                    return;
                case "browserstart":
                    SendeJson(ctx, BrowserStart(Bool(LeseBody(ctx), "an")));
                    return;
                case "programmupdate/neustart":
                    SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    Neustart();
                    return;
                case "verbindung":
                    SendeJson(ctx, Verbindung());
                    return;
                case "feedback": SendeJson(ctx, FeedbackInfo()); return;
                case "statistik": SendeJson(ctx, StatInfo()); return;
                case "statistik/einstellen": SendeJson(ctx, StatEinstellen(LeseBody(ctx))); return;
                case "statistik/neueid": SendeJson(ctx, StatNeueId()); return;
                case "statistik/ereignis": StatEreignis(LeseBody(ctx)); SendeJson(ctx, new Dictionary<string, object> { { "ok", true } }); return;
                case "statistik/jetzt": SendeJson(ctx, new Dictionary<string, object> { { "code", StatSenden(true) } }); return;
                case "feedback/senden": SendeJson(ctx, FeedbackSenden(LeseBody(ctx))); return;
                case "aktualisierung/laden":
                    SendeJson(ctx, UpdatesJetztLaden());
                    return;
                case "chats": SendeJson(ctx, ChatListe()); return;
                case "chat":
                    {
                        string d = ChatDatei(Q("id"));
                        SendeJson(ctx, d != null && File.Exists(d) ? (object)LadeJson(d) : new Dictionary<string, object> { { "fehler", "Chat nicht gefunden." } });
                        return;
                    }
                case "chat/speichern":
                    {
                        var b = LeseBody(ctx);
                        string d = ChatDatei(Str(b, "id"));
                        if (d == null) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Ungültige Chat-ID." } }); return; }
                        b["zeit"] = DateTime.Now.ToString("s");
                        Directory.CreateDirectory(Path.GetDirectoryName(d));
                        SicherSchreiben(d, Json.Serialize(b));
                        SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        return;
                    }
                case "chat/loeschen":
                    {
                        string d = ChatDatei(Str(LeseBody(ctx), "id"));
                        try { if (d != null) SicherLoeschen(d); } catch { }
                        SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        return;
                    }
                // Alle früheren Chats löschen (Knopf unter der Liste auf der Seite Fragen)
                case "chats/loeschen":
                    {
                        int weg = 0, fehler = 0;
                        string ordner = Path.Combine(Daten, "chats");
                        if (Directory.Exists(ordner))
                            foreach (var f in Directory.GetFiles(ordner, "*.json"))
                            {
                                try { SicherLoeschen(f); weg++; } catch { fehler++; }
                            }
                        if (fehler > 0) SendeJson(ctx, new Dictionary<string, object> { { "fehler", fehler + " Chat(s) ließen sich nicht löschen." }, { "geloescht", weg } });
                        else SendeJson(ctx, new Dictionary<string, object> { { "ok", true }, { "geloescht", weg } });
                        return;
                    }
                // Lernstand im Erste-Hilfe-Kurs (wandert mit dem daten-Ordner mit)
                case "erstehilfe":
                    SendeJson(ctx, (object)LadeJson(Path.Combine(Daten, "erstehilfe.json")) ?? new Dictionary<string, object>());
                    return;
                case "erstehilfe/speichern":
                    {
                        var b = LeseBody(ctx);
                        try { SicherSchreiben(Path.Combine(Daten, "erstehilfe.json"), Json.Serialize(b)); }
                        catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", e.Message } }); return; }
                        SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        return;
                    }
                // Häkchen und Personenzahl auf der Seite Vorsorge
                case "vorsorge":
                    SendeJson(ctx, (object)LadeJson(Path.Combine(Daten, "vorsorge.json")) ?? new Dictionary<string, object>());
                    return;
                case "vorsorge/speichern":
                    {
                        var b = LeseBody(ctx);
                        try { SicherSchreiben(Path.Combine(Daten, "vorsorge.json"), Json.Serialize(b)); }
                        catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", e.Message } }); return; }
                        SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        return;
                    }
                // „Zuletzt gelesen“ in der Bibliothek: die letzten Artikel und PDF-Bücher (wandert mit dem daten-Ordner mit)
                case "zuletzt": SendeJson(ctx, ZuletztListe()); return;
                case "zuletzt/merken":
                    try { SendeJson(ctx, ZuletztMerken(LeseBody(ctx))); }
                    catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", e.Message } }); }
                    return;
                case "zuletzt/leeren":
                    lock (ZuletztLk) { try { SicherLoeschen(Path.Combine(Daten, "zuletzt.json")); } catch { } }
                    SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    return;
                // Merkliste: selbst gemerkte Sachen aus allen Bereichen, mit eigenen Ordnern (daten/merkliste.json)
                case "merkliste": lock (MerkLk) SendeJson(ctx, MerkLaden()); return;
                case "merkliste/aendern":
                    try { SendeJson(ctx, MerkAendern(LeseBody(ctx))); }
                    catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", e.Message } }); }
                    return;
                case "routengroesse": SendeJson(ctx, RoutenGroesse((Q("ids") ?? "").Split(','))); return;
                case "installieren": SendeJson(ctx, Installieren(LeseBody(ctx))); return;
                case "sprechen": Sprechen(ctx, Q("sprache"), Q("paar"), Q("erwartet")); return;
                case "sprechen/dienst": SendeJson(ctx, SprechDienstSchalten(Q("an") == "1")); return;
                case "vorlesen": Vorlesen(ctx); return;
                case "downloads/aufraeumen":
                    // Fertige Downloads aus der Liste nehmen (die Inhalte bleiben installiert); geht auch während Downloads laufen.
                    // Ein fertiges Programm-Update bleibt, daran erkennt die Seite den anstehenden Neustart.
                    lock (Lk) jobs = jobs.Where(x => x.Status != "fertig" || x.Art == "programm-update").ToList();
                    SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    return;
                case "abbrechen":
                    abbrechen = true;
                    AlleDownloadsStoppen();
                    SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    return;
                case "entfernen": SendeJson(ctx, Entfernen(LeseBody(ctx))); return;
                case "ki":
                    {
                        var b = LeseBody(ctx);
                        bool an = Bool(b, "an");
                        lock (Lk) { einst["sparmodus"] = !an; SpeichereEinst(); }
                        if (an) new Thread(StarteKi) { IsBackground = true }.Start(); else StoppeKi();
                        SendeJson(ctx, Status());
                        return;
                    }
                case "einstellungen":
                    {
                        var b = LeseBody(ctx);
                        // Ungültige Proxy-Adresse gar nicht erst speichern
                        if (b.ContainsKey("proxy") && !ProxyGueltig(Str(b, "proxy")))
                        {
                            SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Die Proxy-Adresse ist ungültig." } });
                            return;
                        }
                        lock (Lk)
                        {
                            foreach (var kv in b) einst[kv.Key] = kv.Value;
                            SpeichereEinst();
                        }
                        if (b.ContainsKey("proxy")) ProxySetzen();
                        if (b.ContainsKey("modell") || b.ContainsKey("backend"))
                        {
                            StoppeKi();
                            if (!Bool(einst, "sparmodus")) new Thread(StarteKi) { IsBackground = true }.Start();
                        }
                        SendeJson(ctx, Status());
                        return;
                    }
                case "beenden":
                    SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                    new Thread(delegate () { Thread.Sleep(400); BeendenVorbereiten(); AlleDownloadsStoppen(); StoppeKi(); StoppeKiwix(); StoppeRouting(); Environment.Exit(0); }).Start();
                    return;
                default: SendeText(ctx, 404, "Unbekannt"); return;
            }
        }

        // Zwischenspeicher für die teuren, selten wechselnden Teile von /api/status (jeder Tab fragt alle 5 s).
        // Gilt 30 s; Installieren, Entfernen, fertige Jobs und Einstellungen leeren ihn (StatusCacheLeeren).
        // Die Sperre schützt nur die drei Felder, darin wird nichts anderes aufgerufen (keine Verklemmung mit Lk).
        static readonly object statusCacheLk = new object();
        static Dictionary<string, object> statusCache;
        static DateTime statusCacheZeit;
        static int statusCacheGen;

        static void StatusCacheLeeren()
        {
            lock (statusCacheLk) { statusCacheGen++; statusCache = null; }
        }

        static Dictionary<string, object> StatusTeuer()
        {
            int gen;
            lock (statusCacheLk)
            {
                if (statusCache != null && (DateTime.UtcNow - statusCacheZeit).TotalSeconds < 30) return statusCache;
                gen = statusCacheGen;
            }
            // Außerhalb der Sperre berechnen (liest Dateien, ProgrammPfad durchsucht Ordner)
            var karten = new List<object>();
            foreach (var r in Arr(LadeJson(Path.Combine(Config, "karten.json")), "regionen"))
            {
                var d = r as Dictionary<string, object>;
                if (d != null && File.Exists(Path.Combine(Daten, "karten", Str(d, "id") + ".pmtiles"))) karten.Add(d);
            }
            var sprachen = InstallierteSprachen();
            bool uebersetzer = UebersetzerBereit();
            bool spracheingabe = SpracheingabeBereit();
            var t = new Dictionary<string, object>
            {
                {"wissen", Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim").Length},
                {"uebersetzer", uebersetzer},
                {"uebersetzerAlt", uebersetzer && !UebersetzerNeu()},
                {"sprachen", sprachen},
                {"spracheingabe", spracheingabe},
                {"spracheingabeKomplett", spracheingabe && SprachModelle().All(m => File.Exists(SprachModellPfad(m)))},
                {"stimmen", Stimmen()},
                {"piperNeu", PiperPyPfad() != null},
                {"stimmenFehlen", StimmenJobs(sprachen).Where(x => x.Art == "stimme").Select(x => x.Ziel).ToArray()},
                {"kontext", AktuellesModellKontext()},
                {"kontextFuer", Str(einst, "modell") ?? ""},
                {"karten", karten},
                {"kartenAssets", Directory.Exists(Path.Combine(Prog, "karten-assets", "fonts"))},
                {"orte", Directory.GetFiles(Path.Combine(Daten, "orte"), "*.txt").Length > 0},
                {"routenKacheln", Directory.GetFiles(Path.Combine(Daten, "routen"), "*.rd5").Select(f => Path.GetFileNameWithoutExtension(f)).ToArray()},
                {"desktopSymbol", File.Exists(DesktopLnk())},
                {"pdfTexte", PdfTexte()},
                {"programmBereit", BereitVersion()},
                {"statistikEingerichtet", FeedbackUrl() != null}
            };
            // Nur merken, wenn inzwischen nicht geleert wurde (sonst wäre der Stand evtl. schon veraltet)
            lock (statusCacheLk)
            {
                if (gen == statusCacheGen) { statusCache = t; statusCacheZeit = DateTime.UtcNow; }
            }
            return t;
        }

        // Ungünstiger Ort für den Fieldbook-Ordner (einmal ermittelt, ändert sich zur Laufzeit nicht):
        // OneDrive lädt Gigabytes hoch und lagert Dateien evtl. in die Cloud aus (dann fehlen sie offline);
        // ein sehr langer Pfad stößt mit den tiefsten Dateien an die Windows-Grenze von 260 Zeichen.
        static string ordnerWarnung;
        static bool ordnerGeprueft;
        static string OrdnerWarnung()
        {
            if (ordnerGeprueft) return ordnerWarnung;
            ordnerGeprueft = true;
            try
            {
                string wurzel = Path.GetFullPath(Root).TrimEnd('\\') + "\\";
                bool oneDrive = wurzel.IndexOf("\\OneDrive", StringComparison.OrdinalIgnoreCase) >= 0;
                foreach (var v in new[] { "OneDrive", "OneDriveConsumer", "OneDriveCommercial" })
                {
                    string p = Environment.GetEnvironmentVariable(v);
                    if (!string.IsNullOrEmpty(p) && wurzel.StartsWith(p.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)) oneDrive = true;
                }
                if (oneDrive) ordnerWarnung = "Fieldbook liegt in einem OneDrive-Ordner. OneDrive lädt dann alle Inhalte ins Internet hoch und kann Dateien in die Cloud auslagern, die offline dann fehlen. Bitte den Fieldbook-Ordner an einen anderen Ort verschieben, zum Beispiel nach C:\\Fieldbook.";
                else if (wurzel.Length > 130) ordnerWarnung = "Der Pfad zum Fieldbook-Ordner ist sehr lang (" + wurzel.Length + " Zeichen). Windows kann dann manche Dateien nicht speichern. Bitte den Ordner weiter nach oben verschieben, zum Beispiel nach C:\\Fieldbook.";
            }
            catch { }
            return ordnerWarnung;
        }

        static Dictionary<string, object> Status()
        {
            var akku = new Dictionary<string, object>();
            try
            {
                var ps = System.Windows.Forms.SystemInformation.PowerStatus;
                var cs = ps.BatteryChargeStatus;
                bool vorhanden = (cs & System.Windows.Forms.BatteryChargeStatus.NoSystemBattery) == 0 && cs != System.Windows.Forms.BatteryChargeStatus.Unknown;
                akku["vorhanden"] = vorhanden;
                akku["prozent"] = (int)Math.Round(ps.BatteryLifePercent * 100);
                akku["netz"] = ps.PowerLineStatus == System.Windows.Forms.PowerLineStatus.Online;
                akku["restMinuten"] = ps.BatteryLifeRemaining > 0 ? ps.BatteryLifeRemaining / 60 : -1;
            }
            catch { akku["vorhanden"] = false; }

            var t = StatusTeuer();
            // Kontext gehört zum gewählten Modell: wurde es ohne Leeren gewechselt, frisch lesen
            int kontext = Str(t, "kontextFuer") == (Str(einst, "modell") ?? "") ? (int)Num(t, "kontext") : AktuellesModellKontext();
            var sh = suchhilfe;
            var br = brouter;
            bool aktiv = worker != null && worker.IsAlive;
            return new Dictionary<string, object>
            {
                {"version", Version},
                {"setupFertig", Bool(einst, "setupFertig")},
                {"wissen", t["wissen"]},
                {"bibliothek", KiwixAktiv()},
                {"bibliothekFehler", kiwixFehler},
                {"ordnerWarnung", OrdnerWarnung()},
                {"desktopSymbol", t["desktopSymbol"]},
                {"browserStart", Bool(einst, "browserStart")},
                {"proxy", Str(einst, "proxy") ?? ""},
                {"unterbrochen", unterbrochen},
                {"uebersetzer", t["uebersetzer"]},
                {"uebersetzerAlt", t["uebersetzerAlt"]},
                {"sprachen", t["sprachen"]},
                {"spracheingabe", t["spracheingabe"]},
                {"spracheingabeKomplett", t["spracheingabeKomplett"]},
                {"stimmen", t["stimmen"]},
                {"piperNeu", t["piperNeu"]},
                {"stimmenFehlen", t["stimmenFehlen"]},
                {"defektePakete", kiwixDefekt.ToArray()},
                {"pdfTexte", t["pdfTexte"]},
                {"ki", new Dictionary<string, object> { {"status", llmStatus}, {"fehler", llmFehler}, {"modell", llmModell}, {"kontext", kontext}, {"suchhilfe", sh != null && !sh.HasExited} }},
                {"modell", Str(einst, "modell")},
                {"backend", Str(einst, "backend") ?? "cpu"},
                {"sparmodus", Bool(einst, "sparmodus")},
                {"akku", akku},
                {"karten", t["karten"]},
                {"kartenAssets", t["kartenAssets"]},
                {"orte", t["orte"]},
                {"routen", br != null && !br.HasExited},
                {"routenKacheln", t["routenKacheln"]},
                {"downloadAktiv", aktiv},
                {"land", Str(einst, "land")},
                {"landErkannt", WindowsLand()},
                {"sprache", Str(einst, "sprache") ?? "de"},
                {"programmNeu", progUpdate != null && Bool(progUpdate, "verfuegbar") ? Str(progUpdate, "neu") : null},
                {"programmBereit", t["programmBereit"]},
                {"start", StartKennung},
                {"updateBeimStart", UpdateBeimStart()},
                {"statistikFehler", StatFehlerAn()},
                {"statistikNutzung", StatNutzungAn()},
                {"statistikGefragt", Bool(einst, "statistikGefragt")},
                {"statistikEingerichtet", t["statistikEingerichtet"]}
            };
        }

        // Beim Start und beim Öffnen der Einstellungen nach einer neuen Version fragen (Standard: an)
        static bool UpdateBeimStart()
        {
            return !einst.ContainsKey("updateBeimStart") || Bool(einst, "updateBeimStart");
        }

        // Land aus der Windows-Regionseinstellung (offline verfügbar)
        static string WindowsLand()
        {
            try { return RegionInfo.CurrentRegion.TwoLetterISORegionName.ToUpperInvariant(); } catch { return null; }
        }

        // ------------------------------------------------------------------ Hardware

        [StructLayout(LayoutKind.Sequential)]
        class MEMORYSTATUSEX
        {
            public uint dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
            public uint dwMemoryLoad;
            public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool GlobalMemoryStatusEx([In, Out] MEMORYSTATUSEX m);

        // Prozessor und Grafikkarten ändern sich im Betrieb nicht: einmal ermitteln (WMI ist langsam)
        static Dictionary<string, object> hardwareFest;

        static Dictionary<string, object> Hardware()
        {
            var fest = hardwareFest;
            if (fest == null) hardwareFest = fest = HardwareFest();
            var h = new Dictionary<string, object>(fest);
            // Veränderliches immer frisch: Arbeitsspeicher und freier Platz
            var ms = new MEMORYSTATUSEX();
            double ram = 0, ramFrei = 0;
            if (GlobalMemoryStatusEx(ms)) { ram = ms.ullTotalPhys / 1073741824.0; ramFrei = ms.ullAvailPhys / 1073741824.0; }
            h["ramGB"] = Math.Round(ram, 1);
            h["ramFreiGB"] = Math.Round(ramFrei, 1);
            try
            {
                var di = new DriveInfo(Path.GetPathRoot(Root));
                h["laufwerk"] = di.Name;
                h["freiGB"] = Math.Round(di.AvailableFreeSpace / 1073741824.0, 1);
                h["gesamtGB"] = Math.Round(di.TotalSize / 1073741824.0, 1);
            }
            catch { h["freiGB"] = 0; }
            return h;
        }

        static Dictionary<string, object> HardwareFest()
        {
            var h = new Dictionary<string, object>();
            string cpu = "";
            try { cpu = (Registry.GetValue(@"HKEY_LOCAL_MACHINE\HARDWARE\DESCRIPTION\System\CentralProcessor\0", "ProcessorNameString", "") as string) ?? ""; } catch { }
            h["cpu"] = Regex.Replace(cpu, @"\s+", " ").Trim();
            h["threads"] = Environment.ProcessorCount;
            int kerne = 0;
            try
            {
                using (var s = new ManagementObjectSearcher("SELECT NumberOfCores FROM Win32_Processor"))
                    foreach (ManagementObject m in s.Get()) kerne += Convert.ToInt32(m["NumberOfCores"]);
            }
            catch { }
            h["kerne"] = kerne > 0 ? kerne : Environment.ProcessorCount;

            var gpus = new List<object>();
            try
            {
                using (var k = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}"))
                {
                    if (k != null)
                        foreach (var sub in k.GetSubKeyNames())
                        {
                            if (!Regex.IsMatch(sub, @"^\d{4}$")) continue;
                            try
                            {
                                using (var g = k.OpenSubKey(sub))
                                {
                                    string name = g.GetValue("DriverDesc") as string;
                                    if (string.IsNullOrEmpty(name)) continue;
                                    if (Regex.IsMatch(name, "Basic Display|Basic Render|Remote|Virtual|Parsec|Mirror|Citrix|DisplayLink|Idd", RegexOptions.IgnoreCase)) continue;
                                    long vram = 0;
                                    object q = g.GetValue("HardwareInformation.qwMemorySize");
                                    if (q is long) vram = (long)q;
                                    else if (q is byte[] && ((byte[])q).Length >= 8) vram = BitConverter.ToInt64((byte[])q, 0);
                                    if (vram <= 0)
                                    {
                                        object m = g.GetValue("HardwareInformation.MemorySize");
                                        if (m is int) vram = (uint)(int)m;
                                        else if (m is byte[] && ((byte[])m).Length >= 4) vram = BitConverter.ToUInt32((byte[])m, 0);
                                    }
                                    double gb = vram / 1073741824.0;
                                    bool intelIntegriert = Regex.IsMatch(name, "Intel", RegexOptions.IgnoreCase) && !Regex.IsMatch(name, @"\bArc\b", RegexOptions.IgnoreCase);
                                    bool dediziert = gb >= 2 && !intelIntegriert;
                                    string hersteller = Regex.IsMatch(name, "NVIDIA|GeForce|RTX|GTX|Quadro", RegexOptions.IgnoreCase) ? "nvidia" :
                                                        Regex.IsMatch(name, "AMD|Radeon", RegexOptions.IgnoreCase) ? "amd" :
                                                        Regex.IsMatch(name, "Intel", RegexOptions.IgnoreCase) ? "intel" : "andere";
                                    gpus.Add(new Dictionary<string, object> { { "name", name }, { "vramGB", Math.Round(gb, 1) }, { "dediziert", dediziert }, { "hersteller", hersteller } });
                                }
                            }
                            catch { }
                        }
                }
            }
            catch { }
            h["gpus"] = gpus;
            return h;
        }

        // ------------------------------------------------------------------ Katalog

        static Dictionary<string, object> Katalog(bool neu)
        {
            LadeKiwixKatalog(neu);
            var modelle = LadeJson(Path.Combine(Config, "modelle.json"));
            foreach (var o in Arr(modelle, "modelle"))
            {
                var m = (Dictionary<string, object>)o;
                m["installiert"] = File.Exists(Path.Combine(Daten, "modelle", Str(m, "datei")));
            }
            var sh = modelle.ContainsKey("suchhilfe") ? modelle["suchhilfe"] as Dictionary<string, object> : null;
            if (sh != null) sh["installiert"] = SuchhilfeDa();
            // Ausgemusterte Modelle nur zeigen, wo sie schon installiert sind
            modelle["modelle"] = Arr(modelle, "modelle").OfType<Dictionary<string, object>>()
                .Where(m => !Bool(m, "ausgemustert") || (bool)m["installiert"]).Cast<object>().ToArray();
            var pakete = LadeJson(Path.Combine(Config, "pakete.json"));
            // Ordner einmal auflisten statt für jedes Paket neu
            string[] zimNamen = Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim").Select(Path.GetFileName).ToArray();
            foreach (var o in Arr(pakete, "pakete"))
            {
                var p = (Dictionary<string, object>)o;
                string name = Str(p, "name"), fl = Str(p, "flavour") ?? "";
                Dictionary<string, object> e;
                if (katalog != null && katalog.TryGetValue(name + "|" + fl, out e))
                {
                    p["bytes"] = e["bytes"];
                    p["datum"] = e["datum"];
                    p["url"] = e["url"];
                    p["katalogTitel"] = e["titel"];
                    p["verfuegbar"] = true;
                }
                else
                {
                    p["bytes"] = (long)(Num(p, "mb") * 1000000);
                    p["verfuegbar"] = false;
                }
                string datei = ZimDatei(ZimName(p), fl, zimNamen);
                p["installiert"] = datei != null;
                if (datei != null)
                {
                    var dm = Regex.Match(datei, @"_(\d{4}-\d{2})[a-z]?\.zim$");
                    p["installiertDatum"] = dm.Success ? dm.Groups[1].Value : "";
                    string kat = Str(p, "datum") ?? "";
                    p["update"] = dm.Success && kat.Length >= 7 && string.CompareOrdinal(kat.Substring(0, 7), dm.Groups[1].Value) > 0;
                }
            }
            var karten = LadeJson(Path.Combine(Config, "karten.json"));
            foreach (var o in Arr(karten, "regionen"))
            {
                var r = (Dictionary<string, object>)o;
                string f = Path.Combine(Daten, "karten", Str(r, "id") + ".pmtiles");
                r["installiert"] = File.Exists(f);
                if (File.Exists(f)) r["bytesInstalliert"] = new FileInfo(f).Length;
            }
            var eigene = zimNamen.Cast<object>().ToList();
            // Kopie unter der Sperre: das lebende einst würde sonst außerhalb serialisiert, während es sich ändern kann
            Dictionary<string, object> einstKopie;
            lock (Lk) einstKopie = new Dictionary<string, object>(einst);
            return new Dictionary<string, object>
            {
                {"modelle", Arr(modelle, "modelle")},
                {"suchhilfe", sh},
                {"kategorien", Arr(pakete, "kategorien")},
                {"pakete", Arr(pakete, "pakete")},
                {"vorlagen", Arr(pakete, "vorlagen")},
                {"karten", Arr(karten, "regionen")},
                {"zimDateien", eigene},
                {"katalogOnline", katalogOnline},
                {"einstellungen", einstKopie}
            };
        }

        // Anfang des Dateinamens eines Pakets. Meist der Name aus dem Kiwix-Katalog; weicht die Datei davon ab
        // (Gardenology: Katalog „gardenology_en_all“, Datei „gardenology.org_en_all_…“), steht er als "datei" in pakete.json.
        static string ZimName(Dictionary<string, object> p)
        {
            return Str(p, "datei") ?? Str(p, "name");
        }

        static string ZimDatei(string name, string flavour)
        {
            return ZimDatei(name, flavour, Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim").Select(Path.GetFileName).ToArray());
        }

        // Mit schon gelesener Dateiliste (Katalog() prüft alle Pakete gegen eine Liste)
        static string ZimDatei(string name, string flavour, string[] dateinamen)
        {
            string muster = "^" + Regex.Escape(name) + (string.IsNullOrEmpty(flavour) ? "" : "_" + Regex.Escape(flavour)) + @"_\d{4}-\d{2}[a-z]?\.zim$";
            string treffer = null;
            foreach (var n in dateinamen)
            {
                // Schneller Vorfilter, der Regex nur für passende Anfänge
                if (!n.StartsWith(name, StringComparison.OrdinalIgnoreCase)) continue;
                if (Regex.IsMatch(n, muster, RegexOptions.IgnoreCase) && (treffer == null || string.CompareOrdinal(n, treffer) > 0)) treffer = n;
            }
            return treffer;
        }

        // Nur ein Abruf zugleich: sonst laden zwei Anfragen den großen Katalog doppelt und schreiben gleichzeitig in die Datei
        static readonly object KatalogLk = new object();

        const string KatalogUrl = "https://library.kiwix.org/catalog/v2/entries?count=20000";
        static string KatalogCache { get { return Path.Combine(Daten, "cache", "kiwix-katalog.xml"); } }
        static int katalogErneuern; // 1, solange der Katalog im Hintergrund erneuert wird

        // neu = ausdrücklich (Knopf „Nach Updates suchen“): synchron aus dem Netz. Sonst gilt ein vorhandener
        // Zwischenspeicher sofort, auch wenn er älter als 24 h ist; erneuert wird er dann im Hintergrund.
        // Synchron geladen wird nur, wenn es noch gar keinen gibt.
        static void LadeKiwixKatalog(bool neu)
        {
            string cache = KatalogCache;
            if (katalog != null && !neu) return;
            bool erneuern = false;
            lock (KatalogLk)
            {
                if (katalog != null && !neu) return;   // inzwischen von einer anderen Anfrage geladen
                string xml = null;
                bool da = File.Exists(cache);
                if (neu || !da)
                {
                    try { xml = HoleText(KatalogUrl, 90000); katalogOnline = true; }
                    catch { katalogOnline = false; }   // ohne Netz bleibt xml leer
                    if (xml != null) KatalogSchreiben(xml);
                }
                else
                {
                    katalogOnline = true;
                    erneuern = (DateTime.Now - File.GetLastWriteTime(cache)).TotalHours > 24;
                }
                if (xml == null && File.Exists(cache)) { try { xml = File.ReadAllText(cache, Utf8); } catch { } }
                katalog = ParseKatalog(xml);
            }
            if (erneuern) KatalogImHintergrund();
        }

        // Erst vollständig schreiben, dann ersetzen: ein Abbruch hinterlässt keinen halben Katalog.
        // Scheitert nur das Schreiben, gilt der geladene Text trotzdem.
        static void KatalogSchreiben(string xml)
        {
            try
            {
                string cache = KatalogCache, tmp = cache + ".tmp";
                File.WriteAllText(tmp, xml, Utf8);
                if (File.Exists(cache)) File.Replace(tmp, cache, null); else File.Move(tmp, cache);
            }
            catch (Exception e) { Log("Katalog speichern: " + e.Message); }
        }

        // Alten Katalog im Hintergrund erneuern (nur einer zugleich); bis dahin gilt der alte Stand
        static void KatalogImHintergrund()
        {
            if (Interlocked.Exchange(ref katalogErneuern, 1) == 1) return;
            try
            {
                new Thread(delegate ()
                {
                    try
                    {
                        string xml = HoleText(KatalogUrl, 90000);
                        var neuerKatalog = ParseKatalog(xml);
                        lock (KatalogLk) { KatalogSchreiben(xml); katalog = neuerKatalog; katalogOnline = true; }
                    }
                    catch (Exception e) { katalogOnline = false; Log("Katalog im Hintergrund erneuern: " + e.Message); }
                    finally { Interlocked.Exchange(ref katalogErneuern, 0); }
                }) { IsBackground = true, Priority = ThreadPriority.BelowNormal }.Start();
            }
            catch { Interlocked.Exchange(ref katalogErneuern, 0); }
        }

        static Dictionary<string, Dictionary<string, object>> ParseKatalog(string xml)
        {
            var k = new Dictionary<string, Dictionary<string, object>>();
            if (xml != null)
            {
                foreach (var teil in xml.Split(new[] { "<entry>" }, StringSplitOptions.None).Skip(1))
                {
                    string name = Tag(teil, "name"), fl = Tag(teil, "flavour") ?? "", upd = Tag(teil, "updated") ?? "";
                    var acq = Regex.Match(teil, "type=\"application/x-zim\"\\s+href=\"([^\"]+)\"\\s+length=\"(\\d+)\"");
                    if (name == null || !acq.Success) continue;
                    string key = name + "|" + fl;
                    Dictionary<string, object> vorh;
                    if (k.TryGetValue(key, out vorh) && string.CompareOrdinal((string)vorh["datum"], upd) >= 0) continue;
                    string url = acq.Groups[1].Value;
                    if (url.EndsWith(".meta4")) url = url.Substring(0, url.Length - 6);
                    k[key] = new Dictionary<string, object>
                    {
                        {"titel", WebUtility.HtmlDecode(Tag(teil, "title") ?? name)},
                        {"datum", upd.Length >= 10 ? upd.Substring(0, 10) : upd},
                        {"url", url},
                        {"bytes", long.Parse(acq.Groups[2].Value)}
                    };
                }
            }
            return k;
        }

        static string Tag(string s, string tag)
        {
            var m = Regex.Match(s, "<" + tag + ">([^<]*)</" + tag + ">");
            return m.Success ? m.Groups[1].Value : null;
        }

        static string HoleText(string url, int timeout)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Timeout = timeout;
            req.ReadWriteTimeout = timeout;
            req.UserAgent = "Fieldbook/" + Version;
            req.AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate;
            using (var resp = req.GetResponse())
            using (var r = new StreamReader(resp.GetResponseStream(), Encoding.UTF8))
                return r.ReadToEnd();
        }

        // ------------------------------------------------------------------ Rückmeldungen (Feedback)
        // Der Nutzer schreibt in den Einstellungen eine Rückmeldung. Sie wird zuerst in daten\feedback gemerkt
        // und dann an den Feedback-Dienst geschickt (Adresse "feedback" in fieldbook.json, ein Cloudflare
        // Worker, siehe tools\feedback-worker.js). Ohne Internet bleibt sie liegen und geht beim nächsten
        // Start oder spätestens nach 30 Minuten raus. Chats und Fragen an die KI gehen nie mit.

        static readonly object FeedbackLk = new object();
        static string FeedbackOrdner { get { return Path.Combine(Daten, "feedback"); } }

        static string FeedbackUrl()
        {
            var k = LadeJson(Path.Combine(Config, "fieldbook.json"));
            string u = (Str(k, "feedback") ?? "").Trim();
            return u.StartsWith("https://") || u.StartsWith("http://localhost:") ? u : null; // localhost nur zum Testen
        }

        static string[] FeedbackWartend()
        {
            try { return Directory.Exists(FeedbackOrdner) ? Directory.GetFiles(FeedbackOrdner, "*.json").OrderBy(f => f).ToArray() : new string[0]; }
            catch { return new string[0]; }
        }

        // Was außer dem Text mitgeht (wird im Formular genau so angezeigt)
        static Dictionary<string, object> FeedbackSystem()
        {
            var ms = new MEMORYSTATUSEX();
            double ram = GlobalMemoryStatusEx(ms) ? ms.ullTotalPhys / 1073741824.0 : 0;
            return new Dictionary<string, object> {
                { "Windows", Environment.OSVersion.Version.ToString() },
                { "Arbeitsspeicher", Math.Round(ram) + " GB" },
                { "KI", Str(einst, "modell") ?? "keine" } };
        }

        static List<string> FeedbackLogDateien()
        {
            try { return Directory.GetFiles(Logs, "*.log").Where(f => new FileInfo(f).Length > 0).OrderBy(f => f).ToList(); }
            catch { return new List<string>(); }
        }

        // Ende einer Logdatei (höchstens 50 KB), Benutzername und Ordnerpfade ersetzt
        static string LogEnde(string pfad)
        {
            string s;
            using (var fs = new FileStream(pfad, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                long start = Math.Max(0, fs.Length - 50000);
                fs.Seek(start, SeekOrigin.Begin);
                using (var r = new StreamReader(fs, Encoding.UTF8)) s = r.ReadToEnd();
                if (start > 0) { int i = s.IndexOf('\n'); if (i >= 0) s = "… (nur das Ende)\n" + s.Substring(i + 1); }
            }
            s = Regex.Replace(s, Regex.Escape(Root.TrimEnd('\\')), "<Fieldbook>", RegexOptions.IgnoreCase);
            string profil = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(profil)) s = Regex.Replace(s, Regex.Escape(profil), "<Benutzerordner>", RegexOptions.IgnoreCase);
            if (Environment.UserName.Length >= 3) s = Regex.Replace(s, @"\\" + Regex.Escape(Environment.UserName) + @"(?=\\|\b)", "\\<Benutzer>", RegexOptions.IgnoreCase);
            return s;
        }

        static Dictionary<string, object> FeedbackInfo()
        {
            return new Dictionary<string, object> {
                { "eingerichtet", FeedbackUrl() != null },
                { "version", Version },
                { "system", FeedbackSystem() },
                { "logs", FeedbackLogDateien().Select(f => (object)new Dictionary<string, object> { { "name", Path.GetFileName(f) }, { "bytes", new FileInfo(f).Length } }).ToList() },
                { "wartend", FeedbackWartend().Length } };
        }

        static Dictionary<string, object> FeedbackSenden(Dictionary<string, object> b)
        {
            string text = (Str(b, "text") ?? "").Trim();
            string kontakt = (Str(b, "kontakt") ?? "").Trim();
            if (text.Length < 3) return new Dictionary<string, object> { { "fehler", "Bitte schreib ein paar Worte." } };
            if (text.Length > 5000) text = text.Substring(0, 5000);
            if (kontakt.Length > 200) kontakt = kontakt.Substring(0, 200);
            if (FeedbackUrl() == null) return new Dictionary<string, object> { { "fehler", "Rückmeldungen sind in dieser Fieldbook-Version nicht eingerichtet." } };
            // Höchstens eine Rückmeldung pro Minute (Doppelklick, versehentlich mehrfach gesendet)
            lock (FeedbackLk)
            {
                if ((DateTime.UtcNow - feedbackZuletzt).TotalSeconds < 60)
                    return new Dictionary<string, object> { { "fehler", "Bitte warte eine Minute bis zur nächsten Rückmeldung." } };
                feedbackZuletzt = DateTime.UtcNow;
            }

            var logs = new List<object>();
            if (Bool(b, "logs"))
                foreach (var f in FeedbackLogDateien().Take(8))
                    try { logs.Add(new Dictionary<string, object> { { "name", Path.GetFileName(f) }, { "inhalt", LogEnde(f) } }); } catch { }
            var daten = new Dictionary<string, object> {
                { "art", "feedback" }, { "text", text }, { "kontakt", kontakt }, { "version", Version },
                { "system", FeedbackSystem() }, { "erstellt", DateTime.Now.ToString("yyyy-MM-dd HH:mm") }, { "logs", logs } };
            Directory.CreateDirectory(FeedbackOrdner);
            string datei = Path.Combine(FeedbackOrdner, DateTime.UtcNow.Ticks + ".json");
            SicherSchreiben(datei, Json.Serialize(daten));

            int code = FeedbackAusgang();
            bool gesendet = !File.Exists(datei);
            return new Dictionary<string, object> { { "ok", true }, { "gesendet", gesendet }, { "zuViele", !gesendet && code == 429 }, { "wartend", FeedbackWartend().Length } };
        }

        static DateTime feedbackZuletzt = DateTime.MinValue;

        // Schickt alle gemerkten Rückmeldungen. Bei Netzfehlern oder "zu viele" (429) bleibt der Rest
        // für später liegen. Gibt den letzten Antwortcode zurück (0 = keine Verbindung).
        static int FeedbackAusgang()
        {
            string url = FeedbackUrl();
            if (url == null) return 0;
            int code = 200;
            lock (FeedbackLk)
                foreach (var f in FeedbackWartend())
                {
                    code = SendePost(url, File.ReadAllText(f, Encoding.UTF8));
                    if (code >= 200 && code < 300) { try { File.Delete(f); } catch { } Log("Rückmeldung gesendet."); }
                    // Vom Dienst abgelehnt (fehlerhaft oder zu groß): nicht endlos wiederholen
                    else if (code == 400 || code == 413) { try { File.Move(f, f + ".abgelehnt"); } catch { } Log("Rückmeldung abgelehnt (" + code + ")."); }
                    else { Log("Rückmeldung wartet (" + (code == 0 ? "keine Verbindung" : "Dienst antwortet " + code) + ")."); return code; }
                }
            return code;
        }

        static void FeedbackHintergrund()
        {
            Thread.Sleep(20000);
            while (true)
            {
                try { if (FeedbackWartend().Length > 0) FeedbackAusgang(); } catch { }
                Thread.Sleep(30 * 60 * 1000);
            }
        }

        static int SendePost(string url, string json)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "POST";
                req.ContentType = "application/json; charset=utf-8";
                req.UserAgent = "Fieldbook/" + Version;
                req.Timeout = 20000;
                req.ReadWriteTimeout = 20000;
                byte[] b = Utf8.GetBytes(json);
                req.ContentLength = b.Length;
                using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
                using (var resp = (HttpWebResponse)req.GetResponse()) return (int)resp.StatusCode;
            }
            catch (WebException e)
            {
                var r = e.Response as HttpWebResponse;
                if (r == null) return 0;
                int c = (int)r.StatusCode;
                r.Close();
                return c;
            }
            catch { return 0; }
        }

        // ------------------------------------------------------------------ Nutzungsstatistik und Fehlerberichte
        // Nur mit ausdrücklicher Zustimmung, zwei getrennte Schalter (Standard aus):
        //   statistikFehler:  Fehler (Dienste, Downloads, Oberfläche), Gerät, KI-Tempo
        //   statistikNutzung: wie oft die Bereiche geöffnet werden, installierte Pakete und Karten, Land
        // Gezählt wird nur auf dem Gerät (daten\statistik.json), und nur, solange der Schalter an ist. Das erste
        // Paket geht gleich nach dem Einschalten raus, danach eins pro Woche, nie über getaktete Verbindungen. Fragen, Chats,
        // Suchbegriffe und Einträge gehen nie mit. Die Kennung ist zufällig und lässt sich neu würfeln.

        static readonly object StatLk = new object();
        static Dictionary<string, object> stat;
        static string StatDatei { get { return Path.Combine(Daten, "statistik.json"); } }
        static readonly string[] StatBereiche = { "start", "fragen", "bibliothek", "lesen", "kochen", "karten", "erstehilfe", "vorsorge", "einstellungen", "inhalte", "setup" };

        // Eigener Arbeitsordner des Entwicklers (Datei liegt nur dort, nie in der ZIP): nichts senden,
        // damit Tests und Testfragen die Auswertung nicht verfälschen
        static bool StatEntwickler() { return File.Exists(Path.Combine(Root, ".keine-statistik")); }

        static bool StatFehlerAn() { return Bool(einst, "statistikFehler"); }
        static bool StatNutzungAn() { return Bool(einst, "statistikNutzung"); }

        // Nur unter StatLk aufrufen
        static Dictionary<string, object> StatLaden()
        {
            if (stat == null) stat = LadeJson(StatDatei) ?? new Dictionary<string, object>();
            if (Str(stat, "id") == null) stat["id"] = NeueStatId();
            return stat;
        }

        static void StatSpeichern() { try { SicherSchreiben(StatDatei, Json.Serialize(stat)); } catch { } }

        static string NeueStatId()
        {
            var b = new byte[8];
            using (var r = System.Security.Cryptography.RandomNumberGenerator.Create()) r.GetBytes(b);
            return BitConverter.ToString(b).Replace("-", "").ToLowerInvariant();
        }

        static Dictionary<string, object> Unter(Dictionary<string, object> d, string k)
        {
            object v;
            if (d.TryGetValue(k, out v) && v is Dictionary<string, object>) return (Dictionary<string, object>)v;
            var n = new Dictionary<string, object>();
            d[k] = n;
            return n;
        }

        // Fehlertext ohne persönliche Angaben (Pfade, Benutzername, Zugangsdaten), höchstens 300 Zeichen
        static string StatText(string s)
        {
            s = (s ?? "").Replace("\r", " ").Replace("\n", " ");
            s = Regex.Replace(s, Regex.Escape(Root.TrimEnd('\\')), "<Fieldbook>", RegexOptions.IgnoreCase);
            string profil = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            if (!string.IsNullOrEmpty(profil)) s = Regex.Replace(s, Regex.Escape(profil), "<Benutzerordner>", RegexOptions.IgnoreCase);
            s = Regex.Replace(s, @"[A-Za-z]:\\[^\s""']*", "<Pfad>");
            s = Regex.Replace(s, @"://[^/\s:@]+:[^/\s@]+@", "://<Zugang>@");
            s = Regex.Replace(s, @"https?://(localhost|127\.0\.0\.1)[^\s""']*", "<lokal>");
            if (Environment.UserName.Length >= 3) s = Regex.Replace(s, @"\b" + Regex.Escape(Environment.UserName) + @"\b", "<Benutzer>", RegexOptions.IgnoreCase);
            s = Regex.Replace(s, @"\s+", " ").Trim();
            return s.Length > 300 ? s.Substring(0, 300) : s;
        }

        // Gleiche Fehler werden zusammengezählt (Ziffern zählen dabei nicht), höchstens 30 verschiedene je Woche
        static void StatFehler(string art, string text)
        {
            if (!StatFehlerAn() || string.IsNullOrEmpty(text)) return;
            try
            {
                string t = StatText(text);
                string schluessel = art + "|" + Regex.Replace(t, @"\d+", "#");
                lock (StatLk)
                {
                    var f = Unter(StatLaden(), "fehler");
                    if (!f.ContainsKey(schluessel) && f.Count >= 30) return;
                    var e = Unter(f, schluessel);
                    e["art"] = art;
                    e["text"] = t;
                    e["anzahl"] = (int)Num(e, "anzahl") + 1;
                    // Gesendet wird oft erst Tage später: die Version merken, in der der Fehler zuletzt auftrat
                    e["version"] = Version;
                    StatSpeichern();
                }
            }
            catch { }
        }

        static void StatBereich(string b)
        {
            if (!StatNutzungAn() || Array.IndexOf(StatBereiche, b) < 0) return;
            lock (StatLk)
            {
                var d = Unter(StatLaden(), "bereiche");
                d[b] = (int)Num(d, b) + 1;
                StatSpeichern();
            }
        }

        // KI-Tempo je Modell: "antwort" und "lesen" in Tokens pro Sekunde, "laden" in Sekunden
        static void StatKi(string feld, double wert) { StatKi(new[] { feld }, new[] { wert }); }

        // Mehrere Werte auf einmal, nur einmal speichern
        static void StatKi(string[] felder, double[] werte)
        {
            if (!StatFehlerAn()) return;
            lock (StatLk)
            {
                Dictionary<string, object> k = null;
                for (int i = 0; i < felder.Length; i++)
                {
                    string feld = felder[i];
                    double wert = werte[i];
                    if (double.IsNaN(wert) || wert <= 0 || wert > 100000) continue;
                    if (k == null) k = Unter(Unter(StatLaden(), "ki"), (Str(einst, "modell") ?? "?") + "|" + (Str(einst, "backend") ?? "cpu"));
                    k[feld + "Summe"] = Math.Round(Num(k, feld + "Summe") + wert, 2);
                    k[feld + "Anzahl"] = (int)Num(k, feld + "Anzahl") + 1;
                }
                if (k != null) StatSpeichern();
            }
        }

        // Das Paket, das als Nächstes gesendet würde (wird in den Einstellungen genau so angezeigt)
        static Dictionary<string, object> StatPaket()
        {
            Dictionary<string, object> s;
            lock (StatLk) s = Json.DeserializeObject(Json.Serialize(StatLaden())) as Dictionary<string, object>;
            var p = new Dictionary<string, object> {
                { "art", "statistik" }, { "id", Str(s, "id") }, { "version", Version },
                { "windows", Environment.OSVersion.Version.ToString() } };
            if (StatFehlerAn())
            {
                var h = Hardware();
                var gpus = (h["gpus"] as List<object> ?? new List<object>()).Select(o => (object)Str((Dictionary<string, object>)o, "name")).ToList();
                p["geraet"] = new Dictionary<string, object> {
                    { "cpu", Str(h, "cpu") }, { "kerne", h["kerne"] }, { "threads", h["threads"] },
                    { "ramGB", Math.Round(Num(h, "ramGB")) }, { "grafik", gpus } };
                var kiListe = new List<object>();
                foreach (var kv in Unter(s, "ki"))
                {
                    var k = kv.Value as Dictionary<string, object>;
                    if (k == null) continue;
                    var teile = kv.Key.Split('|');
                    var e = new Dictionary<string, object> { { "modell", teile[0] }, { "backend", teile.Length > 1 ? teile[1] : "cpu" } };
                    if (Num(k, "antwortAnzahl") > 0) e["antwortTokenProSek"] = Math.Round(Num(k, "antwortSumme") / Num(k, "antwortAnzahl"), 1);
                    if (Num(k, "lesenAnzahl") > 0) e["leseTokenProSek"] = Math.Round(Num(k, "lesenSumme") / Num(k, "lesenAnzahl"), 1);
                    if (Num(k, "ladenAnzahl") > 0) e["ladeSek"] = Math.Round(Num(k, "ladenSumme") / Num(k, "ladenAnzahl"), 1);
                    e["antworten"] = (int)Num(k, "antwortAnzahl");
                    kiListe.Add(e);
                }
                p["ki"] = kiListe;
                p["fehler"] = Unter(s, "fehler").Values.ToList();
            }
            if (StatNutzungAn())
            {
                p["land"] = Str(einst, "land") ?? "";
                p["bereiche"] = Unter(s, "bereiche");
                // Kennungen aus pakete.json (z. B. "wp-maxi"); alles andere nur als "eigenes Paket",
                // damit kein selbst gewählter Dateiname nach außen geht
                var pakete = new List<object>();
                try
                {
                    var bekannt = Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete").OfType<Dictionary<string, object>>()
                        .Select(d => new { id = Str(d, "id"), datei = Str(d, "name") + (string.IsNullOrEmpty(Str(d, "flavour")) ? "" : "_" + Str(d, "flavour")) }).ToList();
                    foreach (var f in Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim"))
                    {
                        string n = Regex.Replace(Path.GetFileNameWithoutExtension(f), @"_\d{4}-\d{2}[a-z]?$", "");
                        var treffer = bekannt.FirstOrDefault(b => string.Equals(b.datei, n, StringComparison.OrdinalIgnoreCase));
                        pakete.Add(treffer != null ? treffer.id : "eigenes Paket");
                    }
                }
                catch { }
                p["pakete"] = pakete;
                var karten = new List<object>();
                try
                {
                    foreach (var f in Directory.GetFiles(Path.Combine(Daten, "karten"), "*.pmtiles"))
                        if (!f.EndsWith(".neu.pmtiles") && !f.EndsWith(".tmp.pmtiles")) karten.Add(Path.GetFileNameWithoutExtension(f));
                }
                catch { }
                p["karten"] = karten;
                p["routen"] = Directory.GetFiles(Path.Combine(Daten, "routen"), "*.rd5").Length > 0;
                p["uebersetzer"] = UebersetzerBereit();
            }
            return p;
        }

        static Dictionary<string, object> StatInfo()
        {
            string gesendet;
            lock (StatLk) gesendet = File.Exists(StatDatei) || stat != null ? Str(StatLaden(), "gesendet") : null;
            bool an = StatFehlerAn() || StatNutzungAn();
            return new Dictionary<string, object> {
                { "eingerichtet", FeedbackUrl() != null },
                { "fehler", StatFehlerAn() }, { "nutzung", StatNutzungAn() }, { "gefragt", Bool(einst, "statistikGefragt") },
                { "gesendet", gesendet }, { "entwickler", StatEntwickler() }, { "paket", an ? (object)StatPaket() : null } };
        }

        static Dictionary<string, object> StatEinstellen(Dictionary<string, object> b)
        {
            lock (Lk)
            {
                if (b.ContainsKey("fehler")) einst["statistikFehler"] = Bool(b, "fehler");
                if (b.ContainsKey("nutzung")) einst["statistikNutzung"] = Bool(b, "nutzung");
                einst["statistikGefragt"] = true;
                SpeichereEinst();
            }
            lock (StatLk)
            {
                if (!StatFehlerAn() && !StatNutzungAn())
                {
                    // Beides aus: alles Gesammelte löschen, beim nächsten Einschalten gibt es eine neue Kennung
                    try { SicherLoeschen(StatDatei); } catch { }
                    stat = null;
                }
                else
                {
                    var s = StatLaden();
                    if (!StatFehlerAn()) { s.Remove("fehler"); s.Remove("ki"); }
                    if (!StatNutzungAn()) s.Remove("bereiche");
                    StatSpeichern();
                    // Noch nie gesendet: das erste Paket gleich verschicken (nach ein paar Sekunden, im Hintergrund)
                    if (Str(s, "gesendet") == null)
                        new Thread(delegate () { Thread.Sleep(5000); try { StatSenden(false); } catch { } }) { IsBackground = true }.Start();
                }
            }
            return StatInfo();
        }

        static Dictionary<string, object> StatNeueId()
        {
            lock (StatLk) { StatLaden()["id"] = NeueStatId(); StatSpeichern(); }
            return StatInfo();
        }

        static void StatEreignis(Dictionary<string, object> b)
        {
            switch (Str(b, "art"))
            {
                case "bereich": StatBereich(Str(b, "name") ?? ""); break;
                case "jsfehler": StatFehler("oberflaeche", Str(b, "text")); break;
                case "ki":
                    StatKi(new[] { "antwort", "lesen" }, new[] { Num(b, "antwort"), Num(b, "lesen") });
                    break;
            }
        }

        static void StatHintergrund()
        {
            Thread.Sleep(90000);
            while (true)
            {
                try { StatSenden(false); } catch { }
                Thread.Sleep(6 * 3600 * 1000);
            }
        }

        static int statSendetGerade;

        // Schickt das Paket, wenn es fällig ist (oder sofort, nur zum Testen): das erste, sobald eine passende
        // Verbindung da ist, danach 7 Tage nach dem letzten.
        // Gibt den Antwortcode zurück, -1 = nicht fällig oder aus, 0 = keine passende Verbindung.
        static int StatSenden(bool sofort)
        {
            if (!StatFehlerAn() && !StatNutzungAn()) return -1;
            if (StatEntwickler()) { Log("Statistik: Entwicklerordner (.keine-statistik), nicht gesendet."); return -1; }
            string url = FeedbackUrl();
            if (url == null) return -1;
            // Einschalten und Hintergrund-Prüfung können zugleich kommen: nur einer sendet
            if (Interlocked.Exchange(ref statSendetGerade, 1) == 1) return -1;
            try { return StatSendenJetzt(sofort, url); }
            finally { statSendetGerade = 0; }
        }

        static int StatSendenJetzt(bool sofort, string url)
        {
            string gesendet;
            lock (StatLk) gesendet = Str(StatLaden(), "gesendet");
            DateTime zuletzt;
            if (!sofort && gesendet != null && DateTime.TryParse(gesendet, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out zuletzt)
                && (DateTime.UtcNow - zuletzt.ToUniversalTime()).TotalDays < 7) return -1;
            var v = Verbindung();
            if (!Bool(v, "online") || Bool(v, "getaktet")) return 0;
            int code = SendePost(url, Json.Serialize(StatPaket()));
            // Angekommen oder vom Dienst abgelehnt: neue Woche beginnen (nichts stapelt sich an)
            if ((code >= 200 && code < 300) || code == 400 || code == 413)
                lock (StatLk)
                {
                    var s = StatLaden();
                    s.Remove("fehler"); s.Remove("ki"); s.Remove("bereiche");
                    s["gesendet"] = DateTime.UtcNow.ToString("o");
                    StatSpeichern();
                }
            Log("Statistik: " + (code >= 200 && code < 300 ? "gesendet." : "nicht gesendet (" + code + ")."));
            return code;
        }

        // ------------------------------------------------------------------ Proxy und Verbindungstest
        // Die .NET-Anfragen nehmen den Windows-Proxy von selbst; curl (Pakete, KI, Programme) und pmtiles
        // (Karten) kennen ihn nicht und bekommen ihn deshalb ausdrücklich mit. Ein eigener Proxy aus den
        // Einstellungen ("proxy") hat Vorrang.

        static string EigenerProxy()
        {
            return ProxyNormal(Str(einst, "proxy"));
        }

        // Proxy-Eingabe als vollständige Adresse ("proxy.schule.de:8080" → "http://proxy.schule.de:8080").
        // Leer oder ungültig: null (dann gilt der Windows-Proxy).
        static string ProxyNormal(string eingabe)
        {
            string p = (eingabe ?? "").Trim();
            if (p == "") return null;
            if (!p.Contains("://")) p = "http://" + p;
            Uri u;
            if (!Uri.TryCreate(p, UriKind.Absolute, out u) || string.IsNullOrEmpty(u.Host) || p.Any(char.IsWhiteSpace)) return null;
            return p;
        }

        // true, wenn die Eingabe leer (Windows-Proxy) oder eine gültige Proxy-Adresse ist
        static bool ProxyGueltig(string eingabe)
        {
            if ((eingabe ?? "").Trim() == "") return true;
            string p = ProxyNormal(eingabe);
            if (p == null) return false;
            try { new WebProxy(p); return true; } catch { return false; }
        }

        // Proxy für eine Adresse oder null, wenn direkt verbunden wird
        static string ProxyFuer(string url)
        {
            string eigen = EigenerProxy();
            if (eigen != null) return eigen;
            try
            {
                var u = new Uri(url);
                var p = WebRequest.GetSystemWebProxy().GetProxy(u);
                if (p != null && !p.Equals(u)) return p.GetLeftPart(UriPartial.Authority);
            }
            catch { }
            return null;
        }

        static void ProxySetzen()
        {
            IWebProxy p;
            try
            {
                string eigen = EigenerProxy();
                p = eigen != null ? new WebProxy(eigen) : WebRequest.GetSystemWebProxy();
            }
            catch (Exception e)
            {
                // Ungültige Adresse darf den Start nicht verhindern: dann den Windows-Proxy nehmen
                Log("Proxy-Adresse ungültig, Windows-Proxy wird benutzt: " + e.Message);
                p = WebRequest.GetSystemWebProxy();
            }
            try
            {
                p.Credentials = CredentialCache.DefaultCredentials;
                WebRequest.DefaultWebProxy = p;
            }
            catch (Exception e) { Log("Proxy setzen: " + e.Message); }
        }

        // Für Hilfsprogramme (Go-Programme wie pmtiles lesen diese Umgebungsvariablen)
        static void ProxyFuerProgramm(ProcessStartInfo psi, string url)
        {
            string p = ProxyFuer(url);
            if (p == null) return;
            psi.EnvironmentVariables["HTTPS_PROXY"] = p;
            psi.EnvironmentVariables["HTTP_PROXY"] = p;
        }

        // ------------------------------------------------------------------ Drossel für Kartendownloads
        // pmtiles kennt kein Tempolimit. Ist eines eingestellt (ladeLimit), laufen seine Verbindungen über
        // diesen lokalen Weiterleiter (HTTP-CONNECT, die Verschlüsselung bleibt unangetastet). Ein gemeinsamer
        // "Eimer" verteilt das Tempo auf alle Verbindungen zusammen, so bleibt die Summe beim Limit.

        static TcpListener drossel;
        static int drosselPort;
        static readonly object DrosselLk = new object();
        static double drosselGuthaben;
        static DateTime drosselZeit = DateTime.UtcNow;

        static int DrosselPort()
        {
            lock (DrosselLk)
            {
                if (drossel != null) return drosselPort;
                drossel = new TcpListener(IPAddress.Loopback, 0);
                drossel.Start();
                drosselPort = ((IPEndPoint)drossel.LocalEndpoint).Port;
            }
            new Thread(delegate ()
            {
                while (true)
                {
                    TcpClient c;
                    try { c = drossel.AcceptTcpClient(); } catch { break; }
                    ThreadPool.QueueUserWorkItem(delegate (object o) { DrosselVerbindung((TcpClient)o); }, c);
                }
            }) { IsBackground = true }.Start();
            return drosselPort;
        }

        static void DrosselVerbindung(TcpClient client)
        {
            TcpClient ziel = null;
            try
            {
                client.NoDelay = true;
                var cs = client.GetStream();
                // Anfragekopf lesen: "CONNECT host:443 HTTP/1.1 ... \r\n\r\n"
                var kopf = new StringBuilder();
                int b;
                while ((b = cs.ReadByte()) >= 0) { kopf.Append((char)b); if (kopf.Length > 8192) return; if (kopf.Length >= 4 && kopf.ToString(kopf.Length - 4, 4) == "\r\n\r\n") break; }
                var m = Regex.Match(kopf.ToString(), @"^CONNECT ([^\s:]+):(\d+) ");
                if (!m.Success) { var nein = Encoding.ASCII.GetBytes("HTTP/1.1 405 Method Not Allowed\r\n\r\n"); cs.Write(nein, 0, nein.Length); return; }
                ziel = new TcpClient(m.Groups[1].Value, int.Parse(m.Groups[2].Value)) { NoDelay = true };
                var zs = ziel.GetStream();
                var ok = Encoding.ASCII.GetBytes("HTTP/1.1 200 Connection established\r\n\r\n");
                cs.Write(ok, 0, ok.Length);
                // Hin ungedrosselt (nur Anfragen), zurück gedrosselt (die Kartendaten)
                var zielFest = ziel;
                var hin = new Thread(delegate () { DrosselKopieren(cs, zs, false); try { zielFest.Client.Shutdown(SocketShutdown.Send); } catch { } }) { IsBackground = true };
                hin.Start();
                DrosselKopieren(zs, cs, true);
            }
            catch { }
            finally
            {
                try { client.Close(); } catch { }
                if (ziel != null) try { ziel.Close(); } catch { }
            }
        }

        static void DrosselKopieren(Stream von, Stream nach, bool drosseln)
        {
            var puffer = new byte[16384];
            try
            {
                int n;
                while ((n = von.Read(puffer, 0, puffer.Length)) > 0)
                {
                    if (drosseln) DrosselWarten(n);
                    nach.Write(puffer, 0, n);
                }
            }
            catch { }
        }

        // Gemeinsamer Eimer: füllt sich mit ladeLimit Byte pro Sekunde (höchstens eine Sekunde Vorrat)
        static void DrosselWarten(int bytes)
        {
            long limit = ladeLimit;
            if (limit <= 0) return;
            double warten;
            lock (DrosselLk)
            {
                var jetzt = DateTime.UtcNow;
                drosselGuthaben = Math.Min(limit, drosselGuthaben + (jetzt - drosselZeit).TotalSeconds * limit);
                drosselZeit = jetzt;
                drosselGuthaben -= bytes;
                warten = drosselGuthaben < 0 ? -drosselGuthaben / limit : 0;
            }
            if (warten > 0) Thread.Sleep((int)Math.Min(5000, warten * 1000));
        }

        // Alle Adressen, die Fieldbook zum Herunterladen braucht, prüfen und verständlich sagen, was nicht geht
        static Dictionary<string, object> Verbindungstest()
        {
            var ziele = new List<string[]>
            {
                new[] { "Wissenspakete (Katalog)", "https://library.kiwix.org/catalog/v2/root.xml" },
                new[] { "Wissenspakete (Download)", "https://download.kiwix.org/zim/" },
                new[] { "Karten (Verzeichnis)", "https://build-metadata.protomaps.dev/builds.json" },
                new[] { "Karten (Daten)", "https://build.protomaps.com/" },
                new[] { "KI-Modelle", "https://huggingface.co/" },
                new[] { "Hilfsprogramme und Updates", "https://github.com/" },
                new[] { "Übersetzer (Programm)", "https://cdn.jsdelivr.net/npm/@browsermt/bergamot-translator@0.4.9/translator.js" },
                new[] { "Übersetzer (Verzeichnis)", "https://firefox.settings.services.mozilla.com/v1/" },
                new[] { "Übersetzer (Sprachen)", "https://firefox-settings-attachments.cdn.mozilla.net/" },
                new[] { "Ortsnamen", "https://download.geonames.org/export/dump/" },
                new[] { "Wegedaten", SegmentBasis },
            };
            var erg = new Dictionary<string, object>[ziele.Count];
            System.Threading.Tasks.Parallel.For(0, ziele.Count, i => { erg[i] = AdresseTesten(ziele[i][0], ziele[i][1]); });
            string proxy = ProxyFuer("https://download.kiwix.org/");
            return new Dictionary<string, object>
            {
                { "ok", erg.All(x => (bool)x["ok"]) },
                { "proxy", proxy ?? "" }, { "proxyEigen", EigenerProxy() != null },
                { "ergebnisse", erg }
            };
        }

        static Dictionary<string, object> AdresseTesten(string name, string url)
        {
            var u = new Uri(url);
            var d = new Dictionary<string, object> { { "name", name }, { "adresse", u.Host }, { "ok", false }, { "meldung", "" } };
            // Ohne Proxy zuerst den Namen auflösen: DNS-Werbeblocker antworten mit 0.0.0.0 oder gar nicht
            if (ProxyFuer(url) == null)
            {
                try
                {
                    var ips = Dns.GetHostAddresses(u.Host);
                    if (ips.Length == 0 || ips.All(ip => IPAddress.IsLoopback(ip) || ip.Equals(IPAddress.Any) || ip.Equals(IPAddress.IPv6Any)))
                    { d["meldung"] = "Gesperrt, vermutlich von einem Werbeblocker oder DNS-Filter (z. B. Pi-hole, AdGuard). Bitte " + u.Host + " freigeben."; return d; }
                }
                catch { d["meldung"] = "Adresse nicht gefunden. Kein Internet, oder ein DNS-Filter sperrt " + u.Host + "."; return d; }
            }
            var sw = Stopwatch.StartNew();
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.AddRange(0, 1023);
                req.Timeout = 12000;
                req.ReadWriteTimeout = 12000;
                req.UserAgent = "Fieldbook/" + Version;
                using (var r = (HttpWebResponse)req.GetResponse()) { }
                d["ok"] = true;
            }
            catch (WebException e)
            {
                var r = e.Response as HttpWebResponse;
                int code = r != null ? (int)r.StatusCode : 0;
                // Der Server hat geantwortet (z. B. 403 auf ein Verzeichnis, 416 auf den Bereich): erreichbar
                if (code == 407) d["meldung"] = "Der Proxy verlangt eine Anmeldung.";
                else if (code > 0 && code < 500 && code != 403) d["ok"] = true;
                else if (code == 403) d["meldung"] = "Zugriff verweigert (403). Eine Firewall oder ein Jugendschutzfilter könnte " + u.Host + " sperren.";
                else if (e.Status == WebExceptionStatus.Timeout) d["meldung"] = "Keine Antwort. Eine Firewall könnte " + u.Host + " sperren.";
                else if (e.Status == WebExceptionStatus.TrustFailure || e.Status == WebExceptionStatus.SecureChannelFailure)
                    d["meldung"] = SichereVerbindungMeldung();
                else if (e.Status == WebExceptionStatus.NameResolutionFailure) d["meldung"] = "Adresse nicht gefunden. Kein Internet, oder ein DNS-Filter sperrt " + u.Host + ".";
                else if (e.Status == WebExceptionStatus.ProxyNameResolutionFailure) d["meldung"] = "Der eingestellte Proxy wurde nicht gefunden.";
                else if (e.Status == WebExceptionStatus.ConnectFailure) d["meldung"] = "Verbindung abgelehnt. Eine Firewall könnte " + u.Host + " sperren.";
                else d["meldung"] = code > 0 ? "Der Server meldet einen Fehler (" + code + "). Vermutlich nur vorübergehend." : "Nicht erreichbar (" + e.Status + ").";
                if (r != null) r.Close();
            }
            catch (Exception e) { d["meldung"] = "Nicht erreichbar: " + e.Message; }
            d["ms"] = sw.ElapsedMilliseconds;
            return d;
        }

        static long EntfernteGroesse(string url)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "HEAD";
                req.Timeout = 30000;
                req.UserAgent = "Fieldbook/" + Version;
                using (var resp = (HttpWebResponse)req.GetResponse()) return resp.ContentLength;
            }
            catch { return -1; }
        }

        // ------------------------------------------------------------------ Karten

        static string PlanetUrl()
        {
            if (planetUrl != null) return planetUrl;
            string json = HoleText("https://build-metadata.protomaps.dev/builds.json", 30000);
            var arr = Json.DeserializeObject(json) as object[];
            string letzter = null;
            foreach (var o in arr)
            {
                string key = Str(o as Dictionary<string, object>, "key");
                if (key != null && key.EndsWith(".pmtiles") && (letzter == null || string.CompareOrdinal(key, letzter) > 0)) letzter = key;
            }
            planetUrl = "https://build.protomaps.com/" + letzter;
            return planetUrl;
        }

        static Dictionary<string, object> Region(string id)
        {
            foreach (var o in Arr(LadeJson(Path.Combine(Config, "karten.json")), "regionen"))
            {
                var r = (Dictionary<string, object>)o;
                if (Str(r, "id") == id) return r;
            }
            return null;
        }

        static string BboxText(Dictionary<string, object> r)
        {
            return string.Join(",", Arr(r, "bbox").Select(x => Convert.ToDouble(x, CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture)));
        }

        // Zoomstufe 0–15 als Text; ungültig (keine Zahl, außerhalb) ergibt den Standard
        static bool ZoomGueltig(string s, out int z)
        {
            return int.TryParse((s ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out z) && z >= 0 && z <= 15;
        }

        static string ZoomOder(string s, string standard)
        {
            int z;
            if (ZoomGueltig(s, out z)) return z.ToString(CultureInfo.InvariantCulture);
            return ZoomGueltig(standard, out z) ? z.ToString(CultureInfo.InvariantCulture) : "15";
        }

        // Kartenausschnitt "West,Süd,Ost,Nord" als vier Zahlen prüfen; zurück kommt der saubere Text oder null
        static string BboxGueltig(string s)
        {
            var teile = (s ?? "").Split(',');
            if (teile.Length != 4) return null;
            var z = new double[4];
            for (int i = 0; i < 4; i++)
                if (!double.TryParse(teile[i].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out z[i]) || double.IsNaN(z[i]) || double.IsInfinity(z[i])) return null;
            if (Math.Abs(z[0]) > 180 || Math.Abs(z[2]) > 180 || Math.Abs(z[1]) > 90 || Math.Abs(z[3]) > 90) return null;
            return string.Join(",", z.Select(x => x.ToString(CultureInfo.InvariantCulture)));
        }

        static readonly Dictionary<string, Dictionary<string, object>> groessenCache = new Dictionary<string, Dictionary<string, object>>();

        static Dictionary<string, object> KartenGroesse(string id, string maxzoom)
        {
            var r = Region(id);
            if (r == null) return new Dictionary<string, object> { { "fehler", "Unbekannte Region" } };
            int zoom;
            if (!string.IsNullOrEmpty(maxzoom) && !ZoomGueltig(maxzoom, out zoom)) return new Dictionary<string, object> { { "fehler", "Ungültige Zoomstufe (erlaubt 0 bis 15)." } };
            string mz = string.IsNullOrEmpty(maxzoom) ? ZoomOder(Str(r, "maxzoom"), "15") : ZoomOder(maxzoom, "15");
            string key = id + "|" + mz;
            lock (groessenCache) { if (groessenCache.ContainsKey(key)) return groessenCache[key]; }
            var erg = new Dictionary<string, object>();
            try
            {
                string exe = SicherstellenProgramm("pmtiles");
                string args = "extract \"" + PlanetUrl() + "\" \"" + Path.Combine(Daten, "cache", "probe.pmtiles") + "\" --bbox=" + BboxText(r) + " --maxzoom=" + mz + " --dry-run";
                string ausgabe = Ausfuehren(exe, args, 180000);
                long bytes = GroesseAusText(ausgabe);
                erg["bytes"] = bytes;
                erg["ausgabe"] = ausgabe.Length > 600 ? ausgabe.Substring(ausgabe.Length - 600) : ausgabe;
                if (bytes > 0) lock (groessenCache) groessenCache[key] = erg;
            }
            catch (Exception e) { erg["fehler"] = e.Message; }
            return erg;
        }

        static long GroesseAusText(string s)
        {
            var m = Regex.Match(s, @"archive size of ([\d.,]+)\s*([kKMGT]?i?B)");
            if (!m.Success)
            {
                var alle = Regex.Matches(s, @"([\d.,]+)\s*([kKMGT]i?B)\b");
                if (alle.Count == 0) return -1;
                m = alle[alle.Count - 1];
            }
            double v = double.Parse(m.Groups[1].Value.Replace(",", ""), CultureInfo.InvariantCulture);
            string u = m.Groups[2].Value.ToUpperInvariant();
            double f = u.StartsWith("K") ? 1e3 : u.StartsWith("M") ? 1e6 : u.StartsWith("G") ? 1e9 : u.StartsWith("T") ? 1e12 : 1;
            if (u.Contains("I")) f = u.StartsWith("K") ? 1024 : u.StartsWith("M") ? 1048576 : u.StartsWith("G") ? 1073741824.0 : u.StartsWith("T") ? 1099511627776.0 : 1;
            return (long)(v * f);
        }

        // normalePrioritaet: nicht die niedrige Priorität des Update-Prozesses erben (sonst Zeitüberschreitung bei Last)
        static string Ausfuehren(string exe, string args, int timeout, bool normalePrioritaet = false)
        {
            var psi = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Encoding.UTF8, StandardErrorEncoding = Encoding.UTF8
            };
            var sb = new StringBuilder();
            using (var p = new Process { StartInfo = psi })
            {
                p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (sb) sb.AppendLine(e.Data); };
                p.Start();
                if (normalePrioritaet) try { p.PriorityClass = ProcessPriorityClass.Normal; } catch { }
                ChildJob.Add(p);
                p.BeginOutputReadLine();
                p.BeginErrorReadLine();
                if (!p.WaitForExit(timeout)) { try { p.Kill(); } catch { } throw new Exception("Zeitüberschreitung"); }
                p.WaitForExit();
                if (p.ExitCode != 0) throw new Exception("Fehlercode " + p.ExitCode + ": " + sb.ToString().Trim());
            }
            return sb.ToString();
        }

        // ------------------------------------------------------------------ Programme

        static Dictionary<string, object> ProgrammInfo(string id)
        {
            // Unbekannte Kennung (z. B. aus einer alten Einstellung): null statt Absturz
            object p;
            if (id == null || !LadeJson(Path.Combine(Config, "programme.json")).TryGetValue(id, out p)) return null;
            return p as Dictionary<string, object>;
        }

        static string FindeExe(string ordner, string exe)
        {
            if (!Directory.Exists(ordner)) return null;
            if (exe == "fonts") return Directory.Exists(Path.Combine(ordner, "fonts")) ? ordner : null;
            var f = Directory.GetFiles(ordner, exe, SearchOption.AllDirectories);
            return f.Length > 0 ? f[0] : null;
        }

        static string ProgrammPfad(string id)
        {
            var info = ProgrammInfo(id);
            return info == null ? null : FindeExe(Path.Combine(Prog, id), Str(info, "exe"));
        }

        static readonly object programmLk = new object();

        // Lädt ein kleines Hilfsprogramm sofort (synchron), z. B. pmtiles für die Grössenberechnung.
        static string SicherstellenProgramm(string id)
        {
            string p = ProgrammPfad(id);
            if (p != null) return p;
            var j = new Job { Art = "programm", Titel = Str(ProgrammInfo(id), "titel"), Url = Str(ProgrammInfo(id), "url"), Ziel = id };
            lock (programmLk) { if (ProgrammPfad(id) == null) ProgrammLaden(j); }
            return ProgrammPfad(id);
        }

        // ------------------------------------------------------------------ Installieren

        static Dictionary<string, object> Installieren(Dictionary<string, object> b)
        {
            // Schließt ein Durchgang gerade ab (KI starten usw.), kurz warten und dann neu beginnen
            Thread endet = null;
            lock (Lk) if (worker != null && worker.IsAlive && abschluss) endet = worker;
            if (endet != null) endet.Join(60000);
            // Katalog vorher holen: ohne Zwischenspeicher dauert das bis zu 90 s, und unter Lk stünde solange alles still
            try { LadeKiwixKatalog(false); } catch (Exception e) { Log("Katalog: " + e.Message); }
            // Liste der Wegedaten ebenfalls vorher (Netzabruf bis 30 s)
            var segmentListe = Arr(b, "routen").Length > 0 ? SegmentListe() : null;
            lock (Lk)
            {
                // Laufen schon Downloads, kommen die neuen in dieselbe Warteschlange
                bool dazu = worker != null && worker.IsAlive;
                if (dazu && !warteschlange) return new Dictionary<string, object> { { "fehler", "Gerade läuft eine Aktualisierung. Neue Downloads gehen danach." } };
                if (dazu && (abschluss || abbrechen)) return new Dictionary<string, object> { { "fehler", "Die laufenden Downloads werden gerade beendet. Bitte gleich noch einmal versuchen." } };
                var bisher = jobs;
                if (!dazu) abbrechen = false;
                // Erst lokal aufbauen, jobs wird erst am Ende ersetzt: eine Ausnahme dazwischen lässt keine halbe Liste stehen
                var plan = new List<Job>();

                // Einrichtungs-Assistent abgeschlossen: ab jetzt startet das Dashboard, auch wenn noch geladen wird
                if (Bool(b, "abschliessen")) einst["setupFertig"] = true;
                string modellId = Str(b, "modell");
                string backend = Str(b, "backend") ?? Str(einst, "backend") ?? "cpu";
                var pakete = Arr(b, "pakete").Select(x => Convert.ToString(x)).ToList();
                var karten = Arr(b, "karten");

                if (pakete.Count > 0 && ProgrammPfad("kiwix") == null) plan.Add(ProgrammJob("kiwix"));

                // "modell" wird die aktive KI, "modelle" (Seite Inhalte) werden nur geladen
                var modellIds = Arr(b, "modelle").Select(x => Convert.ToString(x)).ToList();
                if (!string.IsNullOrEmpty(modellId) && !modellIds.Contains(modellId)) modellIds.Add(modellId);
                if (modellIds.Count > 0)
                {
                    if (ProgrammPfad("llama-" + backend) == null) plan.Add(ProgrammJob("llama-" + backend));
                    foreach (var o in Arr(LadeJson(Path.Combine(Config, "modelle.json")), "modelle"))
                    {
                        var m = (Dictionary<string, object>)o;
                        if (!modellIds.Contains(Str(m, "id"))) continue;
                        string ziel = Path.Combine(Daten, "modelle", Str(m, "datei"));
                        if (!File.Exists(ziel))
                            plan.Add(new Job { Art = "datei", Titel = "KI: " + Str(m, "name") + " (" + Str(m, "modell") + ")", Url = Str(m, "url"), Ziel = ziel, Gesamt = (long)Num(m, "bytes") });
                    }
                    if (!string.IsNullOrEmpty(modellId)) einst["modell"] = modellId;
                    einst["backend"] = backend;
                }
                // Suchhilfe kommt mit jeder KI mit; ältere Installationen holen sie mit "suchhilfe" nach
                if ((modellIds.Count > 0 || Bool(b, "suchhilfe")) && !SuchhilfeDa())
                {
                    var sj = SuchhilfeJob();
                    if (sj != null)
                    {
                        if (ProgrammPfad("llama-" + backend) == null && ProgrammPfad("llama-cpu") == null && !plan.Any(x => x.Art == "programm" && x.Ziel == "llama-" + backend)) plan.Add(ProgrammJob("llama-" + backend));
                        plan.Add(sj);
                    }
                }

                var paketListe = Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete");
                foreach (var id in pakete)
                {
                    foreach (var o in paketListe)
                    {
                        var p = (Dictionary<string, object>)o;
                        if (Str(p, "id") != id) continue;
                        Dictionary<string, object> e;
                        if (katalog == null || !katalog.TryGetValue(Str(p, "name") + "|" + (Str(p, "flavour") ?? ""), out e)) continue;
                        string url = (string)e["url"];
                        string datei = url.Substring(url.LastIndexOf('/') + 1);
                        string ziel = Path.Combine(Daten, "wissen", datei);
                        if (File.Exists(ziel)) continue;
                        plan.Add(new Job { Art = "zim", Titel = Str(p, "titel"), Url = url, Ziel = ziel, Gesamt = (long)e["bytes"], Extra = Str(p, "name") + "|" + (Str(p, "flavour") ?? "") });
                    }
                }

                if (karten.Length > 0)
                {
                    if (ProgrammPfad("pmtiles") == null) plan.Add(ProgrammJob("pmtiles"));
                    if (ProgrammPfad("karten-assets") == null) plan.Add(ProgrammJob("karten-assets"));
                }
                var orteNoetig = new List<string>();
                foreach (var o in karten)
                {
                    var k = o as Dictionary<string, object>;
                    string id = k != null ? Str(k, "id") : Convert.ToString(o);
                    var r = Region(id);
                    if (r == null) continue;
                    string mz = ZoomOder(k != null ? Str(k, "maxzoom") : null, ZoomOder(Str(r, "maxzoom"), "15"));
                    long gesamt = k != null ? (long)Num(k, "bytes") : 0;
                    string ziel = Path.Combine(Daten, "karten", id + ".pmtiles");
                    if (!File.Exists(ziel))
                        plan.Add(new Job { Art = "karte", Titel = "Karte: " + Str(r, "titel"), Ziel = ziel, Gesamt = gesamt, Extra = BboxText(r) + "|" + mz });
                    foreach (var cc in Arr(r, "orte")) if (!orteNoetig.Contains(Convert.ToString(cc))) orteNoetig.Add(Convert.ToString(cc));
                }
                // Routenplanung: Java, BRouter und Wegedaten für die gewählten Regionen
                var routenRegionen = Arr(b, "routen").Select(x => Convert.ToString(x)).ToList();
                if (routenRegionen.Count > 0)
                {
                    if (ProgrammPfad("java") == null) plan.Add(ProgrammJob("java"));
                    if (ProgrammPfad("brouter") == null) plan.Add(ProgrammJob("brouter"));
                    var liste = segmentListe ?? new Dictionary<string, long>();
                    var geplant = new HashSet<string>();
                    foreach (var rid in routenRegionen)
                    {
                        var r = Region(rid);
                        if (r == null) continue;
                        foreach (var kachel in RoutenKacheln(r))
                        {
                            string ziel = Path.Combine(Daten, "routen", kachel + ".rd5");
                            if (!liste.ContainsKey(kachel) || File.Exists(ziel) || !geplant.Add(kachel)) continue;
                            plan.Add(new Job { Art = "route", Titel = "Wegedaten " + kachel, Url = SegmentBasis + kachel + ".rd5", Ziel = ziel, Gesamt = liste[kachel] });
                        }
                    }
                    einst["routen"] = true;
                }
                // Sprachen für Gespräche; übersetzt wird über Englisch, deshalb kommt "en" immer mit
                var sprachen = Arr(b, "sprachen").Select(x => Convert.ToString(x)).Where(c => SprachInfo(c) != null).Distinct().ToList();
                var sprachenDa = new HashSet<string>(InstallierteSprachen());
                sprachen = sprachen.Where(c => !sprachenDa.Contains(c)).ToList();
                if (sprachen.Count > 0 && !sprachenDa.Contains("en") && !sprachen.Contains("en")) sprachen.Insert(0, "en");
                // Artikel übersetzen (Englisch → Deutsch): ein Job für alle Dateien. Die Sprachen brauchen die neue
                // Version (eine ältere aus früheren Fieldbook-Versionen wird dabei ersetzt).
                if ((Bool(b, "uebersetzer") && !UebersetzerBereit()) || ((Bool(b, "uebersetzer") || sprachen.Count > 0) && !UebersetzerNeu()))
                {
                    var u = LadeJson(Path.Combine(Config, "uebersetzer.json"));
                    plan.Add(new Job { Art = "uebersetzer", Titel = Str(u, "titel") ?? "Übersetzer", Gesamt = (long)(Num(u, "mb") * 1048576) });
                }
                foreach (var c in sprachen)
                {
                    if (sprachenDa.Contains(c)) continue;
                    var si = SprachInfo(c);
                    plan.Add(new Job { Art = "sprache", Titel = "Sprache: " + Str(si, "name"), Ziel = c, Gesamt = (long)(Num(si, "mb") * 1048576) });
                }
                // Stimmen zum Vorlesen nur auf Wunsch („Text + Sprache“), für neue oder schon installierte Sprachen;
                // Deutsch kommt mit der ersten Stimme mit. "de" allein = Grundfunktion Vorlesen (Programm und deutsche Stimme)
                var mitStimme = Arr(b, "stimmen").Select(x => Convert.ToString(x))
                    .Where(c => c == "de" || sprachen.Contains(c) || sprachenDa.Contains(c)).ToList();
                // Grundfunktion Vorlesen bei älteren Installationen: das neue Programm holen, auch wenn alle Stimmen da sind
                if (mitStimme.Contains("de") && PiperPyPfad() == null && !plan.Any(y => y.Art == "programm" && y.Ziel == "piper-py")) plan.Add(PiperPyJob());
                if (mitStimme.Count > 0) plan.AddRange(StimmenJobs(mitStimme).Where(x => x.Art != "programm" || !plan.Any(y => y.Art == "programm" && y.Ziel == x.Ziel)));
                // Spracheingabe: Programm (whisper.cpp) und die beiden Modelle
                if (Bool(b, "spracheingabe"))
                {
                    if (ProgrammPfad("whisper") == null) plan.Add(ProgrammJob("whisper"));
                    foreach (var m in SprachModelle())
                        if (!File.Exists(SprachModellPfad(m)))
                            plan.Add(new Job { Art = "sprachmodell", Titel = Str(m, "titel"), Url = Str(m, "url"), Ziel = SprachModellPfad(m), Gesamt = (long)Num(m, "bytes"), Extra = Str(m, "id") });
                }
                foreach (var cc in orteNoetig)
                {
                    string ziel = Path.Combine(Daten, "orte", cc + ".txt");
                    if (!File.Exists(ziel))
                        plan.Add(new Job { Art = "orte", Titel = "Ortsnamen: " + cc, Url = "https://download.geonames.org/export/dump/" + cc + ".zip", Ziel = ziel });
                    // Postleitzahlen für die Straßensuche (nur Länder, nicht die Weltliste cities…)
                    string plzZiel = Path.Combine(Daten, "orte", "plz", cc + ".txt");
                    if (Regex.IsMatch(cc, "^[A-Z]{2}$") && !File.Exists(plzZiel))
                        plan.Add(new Job { Art = "plz", Titel = "Postleitzahlen: " + cc, Url = "https://download.geonames.org/export/zip/" + cc + ".zip", Ziel = plzZiel });
                }
                // Kleine Downloads zuerst (Hilfsprogramme ganz vorne, die brauchen andere Schritte;
                // pmtiles als allererstes, ohne es kann keine Karte laden)
                var neu = plan.OrderBy(x => x.Art == "programm" ? 0 : 1).ThenBy(x => x.Art == "programm" && x.Ziel == "pmtiles" ? 0 : 1).ThenBy(x => x.Gesamt).ToList();
                if (dazu)
                {
                    // Was schon wartet oder lädt, nicht doppelt aufnehmen
                    var offen = new HashSet<string>(bisher.Where(x => x.Status == "wartet" || x.Status == "laeuft").Select(x => x.Art + "|" + x.Ziel));
                    neu = neu.Where(x => !offen.Contains(x.Art + "|" + x.Ziel)).ToList();
                }
                // Vorab prüfen, ob es auf das Laufwerk passt (sonst scheitert es erst nach Stunden)
                string problem = LaufwerkPruefen(neu, dazu ? bisher : null);
                if (problem != null) return new Dictionary<string, object> { { "fehler", problem } };
                jobs = dazu ? bisher.Concat(neu).ToList() : neu;
                SpeichereEinst();
                try { AufgabenAbgleichen(); } catch (Exception e) { Log("Aufgabenplanung: " + e.Message); }

                if (dazu) HelferAuffuellen();
                else
                {
                    abschluss = false;
                    warteschlange = true;
                    worker = new Thread(Arbeiter) { IsBackground = true };
                    worker.Start();
                }
                WarteschlangeMerken();
                StatusCacheLeeren();
                return new Dictionary<string, object> { { "ok", true }, { "anzahl", neu.Count } };
            }
        }

        static Job ProgrammJob(string id)
        {
            var info = ProgrammInfo(id);
            return new Job { Art = "programm", Titel = Str(info, "titel"), Url = Str(info, "url"), Ziel = id };
        }

        static Dictionary<string, object> Fortschritt()
        {
            var liste = new List<object>();
            List<Job> kopie;
            lock (Lk) kopie = jobs.ToList();
            long summe = 0, fertig = 0;
            foreach (var j in kopie)
            {
                liste.Add(new Dictionary<string, object> { { "titel", j.Titel }, { "art", j.Art }, { "status", j.Status }, { "bytes", j.Bytes }, { "gesamt", j.Gesamt }, { "fehler", j.Fehler }, { "paket", j.Art == "zim" ? j.Extra : null } });
                summe += Math.Max(j.Gesamt, j.Bytes);
                fertig += j.Status == "fertig" ? Math.Max(j.Gesamt, j.Bytes) : j.Bytes;
            }
            return new Dictionary<string, object>
            {
                {"aktiv", worker != null && worker.IsAlive},
                {"jobs", liste},
                {"bytes", fertig},
                {"gesamt", summe},
                {"abgebrochen", abbrechen}
            };
        }

        // Bis zu 3 Downloads gleichzeitig aus einer gemeinsamen Warteschlange (jobs), möglichst verteilt auf
        // die Gruppen (Karten, Wissen, KI, Sprachen …): Ist ein Server langsam, bremst er nicht alles.
        // Während ein Durchgang läuft, kann Installieren() neue Jobs anhängen; die Helfer holen sie sich von selbst.
        const int MaxHelfer = 3;
        static int aktiveHelfer;
        static bool abschluss; // Durchgang ist fertig und schließt ab, nimmt nichts mehr an
        static bool warteschlange; // worker ist ein normaler Download-Durchgang (keine Aktualisierung, kein Programm-Update)
        static volatile bool neueKi, neueOrte;

        static void Arbeiter()
        {
            neueKi = false; neueOrte = false;
            lock (Lk) HelferAuffuellen();
            // Warten, bis alle Helfer fertig sind; danach nimmt der Durchgang nichts Neues mehr an
            while (true)
            {
                lock (Lk) if (aktiveHelfer == 0) { abschluss = true; break; }
                Thread.Sleep(300);
            }
            AbschlussArbeiten();
        }

        // Nur unter lock (Lk) aufrufen
        static void HelferAuffuellen()
        {
            // Freie Helfer = gestartete minus die, die gerade etwas laden
            int wartend = jobs.Count(x => x.Status == "wartet"), laufend = jobs.Count(x => x.Status == "laeuft");
            while (aktiveHelfer < MaxHelfer && aktiveHelfer - laufend < wartend)
            {
                aktiveHelfer++;
                new Thread(Helfer) { IsBackground = true }.Start();
            }
        }

        // Gruppe für "je Gruppe nur ein Download": was meist vom selben Server kommt
        static string Gruppe(Job j)
        {
            switch (j.Art)
            {
                case "zim": return "wissen";
                case "karte": return "karten";
                case "datei": return "ki";
                case "sprache": case "uebersetzer": case "sprachmodell": case "stimme": return "sprachen";
                default: return j.Art; // programm, route, orte, kopie
            }
        }

        // Nächster Job: erst die Hilfsprogramme (Karten brauchen z. B. pmtiles), dann aus der Gruppe, aus der
        // gerade am wenigsten läuft, der kleinste. So verteilt es sich auf möglichst viele Server; wartet nur
        // noch eine Gruppe, laden auch mehrere aus ihr zugleich. Kleine Pakete sind so nebenbei fertig.
        // warten = true heißt: gleich wieder fragen (ein Hilfsprogramm läuft noch).
        static Job NaechsterJob(out bool warten)
        {
            warten = false;
            var wartend = jobs.Where(x => x.Status == "wartet").ToList();
            var programm = wartend.FirstOrDefault(x => x.Art == "programm");
            if (programm != null) return programm;
            if (jobs.Any(x => x.Art == "programm" && x.Status == "laeuft")) { warten = wartend.Count > 0; return null; }
            var laufend = jobs.Where(x => x.Status == "laeuft").GroupBy(x => Gruppe(x)).ToDictionary(g => g.Key, g => g.Count());
            Func<Job, int> inGruppe = x => { int n; return laufend.TryGetValue(Gruppe(x), out n) ? n : 0; };
            return wartend.OrderBy(inGruppe).ThenBy(x => x.Gesamt).FirstOrDefault();
        }

        static void Helfer()
        {
            while (true)
            {
                Job j;
                bool warten;
                lock (Lk)
                {
                    // Beim Beenden nichts Neues mehr anfangen (die offenen Jobs sind schon gemerkt)
                    if (beenden) { aktiveHelfer--; return; }
                    j = NaechsterJob(out warten);
                    if (j == null && !warten) { aktiveHelfer--; return; }
                    if (j != null)
                    {
                        if (abbrechen) { j.Status = "abgebrochen"; continue; }
                        j.Status = "laeuft";
                    }
                }
                if (j == null) { Thread.Sleep(500); continue; }
                JobAusfuehren(j);
                lock (Lk) WarteschlangeMerken(beenden && j.Status == "fertig");
            }
        }

        static void JobAusfuehren(Job j)
        {
            try
            {
                switch (j.Art)
                {
                    case "programm":
                        if (j.Ziel == "piper-py") { PiperPyLaden(j); break; }
                        if (j.Ziel.StartsWith("llama")) StoppeKi();
                        if (j.Ziel == "kiwix") StoppeKiwix();
                        if (j.Ziel == "java" || j.Ziel == "brouter") StoppeRouting();
                        ProgrammLaden(j);
                        if (j.Ziel.StartsWith("llama")) neueKi = true;
                        break;
                    case "datei":
                        Herunterladen(j, j.Url, j.Ziel);
                        ModellPruefen(j);
                        neueKi = true;
                        // Fehler hier machen den fertigen Download nicht zum Fehler
                        if (!Bool(einst, "sparmodus")) try { NachKiDatei(j.Ziel); } catch (Exception e) { Log("KI: " + e.Message); }
                        break;
                    case "zim":
                        Herunterladen(j, j.Url, j.Ziel);
                        // Alte Variante löschen und Bibliothek mit dem neuen Paket starten, ohne dass ein anderer Thread dazwischen startet
                        lock (KiwixLk)
                        {
                            AlteVersionenLoeschen(j);
                            StarteKiwix();
                        }
                        break;
                    case "karte":
                        KarteLaden(j);
                        break;
                    case "route":
                        Herunterladen(j, j.Url, j.Ziel);
                        StarteRouting();
                        break;
                    case "uebersetzer":
                        UebersetzerLaden(j);
                        break;
                    case "sprache":
                        SpracheLaden(j);
                        break;
                    case "sprachmodell":
                        SprachmodellLaden(j);
                        break;
                    case "stimme":
                        StimmeLaden(j);
                        break;
                    case "plz":
                        // Nicht jedes Land hat eine Postleitzahlen-Liste (z. B. Irland). Die Straßensuche geht auch
                        // ohne, darum kein Fehler; beim nächsten Kartendownload wird es erneut versucht.
                        Directory.CreateDirectory(Path.GetDirectoryName(j.Ziel));
                        try { OrteLaden(j); }
                        catch (Exception pe)
                        {
                            if (abbrechen || beenden) throw;
                            Log("Postleitzahlen " + Path.GetFileNameWithoutExtension(j.Ziel) + " nicht geladen: " + pe.Message);
                            try { File.Delete(j.Ziel + ".zip.part"); File.Delete(j.Ziel + ".zip"); } catch { }
                        }
                        lock (PlzLk) plzListe = null;
                        break;
                    case "orte":
                        OrteLaden(j);
                        neueOrte = true;
                        lock (OrteLk) orte = null;
                        break;
                    case "kopie":
                        DateiKopieren(j);
                        if (j.Extra == "wissen") StarteKiwix();
                        else if (j.Extra == "route") StarteRouting();
                        else if (j.Extra == "orte") { neueOrte = true; lock (OrteLk) orte = null; }
                        break;
                }
                j.Status = "fertig";
            }
            catch (Exception e)
            {
                // Beim Beenden ist der Job kein Fehler: er bleibt gemerkt und geht nach dem Neustart weiter
                if (beenden) { j.Status = "wartet"; Log("Download unterbrochen (Fieldbook wird beendet): " + j.Titel); StatusCacheLeeren(); return; }
                j.Status = abbrechen ? "abgebrochen" : "fehler";
                j.Fehler = e.Message;
                Log("Fehler bei " + j.Titel + ": " + e.Message);
                if (!abbrechen) StatFehler("download", j.Art + " " + j.Titel + ": " + e.Message);
            }
            StatusCacheLeeren();
        }

        // Eine KI-Datei ist fertig: nur neu starten, wenn es das gewählte Modell ist oder die KI nicht läuft
        // (sonst bräche eine laufende Antwort ab). Die Suchhilfe allein nachstarten; sie läuft nur zusammen mit der KI.
        static void NachKiDatei(string ziel)
        {
            bool kiLaeuft = llmStatus == "bereit" || llmStatus == "laedt";
            var m = AktuellesModell();
            bool istModell = m != null && GleicherPfad(ziel, Path.Combine(Daten, "modelle", Str(m, "datei")));
            if (!istModell && GleicherPfad(ziel, SuchhilfeDatei()))
            {
                if (kiLaeuft) StarteSuchhilfe();
                return;
            }
            if (!istModell && kiLaeuft) return;
            // KI gleich starten, nicht erst wenn alle anderen Downloads fertig sind
            new Thread(delegate () { StoppeKi(); StarteKi(); }) { IsBackground = true }.Start();
        }

        static bool GleicherPfad(string a, string b)
        {
            if (a == null || b == null) return false;
            try { return string.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }

        static void AbschlussArbeiten()
        {
            // Läuft im Download-Thread: jeder Schritt einzeln abgesichert, damit ein Fehler Fieldbook nicht beendet
            // Beim Beenden nichts mehr starten und die gemerkte Warteschlange nicht anfassen
            if (beenden) return;
            if (neueOrte) lock (OrteLk) orte = null;
            try { if (brouter == null || brouter.HasExited) StarteRouting(); } catch (Exception e) { Log("Routenplanung: " + e.Message); }
            // Bibliothek und KI können lange zum Starten brauchen: in eigenen Threads, damit der Download-Durchgang
            // sofort endet (sonst meldet er sich als aktiv und neue Downloads müssen warten)
            if (!KiwixAktiv())
                new Thread(delegate () { try { if (!KiwixAktiv()) StarteKiwix(); } catch (Exception e) { Log("Bibliothek: " + e.Message); } }) { IsBackground = true }.Start();
            try
            {
                lock (Lk)
                {
                    if (jobs.All(x => x.Status == "fertig")) einst["setupFertig"] = true;
                    SpeichereEinst();
                    WarteschlangeMerken();
                }
            }
            catch (Exception e) { Log("Abschluss: " + e.Message); }
            // Neue KI-Programme (llama.cpp) oder KI noch nicht gestartet
            try
            {
                if (llmStatus == "aus" || llmStatus == "fehler" || (neueKi && llmStatus != "bereit" && llmStatus != "laedt"))
                {
                    // StarteKi fängt seine Fehler selbst ab
                    if (!Bool(einst, "sparmodus")) new Thread(delegate () { StoppeKi(); StarteKi(); }) { IsBackground = true }.Start();
                }
            }
            catch (Exception e) { Log("KI: " + e.Message); }
        }

        static void AlteVersionenLoeschen(Job j)
        {
            // Ältere Ausgaben desselben Pakets und andere Varianten derselben Gruppe (z. B. Wikipedia kompakt,
            // wenn jetzt die mit Bildern geladen wurde): je Gruppe bleibt nur eine Variante
            // Verglichen wird mit dem Anfang des Dateinamens (ZimName), nicht mit dem Katalognamen
            var arten = new List<string> { j.Extra };
            try
            {
                var liste = Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete").Cast<Dictionary<string, object>>().ToList();
                var selbst = liste.FirstOrDefault(p => Str(p, "name") + "|" + (Str(p, "flavour") ?? "") == j.Extra);
                if (selbst != null) arten[0] = ZimName(selbst) + "|" + (Str(selbst, "flavour") ?? "");
                string gruppe = selbst == null ? null : Str(selbst, "gruppeExklusiv");
                if (!string.IsNullOrEmpty(gruppe))
                    foreach (var p in liste) if (Str(p, "gruppeExklusiv") == gruppe) arten.Add(ZimName(p) + "|" + (Str(p, "flavour") ?? ""));
            }
            catch { }
            var muster = arten.Distinct().Select(a =>
            {
                var t = a.Split('|');
                return "^" + Regex.Escape(t[0]) + (t[1] == "" ? "" : "_" + Regex.Escape(t[1])) + @"_\d{4}-\d{2}[a-z]?\.zim$";
            }).ToList();
            string neu = Path.GetFileName(j.Ziel);
            // Unter KiwixLk: sonst startet ein anderer Thread kiwix zwischen Stoppen und Löschen mit der alten Datei,
            // das Löschen scheitert und die alte Variante bleibt liegen. Neu starten muss der Aufrufer (am besten im selben lock).
            lock (KiwixLk)
                foreach (var f in Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim"))
                {
                    string n = Path.GetFileName(f);
                    if (n != neu && muster.Any(m => Regex.IsMatch(n, m, RegexOptions.IgnoreCase)))
                    {
                        StoppeKiwix();
                        try { File.Delete(f); } catch (Exception e) { Log("Alte Version nicht gelöscht (" + n + "): " + e.Message); }
                    }
                }
        }

        // Fertig geladene .part mit der Größe auf dem Server vergleichen. Passt sie nicht, ist die Datei
        // unbrauchbar: löschen und Fehler (die alte Version bleibt erhalten). Ist der Server nicht erreichbar,
        // grob mit der erwarteten Größe aus dem Katalog vergleichen; dann bleibt die .part zum Fortsetzen liegen.
        static void ZimGroessePruefen(Job j, string url, string part)
        {
            long ist = new FileInfo(part).Length;
            long soll = EntfernteGroesse(url);
            if (soll > 0)
            {
                if (ist == soll) return;
                try { File.Delete(part); } catch { }
                j.Bytes = 0;
                throw new Exception("Die geladene Datei ist unvollständig oder beschädigt (" + ist + " statt " + soll + " Byte). Bitte erneut versuchen.");
            }
            if (j.Gesamt > 0 && ist < j.Gesamt * 0.95)
                throw new Exception("Die geladene Datei ist kleiner als erwartet. Bitte erneut versuchen.");
        }

        // Höchstgeschwindigkeit für Downloads in Byte pro Sekunde (0 = unbegrenzt), gilt für Aktualisierungen
        static long ladeLimit = 0;

        static void Herunterladen(Job j, string url, string ziel)
        {
            string part = ziel + ".part";
            if (File.Exists(part))
            {
                long remote = EntfernteGroesse(url);
                if (remote > 0) j.Gesamt = remote;
                // Die .part ist größer als die Datei auf dem Server (Datei dort ausgetauscht): von vorn beginnen
                if (remote > 0 && new FileInfo(part).Length > remote) { File.Delete(part); j.Bytes = 0; }
                else if (remote > 0 && new FileInfo(part).Length == remote)
                {
                    if (File.Exists(ziel)) File.Delete(ziel);
                    File.Move(part, ziel);
                    j.Bytes = remote;
                    return;
                }
            }
            int code = CurlLaden(j, url, part);
            // Kiwix verteilt Downloads auf Spiegelserver. Scheitert einer, beim nächsten weitermachen
            // (curl setzt die .part-Datei fort, alle Spiegel haben dieselbe Datei).
            if (code != 0 && !abbrechen && !beenden && Regex.IsMatch(url, @"^https?://download\.kiwix\.org/", RegexOptions.IgnoreCase))
            {
                foreach (var spiegel in KiwixSpiegel(url).Take(4))
                {
                    if (abbrechen || beenden) break;
                    Log("Download " + j.Titel + ": versuche Spiegelserver " + new Uri(spiegel).Host);
                    code = CurlLaden(j, spiegel, part);
                    if (code == 0) break;
                }
            }
            // Beim Beenden ist curl absichtlich gestoppt worden: kein Fehler, die .part bleibt zum Fortsetzen
            if (abbrechen || beenden) throw new Exception("Abgebrochen");
            // curl 33: Fortsetzen nicht möglich, der nächste Versuch beginnt von vorn
            if (code == 33) { try { File.Delete(part); } catch { } j.Bytes = 0; }
            if (code != 0) throw new Exception(CurlMeldung(code));
            // Wissenspakete erst einsetzen, wenn die Größe stimmt (sonst würde danach die alte Version gelöscht)
            if (ziel.EndsWith(".zim", StringComparison.OrdinalIgnoreCase)) ZimGroessePruefen(j, url, part);
            if (File.Exists(ziel)) File.Delete(ziel);
            File.Move(part, ziel);
            j.Bytes = new FileInfo(ziel).Length;
            if (j.Gesamt <= 0) j.Gesamt = j.Bytes;
        }

        // Lädt mit bis zu 5 Neuversuchen bei vorübergehenden Fehlern; gibt den Rückgabewert von curl zurück (0 = fertig).
        // Die Neuversuche macht Fieldbook selbst statt curl mit --retry: curl springt dabei an die Stelle zurück, an der
        // der Aufruf begann (hängt die Wikipedia nach 20 GB, ginge alles verloren). Ein neuer Aufruf setzt am Dateiende fort.
        static int CurlLaden(Job j, string url, string part)
        {
            int code = 0;
            for (int versuch = 0; versuch <= 5; versuch++)
            {
                if (versuch > 0)
                {
                    Log("Download " + j.Titel + ": Neuversuch " + versuch + " von 5");
                    for (int w = 0; w < 6 && !abbrechen && !beenden; w++) Thread.Sleep(500);
                    if (abbrechen || beenden) break;
                }
                string fehler;
                code = CurlEinmal(j, url, part, out fehler);
                if (code == 0 || abbrechen || beenden) break;
                // Vorübergehend: zu langsam oder hängend (28), Verbindung abgerissen (18, 52, 56, 92),
                // Server überlastet (22 mit 408, 429 oder 5xx). Wie bisher mit curl --retry, plus abgerissene Verbindungen.
                bool voruebergehend = code == 28 || code == 18 || code == 52 || code == 56 || code == 92
                    || (code == 22 && Regex.IsMatch(fehler, @"error: (408|429|5\d\d)"));
                if (!voruebergehend) break;
            }
            return code;
        }

        // Ein Durchlauf von curl; gibt den Rückgabewert zurück (0 = fertig). Fehlertexte kommen ins Protokoll.
        static int CurlEinmal(Job j, string url, string part, out string fehlertext)
        {
            fehlertext = "";
            string curl = Path.Combine(Environment.SystemDirectory, "curl.exe");
            string proxy = ProxyFuer(url);
            // -y/-Y: unter N Byte/s für 60 s gilt als hängend (z. B. nach Standby); bei Tempolimit liegt N darunter
            long mindest = ladeLimit > 0 ? Math.Max(1L, Math.Min(1000L, ladeLimit / 4)) : 1000L;
            string args = "-L --fail -sS --connect-timeout 30 -y 60 -Y " + mindest + " -A \"Fieldbook/" + Version + "\" -C - -o \"" + part + "\" \"" + url + "\"" + (ladeLimit > 0 ? " --limit-rate " + Math.Max(8, ladeLimit / 1000) + "k" : "")
                + (proxy != null ? " --proxy \"" + proxy + "\" --proxy-anyauth --proxy-user :" : "");
            var psi = new ProcessStartInfo(curl, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
            var fehler = new StringBuilder();
            using (var p = new Process { StartInfo = psi })
            {
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (fehler) fehler.AppendLine(e.Data); };
                p.OutputDataReceived += (s, e) => { };
                p.Start();
                ChildJob.Add(p);
                ProzessMerken(p, true);
                try
                {
                    p.BeginErrorReadLine();
                    p.BeginOutputReadLine();
                    while (!p.WaitForExit(500))
                    {
                        try { if (File.Exists(part)) j.Bytes = new FileInfo(part).Length; } catch { }
                        if (abbrechen || beenden) { try { p.Kill(); } catch { } throw new Exception("Abgebrochen"); }
                    }
                    p.WaitForExit();
                }
                finally { ProzessMerken(p, false); }
                // Absichtlich gestoppt (Abbrechen, Beenden): nicht als Fehler protokollieren
                if (p.ExitCode != 0 && !abbrechen && !beenden)
                {
                    string text;
                    lock (fehler) text = fehler.ToString().Trim();
                    fehlertext = text;
                    Log("Download " + j.Titel + " fehlgeschlagen (curl " + p.ExitCode + ", " + new Uri(url).Host + "): " + text);
                    try { File.AppendAllText(Path.Combine(Logs, "downloads.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm") + " " + j.Titel + " (curl " + p.ExitCode + ", " + url + "): " + text + Environment.NewLine, Utf8); } catch { }
                }
                return p.ExitCode;
            }
        }

        // Gestörte sichere Verbindung: Geht die Uhr des PCs nach (früher als die Programmdateien selbst),
        // sind Zertifikate scheinbar noch nicht gültig. Das ist dann die Ursache, nicht ein Virenscanner.
        static string SichereVerbindungMeldung()
        {
            bool uhrFalsch = false;
            try { uhrFalsch = DateTime.UtcNow < File.GetLastWriteTimeUtc(Path.Combine(AppDir, "Server.cs")).AddDays(-1); }
            catch { }
            if (uhrFalsch) return "Datum oder Uhrzeit am PC sind falsch (" + DateTime.Now.ToString("d. M. yyyy") + "). Deshalb klappt keine sichere Verbindung. Bitte in Windows unter Einstellungen → Zeit und Sprache korrigieren.";
            return "Die sichere Verbindung wird gestört, oft durch eine Firewall oder einen Virenscanner, der verschlüsselte Verbindungen prüft. Auch ein falsches Datum am PC kann die Ursache sein.";
        }

        // Verständliche Meldung zu curl-Rückgabewerten (Einzelheiten in daten\logs\downloads.log)
        static string CurlMeldung(int code)
        {
            switch (code)
            {
                case 5: return "Der Proxy wurde nicht gefunden. Bitte unter Einstellungen → Erweitert prüfen.";
                case 6: return "Server nicht gefunden. Kein Internet, oder ein Werbeblocker/DNS-Filter sperrt die Adresse. „Verbindung prüfen“ zeigt, welche.";
                case 7: return "Verbindung abgelehnt. Eine Firewall könnte die Adresse sperren. „Verbindung prüfen“ zeigt, welche.";
                case 22: return "Der Server hat die Datei verweigert oder nicht gefunden. Vielleicht gibt es inzwischen eine neuere Version; bitte später erneut versuchen.";
                case 23: return "Die Datei konnte nicht gespeichert werden. Ist genug Platz auf dem Laufwerk?";
                case 33: return "Der Download konnte nicht fortgesetzt werden. Bitte erneut versuchen.";
                case 28: return "Zeitüberschreitung: Der Server antwortet nicht. Bitte später erneut versuchen.";
                case 35: case 60: return SichereVerbindungMeldung();
                case 18: case 52: case 56: case 92: return "Die Verbindung ist abgebrochen. Bitte „Erneut versuchen“, es geht an derselben Stelle weiter.";
                default: return "Download fehlgeschlagen (Fehler " + code + "). Bitte „Erneut versuchen“, es geht an derselben Stelle weiter. Einzelheiten stehen in daten\\logs\\downloads.log.";
            }
        }

        // Spiegelserver für eine Datei auf download.kiwix.org, aus der Metalink-Liste (beste zuerst)
        static List<string> KiwixSpiegel(string url)
        {
            var liste = new List<string>();
            try
            {
                string xml = HoleText(url + ".meta4", 20000);
                foreach (Match m in Regex.Matches(xml, @"<url[^>]*>(https?://[^<]+)</url>"))
                    if (!liste.Contains(m.Groups[1].Value)) liste.Add(m.Groups[1].Value);
            }
            catch (Exception e) { Log("Spiegelliste nicht verfügbar: " + e.Message); }
            return liste;
        }

        // ------------------------------------------------------------------ Übernahme vom USB-Stick
        // Pakete, Karten, KI-Modelle, Wegedaten und Ortslisten aus einem Ordner übernehmen, z. B. vom
        // USB-Stick oder dem daten-Ordner eines anderen Fieldbook-Laptops. Kopiert wird über die Warteschlange.

        // Windows-Fenster zur Ordnerauswahl (eigener STA-Thread, vor dem Browser). Die moderne Auswahl wie im
        // Explorer; nur wenn die nicht geht, das alte Baum-Fenster.
        static string OrdnerWaehlen()
        {
            string pfad = null;
            var t = new Thread(delegate ()
            {
                using (var vorne = new System.Windows.Forms.Form { TopMost = true, ShowInTaskbar = true, Text = "Fieldbook: Ordner wählen", Opacity = 0, FormBorderStyle = System.Windows.Forms.FormBorderStyle.None, StartPosition = System.Windows.Forms.FormStartPosition.CenterScreen })
                {
                    vorne.Show();
                    // Fieldbook-Logo statt des Standard-Symbols in der Taskleiste
                    try
                    {
                        IntPtr symbol = ExtractIcon(IntPtr.Zero, Path.Combine(Root, "Fieldbook.exe"), 0);
                        if ((long)symbol > 1) { SendMessage(vorne.Handle, 0x80, new IntPtr(0), symbol); SendMessage(vorne.Handle, 0x80, new IntPtr(1), symbol); }
                    }
                    catch { }
                    // Windows lässt ein Hintergrundprogramm sonst nicht nach vorne; ein kurzer Alt-Tastendruck erlaubt es
                    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
                    SetForegroundWindow(vorne.Handle);
                    vorne.Activate();
                    try
                    {
                        var d = (IOrdnerDialog)new OrdnerDialogKlasse();
                        d.SetOptions(0x20 | 0x40 | 0x800); // nur Ordner, nur echte Laufwerke, Pfad muss existieren
                        d.SetTitle("Ordner oder USB-Stick mit Fieldbook-Daten wählen");
                        d.SetOkButtonLabel("Diesen Ordner nehmen");
                        if (d.Show(vorne.Handle) == 0)
                        {
                            IShellEintrag e; d.GetResult(out e);
                            IntPtr p; e.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
                            pfad = Marshal.PtrToStringUni(p);
                            Marshal.FreeCoTaskMem(p);
                        }
                    }
                    catch
                    {
                        using (var d = new System.Windows.Forms.FolderBrowserDialog { Description = "Ordner oder USB-Stick mit Fieldbook-Daten wählen", ShowNewFolderButton = false })
                            if (d.ShowDialog(vorne) == System.Windows.Forms.DialogResult.OK) pfad = d.SelectedPath;
                    }
                }
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            return pfad;
        }

        // Alle Dateien bis zu einer Tiefe; Ordner ohne Zugriff (z. B. "System Volume Information") überspringen
        static IEnumerable<string> ImportDateien(string ordner, int tiefe)
        {
            string[] dateien = new string[0], ordnerListe = new string[0];
            try { dateien = Directory.GetFiles(ordner); ordnerListe = tiefe > 0 ? Directory.GetDirectories(ordner) : new string[0]; } catch { }
            foreach (var f in dateien) yield return f;
            foreach (var o in ordnerListe) foreach (var f in ImportDateien(o, tiefe - 1)) yield return f;
        }

        // Was ist diese Datei und wohin gehört sie? null, wenn Fieldbook sie nicht verwenden kann
        static Dictionary<string, object> ImportEinordnen(string datei, object[] pakete, object[] modelle)
        {
            if (!LokalerPfad(datei)) return null;
            string name = Path.GetFileName(datei);
            string endung = Path.GetExtension(name).ToLowerInvariant();
            string art = null, titel = null, ziel = null;
            // Wissenspaket, das nicht im Fieldbook-Katalog steht: Die Oberfläche warnt davor (Artikelseiten laufen
            // unter derselben Adresse wie Fieldbook und könnten Fieldbook-Funktionen aufrufen)
            bool fremd = false;
            if (endung == ".zim")
            {
                art = "wissen"; ziel = Path.Combine(Daten, "wissen", name); titel = name; fremd = true;
                foreach (var o in pakete)
                {
                    var p = (Dictionary<string, object>)o;
                    if (Regex.IsMatch(name, "^" + Regex.Escape(ZimName(p)) + (string.IsNullOrEmpty(Str(p, "flavour")) ? "" : "_" + Regex.Escape(Str(p, "flavour"))) + @"_\d{4}-\d{2}[a-z]?\.zim$"))
                    { titel = Str(p, "titel"); fremd = false; break; }
                }
            }
            else if (endung == ".gguf")
            {
                foreach (var o in modelle)
                {
                    var m = (Dictionary<string, object>)o;
                    if (string.Equals(Str(m, "datei"), name, StringComparison.OrdinalIgnoreCase))
                    { art = "modell"; titel = "KI: " + Str(m, "name") + " (" + Str(m, "modell") + ")"; ziel = Path.Combine(Daten, "modelle", Str(m, "datei")); }
                }
                var sh = SuchhilfeInfo();
                if (art == null && sh != null && string.Equals(Str(sh, "datei"), name, StringComparison.OrdinalIgnoreCase))
                { art = "modell"; titel = "KI: Suchhilfe (" + Str(sh, "modell") + ")"; ziel = SuchhilfeDatei(); }
            }
            else if (endung == ".pmtiles" && !name.Contains(".tmp.") && !name.Contains(".neu."))
            {
                string id = Path.GetFileNameWithoutExtension(name).ToLowerInvariant();
                var r = Region(id);
                if (r != null) { art = "karte"; titel = "Karte: " + Str(r, "titel"); ziel = Path.Combine(Daten, "karten", id + ".pmtiles"); }
            }
            else if (endung == ".rd5")
            {
                art = "route"; titel = "Wegedaten " + Path.GetFileNameWithoutExtension(name); ziel = Path.Combine(Daten, "routen", name);
            }
            else if (endung == ".txt" && string.Equals(Path.GetFileName(Path.GetDirectoryName(datei)), "orte", StringComparison.OrdinalIgnoreCase)
                     && Regex.IsMatch(name, @"^([A-Z]{2}|cities\d+)\.txt$"))
            {
                art = "orte"; titel = "Ortsnamen: " + Path.GetFileNameWithoutExtension(name); ziel = Path.Combine(Daten, "orte", name);
            }
            if (art == null) return null;
            // Die eigene Datei nicht auf sich selbst kopieren
            if (string.Equals(Path.GetFullPath(datei), Path.GetFullPath(ziel), StringComparison.OrdinalIgnoreCase)) return null;
            long bytes = new FileInfo(datei).Length;
            bool vorhanden = File.Exists(ziel) && new FileInfo(ziel).Length == bytes;
            return new Dictionary<string, object> { { "datei", datei }, { "art", art }, { "titel", titel }, { "ziel", ziel }, { "bytes", bytes }, { "vorhanden", vorhanden }, { "fremd", fremd } };
        }

        // Nur Pfade auf lokalen Laufwerken oder USB-Sticks (keine Netzwerkpfade wie \\server\freigabe).
        // Vor jedem Dateizugriff prüfen: schon File.Exists auf einen Netzwerkpfad baut eine Verbindung auf.
        static bool LokalerPfad(string pfad)
        {
            try
            {
                if (string.IsNullOrWhiteSpace(pfad)) return false;
                string p = pfad.Trim();
                if (p.StartsWith("\\\\") || p.StartsWith("//") || p.StartsWith("\\/") || p.StartsWith("/\\")) return false;
                if (!Regex.IsMatch(p, @"^[A-Za-z]:[\\/]")) return false;
                string wurzel = Path.GetPathRoot(Path.GetFullPath(p));
                if (wurzel == null || !Regex.IsMatch(wurzel, @"^[A-Za-z]:\\$")) return false;
                var typ = new DriveInfo(wurzel).DriveType;
                return typ == DriveType.Fixed || typ == DriveType.Removable;
            }
            catch { return false; }
        }

        static Dictionary<string, object> ImportPruefen(string ordner)
        {
            if (!string.IsNullOrEmpty(ordner) && !LokalerPfad(ordner)) return new Dictionary<string, object> { { "fehler", "Bitte einen Ordner auf diesem Rechner oder einem USB-Stick wählen (keine Netzwerkpfade)." } };
            if (string.IsNullOrEmpty(ordner) || !Directory.Exists(ordner)) return new Dictionary<string, object> { { "fehler", "Ordner nicht gefunden." } };
            var pakete = Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete");
            var modelle = Arr(LadeJson(Path.Combine(Config, "modelle.json")), "modelle");
            var liste = new List<object>();
            foreach (var f in ImportDateien(ordner, 4))
            {
                var e = ImportEinordnen(f, pakete, modelle);
                if (e != null) liste.Add(e);
                if (liste.Count >= 500) break;
            }
            return new Dictionary<string, object> { { "ordner", ordner }, { "dateien", liste } };
        }

        static Dictionary<string, object> ImportUebernehmen(Dictionary<string, object> b)
        {
            var pakete = Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete");
            var modelle = Arr(LadeJson(Path.Combine(Config, "modelle.json")), "modelle");
            var neu = new List<Job>();
            foreach (var o in Arr(b, "dateien"))
            {
                string datei = Convert.ToString(o);
                if (!LokalerPfad(datei) || !File.Exists(datei)) continue;
                var e = ImportEinordnen(datei, pakete, modelle); // erneut prüfen, nicht dem Browser vertrauen
                if (e == null || (bool)e["vorhanden"]) continue;
                neu.Add(new Job { Art = "kopie", Titel = "Übernehmen: " + Str(e, "titel"), Url = datei, Ziel = Str(e, "ziel"), Gesamt = (long)e["bytes"], Extra = Str(e, "art") });
            }
            if (neu.Count == 0) return new Dictionary<string, object> { { "fehler", "Nichts Neues zum Übernehmen ausgewählt." } };
            return Einreihen(neu.OrderBy(x => x.Gesamt).ToList());
        }

        // ------------------------------------------------------------------ Downloads nach einem Neustart fortsetzen
        // Offene Jobs stehen in daten/downloads.json. Beim Start geht es automatisch weiter, außer ohne Internet
        // oder über eine getaktete Verbindung (Handy-Hotspot): Dann zeigt die Seite Inhalte "Fortsetzen".
        // Vom Nutzer abgebrochene Downloads werden nicht gemerkt.

        static int unterbrochen; // gemerkte Downloads, die auf "Fortsetzen" warten

        static string DownloadDatei() { return Path.Combine(Daten, "downloads.json"); }

        // Nur unter lock (Lk) und nur für die normale Warteschlange aufrufen
        // Beim Beenden ist die Warteschlange schon gemerkt (BeendenVorbereiten), abgebrochene Jobs nicht streichen.
        // auchBeimBeenden: ein Job ist gerade noch fertig geworden, ihn austragen (die gestoppten stehen auf "wartet").
        static void WarteschlangeMerken(bool auchBeimBeenden = false)
        {
            if (!warteschlange || (beenden && !auchBeimBeenden)) return;
            var laufend = jobs.Where(x => x.Status == "wartet" || x.Status == "laeuft").ToList();
            // Warten noch unterbrochene Downloads auf "Fortsetzen", diese nicht vergessen
            if (unterbrochen > 0) laufend.AddRange(GemerkteDownloads().Where(g => !laufend.Any(x => x.Ziel == g.Ziel)));
            var offen = laufend.Select(x => (object)new Dictionary<string, object>
            {
                { "art", x.Art }, { "titel", x.Titel }, { "url", x.Url }, { "ziel", x.Ziel }, { "gesamt", x.Gesamt }, { "extra", x.Extra }
            }).ToList();
            try
            {
                if (offen.Count == 0) { SicherLoeschen(DownloadDatei()); }
                else SicherSchreiben(DownloadDatei(), Json.Serialize(offen));
            }
            catch (Exception e) { Log("Warteschlange merken: " + e.Message); }
        }

        static List<Job> GemerkteDownloads()
        {
            var liste = new List<Job>();
            try
            {
                foreach (var o in (LadeJsonRoh(DownloadDatei()) as object[]) ?? new object[0])
                {
                    var d = o as Dictionary<string, object>;
                    if (d == null) continue;
                    var j = new Job { Art = Str(d, "art"), Titel = Str(d, "titel"), Url = Str(d, "url"), Ziel = Str(d, "ziel"), Gesamt = (long)Num(d, "gesamt"), Extra = Str(d, "extra") };
                    if (j.Art == null || j.Ziel == null) continue;
                    if (j.Art == "kopie" && !File.Exists(j.Url)) continue; // USB-Stick nicht mehr da
                    liste.Add(j);
                }
            }
            catch (Exception e) { Log("Gemerkte Downloads unlesbar: " + e.Message); }
            return liste;
        }

        static void FortsetzenBeimStart()
        {
            var liste = GemerkteDownloads();
            if (liste.Count == 0) return;
            var v = Verbindung();
            if (!Bool(v, "online") || Bool(v, "getaktet"))
            {
                unterbrochen = liste.Count;
                Log(liste.Count + " unterbrochene Downloads warten (" + (Bool(v, "online") ? "getaktete Verbindung" : "kein Internet") + ").");
                return;
            }
            Log(liste.Count + " unterbrochene Downloads werden fortgesetzt.");
            // Klappt das Einreihen nicht (z. B. zu wenig Platz), bleiben sie gemerkt und die Seite zeigt "Fortsetzen"
            Dictionary<string, object> erg;
            try { erg = Einreihen(liste); }
            catch { unterbrochen = liste.Count; throw; }
            if (!erg.ContainsKey("ok")) { unterbrochen = liste.Count; Log("Fortsetzen nicht möglich: " + Str(erg, "fehler")); }
        }

        static Dictionary<string, object> Fortsetzen()
        {
            var liste = GemerkteDownloads();
            if (liste.Count == 0) { unterbrochen = 0; return new Dictionary<string, object> { { "fehler", "Es gibt keine unterbrochenen Downloads." } }; }
            // Erst nach erfolgreichem Einreihen vergessen; scheitert es, bleiben die gemerkten Downloads erhalten
            var erg = Einreihen(liste);
            if (erg.ContainsKey("ok"))
                lock (Lk)
                {
                    unterbrochen = 0;
                    WarteschlangeMerken();
                }
            return erg;
        }

        // Jobs in die Warteschlange stellen (wie Installieren, aber mit fertigen Jobs)
        static Dictionary<string, object> Einreihen(List<Job> neu)
        {
            string problem = LaufwerkPruefen(neu, null);
            if (problem != null) return new Dictionary<string, object> { { "fehler", problem } };
            Thread endet = null;
            lock (Lk) if (worker != null && worker.IsAlive && abschluss) endet = worker;
            if (endet != null) endet.Join(60000);
            lock (Lk)
            {
                bool dazu = worker != null && worker.IsAlive;
                if (dazu && !warteschlange) return new Dictionary<string, object> { { "fehler", "Gerade läuft eine Aktualisierung. Bitte danach noch einmal versuchen." } };
                if (dazu && (abschluss || abbrechen)) return new Dictionary<string, object> { { "fehler", "Die laufenden Downloads werden gerade beendet. Bitte gleich noch einmal versuchen." } };
                if (dazu)
                {
                    var offen = new HashSet<string>(jobs.Where(x => x.Status == "wartet" || x.Status == "laeuft").Select(x => x.Ziel));
                    neu = neu.Where(x => !offen.Contains(x.Ziel)).ToList();
                    jobs = jobs.Concat(neu).ToList();
                    HelferAuffuellen();
                }
                else
                {
                    abbrechen = false;
                    jobs = neu;
                    abschluss = false;
                    warteschlange = true;
                    worker = new Thread(Arbeiter) { IsBackground = true };
                    worker.Start();
                }
                WarteschlangeMerken();
                return new Dictionary<string, object> { { "ok", true }, { "anzahl", neu.Count } };
            }
        }

        // Datei kopieren mit Fortschritt; erst als .part, dann umbenennen (ein Abbruch hinterlässt nichts Halbes)
        static void DateiKopieren(Job j)
        {
            string part = j.Ziel + ".part";
            Directory.CreateDirectory(Path.GetDirectoryName(j.Ziel));
            try
            {
                using (var quelle = new FileStream(j.Url, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 20))
                using (var ziel = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, 1 << 20))
                {
                    var buf = new byte[1 << 20];
                    int n;
                    long summe = 0;
                    while ((n = quelle.Read(buf, 0, buf.Length)) > 0)
                    {
                        if (abbrechen) throw new Exception("Abgebrochen");
                        ziel.Write(buf, 0, n);
                        summe += n;
                        j.Bytes = summe;
                    }
                }
            }
            catch (IOException e)
            {
                try { File.Delete(part); } catch { }
                throw new Exception(Regex.IsMatch(e.Message, "Speicherplatz|space", RegexOptions.IgnoreCase) ? "Nicht genug Platz auf dem Laufwerk." : "Kopieren fehlgeschlagen: " + e.Message);
            }
            catch { try { File.Delete(part); } catch { } throw; }
            if (j.Extra == "wissen" && File.Exists(j.Ziel))
            {
                // Stoppen und Ersetzen unter KiwixLk: sonst startet ein anderer Thread kiwix dazwischen mit der alten Datei.
                // Danach startet JobAusfuehren die Bibliothek neu; scheitert das Ersetzen, gleich hier (nicht aus lassen).
                lock (KiwixLk)
                {
                    StoppeKiwix();
                    try { File.Delete(j.Ziel); File.Move(part, j.Ziel); }
                    catch { StarteKiwix(); throw; }
                }
            }
            else
            {
                if (File.Exists(j.Ziel)) File.Delete(j.Ziel);
                File.Move(part, j.Ziel);
            }
            // Karten: Begleitdatei mit den Download-Einstellungen mitnehmen
            string meta = Path.ChangeExtension(j.Url, ".json");
            if (j.Extra == "karte" && File.Exists(meta)) try { File.Copy(meta, Path.ChangeExtension(j.Ziel, ".json"), true); } catch { }
        }

        // ------------------------------------------------------------------ Übersetzer (Bergamot)

        static string UebersetzerDir { get { return Path.Combine(Prog, "uebersetzer"); } }

        static List<Dictionary<string, object>> UebersetzerDateien()
        {
            return Arr(LadeJson(Path.Combine(Config, "uebersetzer.json")), "dateien").OfType<Dictionary<string, object>>().ToList();
        }

        // "Artikel übersetzen": Bibliothek (lib\) plus Modell Englisch → Deutsch von Mozilla. Fertig geladen liegt
        // artikel.json mit dem Registereintrag daneben. Ältere Fieldbook-Versionen luden ein älteres Modell nach
        // ende\ (Register in web\uebersetzer-modelle.json); das gilt weiter als installiert, bis es ersetzt wird.
        static string ArtikelMarke { get { return Path.Combine(UebersetzerDir, "artikel.json"); } }

        static bool UebersetzerLibDa()
        {
            var d = UebersetzerDateien();
            return d.Count > 0 && d.All(f => { string z = SichererPfad(UebersetzerDir, Str(f, "ziel")); return z != null && File.Exists(z); });
        }

        static bool UebersetzerNeu() { return UebersetzerLibDa() && File.Exists(ArtikelMarke); }

        static bool UebersetzerBereit()
        {
            return UebersetzerLibDa() && (File.Exists(ArtikelMarke) || File.Exists(Path.Combine(UebersetzerDir, "ende", "model.ende.intgemm.alphas.bin")));
        }

        static void UebersetzerLaden(Job j)
        {
            var konf = LadeJson(Path.Combine(Config, "uebersetzer.json"));
            ModelleLaden(j, Arr(konf, "modelle").OfType<Dictionary<string, object>>(), "artikel", ArtikelMarke);
            // Älteres Modell ist jetzt überflüssig
            string alt = Path.Combine(UebersetzerDir, "ende");
            if (Directory.Exists(alt)) try { Directory.Delete(alt, true); } catch { }
        }

        // ------------------------------------------------------------------ Sprachen für den Gesprächs-Übersetzer
        // Je Sprache zwei Modelle von Mozilla (dieselben wie in Firefox): Sprache → Englisch und Englisch → Sprache.
        // Übersetzt wird über Englisch, deshalb brauchen alle Sprachen das Paket "en" (nur Deutsch → Englisch)
        // und "Artikel übersetzen" (Englisch → Deutsch).
        // Welche Modellversion, steht in config\sprachen.json (mit der Bergamot-Bibliothek geprüft). Die Adressen
        // holt Fieldbook beim Laden aus der Modellliste von Mozilla und vergleicht danach die Prüfsumme.
        // Fertig geladen: programme\uebersetzer\sprachen\<code>.json mit den Einträgen für das Modellregister.

        static readonly object SprachLibLk = new object();
        static string SprachenDir { get { return Path.Combine(UebersetzerDir, "sprachen"); } }

        static Dictionary<string, object> SprachenKonfig()
        {
            return LadeJson(Path.Combine(Config, "sprachen.json")) ?? new Dictionary<string, object>();
        }

        static Dictionary<string, object> SprachInfo(string code)
        {
            return Arr(SprachenKonfig(), "sprachen").OfType<Dictionary<string, object>>().FirstOrDefault(s => Str(s, "code") == code);
        }

        static string[] InstallierteSprachen()
        {
            if (!Directory.Exists(SprachenDir)) return new string[0];
            var bekannt = new HashSet<string>(Arr(SprachenKonfig(), "sprachen").OfType<Dictionary<string, object>>().Select(s => Str(s, "code")));
            return Directory.GetFiles(SprachenDir, "*.json").Select(f => Path.GetFileNameWithoutExtension(f)).Where(c => bekannt.Contains(c)).ToArray();
        }

        // Modellregister für die Bergamot-Bibliothek: Englisch → Deutsch aus dem Grundpaket, dazu alle Sprachen
        static Dictionary<string, object> UebersetzerRegister()
        {
            var reg = new Dictionary<string, object>();
            if (UebersetzerBereit())
            {
                var basis = LadeJson(File.Exists(ArtikelMarke) ? ArtikelMarke : Path.Combine(Web, "uebersetzer-modelle.json"));
                if (basis != null) foreach (var kv in basis) reg[kv.Key] = kv.Value;
            }
            foreach (var c in InstallierteSprachen())
            {
                var r = LadeJson(Path.Combine(SprachenDir, c + ".json"));
                if (r != null) foreach (var kv in r) reg[kv.Key] = kv.Value;
            }
            return reg;
        }

        static bool VersionOk(string v)
        {
            return v != null && Regex.IsMatch(v, @"^\d+(\.\d+)+$");
        }

        // Dateien eines Modells aus der Liste von Mozilla: genau die geprüfte Version, sonst die neueste mit
        // derselben Hauptversion (neuere Hauptversionen laufen evtl. nicht mit unserer Bibliothek)
        static List<Dictionary<string, object>> ModellDateien(List<Dictionary<string, object>> liste, string von, string nach, string version)
        {
            var passend = liste.Where(r => Str(r, "fromLang") == von && Str(r, "toLang") == nach && VersionOk(Str(r, "version"))
                && (string.IsNullOrEmpty(Str(r, "filter_expression")) || Str(r, "filter_expression") == "env.appinfo.OS != 'Android' || env.channel != 'release'")).ToList();
            var genau = passend.Where(r => Str(r, "version") == version).ToList();
            if (genau.Count > 0) return genau;
            string haupt = (version ?? "").Split('.')[0];
            var gleich = passend.Where(r => Str(r, "version").Split('.')[0] == haupt).ToList();
            if (gleich.Count == 0) return gleich;
            var neueste = gleich.Select(r => new Version(Str(r, "version"))).Max();
            return gleich.Where(r => new Version(Str(r, "version")) == neueste).ToList();
        }

        static string Sha256Datei(string pfad)
        {
            using (var s = File.OpenRead(pfad))
            using (var h = System.Security.Cryptography.SHA256.Create())
                return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
        }

        static void SpracheLaden(Job j)
        {
            string code = j.Ziel;
            var info = SprachInfo(code);
            if (info == null) throw new Exception("Unbekannte Sprache: " + code);
            ModelleLaden(j, Arr(info, "modelle").OfType<Dictionary<string, object>>(), "sprachen", Path.Combine(SprachenDir, code + ".json"));
        }

        // Bibliothek (falls sie fehlt) und Modelle von Mozilla laden, Prüfsummen vergleichen, zum Schluss die
        // Marke mit den Registereinträgen schreiben. Die Modelle landen in programme\uebersetzer\<ordner>\<schluessel>.
        static void ModelleLaden(Job j, IEnumerable<Dictionary<string, object>> modelle, string ordner, string marke)
        {
            var konf = SprachenKonfig();
            var liste = Arr(Json.DeserializeObject(HoleText(Str(konf, "quelle"), 60000)) as Dictionary<string, object>, "data")
                .OfType<Dictionary<string, object>>().ToList();
            // Was zu laden ist: Adresse, Ziel unter programme\uebersetzer, Prüfsumme
            var dateien = new List<string[]>();
            var register = new Dictionary<string, object>();
            foreach (var m in modelle)
            {
                string von = Str(m, "von"), nach = Str(m, "nach"), schluessel = Str(m, "schluessel");
                var recs = ModellDateien(liste, von, nach, Str(m, "version"));
                if (recs.Count == 0) throw new Exception("Mozilla bietet das Modell " + von + " → " + nach + " gerade nicht an.");
                var eintrag = new Dictionary<string, object>();
                foreach (var r in recs)
                {
                    var anh = r["attachment"] as Dictionary<string, object>;
                    string name = Path.GetFileName(Str(r, "name") ?? "");
                    if (anh == null || name == "") continue;
                    string ziel = ordner + "/" + schluessel + "/" + name;
                    dateien.Add(new[] { Str(konf, "dateien") + Str(anh, "location"), ziel, Str(anh, "hash") });
                    eintrag[Str(r, "fileType")] = new Dictionary<string, object> { { "name", "/uebersetzer/" + ziel }, { "size", (long)Num(anh, "size") }, { "expectedSha256Hash", Str(anh, "hash") } };
                }
                register[schluessel] = eintrag;
            }
            j.Gesamt = Math.Max(j.Gesamt, 1);
            long fertig = 0;
            // Die Bibliothek (Bergamot) ist für alle Sprachen gleich; fehlt sie, zuerst laden (nur einer zur Zeit)
            lock (SprachLibLk)
            {
                foreach (var f in UebersetzerDateien())
                {
                    string ziel = SichererPfad(UebersetzerDir, Str(f, "ziel"));
                    if (ziel == null || File.Exists(ziel)) continue;
                    // Die Bibliothek läuft in Fieldbook selbst: ohne passende Prüfsumme nicht übernehmen
                    string soll = Str(f, "sha256");
                    if (string.IsNullOrEmpty(soll)) throw new Exception("Zu " + Path.GetFileName(ziel) + " fehlt die Prüfsumme, es wird deshalb nicht geladen.");
                    TeilLaden(j, fertig, Str(f, "url"), ziel);
                    if (Sha256Datei(ziel) != soll.ToLowerInvariant()) { File.Delete(ziel); throw new Exception("Die Prüfsumme von " + Path.GetFileName(ziel) + " stimmt nicht. Bitte erneut versuchen."); }
                }
            }
            foreach (var d in dateien)
            {
                string ziel = SichererPfad(UebersetzerDir, d[1]);
                if (ziel == null) throw new Exception("Ungültiger Dateiname: " + d[1]);
                if (!File.Exists(ziel))
                {
                    TeilLaden(j, fertig, d[0], ziel);
                    if (Sha256Datei(ziel) != d[2]) { File.Delete(ziel); throw new Exception("Die Prüfsumme von " + Path.GetFileName(ziel) + " stimmt nicht. Bitte erneut versuchen."); }
                }
                fertig += new FileInfo(ziel).Length;
                j.Bytes = fertig;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(marke));
            File.WriteAllText(marke, Json.Serialize(register), Utf8);
            j.Gesamt = fertig;
        }

        // Eine Datei laden und den Fortschritt im Job weiterzählen (basis = was davor schon fertig war)
        static void TeilLaden(Job j, long basis, string url, string ziel)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(ziel));
            var teil = new Job { Titel = j.Titel };
            bool laeuft = true;
            var anzeige = new Thread(delegate () { while (laeuft) { j.Bytes = basis + teil.Bytes; Thread.Sleep(300); } }) { IsBackground = true };
            anzeige.Start();
            try { Herunterladen(teil, url, ziel); }
            finally { laeuft = false; }
        }

        static void ProgrammLaden(Job j)
        {
            string id = j.Ziel;
            string zip = Path.Combine(Prog, id + ".zip");
            // Nur Programme mit eingetragener Prüfsumme starten: So läuft genau die geprüfte Version, auch wenn die Download-Quelle verändert wurde
            string soll = Str(ProgrammInfo(id), "sha256");
            if (string.IsNullOrEmpty(soll)) throw new Exception("Zu " + j.Titel + " fehlt die Prüfsumme, es wird deshalb nicht eingerichtet.");
            Herunterladen(j, j.Url, zip);
            if (Sha256Datei(zip) != soll.ToLowerInvariant()) { File.Delete(zip); throw new Exception("Die Prüfsumme von " + j.Titel + " stimmt nicht. Bitte erneut versuchen."); }
            string tmp = Path.Combine(Prog, id + ".neu");
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            ZipFile.ExtractToDirectory(zip, tmp);
            // Wenn das Archiv nur einen Unterordner enthält, diesen nach oben holen.
            var eintraege = Directory.GetFileSystemEntries(tmp);
            string quelle = tmp;
            if (eintraege.Length == 1 && Directory.Exists(eintraege[0])) quelle = eintraege[0];
            string ziel = Path.Combine(Prog, id);
            if (Directory.Exists(ziel)) Directory.Delete(ziel, true);
            Directory.Move(quelle, ziel);
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            File.Delete(zip);
        }

        // Karten lassen sich nicht fortsetzen. Bricht die Verbindung ab, bis zu zweimal von vorn versuchen.
        static void KarteLaden(Job j)
        {
            string exe = ProgrammPfad("pmtiles");
            if (exe == null) throw new Exception("pmtiles fehlt");
            var t = (j.Extra ?? "").Split('|');
            // Ausschnitt und Zoomstufe gehen als Argumente an pmtiles: nur saubere Zahlen durchlassen
            string bbox = t.Length >= 2 ? BboxGueltig(t[0]) : null;
            if (bbox == null) throw new Exception("Der Kartenausschnitt ist ungültig. Bitte die Karte neu auswählen.");
            t = new[] { bbox, ZoomOder(t[1], "15") };
            string tmp = j.Ziel.Replace(".pmtiles", ".tmp.pmtiles");
            const int Versuche = 3;
            for (int versuch = 1; ; versuch++)
            {
                string fehler;
                // Beim Abbrechen keine halbe Karte (oft mehrere GB) liegen lassen
                try { fehler = KarteVersuch(j, exe, t, tmp); }
                catch { try { File.Delete(tmp); } catch { } throw; }
                if (fehler == null) break;
                Log("Karte " + j.Titel + " fehlgeschlagen (Versuch " + versuch + "): " + fehler);
                try { File.AppendAllText(Path.Combine(Logs, "karten.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm") + " " + j.Titel + " (Versuch " + versuch + "): " + fehler + Environment.NewLine, Utf8); } catch { }
                bool netz = Regex.IsMatch(fehler, "timeout|connection|connect|EOF|reset|refused|no such host|dial|tls|unexpected|status code|stream error|PROTOCOL_ERROR|GOAWAY", RegexOptions.IgnoreCase);
                bool platz = Regex.IsMatch(fehler, "no space|not enough space|disk", RegexOptions.IgnoreCase);
                if (netz && versuch < Versuche && !abbrechen) { j.Bytes = 0; Thread.Sleep(5000); continue; }
                try { File.Delete(tmp); } catch { }
                // Technische Einzelheiten nur ins Protokoll, in der Oberfläche eine verständliche Meldung
                throw new Exception(platz ? "Nicht genug Platz auf dem Laufwerk."
                    : netz ? "Die Verbindung zum Kartenserver ist " + Versuche + "-mal abgebrochen. Bitte später „Erneut versuchen“ (die Karte beginnt dann von vorn)."
                    : "Die Karte konnte nicht geladen werden. Bitte „Erneut versuchen“. Einzelheiten stehen in daten\\logs\\karten.log.");
            }
            if (File.Exists(j.Ziel)) File.Delete(j.Ziel);
            File.Move(tmp, j.Ziel);
            j.Bytes = new FileInfo(j.Ziel).Length;
            j.Gesamt = j.Bytes;
            try
            {
                string id = Path.GetFileName(j.Ziel).Replace(".neu.pmtiles", "").Replace(".pmtiles", "");
                SicherSchreiben(Path.Combine(Daten, "karten", id + ".json"), Json.Serialize(new Dictionary<string, object> { { "bbox", t[0] }, { "maxzoom", t[1] } }));
            }
            catch { }
        }

        // Ein Durchlauf von pmtiles extract; gibt null zurück oder die letzten Meldungen des Programms
        static string KarteVersuch(Job j, string exe, string[] t, string tmp)
        {
            if (File.Exists(tmp)) File.Delete(tmp);
            // pmtiles legt die Datei in voller Größe an und schreibt an verstreute Stellen. Windows füllt dann
            // alles davor mit Nullen (bei Deutschland ~7 GB, Platte auf 100 %, Download stockt). Eine als
            // "sparse" markierte Datei füllt Windows nicht auf; die Markierung bleibt, wenn pmtiles sie neu öffnet.
            try { using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.ReadWrite)) { uint r; DeviceIoControl(fs.SafeFileHandle, 0x000900C4, IntPtr.Zero, 0, IntPtr.Zero, 0, out r, IntPtr.Zero); } } catch { }
            // 8 Verbindungen: Der Kartenserver antwortet pro Anfrage oft träge, parallel geht es deutlich schneller
            // (Test: 4 Verbindungen 18 MBit/s, 8 Verbindungen 44 MBit/s, 16 kaum mehr). Mit Tempolimit laufen
            // sie über die Drossel, die das Limit für alle zusammen einhält. Hinter einem Proxy geht das nicht
            // (der Proxy kann eine Anmeldung verlangen); dann ungefähr: etwa 10 MBit/s je Verbindung.
            string proxy = ProxyFuer(PlanetUrl());
            bool gedrosselt = ladeLimit > 0 && proxy == null;
            int verbindungen = ladeLimit > 0 && !gedrosselt ? (int)Math.Max(1, Math.Min(8, ladeLimit * 8 / 1000000 / 10)) : 8;
            string args = "extract \"" + PlanetUrl() + "\" \"" + tmp + "\" --bbox=" + t[0] + " --maxzoom=" + t[1] + " --download-threads=" + verbindungen;
            var psi = new ProcessStartInfo(exe, args) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardError = true, RedirectStandardOutput = true };
            // HTTP/1.1 statt HTTP/2: Der Kartenserver bricht lange HTTP/2-Übertragungen manchmal ab (PROTOCOL_ERROR)
            psi.EnvironmentVariables["GODEBUG"] = "http2client=0";
            if (gedrosselt)
            {
                string ueber = "http://127.0.0.1:" + DrosselPort();
                psi.EnvironmentVariables["HTTPS_PROXY"] = ueber;
                psi.EnvironmentVariables["HTTP_PROXY"] = ueber;
            }
            else ProxyFuerProgramm(psi, PlanetUrl());
            // pmtiles legt die Datei sofort in voller Größe an, die Dateigröße sagt also nichts über den Fortschritt.
            // Stattdessen die Fortschrittszeilen auswerten ("fetching chunks 2% |…| (155 MB/7.1 GB, 6.7 MB/s)",
            // bei gleicher Einheit nur einmal: "(1.0/7.1 GB, …)") und für Fehlermeldungen nur die übrigen
            // Zeilen behalten (die letzten, dort steht der Fehler).
            var aus = new List<string>();
            DataReceivedEventHandler zeile = (s, e) =>
            {
                if (e.Data == null) return;
                string text = e.Data;
                var m = Regex.Match(text, @"\((\d+(?:\.\d+)?) ?([kMGT]?B)?/(\d+(?:\.\d+)?) ([kMGT]?B)");
                if (m.Success)
                {
                    j.Bytes = PmtilesBytes(m.Groups[1].Value, m.Groups[2].Success ? m.Groups[2].Value : m.Groups[4].Value);
                    j.Gesamt = PmtilesBytes(m.Groups[3].Value, m.Groups[4].Value);
                    // Eine Fehlermeldung kann direkt an der letzten Fortschrittszeile hängen ("…[7m0s:1m22s]2026/10/31 … Failed …")
                    int ende = text.LastIndexOf(']');
                    text = ende >= 0 ? text.Substring(ende + 1) : "";
                }
                if (text.Trim() == "") return;
                lock (aus) { aus.Add(text.Trim()); if (aus.Count > 20) aus.RemoveAt(0); }
            };
            using (var p = new Process { StartInfo = psi })
            {
                p.ErrorDataReceived += zeile;
                p.OutputDataReceived += zeile;
                p.Start();
                ChildJob.Add(p);
                ProzessMerken(p, true);
                try
                {
                    p.BeginErrorReadLine();
                    p.BeginOutputReadLine();
                    // Kommt 5 Minuten lang nichts voran (z. B. nach Standby), abbrechen: dann greift der nächste Versuch
                    long letzteBytes = -1;
                    DateTime letzterFortschritt = DateTime.Now;
                    while (!p.WaitForExit(500))
                    {
                        if (abbrechen || beenden) { try { p.Kill(); } catch { } throw new Exception("Abgebrochen"); }
                        if (j.Bytes != letzteBytes) { letzteBytes = j.Bytes; letzterFortschritt = DateTime.Now; }
                        else if ((DateTime.Now - letzterFortschritt).TotalMinutes >= 5)
                        {
                            try { p.Kill(); } catch { }
                            p.WaitForExit(10000);
                            return "timeout: seit 5 Minuten kein Fortschritt";
                        }
                    }
                    p.WaitForExit();
                }
                finally { ProzessMerken(p, false); }
                // Absichtlich gestoppt: KarteLaden soll es nicht erneut versuchen
                if (p.ExitCode != 0 && (abbrechen || beenden)) throw new Exception("Abgebrochen");
                if (p.ExitCode == 0) return null;
                lock (aus) return "Code " + p.ExitCode + ": " + string.Join(" | ", aus);
            }
        }

        // "155", "MB" -> Bytes (pmtiles rechnet mit 1000er-Schritten)
        static long PmtilesBytes(string zahl, string einheit)
        {
            double z = double.Parse(zahl, CultureInfo.InvariantCulture);
            int stufe = "BkMGT".IndexOf(einheit[0]);
            return (long)(z * Math.Pow(1000, einheit.Length == 1 ? 0 : stufe));
        }

        static void OrteLaden(Job j)
        {
            string zip = j.Ziel + ".zip";
            Herunterladen(j, j.Url, zip);
            using (var z = ZipFile.OpenRead(zip))
            {
                var e = z.Entries.FirstOrDefault(x => x.Name.Equals(Path.GetFileName(j.Ziel), StringComparison.OrdinalIgnoreCase));
                if (e == null) throw new Exception("Ortsliste nicht im Archiv gefunden");
                e.ExtractToFile(j.Ziel, true);
            }
            File.Delete(zip);
        }

        static Dictionary<string, object> Entfernen(Dictionary<string, object> b)
        {
            string art = Str(b, "art"), id = Str(b, "id");
            try
            {
                if (art == "paket")
                {
                    foreach (var o in Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete"))
                    {
                        var p = (Dictionary<string, object>)o;
                        if (Str(p, "id") != id) continue;
                        string f = ZimDatei(ZimName(p), Str(p, "flavour") ?? "");
                        // Stoppen, Löschen, Neustarten zusammen unter KiwixLk; die Bibliothek auch starten, wenn das Löschen scheitert
                        if (f != null)
                            lock (KiwixLk)
                            {
                                StoppeKiwix();
                                try { File.Delete(Path.Combine(Daten, "wissen", f)); }
                                finally { StarteKiwix(); }
                            }
                    }
                }
                else if (art == "modell")
                {
                    foreach (var o in Arr(LadeJson(Path.Combine(Config, "modelle.json")), "modelle"))
                    {
                        var m = (Dictionary<string, object>)o;
                        if (Str(m, "id") != id) continue;
                        if (Str(einst, "modell") == id) StoppeKi();
                        string f = Path.Combine(Daten, "modelle", Str(m, "datei"));
                        if (File.Exists(f)) File.Delete(f);
                    }
                    // Ohne KI braucht es auch die Suchhilfe nicht mehr
                    if (!KiInstalliert())
                    {
                        StoppeSuchhilfe();
                        string sf = SuchhilfeDatei();
                        if (sf != null && File.Exists(sf)) File.Delete(sf);
                    }
                }
                else if (art == "karte")
                {
                    string f = SichererPfad(Path.Combine(Daten, "karten"), id + ".pmtiles");
                    if (f != null && File.Exists(f)) File.Delete(f);
                }
                else if (art == "uebersetzer")
                {
                    // Die Sprachen brauchen Englisch → Deutsch und die Bibliothek
                    if (InstallierteSprachen().Length > 0)
                        return new Dictionary<string, object> { { "fehler", "Die Sprachen für Gespräche brauchen „Artikel übersetzen“, weil darin Englisch → Deutsch steckt. Lösche zuerst die Sprachen." } };
                    if (Directory.Exists(UebersetzerDir)) Directory.Delete(UebersetzerDir, true);
                }
                else if (art == "sprache")
                {
                    var da = InstallierteSprachen();
                    if (id == "en" && da.Any(c => c != "en"))
                        return new Dictionary<string, object> { { "fehler", "Englisch brauchen die anderen Sprachen, weil über Englisch übersetzt wird. Lösche zuerst die anderen Sprachen." } };
                    var si = SprachInfo(id);
                    if (si != null)
                        foreach (var m in Arr(si, "modelle").OfType<Dictionary<string, object>>())
                        {
                            string d = SichererPfad(SprachenDir, Str(m, "schluessel"));
                            if (d != null && Directory.Exists(d)) Directory.Delete(d, true);
                        }
                    string f = SichererPfad(SprachenDir, id + ".json");
                    if (f != null && File.Exists(f)) File.Delete(f);
                    // Die Stimme gehört zur Sprache; ohne Sprachen auch Deutsch und das Programm weg
                    if (id != "de") StimmeLoeschen(id);
                    if (InstallierteSprachen().Length == 0)
                    {
                        StimmeLoeschen("de");
                        lock (vorlesenLk)
                        {
                            PiperDienstStoppen();
                            foreach (var pd in new[] { Path.Combine(Prog, "piper"), Path.Combine(Prog, "piper-py") })
                                if (Directory.Exists(pd)) Directory.Delete(pd, true);
                        }
                    }
                }
                else if (art == "vorlesen")
                {
                    // Grundfunktion Vorlesen: Programm und alle Stimmen weg, die Sprachen bleiben (dann „Nur Text“)
                    foreach (var st in Arr(StimmenKonfig(), "stimmen").OfType<Dictionary<string, object>>()) StimmeLoeschen(Str(st, "code"));
                    lock (vorlesenLk)
                    {
                        PiperDienstStoppen();
                        foreach (var pd in new[] { Path.Combine(Prog, "piper"), Path.Combine(Prog, "piper-py") })
                            if (Directory.Exists(pd)) Directory.Delete(pd, true);
                    }
                }
                else if (art == "spracheingabe")
                {
                    lock (sprechenLk)
                    {
                        SprechDienstStoppen();   // hält sonst Modelle und DLLs fest
                        foreach (var m in SprachModelle()) if (File.Exists(SprachModellPfad(m))) File.Delete(SprachModellPfad(m));
                        string d = Path.Combine(Prog, "whisper");
                        if (Directory.Exists(d)) Directory.Delete(d, true);
                    }
                }
                return new Dictionary<string, object> { { "ok", true } };
            }
            catch (Exception e) { return new Dictionary<string, object> { { "fehler", e.Message } }; }
            finally { StatusCacheLeeren(); }
        }

        // ------------------------------------------------------------------ Kiwix

        static readonly object KiwixLk = new object();
        static List<string> kiwixDefekt = new List<string>();
        static string kiwixFehler = "";

        static string KiwixArgs(int port, IEnumerable<string> zims)
        {
            return "--address=127.0.0.1 --port=" + port + " --urlRootLocation=/kiwix --threads=8 " + string.Join(" ", zims.Select(z => "\"" + z + "\""));
        }

        // Wie KiwixArgs, aber über eine Bibliotheksliste. Mehrsprachige Pakete (z. B. Low-tech Magazine,
        // "eng,fra,deu,...") gelten darin nur in ihrer ersten Sprache, denn sonst verweigert Kiwix die
        // Suche ("confusion of tongues"). Klappt das nicht, werden die Dateien direkt übergeben.
        static string KiwixBibliothekArgs(string exe, int port, List<string> zims)
        {
            try
            {
                string manage = Path.Combine(Path.GetDirectoryName(exe), "kiwix-manage.exe");
                if (!File.Exists(manage)) return KiwixArgs(port, zims);
                string lib = Path.Combine(Daten, "cache", "kiwix-bibliothek.xml");
                if (File.Exists(lib)) File.Delete(lib);
                Ausfuehren(manage, "\"" + lib + "\" add " + string.Join(" ", zims.Select(z => "\"" + z + "\"")), 120000);
                string xml = File.ReadAllText(lib, Utf8);
                xml = Regex.Replace(xml, "language=\"([^\",]*),[^\"]*\"", "language=\"$1\"");
                File.WriteAllText(lib, xml, Utf8);
                return "--address=127.0.0.1 --port=" + port + " --urlRootLocation=/kiwix --threads=8 --library \"" + lib + "\"";
            }
            catch (Exception ex)
            {
                Log("Bibliotheksliste für Kiwix nicht erstellt, Pakete werden direkt geladen: " + ex.Message);
                return KiwixArgs(port, zims);
            }
        }

        // Startet die Bibliothek. Lässt eine einzelne defekte ZIM-Datei kiwix-serve abstürzen,
        // wird sie aussortiert und die Bibliothek mit den übrigen Paketen gestartet.
        static void StarteKiwix()
        {
            PdfTexteAufraeumen();
            IfixitAufraeumen();
            try { StarteKiwixDienst(); }
            catch (Exception e)
            {
                // z. B. Virenscanner sperrt kiwix-serve.exe oder die Logdatei
                kiwix = null;
                kiwixFehler = "Die Bibliothek konnte nicht starten, oft blockiert ein Virenscanner das Programm Kiwix.";
                Log("Bibliothek konnte nicht starten: " + e.Message);
                StatFehler("bibliothek", kiwixFehler + " " + e.Message);
            }
            IfixitVorbereiten();
        }

        static void StarteKiwixDienst()
        {
            lock (KiwixLk)
            {
                StoppeKiwix();
                var zims = Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim").Where(z => new FileInfo(z).Length > 0).ToList();
                string exe = ProgrammPfad("kiwix");
                kiwixFehler = "";
                if (exe == null) { if (zims.Count > 0) kiwixFehler = "Das Programm Kiwix fehlt. Bitte unter Inhalte ein Wissenspaket neu installieren."; return; }
                if (zims.Count == 0) return;
                string log = Path.Combine(Logs, "kiwix.log");
                if (KiwixLaeuft(exe, KiwixBibliothekArgs(exe, KiwixPort, zims), log, 40)) { kiwixDefekt = new List<string>(); Log("Bibliothek gestartet (" + zims.Count + " Pakete)."); return; }

                // Einzeln prüfen, welche Datei das Problem ist
                Log("Bibliothek startet nicht, Pakete werden einzeln geprüft ...");
                var gut = new List<string>();
                var defekt = new List<string>();
                int testPort = FreierPort();
                foreach (var z in zims)
                {
                    var p = StarteDienst(exe, KiwixArgs(testPort, new[] { z }), Path.Combine(Logs, "kiwix-test.log"));
                    bool ok = false;
                    for (int i = 0; i < 40 && !p.HasExited; i++) { if (HttpOk("http://127.0.0.1:" + testPort + "/kiwix/")) { ok = true; break; } Thread.Sleep(250); }
                    try { if (!p.HasExited) { p.Kill(); p.WaitForExit(3000); } } catch { }
                    (ok ? gut : defekt).Add(z);
                }
                kiwixDefekt = defekt.Select(Path.GetFileName).ToList();
                if (defekt.Count > 0) Log("Defekte oder unvollständige Pakete: " + string.Join(", ", kiwixDefekt));
                if (gut.Count > 0 && KiwixLaeuft(exe, KiwixBibliothekArgs(exe, KiwixPort, gut), log, 40))
                    Log("Bibliothek gestartet (" + gut.Count + " Pakete, " + defekt.Count + " ausgelassen).");
                else
                    kiwixFehler = "Die Bibliothek konnte nicht starten. Details in daten\\logs\\kiwix.log";
                if (defekt.Count > 0 && kiwixFehler == "") kiwixFehler = "Diese Pakete sind beschädigt und wurden ausgelassen: " + string.Join(", ", kiwixDefekt) + ". Bitte unter Inhalte löschen und neu laden.";
                if (kiwixFehler != "") StatFehler("bibliothek", kiwixFehler);
            }
        }

        // kiwix-serve kann unter vielen gleichzeitigen Suchanfragen abstürzen. Dann beim nächsten Zugriff neu
        // starten, höchstens einmal in 30 Sekunden (falls es sofort wieder abstürzt, nicht endlos).
        // Der Neustart läuft in einem eigenen Thread, damit nicht jede Anfrage (z. B. 40 Bilder eines Artikels)
        // einen Pool-Thread blockiert. Rückgabe true: Neustart läuft gerade, die Anfrage bekommt 503.
        static DateTime kiwixWiederbelebt = DateTime.MinValue;
        static int kiwixNeustartLaeuft; // 1, solange der Hintergrund-Neustart läuft
        static bool KiwixWiederbeleben()
        {
            if (Interlocked.CompareExchange(ref kiwixNeustartLaeuft, 0, 0) == 1) return true;
            if ((DateTime.Now - kiwixWiederbelebt).TotalSeconds < 30) return false;
            // Belegt: die Bibliothek wird gerade gestartet oder gestoppt
            if (!Monitor.TryEnter(KiwixLk)) return true;
            try
            {
                var k = kiwix;
                if (k == null || !k.HasExited) return false;
                if ((DateTime.Now - kiwixWiederbelebt).TotalSeconds < 30) return false;
                kiwixWiederbelebt = DateTime.Now;
                int code = -1;
                try { code = k.ExitCode; } catch { }
                Log("Bibliothek war abgestürzt (Code " + code + "), wird neu gestartet.");
                Interlocked.Exchange(ref kiwixNeustartLaeuft, 1);
                try
                {
                    new Thread(delegate ()
                    {
                        try { StarteKiwix(); }
                        catch (Exception e) { Log("Neustart der Bibliothek: " + e.Message); }
                        finally { Interlocked.Exchange(ref kiwixNeustartLaeuft, 0); }
                    }) { IsBackground = true }.Start();
                }
                catch { Interlocked.Exchange(ref kiwixNeustartLaeuft, 0); throw; }
                return true;
            }
            finally { Monitor.Exit(KiwixLk); }
        }

        // Läuft Kiwix gerade? Mit lokaler Kopie, weil ein anderer Thread kiwix auf null setzen kann.
        static bool KiwixAktiv() { var k = kiwix; return k != null && !k.HasExited; }

        static bool KiwixLaeuft(string exe, string args, string log, int versuche)
        {
            // Mit einer lokalen Kopie arbeiten: StoppeKiwix kann das Feld zwischendurch auf null setzen
            var p = StarteDienst(exe, args, log);
            kiwix = p;
            for (int i = 0; i < versuche; i++)
            {
                if (p.HasExited) { if (kiwix == p) kiwix = null; return false; }
                if (HttpOk("http://127.0.0.1:" + KiwixPort + "/kiwix/")) return true;
                Thread.Sleep(250);
            }
            // Große Pakete brauchen manchmal länger: läuft der Prozess noch, gilt der Start als gelungen
            return kiwix == p && !p.HasExited;
        }

        static void StoppeKiwix()
        {
            lock (Lk)
            {
                var k = kiwix;
                try { if (k != null && !k.HasExited) { k.Kill(); k.WaitForExit(5000); } } catch { }
                kiwix = null;
            }
        }

        // ------------------------------------------------------------------ Aktualisierung
        // Nichts läuft dauerhaft. Zwei Windows-Aufgaben starten das Skript app\aktualisieren.ps1:
        //  - "Prüfen": einmal pro Woche, wenige kleine Anfragen, im Modus "fragen" danach ein Pop-up.
        //  - "Herunterladen": nur im Leerlauf am Stromnetz. Bei Maus/Tastatur oder Akku sofort Pause.

        const string AufgabePruefen = "Fieldbook Daten pruefen";
        const string AufgabeLaden = "Fieldbook Daten herunterladen";

        static string AktDatei { get { return Path.Combine(Daten, "aktualisierung.json"); } }
        static string AktFlag { get { return Path.Combine(Daten, "aktualisierung-bereit"); } }

        static Dictionary<string, object> AktEinst()
        {
            return einst.ContainsKey("aktualisierung") ? einst["aktualisierung"] as Dictionary<string, object> : null;
        }

        static void AktLog(string s)
        {
            try { File.AppendAllText(Path.Combine(Logs, "aktualisierung.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm") + "  " + s + "\r\n", Utf8); } catch { }
        }

        // Nur ein Update-Lauf zur Zeit (Windows-Aufgaben und laufendes Fieldbook), sonst hängen zwei curl an dieselbe .part an.
        // Gibt die Sperre zurück oder null, wenn ein anderer Lauf sie hat. Freigeben im selben Thread (UpdateSperreFrei).
        static Mutex UpdateSperre()
        {
            Mutex m = null;
            try
            {
                m = new Mutex(false, @"Local\FieldbookUpdate");
                bool hab;
                try { hab = m.WaitOne(0); }
                catch (AbandonedMutexException) { hab = true; } // Vorheriger Lauf abgestürzt: Sperre gehört jetzt uns
                if (hab) return m;
            }
            catch { }
            if (m != null) m.Dispose();
            return null;
        }

        static void UpdateSperreFrei(Mutex m)
        {
            if (m == null) return;
            try { m.ReleaseMutex(); } catch { }
            m.Dispose();
        }

        // Einstieg für app\aktualisieren.ps1 (eigener Prozess, ohne Server)
        public static int Aktualisierung(string root, string modus)
        {
            Init(root);
            try
            {
                if (modus == "pruefen") Pruefen(true);
                else if (modus == "laden") LadenImLeerlauf();
                return 0;
            }
            catch (Exception e) { AktLog("Fehler: " + e.Message); return 1; }
        }

        static Dictionary<string, object> AktualisierungStatus()
        {
            var a = AktEinst() ?? new Dictionary<string, object>();
            var d = LadeJson(AktDatei) ?? new Dictionary<string, object>();
            long bytes = 0;
            var titel = new List<object>();
            foreach (var o in Arr(d, "updates")) { var u = (Dictionary<string, object>)o; bytes += (long)Num(u, "bytes"); titel.Add(Str(u, "titel")); }
            return new Dictionary<string, object>
            {
                {"an", Bool(a, "an")}, {"modus", Str(a, "modus") ?? "fragen"}, {"wann", Str(a, "wann") ?? "sofort"}, {"mbit", (int)Num(a, "mbit")}, {"programm", !a.ContainsKey("programm") || Bool(a, "programm")},
                {"geprueft", Str(d, "geprueft")}, {"anzahl", titel.Count}, {"bytes", bytes}, {"titel", titel},
                {"freigegeben", Bool(d, "freigegeben")}, {"eingerichtet", Bool(einst, "aufgabenEingerichtet")}
            };
        }

        static Dictionary<string, object> AktualisierungSetzen(Dictionary<string, object> b)
        {
            lock (Lk)
            {
                einst["aktualisierung"] = new Dictionary<string, object> { { "an", Bool(b, "an") }, { "modus", Str(b, "modus") == "auto" ? "auto" : "fragen" }, { "wann", Str(b, "wann") == "leerlauf" ? "leerlauf" : "sofort" }, { "mbit", Math.Max(0, (int)Num(b, "mbit")) }, { "programm", !b.ContainsKey("programm") || Bool(b, "programm") } };
                SpeichereEinst();
            }
            // Im Assistenten erst beim Herunterladen eintragen, in den Einstellungen sofort
            if (Bool(b, "sofort"))
            {
                try { AufgabenAbgleichen(); }
                catch (Exception e) { var s = AktualisierungStatus(); s["fehler"] = e.Message; return s; }
            }
            return AktualisierungStatus();
        }

        // Windows-Aufgaben passend zur Einstellung anlegen oder entfernen
        static void AufgabenAbgleichen()
        {
            var a = AktEinst();
            if (a != null && Bool(a, "an")) AufgabenAnlegen();
            else if (Bool(einst, "aufgabenEingerichtet")) AufgabenEntfernen();
        }

        // Ordner verschoben (z. B. USB-Stick)? Dann Aufgaben mit neuem Pfad neu anlegen.
        static void AufgabenPfadPruefen()
        {
            try
            {
                var a = AktEinst();
                if (a == null || !Bool(a, "an")) return;
                if (Str(einst, "aufgabenPfad") != Root) { AufgabenAnlegen(); return; }
                // Gleicher Pfad heißt nicht gleicher Rechner: Steckt derselbe Stick an einem anderen Laptop,
                // fehlen dort die Aufgaben. Deshalb nachsehen, ob es sie hier gibt und sie auf diesen Ordner zeigen.
                string xml = "";
                try { xml = Ausfuehren("schtasks.exe", "/Query /TN \"" + AufgabePruefen + "\" /XML", 15000) ?? ""; }
                catch { xml = ""; }   // Aufgabe gibt es hier nicht (schtasks meldet Fehler)
                // Nur ASCII vergleichen: schtasks gibt je nach System eine andere Kodierung aus (Umlaute im Pfad)
                Func<string, string> ascii = s => Regex.Replace(s ?? "", "[^\\x20-\\x7E]", "");
                if (ascii(xml).IndexOf(ascii(System.Security.SecurityElement.Escape(Root)), StringComparison.OrdinalIgnoreCase) < 0)
                {
                    Log("Aufgabenplanung: Aufgaben fehlen auf diesem Rechner oder zeigen woandershin, werden neu angelegt.");
                    AufgabenAnlegen();
                }
            }
            catch (Exception e) { Log("Aufgabenplanung: " + e.Message); }
        }

        static void AufgabenAnlegen()
        {
            string exe = Path.Combine(Root, "Fieldbook.exe");
            string cmd, argP, argL;
            if (File.Exists(exe)) { cmd = exe; argP = "--aktualisieren pruefen"; argL = "--aktualisieren laden"; }
            else
            {
                cmd = "powershell.exe";
                string ps = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + Path.Combine(AppDir, "aktualisieren.ps1") + "\" -Modus ";
                argP = ps + "pruefen"; argL = ps + "laden";
            }
            string start = DateTime.Today.AddDays(1).ToString("yyyy-MM-dd") + "T19:00:00";
            // Herunterladen eine halbe Stunde später, damit beide Aufgaben nicht gleichzeitig starten
            string startLaden = DateTime.Today.AddDays(1).ToString("yyyy-MM-dd") + "T19:30:00";
            string pruefen =
                "<Triggers><CalendarTrigger><StartBoundary>" + start + "</StartBoundary><ScheduleByWeek><DaysOfWeek><Sunday /></DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger></Triggers>" +
                "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>" +
                "<StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>" +
                "<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>" +
                "<ExecutionTimeLimit>PT12H</ExecutionTimeLimit><Priority>7</Priority></Settings>";
            bool leerlauf = Str(AktEinst(), "wann") == "leerlauf";
            // Sofort-Modus: lädt direkt nach dem Prüfen. Diese Aufgabe setzt nur abgebrochene Downloads fort
            // (5 Minuten nach der Anmeldung und täglich), mit niedrigster Priorität.
            string ladenSofort =
                "<Triggers><LogonTrigger><Delay>PT5M</Delay><UserId>" + System.Security.SecurityElement.Escape(Environment.UserDomainName + "\\" + Environment.UserName) + "</UserId></LogonTrigger><CalendarTrigger><StartBoundary>" + startLaden + "</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>" +
                "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>" +
                "<StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>" +
                "<IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>" +
                "<ExecutionTimeLimit>PT12H</ExecutionTimeLimit><Priority>9</Priority></Settings>";
            string laden = !leerlauf ? ladenSofort :
                "<Triggers><IdleTrigger><Enabled>true</Enabled></IdleTrigger></Triggers>" +
                "<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>true</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>true</StopIfGoingOnBatteries>" +
                "<RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable><RunOnlyIfIdle>true</RunOnlyIfIdle>" +
                "<IdleSettings><Duration>PT10M</Duration><WaitTimeout>PT1H</WaitTimeout><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>true</RestartOnIdle></IdleSettings>" +
                "<ExecutionTimeLimit>PT12H</ExecutionTimeLimit><Priority>9</Priority></Settings>";
            Aufgabe(AufgabePruefen, "Fieldbook: sucht einmal pro Woche nach neuen Daten (wenige Sekunden).", pruefen, cmd, argP);
            Aufgabe(AufgabeLaden, leerlauf ? "Fieldbook: lädt freigegebene Aktualisierungen nur, wenn der Computer unbenutzt am Strom hängt."
                                           : "Fieldbook: setzt unterbrochene Aktualisierungen mit niedriger Priorität fort.", laden, cmd, argL);
            lock (Lk) { einst["aufgabenEingerichtet"] = true; einst["aufgabenPfad"] = Root; SpeichereEinst(); }
            Log("Automatische Aktualisierung eingerichtet.");
        }

        static void Aufgabe(string name, string beschreibung, string teil, string cmd, string args)
        {
            string xml = "<?xml version=\"1.0\" encoding=\"UTF-16\"?>" +
                "<Task version=\"1.3\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">" +
                "<RegistrationInfo><Description>" + System.Security.SecurityElement.Escape(beschreibung) + "</Description></RegistrationInfo>" +
                "<Principals><Principal id=\"Author\"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>" +
                teil +
                "<Actions Context=\"Author\"><Exec><Command>" + System.Security.SecurityElement.Escape(cmd) + "</Command><Arguments>" + System.Security.SecurityElement.Escape(args) + "</Arguments></Exec></Actions>" +
                "</Task>";
            string datei = Path.Combine(Daten, "cache", "aufgabe.xml");
            File.WriteAllText(datei, xml, Encoding.Unicode);
            Ausfuehren(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/Create /F /TN \"" + name + "\" /XML \"" + datei + "\"", 30000);
            try { File.Delete(datei); } catch { }
        }

        static void AufgabenEntfernen()
        {
            foreach (var n in new[] { AufgabePruefen, AufgabeLaden })
                try { Ausfuehren(Path.Combine(Environment.SystemDirectory, "schtasks.exe"), "/Delete /F /TN \"" + n + "\"", 30000); } catch { }
            lock (Lk) { einst["aufgabenEingerichtet"] = false; SpeichereEinst(); }
            try { File.Delete(AktFlag); } catch { }
            Log("Automatische Aktualisierung ausgeschaltet.");
        }

        static Dictionary<string, Dictionary<string, object>> KatalogFuerName(string name)
        {
            var xml = HoleText("https://library.kiwix.org/catalog/v2/entries?name=" + Uri.EscapeDataString(name) + "&count=100", 30000);
            return ParseKatalog(xml);
        }

        // mitProgramm=false: nur Inhalte (Knopf „Inhalte aktualisieren“); Fieldbook selbst hat dort einen eigenen Knopf
        static List<Dictionary<string, object>> SucheAktualisierungen(bool mitProgramm = true)
        {
            var liste = new List<Dictionary<string, object>>();
            // Fieldbook selbst (abschaltbar, nie im Entwicklungsordner)
            var ae = AktEinst();
            if (mitProgramm && (ae == null || !ae.ContainsKey("programm") || Bool(ae, "programm")) && UpdateApi() != null && !IstEntwicklungsordner())
            {
                try
                {
                    var u = ProgrammUpdateSuchen();
                    if (Bool(u, "verfuegbar"))
                        liste.Add(new Dictionary<string, object> { { "art", "programm-update" }, { "titel", "Fieldbook " + Str(u, "neu") + " (Programm)" }, { "url", Str(u, "zip") }, { "extra", (Str(u, "sha") ?? "") + "|" + Str(u, "neu") }, { "bytes", u["bytes"] } });
                }
                catch (Exception ex) { AktLog("Programm-Update-Suche fehlgeschlagen: " + ex.Message); }
            }
            // Wissenspakete: neuere Ausgabe im Kiwix-Katalog?
            foreach (var o in Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete"))
            {
                var p = (Dictionary<string, object>)o;
                string name = Str(p, "name"), fl = Str(p, "flavour") ?? "";
                string datei = ZimDatei(ZimName(p), fl);
                if (datei == null) continue;
                Dictionary<string, object> e;
                // Eine fehlschlagende Katalog-Anfrage soll nicht die ganze Prüfung abbrechen
                Dictionary<string, Dictionary<string, object>> kat;
                try { kat = KatalogFuerName(name); }
                catch (Exception ex) { AktLog("Katalog für " + name + " nicht erreichbar: " + ex.Message); continue; }
                if (kat == null || !kat.TryGetValue(name + "|" + fl, out e)) continue;
                string url = (string)e["url"];
                string neu = url.Substring(url.LastIndexOf('/') + 1);
                var dAlt = Regex.Match(datei, @"_(\d{4}-\d{2}[a-z]?)\.zim$");
                var dNeu = Regex.Match(neu, @"_(\d{4}-\d{2}[a-z]?)\.zim$");
                if (!dAlt.Success || !dNeu.Success || string.CompareOrdinal(dNeu.Groups[1].Value, dAlt.Groups[1].Value) <= 0) continue;
                liste.Add(new Dictionary<string, object> { { "art", "zim" }, { "titel", Str(p, "titel") + " (Stand " + dNeu.Groups[1].Value + ")" }, { "url", url }, { "ziel", Path.Combine(Daten, "wissen", neu) }, { "bytes", e["bytes"] }, { "extra", name + "|" + fl } });
            }
            // Wegedaten: höchstens einmal im Monat
            foreach (var f in Directory.GetFiles(Path.Combine(Daten, "routen"), "*.rd5"))
            {
                var fi = new FileInfo(f);
                if ((DateTime.Now - fi.LastWriteTime).TotalDays < 30) continue;
                string url = SegmentBasis + fi.Name;
                try
                {
                    var req = (HttpWebRequest)WebRequest.Create(url);
                    req.Method = "HEAD"; req.Timeout = 20000; req.UserAgent = "Fieldbook/" + Version;
                    using (var r = (HttpWebResponse)req.GetResponse())
                        if (r.LastModified > fi.LastWriteTime.AddDays(7))
                            liste.Add(new Dictionary<string, object> { { "art", "route" }, { "titel", "Wegedaten " + Path.GetFileNameWithoutExtension(f) }, { "url", url }, { "ziel", f }, { "bytes", r.ContentLength } });
                }
                catch { }
            }
            // Vorlesen: Installationen bis 0.8.4 haben das alte Piper, das neue liefert die Wortzeiten fürs Mitlesen
            if (PiperPyPfad() == null && ProgrammPfad("piper") != null && Stimmen().Length > 0)
            {
                var pj = PiperPyJob();
                liste.Add(new Dictionary<string, object> { { "art", "programm" }, { "titel", pj.Titel }, { "ziel", "piper-py" }, { "bytes", pj.Gesamt } });
            }
            // Suchhilfe für die KI: ältere Installationen haben nur die KI
            if (KiInstalliert() && !SuchhilfeDa())
            {
                var sj = SuchhilfeJob();
                if (sj != null) liste.Add(new Dictionary<string, object> { { "art", "datei" }, { "titel", sj.Titel }, { "url", sj.Url }, { "ziel", sj.Ziel }, { "bytes", sj.Gesamt } });
            }
            // Karten: etwa zweimal im Jahr
            foreach (var f in Directory.GetFiles(Path.Combine(Daten, "karten"), "*.pmtiles"))
            {
                var fi = new FileInfo(f);
                if (fi.Name.EndsWith(".neu.pmtiles") || fi.Name.Contains(".tmp.") || (DateTime.Now - fi.LastWriteTime).TotalDays < 180) continue;
                string id = Path.GetFileNameWithoutExtension(f);
                var r = Region(id);
                if (r == null) continue;
                var meta = LadeJson(Path.Combine(Daten, "karten", id + ".json"));
                string mz = ZoomOder(Str(meta, "maxzoom"), ZoomOder(Str(r, "maxzoom"), "15"));
                liste.Add(new Dictionary<string, object> { { "art", "karte" }, { "titel", "Karte: " + Str(r, "titel") }, { "ziel", Path.Combine(Daten, "karten", id + ".neu.pmtiles") }, { "bytes", fi.Length }, { "extra", BboxText(r) + "|" + mz } });
            }
            return liste;
        }

        // Nutzer hat im Fenster trotz getakteter Verbindung „Herunterladen“ gewählt (nur dieser Prozess)
        static bool getaktetErlaubt;

        // Letztes sicheres Ergebnis. Anfangs das der Startprüfung in aktualisieren.ps1 (OW_GETAKTET, dort im Zweifel
        // getaktet): Ohne Erlaubnis läuft der Download nur, wenn diese "frei" ergab. So gilt nie "frei" ohne echte Prüfung.
        static bool getaktetZuletzt = Environment.GetEnvironmentVariable("OW_GETAKTET") == "1";

        // Wie aktualisieren.ps1. Ohne Internetverbindung nicht getaktet (es wird ohnehin nichts geladen).
        // Scheitert die Abfrage (Zeitüberschreitung, Fehler), gilt der letzte Wert: sonst pausierte ein kurz
        // ausgelasteter Rechner den Download fälschlich wegen „Getaktete Verbindung“.
        static bool GetaktetJetzt()
        {
            try
            {
                string ps = "$null=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime];" +
                    "$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile();" +
                    "if(-not $p){'keine'}else{$k=$p.GetConnectionCost();$g=$false;try{$g=$k.ApproachingDataLimit -or $k.OverDataLimit}catch{};" +
                    "if(($k.NetworkCostType.ToString() -in @('Unrestricted','Unknown')) -and -not $k.Roaming -and -not $g){'frei'}else{'getaktet'}}";
                // Normale Priorität: der Update-Prozess läuft im Leerlauf-Modus, PowerShell würde das erben
                string aus = Ausfuehren("powershell.exe", "-NoProfile -NonInteractive -Command \"" + ps + "\"", 30000, true);
                foreach (var z in aus.Split('\n'))
                {
                    string t = z.Trim();
                    if (t == "frei" || t == "keine") { getaktetZuletzt = false; return false; }
                    if (t == "getaktet") { getaktetZuletzt = true; return true; }
                }
                AktLog("Verbindungsart nicht erkannt, letzter Wert gilt.");
            }
            catch (Exception e) { AktLog("Verbindungsart nicht geprüft (" + e.Message + "), letzter Wert gilt."); }
            return getaktetZuletzt;
        }

        const string UpdateLaeuftText = "Gerade läuft eine Aktualisierung. Bitte danach noch einmal prüfen.";

        // Läuft gerade ein Update (hier im Programm oder in einer Windows-Aufgabe)?
        static bool UpdateLaeuft()
        {
            lock (Lk) if (worker != null && worker.IsAlive && !warteschlange) return true;
            var probe = UpdateSperre();
            if (probe == null) return true;
            UpdateSperreFrei(probe);
            return false;
        }

        // Während eines Updates nicht prüfen: das überschriebe aktualisierung.json, und das laufende Update schriebe
        // danach seinen veralteten Stand zurück. Mit popup (Windows-Aufgabe) nur protokollieren, sonst Fehler melden.
        static void Pruefen(bool popup, bool mitProgramm = true)
        {
            if (UpdateLaeuft())
            {
                if (popup) { AktLog("Prüfen übersprungen: ein Update läuft gerade."); return; }
                throw new Exception(UpdateLaeuftText);
            }
            var updates = SucheAktualisierungen(mitProgramm);
            var a = AktEinst();
            string modus = Str(a, "modus") ?? "fragen";
            var d = new Dictionary<string, object> { { "geprueft", DateTime.Now.ToString("yyyy-MM-dd HH:mm") }, { "updates", updates }, { "freigegeben", false } };
            bool ok = false;
            bool getaktet = Environment.GetEnvironmentVariable("OW_GETAKTET") == "1";
            if (updates.Count > 0)
            {
                // Automatisch nie über getaktete Verbindungen; beim Nachfragen entscheidet der Nutzer
                if (modus == "auto") ok = !getaktet;
                else if (popup)
                {
                    int wahl = FrageNutzer(updates, getaktet);
                    ok = wahl > 0;
                    // Gilt nur für diesen Lauf, wird nicht gespeichert
                    if (ok && getaktet) getaktetErlaubt = true;
                    if (wahl == 2) KuenftigAutomatisch();
                }
            }
            d["freigegeben"] = ok;
            // Inzwischen ein Update gestartet (die Suche dauert)? Dann nicht schreiben. Die Sperre hält beim Schreiben
            // ein gleichzeitig startendes Update fern.
            var sperre = UpdateSperre();
            bool belegt = sperre == null;
            if (!belegt) lock (Lk) belegt = worker != null && worker.IsAlive && !warteschlange;
            if (belegt)
            {
                UpdateSperreFrei(sperre);
                if (popup) { AktLog("Prüfergebnis verworfen: ein Update läuft gerade."); return; }
                throw new Exception(UpdateLaeuftText);
            }
            try
            {
                SicherSchreiben(AktDatei, Json.Serialize(d));
                if (ok) File.WriteAllText(AktFlag, DateTime.Now.ToString("s")); else try { File.Delete(AktFlag); } catch { }
            }
            finally { UpdateSperreFrei(sperre); }
            AktLog(updates.Count == 0 ? "Geprüft: keine neuen Daten." : "Geprüft: " + updates.Count + " Aktualisierung(en)" + (ok ? ", freigegeben." : getaktet ? ", getaktete Verbindung, später." : ", nicht freigegeben."));
            // Sofort-Modus: gleich im selben Hintergrundprozess herunterladen
            if (ok && popup && Str(a, "wann") != "leerlauf") LadenImLeerlauf();
        }

        // Ist die aktuelle Internetverbindung getaktet (z. B. Handy-Hotspot)?
        static Dictionary<string, object> Verbindung()
        {
            var erg = new Dictionary<string, object> { { "getaktet", false }, { "typ", "unbekannt" }, { "name", "" }, { "online", true } };
            try
            {
                string ps = "$null=[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime];" +
                    "$p=[Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile();" +
                    "if($p){$c=$p.GetConnectionCost(); Write-Output ($c.NetworkCostType.ToString()+'|'+$c.Roaming+'|'+$c.ApproachingDataLimit+'|'+$p.ProfileName)} else {Write-Output 'Keine'}";
                string aus = Ausfuehren("powershell.exe", "-NoProfile -NonInteractive -Command \"" + ps.Replace("\"", "\\\"") + "\"", 20000).Trim();
                if (aus == "Keine") { erg["online"] = false; return erg; }
                var t = aus.Split('|');
                erg["typ"] = t[0];
                erg["name"] = t.Length > 3 ? t[3] : "";
                erg["getaktet"] = t[0] == "Fixed" || t[0] == "Variable" || (t.Length > 1 && t[1] == "True");
            }
            catch (Exception e) { erg["fehler"] = e.Message; }
            return erg;
        }

        // Fenster nach der wöchentlichen Prüfung. 0 = Später, 1 = Herunterladen, 2 = Immer automatisch.
        // Eigenes Fenster statt MessageBox, weil die keine eigenen Knopfbeschriftungen kennt. Ohne Typen aus
        // System.Drawing (Größen, Schriften), damit die Referenzliste in start.ps1/aktualisieren.ps1 reicht.
        static int FrageNutzer(List<Dictionary<string, object>> updates, bool getaktet)
        {
            int wahl = 0;
            var t = new Thread(delegate ()
            {
                long bytes = updates.Sum(u => (long)Num(u, "bytes"));
                string liste = string.Join("\n", updates.Select(u => "  •  " + Str(u, "titel")));
                bool leerlauf = Str(AktEinst(), "wann") == "leerlauf";
                string text = "Für Fieldbook gibt es neue Daten:\n\n" + liste + "\n\nGröße insgesamt: ca. " + (bytes / 1e9).ToString("0.0", CultureInfo.GetCultureInfo("de-DE")) + " GB\n\n" +
                    (getaktet ? "ACHTUNG: Du bist gerade mit einer getakteten Verbindung verbunden (z. B. Handy-Hotspot). Das Herunterladen kann dein Datenvolumen verbrauchen.\n\n" : "") +
                    (leerlauf ? "Herunterladen? Das passiert nur, wenn der Computer am Strom hängt und gerade nicht benutzt wird."
                              : "Jetzt herunterladen? Das läuft mit niedriger Priorität im Hintergrund, du kannst normal weiterarbeiten.") +
                    "\n\n„Immer automatisch“ lädt neue Daten künftig ohne Nachfrage.\nIn Fieldbook kannst du das unter Einstellungen wieder auf „Vorher fragen“ stellen.";
                System.Windows.Forms.Application.EnableVisualStyles();
                var form = new System.Windows.Forms.Form {
                    Text = "Fieldbook: neue Daten", FormBorderStyle = System.Windows.Forms.FormBorderStyle.FixedDialog,
                    MaximizeBox = false, MinimizeBox = false, ShowIcon = false, TopMost = true,
                    StartPosition = System.Windows.Forms.FormStartPosition.CenterScreen,
                    AutoSize = true, AutoSizeMode = System.Windows.Forms.AutoSizeMode.GrowAndShrink };
                var spalte = new System.Windows.Forms.FlowLayoutPanel {
                    FlowDirection = System.Windows.Forms.FlowDirection.TopDown, AutoSize = true, WrapContents = false,
                    AutoSizeMode = System.Windows.Forms.AutoSizeMode.GrowAndShrink, Padding = new System.Windows.Forms.Padding(16) };
                spalte.Controls.Add(new System.Windows.Forms.Label { Text = text, AutoSize = true, Margin = new System.Windows.Forms.Padding(0, 0, 0, 16) });
                var reihe = new System.Windows.Forms.FlowLayoutPanel {
                    FlowDirection = System.Windows.Forms.FlowDirection.LeftToRight, AutoSize = true, WrapContents = false,
                    AutoSizeMode = System.Windows.Forms.AutoSizeMode.GrowAndShrink, Anchor = System.Windows.Forms.AnchorStyles.Right, Margin = new System.Windows.Forms.Padding(0) };
                Func<string, int, System.Windows.Forms.Button> knopf = (beschriftung, wert) =>
                {
                    var b = new System.Windows.Forms.Button { Text = beschriftung, AutoSize = true, Padding = new System.Windows.Forms.Padding(8, 2, 8, 2), Margin = new System.Windows.Forms.Padding(8, 0, 0, 0) };
                    b.Click += delegate { wahl = wert; form.Close(); };
                    reihe.Controls.Add(b);
                    return b;
                };
                var herunterladen = knopf("Herunterladen", 1);
                knopf("Immer automatisch", 2);
                var spaeter = knopf("Später", 0);
                spalte.Controls.Add(reihe);
                form.Controls.Add(spalte);
                form.AcceptButton = herunterladen;
                form.CancelButton = spaeter;
                // Aus der Windows-Aufgabe heraus nach vorne holen
                form.Shown += delegate { form.Activate(); };
                System.Windows.Forms.Application.Run(form);
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            return wahl;
        }

        // Knopf „Immer automatisch“: Einstellung auf automatisch stellen. Läuft in der Windows-Aufgabe, also frisch
        // aus der Datei lesen; läuft Fieldbook gerade, bekommt es die Änderung auch mit (sonst überschriebe es sie später).
        static void KuenftigAutomatisch()
        {
            try
            {
                einst = LadeJson(Path.Combine(Daten, "einstellungen.json")) ?? einst;
                var a = AktEinst() ?? new Dictionary<string, object> { { "an", true } };
                a["modus"] = "auto";
                einst["aktualisierung"] = a;
                SpeichereEinst();
                AktLog("Künftig automatisch (im Fenster gewählt).");
                try
                {
                    int port = 8090;
                    try { int.TryParse(File.ReadAllText(PortDatei).Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out port); } catch { }
                    if (port < 8090 || port > 8099) port = 8090;
                    var req = (HttpWebRequest)WebRequest.Create("http://localhost:" + port + "/api/aktualisierung");
                    req.Method = "POST";
                    req.Proxy = null;
                    req.Timeout = 3000;
                    req.ContentType = "application/json; charset=utf-8";
                    byte[] b = Utf8.GetBytes(Json.Serialize(a));
                    req.ContentLength = b.Length;
                    using (var s = req.GetRequestStream()) s.Write(b, 0, b.Length);
                    using (req.GetResponse()) { }
                }
                catch { }
            }
            catch (Exception e) { AktLog("Automatisch einstellen: " + e.Message); }
        }

        // FSCTL_SET_SPARSE (0x900C4) für Kartendateien, siehe KarteVersuch
        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool DeviceIoControl(Microsoft.Win32.SafeHandles.SafeFileHandle h, uint code, IntPtr inBuf, uint inSize, IntPtr outBuf, uint outSize, out uint ret, IntPtr overlapped);

        [StructLayout(LayoutKind.Sequential)]
        struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
        [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

        static bool NutzerAktiv()
        {
            var li = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
            if (!GetLastInputInfo(ref li)) return false;
            return unchecked((uint)Environment.TickCount - li.dwTime) < 30000;
        }

        static bool AufAkku()
        {
            try { return System.Windows.Forms.SystemInformation.PowerStatus.PowerLineStatus == System.Windows.Forms.PowerLineStatus.Offline; } catch { return false; }
        }

        // Im eigenen Prozess (Windows-Aufgabe): lädt, bis alles fertig ist oder jemand den Computer benutzt
        static void LadenImLeerlauf()
        {
            if (!File.Exists(AktFlag)) return;
            var d = LadeJson(AktDatei);
            if (!Bool(d, "freigegeben")) return;
            // Erlaubnis aus älteren Versionen nicht weiter gelten lassen und nicht wieder speichern
            d.Remove("getaktetErlaubt");
            if (Environment.GetEnvironmentVariable("OW_GETAKTET") == "1" && !getaktetErlaubt) { AktLog("Getaktete Verbindung, Download später."); return; }
            var sperre = UpdateSperre();
            if (sperre == null) { AktLog("Ein anderer Update-Lauf ist aktiv."); return; }
            try
            {
                bool nurLeerlauf = Str(AktEinst(), "wann") == "leerlauf";
                try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.Idle; } catch { }
                Aufraeumen();
                bool fertig = false;
                string grund = null;
                var waechter = new Thread(delegate ()
                {
                    int runden = 0;
                    while (!fertig)
                    {
                        if (nurLeerlauf && NutzerAktiv()) grund = "Computer wird benutzt";
                        else if (nurLeerlauf && AufAkku()) grund = "Akkubetrieb";
                        // Alle 5 min (150 × 2 s): inzwischen auf eine getaktete Verbindung gewechselt (z. B. Handy-Hotspot)?
                        else if (!getaktetErlaubt && ++runden >= 150) { runden = 0; if (GetaktetJetzt() && !fertig) grund = "Getaktete Verbindung"; }
                        if (grund != null)
                        {
                            abbrechen = true;
                            AlleDownloadsStoppen();
                            return;
                        }
                        Thread.Sleep(2000);
                    }
                }) { IsBackground = true };
                waechter.Start();
                AktLog("Herunterladen gestartet.");
                int erledigt = UpdatesAusfuehren(d, null);
                fertig = true;
                if (grund != null) AktLog("Pausiert (" + grund + "). Geht beim nächsten Leerlauf weiter.");
                else if (Arr(d, "updates").Length == 0) { try { File.Delete(AktFlag); } catch { } AktLog("Aktualisierung abgeschlossen."); }
                else AktLog(erledigt + " erledigt, Rest beim nächsten Mal.");
            }
            finally { UpdateSperreFrei(sperre); }
        }

        // Im Programm: Knopf "Jetzt herunterladen" in den Einstellungen
        static Dictionary<string, object> UpdatesJetztLaden()
        {
            lock (Lk)
            {
                if (worker != null && worker.IsAlive) return new Dictionary<string, object> { { "fehler", "Es läuft bereits ein Download." } };
                var d = LadeJson(AktDatei);
                if (d == null || Arr(d, "updates").Length == 0) return new Dictionary<string, object> { { "fehler", "Keine Aktualisierungen gefunden." } };
                // Läuft gerade eine Windows-Aufgabe? Dann nicht parallel laden.
                var probe = UpdateSperre();
                if (probe == null) return new Dictionary<string, object> { { "fehler", "Im Hintergrund läuft schon ein Update." } };
                UpdateSperreFrei(probe);
                abbrechen = false;
                warteschlange = false;
                jobs = new List<Job>();
                worker = new Thread(delegate ()
                {
                    // Die Sperre gehört dem Thread, der sie hält: hier erneut nehmen
                    var sperre = UpdateSperre();
                    if (sperre == null) { foreach (var jb in jobs) { jb.Status = "fehler"; jb.Fehler = "Im Hintergrund läuft schon ein Update."; } return; }
                    try
                    {
                        UpdatesAusfuehren(d, jobs);
                        if (Arr(d, "updates").Length == 0) try { File.Delete(AktFlag); } catch { }
                        Aufraeumen();
                    }
                    finally { UpdateSperreFrei(sperre); }
                    // Neue Fieldbook-Version bereitgelegt? Dann gleich neu starten, das spielt sie ein.
                    if (BereitVersion() != null) { Neustart(); return; }
                    if (beenden) return; // Fieldbook wird gerade beendet: nichts mehr starten
                    StarteKiwix();
                    StarteRouting();
                    if (llmStatus == "bereit") StarteSuchhilfe();
                }) { IsBackground = true };
                foreach (var o in Arr(d, "updates")) { var u = (Dictionary<string, object>)o; jobs.Add(new Job { Titel = Str(u, "titel"), Gesamt = (long)Num(u, "bytes") }); }
                worker.Start();
                return new Dictionary<string, object> { { "ok", true } };
            }
        }

        static DriveInfo DatenLaufwerk()
        {
            try { var di = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(Daten))); return di.IsReady ? di : null; }
            catch { return null; } // z. B. Netzlaufwerk: dann nicht prüfen
        }

        // FAT32 (oft bei USB-Sticks) kann keine Dateien über 4 GB speichern
        static string Fat32Problem(Job j)
        {
            if (j.Gesamt <= 4294967295L) return null;
            var di = DatenLaufwerk();
            string format = "";
            try { if (di != null) format = di.DriveFormat ?? ""; } catch { }
            if (!format.StartsWith("FAT", StringComparison.OrdinalIgnoreCase)) return null;
            return "„" + j.Titel + "“ ist größer als 4 GB, und dieses Laufwerk (FAT32) kann so große Dateien nicht speichern. Bitte Fieldbook auf ein Laufwerk mit NTFS oder exFAT kopieren.";
        }

        // Vor dem Einreihen: FAT32-Grenze und freier Platz für alles, was noch zu laden ist
        static string LaufwerkPruefen(List<Job> neu, List<Job> bisher)
        {
            foreach (var j in neu) { string fat = Fat32Problem(j); if (fat != null) return fat; }
            var di = DatenLaufwerk();
            if (di == null) return null;
            long frei;
            try { frei = di.AvailableFreeSpace; } catch { return null; }
            long noetig = 0;
            foreach (var j in neu)
            {
                if (j.Gesamt <= 0) continue;
                long schon = 0;
                try { string part = j.Ziel + ".part"; if (j.Ziel != null && Path.IsPathRooted(j.Ziel) && File.Exists(part)) schon = new FileInfo(part).Length; } catch { }
                noetig += Math.Max(0, j.Gesamt - schon);
            }
            if (bisher != null)
                foreach (var j in bisher.Where(x => x.Status == "wartet" || x.Status == "laeuft"))
                    if (j.Gesamt > 0) noetig += Math.Max(0, j.Gesamt - j.Bytes);
            if (noetig == 0) return null;
            noetig += 200000000L; // etwas Reserve für Windows
            if (frei >= noetig) return null;
            var de = CultureInfo.GetCultureInfo("de-DE");
            return "Auf dem Laufwerk ist nicht genug Platz frei (nötig etwa " + (noetig / 1e9).ToString("0.0", de) + " GB, frei " + (frei / 1e9).ToString("0.0", de) + " GB).";
        }

        // Neue Versionen liegen kurz neben den alten (Karten als .neu.pmtiles, Pakete bis die alte gelöscht ist).
        // Reicht der Platz nicht, das Update auslassen; es bleibt in der Liste und wird später erneut versucht.
        static void PlatzPruefen(Job j)
        {
            string fat = Fat32Problem(j);
            if (fat != null) throw new Exception(fat);
            if (j.Gesamt <= 0) return;
            long frei;
            try { frei = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(Daten))).AvailableFreeSpace; } catch { return; }
            long noetig = (long)(j.Gesamt * 1.05) + 1000000000L; // etwas Reserve für Windows
            if (frei < noetig)
                throw new Exception("Nicht genug Platz: nötig sind etwa " + (noetig / 1e9).ToString("0.0", CultureInfo.GetCultureInfo("de-DE")) + " GB, frei sind "
                    + (frei / 1e9).ToString("0.0", CultureInfo.GetCultureInfo("de-DE")) + " GB. Das Update wird später erneut versucht.");
        }

        static int UpdatesAusfuehren(Dictionary<string, object> d, List<Job> anzeige)
        {
            var offen = Arr(d, "updates").Select(x => (Dictionary<string, object>)x).ToList();
            int erledigt = 0, i = 0;
            ladeLimit = (long)Num(AktEinst(), "mbit") * 125000;
            try {
            foreach (var u in offen.ToList())
            {
                var j = anzeige != null && i < anzeige.Count ? anzeige[i] : new Job();
                i++;
                if (abbrechen || beenden) break;
                j.Art = Str(u, "art"); j.Url = Str(u, "url"); j.Ziel = Str(u, "ziel"); j.Extra = Str(u, "extra"); j.Gesamt = (long)Num(u, "bytes"); j.Titel = Str(u, "titel");
                j.Status = "laeuft";
                try
                {
                    PlatzPruefen(j);
                    if (j.Art == "zim")
                    {
                        Herunterladen(j, j.Url, j.Ziel);
                        // Im Programm die Bibliothek gleich wieder starten (sonst bliebe sie bis zum Ende aller Updates aus);
                        // in der Windows-Aufgabe gehört die Bibliothek dem laufenden Fieldbook
                        lock (KiwixLk)
                        {
                            try { AlteVersionenLoeschen(j); } catch { }
                            if (anzeige != null) StarteKiwix();
                        }
                    }
                    else if (j.Art == "route") Herunterladen(j, j.Url, j.Ziel + ".neu");
                    else if (j.Art == "karte") KarteLaden(j);
                    else if (j.Art == "datei") { Directory.CreateDirectory(Path.GetDirectoryName(j.Ziel)); Herunterladen(j, j.Url, j.Ziel); }
                    else if (j.Art == "programm" && j.Ziel == "piper-py") { if (PiperPyPfad() == null) PiperPyLaden(j); }
                    else if (j.Art == "programm-update") { var t = (j.Extra ?? "|").Split('|'); ProgrammUpdateLaden(j, j.Url, t[0], t.Length > 1 ? t[1] : ""); }
                    j.Status = "fertig";
                    offen.Remove(u);
                    erledigt++;
                    d["updates"] = offen.ToArray();
                    SicherSchreiben(AktDatei, Json.Serialize(d));
                    StatusCacheLeeren();
                    AktLog("Fertig: " + j.Titel);
                }
                catch (Exception e) { bool gestoppt = abbrechen || beenden; j.Status = gestoppt ? "abgebrochen" : "fehler"; j.Fehler = e.Message; if (!gestoppt) { AktLog("Fehler bei " + j.Titel + ": " + e.Message); StatFehler("aktualisierung", j.Art + " " + j.Titel + ": " + e.Message); } }
            }
            } finally { ladeLimit = 0; }
            // Wegedaten lassen sich nur tauschen, wenn BRouter sie nicht offen hat. Im Programm startet der Aufrufer
            // (UpdatesJetztLaden) die Routenplanung danach neu; in der Windows-Aufgabe tauscht der nächste Start.
            if (anzeige != null && !beenden)
                try { if (Directory.GetFiles(Path.Combine(Daten, "routen"), "*.rd5.neu").Length > 0) StoppeRouting(); }
                catch (Exception e) { Log("Routenplanung stoppen: " + e.Message); }
            Aufraeumen();
            return erledigt;
        }

        // Fertige neue Dateien einsetzen und alte Versionen löschen (beim Start und nach Updates)
        // beimStart: nur beim Start von Fieldbook, dann lädt sicher keine Karte (Aufraeumen läuft auch in der Windows-Aufgabe)
        // Halbe Downloads (.part), die nie fertig werden: eine neuere Ausgabe des Pakets ist schon installiert,
        // oder die Datei wurde seit 30 Tagen nicht mehr angefasst (die Adresse gibt es dann meist nicht mehr).
        // Läuft nur beim Start, wenn noch kein Download aktiv ist.
        static void PartResteAufraeumen()
        {
            try
            {
                var installiert = new Dictionary<string, string>();   // Paket ohne Datum → neuestes Datum
                foreach (var z in Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim"))
                {
                    var m = Regex.Match(Path.GetFileName(z), @"^(.+)_(\d{4}-\d{2})[a-z]?\.zim$");
                    if (!m.Success) continue;
                    string alt;
                    if (!installiert.TryGetValue(m.Groups[1].Value, out alt) || string.CompareOrdinal(m.Groups[2].Value, alt) > 0)
                        installiert[m.Groups[1].Value] = m.Groups[2].Value;
                }
                var ordner = new[] { "wissen", "modelle", Path.Combine("cache", "update") };
                foreach (var o in ordner)
                {
                    string pfad = Path.Combine(Daten, o);
                    if (!Directory.Exists(pfad)) continue;
                    foreach (var f in Directory.GetFiles(pfad, "*.part", SearchOption.AllDirectories))
                    {
                        bool weg = (DateTime.Now - File.GetLastWriteTime(f)).TotalDays > 30;
                        var m = Regex.Match(Path.GetFileName(f), @"^(.+)_(\d{4}-\d{2})[a-z]?\.zim\.part$");
                        string da;
                        if (m.Success && installiert.TryGetValue(m.Groups[1].Value, out da) && string.CompareOrdinal(da, m.Groups[2].Value) >= 0) weg = true;
                        if (!weg) continue;
                        try { File.Delete(f); Log("Unfertiger Download gelöscht: " + Path.GetFileName(f)); } catch { }
                    }
                }
            }
            catch (Exception e) { Log("Aufräumen (Download-Reste): " + e.Message); }
        }

        static void Aufraeumen(bool beimStart = false)
        {
            try
            {
                foreach (var f in Directory.GetFiles(Path.Combine(Daten, "routen"), "*.rd5.neu"))
                {
                    string ziel = f.Substring(0, f.Length - 4);
                    try { if (File.Exists(ziel)) File.Delete(ziel); File.Move(f, ziel); } catch { }
                }
            }
            catch (Exception e) { Log("Aufräumen (Wegedaten): " + e.Message); }
            try
            {
                foreach (var f in Directory.GetFiles(Path.Combine(Daten, "karten"), "*.neu.pmtiles"))
                {
                    string ziel = f.Replace(".neu.pmtiles", ".pmtiles");
                    try { if (File.Exists(ziel)) File.Delete(ziel); File.Move(f, ziel); } catch { }
                }
                // Halbe Karten von einem abgebrochenen Download (oft mehrere GB)
                if (beimStart)
                    foreach (var f in Directory.GetFiles(Path.Combine(Daten, "karten"), "*.tmp.pmtiles"))
                        try { File.Delete(f); Log("Unfertige Karte gelöscht: " + Path.GetFileName(f)); } catch { }
            }
            catch (Exception e) { Log("Aufräumen (Karten): " + e.Message); }
            if (beimStart) PartResteAufraeumen();
            try
            {
                // Von jedem Wissenspaket nur die neueste Ausgabe behalten
                var gruppen = new Dictionary<string, List<string>>();
                foreach (var f in Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim"))
                {
                    var m = Regex.Match(Path.GetFileName(f), @"^(.+)_\d{4}-\d{2}[a-z]?\.zim$");
                    if (!m.Success) continue;
                    if (!gruppen.ContainsKey(m.Groups[1].Value)) gruppen[m.Groups[1].Value] = new List<string>();
                    gruppen[m.Groups[1].Value].Add(f);
                }
                foreach (var g in gruppen.Values.Where(x => x.Count > 1))
                {
                    string neueste = g.OrderBy(x => Path.GetFileName(x), StringComparer.Ordinal).Last();
                    foreach (var f in g) if (f != neueste) try { File.Delete(f); } catch { }
                }
            }
            catch (Exception e) { Log("Aufräumen (Pakete): " + e.Message); }
            StatusCacheLeeren();
        }

        // ------------------------------------------------------------------ Desktop-Symbol

        static string DesktopLnk() { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Fieldbook.lnk"); }

        static Dictionary<string, object> DesktopSymbol(bool an)
        {
            try
            {
                if (an)
                {
                    string exe = Path.Combine(Root, "Fieldbook.exe");
                    string ziel = File.Exists(exe) ? exe : Path.Combine(AppDir, "Start.bat");
                    string symbol = File.Exists(exe) ? exe : Path.Combine(Environment.SystemDirectory, "imageres.dll");
                    Func<string, string> q = s => "'" + s.Replace("'", "''") + "'";
                    string ps = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut(" + q(DesktopLnk()) + ");" +
                                "$s.TargetPath=" + q(ziel) + ";$s.WorkingDirectory=" + q(Path.GetDirectoryName(ziel)) + ";" +
                                "$s.IconLocation=" + q(symbol + ",0") + ";$s.Description='Fieldbook starten';$s.Save()";
                    Ausfuehren("powershell.exe", "-NoProfile -NonInteractive -Command \"" + ps + "\"", 20000);
                }
                else if (File.Exists(DesktopLnk())) File.Delete(DesktopLnk());
                lock (Lk) { einst["desktopSymbol"] = an; einst["desktopPfad"] = Root; SpeichereEinst(); }
                return new Dictionary<string, object> { { "ok", true }, { "an", an }, { "vorhanden", File.Exists(DesktopLnk()) } };
            }
            catch (Exception e) { return new Dictionary<string, object> { { "fehler", e.Message }, { "vorhanden", File.Exists(DesktopLnk()) } }; }
        }

        // Ordner verschoben? Dann zeigt das Desktop-Symbol ins Leere: neu anlegen
        static void DesktopSymbolPruefen()
        {
            if (Bool(einst, "desktopSymbol") && (Str(einst, "desktopPfad") != Root || !File.Exists(DesktopLnk()))) DesktopSymbol(true);
        }

        // „Start aus dem Browser“ (Einstellungen, aus bis man es einschaltet): trägt die Adresse fieldbook://start für Windows
        // ein (nur für diesen Benutzer, ohne Administratorrechte). Damit startet ein offener Fieldbook-Tab Fieldbook, wenn es
        // nicht läuft (Knopf „Fieldbook starten“; der Browser fragt vorher). Fieldbook.exe startet dann ohne neuen Tab.
        // Ausschalten entfernt den Eintrag wieder. Die README verspricht, dass Fieldbook sonst nichts an Windows ändert.
        const string ProtokollSchluessel = @"Software\Classes\fieldbook";
        static string ProtokollBefehl() { return "\"" + Path.Combine(Root, "Fieldbook.exe") + "\" \"%1\""; }
        static string ProtokollEingetragen()
        {
            using (var k = Registry.CurrentUser.OpenSubKey(ProtokollSchluessel + @"\shell\open\command"))
                return k == null ? null : k.GetValue("") as string;
        }

        static Dictionary<string, object> BrowserStart(bool an)
        {
            try
            {
                string exe = Path.Combine(Root, "Fieldbook.exe");
                if (an)
                {
                    if (!File.Exists(exe)) return new Dictionary<string, object> { { "fehler", "Fieldbook.exe fehlt im Fieldbook-Ordner." } };
                    using (var k = Registry.CurrentUser.CreateSubKey(ProtokollSchluessel))
                    {
                        k.SetValue("", "URL:Fieldbook");
                        k.SetValue("URL Protocol", "");
                        using (var s = k.CreateSubKey("DefaultIcon")) s.SetValue("", "\"" + exe + "\",0");
                        using (var c = k.CreateSubKey(@"shell\open\command")) c.SetValue("", ProtokollBefehl());
                    }
                }
                // Nur den eigenen Eintrag entfernen, nicht den eines anderen Fieldbook-Ordners
                else if (ProtokollEingetragen() == ProtokollBefehl()) Registry.CurrentUser.DeleteSubKeyTree(ProtokollSchluessel, false);
                lock (Lk) { einst["browserStart"] = an; SpeichereEinst(); }
                return new Dictionary<string, object> { { "ok", true }, { "an", an } };
            }
            catch (Exception e) { return new Dictionary<string, object> { { "fehler", e.Message } }; }
        }

        // Eingeschaltet, aber der Ordner wurde verschoben (oder ein anderes Fieldbook hat sich eingetragen): neu eintragen
        static void ProtokollPruefen()
        {
            if (Bool(einst, "browserStart") && ProtokollEingetragen() != ProtokollBefehl()) BrowserStart(true);
        }

        // ------------------------------------------------------------------ Programm-Update (Fieldbook selbst)
        // Eine neue Version wird heruntergeladen, per Prüfsumme geprüft und unter daten\cache\update\bereit
        // abgelegt. Eingespielt wird sie von start.ps1 beim nächsten Start, bevor der Server geladen wird.

        static HttpListener listener;
        static volatile bool neustartAktiv;
        static Dictionary<string, object> progUpdate;

        static string UpdateOrdner { get { return Path.Combine(Daten, "cache", "update"); } }
        static string UpdateBereit { get { return Path.Combine(UpdateOrdner, "bereit"); } }

        // Im Git-Arbeitsordner nie überschreiben
        static bool IstEntwicklungsordner() { return Directory.Exists(Path.Combine(Root, ".git")); }

        static string UpdateApi()
        {
            var k = LadeJson(Path.Combine(Config, "fieldbook.json"));
            string api = Str(k, "updateApi");
            string repo = Str(k, "github");
            if (string.IsNullOrEmpty(api) && !string.IsNullOrEmpty(repo)) api = "https://api.github.com/repos/" + repo.Trim('/') + "/releases/latest";
            return string.IsNullOrEmpty(api) ? null : api;
        }

        static bool VersionNeuer(string a, string b)
        {
            System.Version va, vb;
            return System.Version.TryParse(a, out va) && System.Version.TryParse(b, out vb) && va > vb;
        }

        static string BereitVersion()
        {
            try
            {
                string f = Path.Combine(UpdateBereit, "version.txt");
                return File.Exists(f) ? File.ReadAllText(f).Trim() : null;
            }
            catch { return null; }
        }

        // GitHub erlaubt ohne Anmeldung nur 60 Anfragen pro Stunde und IP: die Antwort 6 h merken.
        // frisch (Einstellungen, Knopf „Nach Updates suchen“) fragt neu, höchstens einmal pro Minute.
        static readonly object ProgUpdateLk = new object();
        static Dictionary<string, object> progRelease;
        static string progReleaseApi;
        static DateTime progReleaseZeit;

        static Dictionary<string, object> ProgrammUpdateSuchen() { return ProgrammUpdateSuchen(false); }

        static Dictionary<string, object> ReleaseHolen(string api, bool frisch)
        {
            lock (ProgUpdateLk)
            {
                double alter = (DateTime.UtcNow - progReleaseZeit).TotalSeconds;
                if (progRelease != null && progReleaseApi == api && alter >= 0 && alter < (frisch ? 60 : 6 * 3600)) return progRelease;
                var rel = Json.DeserializeObject(HoleText(api, 20000)) as Dictionary<string, object>;
                if (rel != null) { progRelease = rel; progReleaseApi = api; progReleaseZeit = DateTime.UtcNow; }
                return rel;
            }
        }

        static Dictionary<string, object> ProgrammUpdateSuchen(bool frisch)
        {
            var erg = new Dictionary<string, object>
            {
                {"version", Version}, {"verfuegbar", false}, {"bereit", BereitVersion()},
                {"eingerichtet", UpdateApi() != null}, {"entwicklung", IstEntwicklungsordner()}
            };
            string api = UpdateApi();
            if (api == null) return erg;
            var rel = ReleaseHolen(api, frisch);
            string neu = (Str(rel, "tag_name") ?? "").TrimStart('v', 'V');
            string zip = null, zipName = null, sha = null;
            long bytes = 0;
            var shas = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            foreach (var o in Arr(rel, "assets"))
            {
                var a = (Dictionary<string, object>)o;
                string n = Str(a, "name") ?? "";
                if (n.EndsWith(".zip.sha256", StringComparison.OrdinalIgnoreCase)) shas[n] = Str(a, "browser_download_url");
                // Fieldbook-<version>.zip bevorzugen, falls weitere ZIP-Dateien im Release liegen
                else if (n.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) && n.StartsWith("Fieldbook", StringComparison.OrdinalIgnoreCase)
                    && (zip == null || n.Equals("Fieldbook-" + neu + ".zip", StringComparison.OrdinalIgnoreCase))) { zip = Str(a, "browser_download_url"); zipName = n; bytes = (long)Num(a, "size"); }
            }
            // Nur die Prüfsumme genau dieser ZIP verwenden
            if (zipName != null) shas.TryGetValue(zipName + ".sha256", out sha);
            erg["neu"] = neu;
            erg["titel"] = Str(rel, "name") ?? ("Fieldbook " + neu);
            erg["notizen"] = Str(rel, "body") ?? "";
            erg["datum"] = Str(rel, "published_at") ?? "";
            erg["zip"] = zip; erg["sha"] = sha; erg["bytes"] = bytes;
            erg["verfuegbar"] = zip != null && VersionNeuer(neu, Version) && BereitVersion() != neu;
            // Ist genau diese Version beim Einspielen schon einmal gescheitert (start.ps1 merkt sie sich),
            // nicht jede Woche neu laden; eine neuere Version wird wieder angeboten
            try
            {
                string fehlDatei = Path.Combine(Daten, "cache", "update", "fehlgeschlagen.txt");
                if (Bool(erg, "verfuegbar") && File.Exists(fehlDatei) && File.ReadAllText(fehlDatei).Trim() == neu)
                {
                    erg["verfuegbar"] = false;
                    erg["fehlgeschlagen"] = neu;
                    AktLog("Programm-Update " + neu + " übersprungen: Das Einspielen ist schon einmal gescheitert.");
                }
            }
            catch { }
            progUpdate = erg;
            return erg;
        }

        // Herunterladen, prüfen, entpacken und bereitlegen
        static void ProgrammUpdateLaden(Job j, string zipUrl, string shaUrl, string neu)
        {
            if (IstEntwicklungsordner()) throw new Exception("Im Entwicklungsordner wird Fieldbook nicht automatisch aktualisiert.");
            // Ohne Prüfsumme lässt sich nicht feststellen, ob das Paket vollständig und echt ist
            if (string.IsNullOrEmpty(shaUrl)) throw new Exception("Zu diesem Update fehlt die Prüfsumme, es wird deshalb nicht eingespielt.");
            // bereit\gestartet: start.ps1 spielt gerade ein oder wurde dabei unterbrochen. Dann bereit nicht ersetzen.
            string marke = Path.Combine(UpdateBereit, "gestartet");
            const string einspielen = "Das vorige Update wird gerade eingespielt oder wurde unterbrochen. Bitte Fieldbook neu starten, dann erneut versuchen.";
            if (File.Exists(marke)) { AktLog("Programm-Update übersprungen: bereit\\gestartet vorhanden."); throw new Exception(einspielen); }
            Directory.CreateDirectory(UpdateOrdner);
            string zip = Path.Combine(UpdateOrdner, "Fieldbook-" + neu + ".zip");
            Herunterladen(j, zipUrl, zip);
            if (!string.IsNullOrEmpty(shaUrl))
            {
                string soll = HoleText(shaUrl, 20000).Trim().Split(' ', '\t', '\r', '\n')[0].ToLowerInvariant();
                string ist;
                using (var s = File.OpenRead(zip))
                using (var h = System.Security.Cryptography.SHA256.Create())
                    ist = BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
                if (soll != ist) { File.Delete(zip); throw new Exception("Die Prüfsumme stimmt nicht. Das Update wurde verworfen."); }
            }
            string tmp = Path.Combine(UpdateOrdner, "entpackt");
            if (Directory.Exists(tmp)) Directory.Delete(tmp, true);
            ZipFile.ExtractToDirectory(zip, tmp);
            string quelle = Directory.Exists(Path.Combine(tmp, "app")) ? tmp
                : Directory.GetDirectories(tmp).FirstOrDefault(d => Directory.Exists(Path.Combine(d, "app")));
            if (quelle == null || !File.Exists(Path.Combine(quelle, "app", "Server.cs")) || !File.Exists(Path.Combine(quelle, "app", "start.ps1")))
                throw new Exception("Das Update-Paket ist unvollständig.");
            // Vor dem Verschieben schreiben: so liegt bereit nie ohne version.txt da
            File.WriteAllText(Path.Combine(quelle, "version.txt"), neu);
            if (Directory.Exists(UpdateBereit)) Directory.Delete(UpdateBereit, true);
            Directory.Move(quelle, UpdateBereit);
            try { if (Directory.Exists(tmp)) Directory.Delete(tmp, true); } catch { }
            try { File.Delete(zip); } catch { }
            AktLog("Fieldbook " + neu + " heruntergeladen und bereitgelegt.");
            try { NeuigkeitenMerken(neu); } catch (Exception e) { AktLog("Neuigkeiten merken: " + e.Message); }
        }

        // ------------------------------------------------------------------ „Was ist neu?“ nach einem Update
        // Beim ersten Start einer neuen Version zeigt die Oberfläche einmal die Seite #neu mit den Release-Notizen.
        // Die Notizen werden beim Herunterladen gemerkt (das Einspielen geschieht oft erst beim nächsten Start, vielleicht
        // ohne Internet). Fehlen sie (Update mit einer älteren Version geladen, von Hand ausgepackt), einmal bei GitHub fragen.
        static string NeuigkeitenDatei { get { return Path.Combine(UpdateOrdner, "neuigkeiten.json"); } }
        static List<Dictionary<string, object>> neuigkeitenGeholt;
        static bool neuigkeitenVersucht;

        static void NeuigkeitenBeimStart()
        {
            lock (Lk)
            {
                string vorher = Str(einst, "versionZuletzt");
                if (vorher == Version) return;
                // Leere Einstellungen = frisch ausgepackt: nichts zeigen. Bis 0.8.6 gab es versionZuletzt noch nicht.
                bool update = vorher != null ? VersionNeuer(Version, vorher) : einst.Count > 0;
                einst["versionZuletzt"] = Version;
                if (update) einst["neuigkeitenOffen"] = Version; else einst.Remove("neuigkeitenOffen");
                // Von welcher Version aus aktualisiert wurde: bei einem Sprung zeigt „Was ist neu?“ alle Versionen seitdem
                if (update && vorher != null) einst["versionVorher"] = vorher; else einst.Remove("versionVorher");
                SpeichereEinst();
                if (update) Log("Update von " + (vorher ?? "einer älteren Version") + " auf " + Version + ": Seite „Was ist neu?“ wird einmal gezeigt.");
            }
        }

        // Ein Eintrag je Version: { version, titel, notizen, datum }
        static Dictionary<string, object> NeuigkeitAusRelease(Dictionary<string, object> rel)
        {
            string v = (Str(rel, "tag_name") ?? "").TrimStart('v', 'V');
            if (v == "" || string.IsNullOrEmpty(Str(rel, "body")) || Bool(rel, "draft") || Bool(rel, "prerelease")) return null;
            return new Dictionary<string, object> {
                { "version", v }, { "titel", Str(rel, "name") ?? ("Fieldbook " + v) }, { "notizen", Str(rel, "body") }, { "datum", Str(rel, "published_at") ?? "" } };
        }

        // Alle Releases von GitHub (die neuesten 30), um übersprungene Versionen mitzunehmen
        static List<Dictionary<string, object>> NeuigkeitenListeVonGitHub()
        {
            string api = UpdateApi();
            if (api == null || !api.EndsWith("/releases/latest", StringComparison.OrdinalIgnoreCase)) return null;
            var liste = Json.DeserializeObject(HoleText(api.Substring(0, api.Length - "/latest".Length) + "?per_page=30", 15000)) as object[];
            if (liste == null) return null;
            return liste.OfType<Dictionary<string, object>>().Select(NeuigkeitAusRelease).Where(n => n != null).ToList();
        }

        // Gemerkte Notizen lesen (bis 0.8.7 lag dort nur eine einzelne Version)
        // „von“: Die Liste enthält alle Versionen nach dieser (beim Herunterladen die damals laufende)
        static List<Dictionary<string, object>> NeuigkeitenGemerkt(out string von)
        {
            von = null;
            var n = LadeJson(NeuigkeitenDatei);
            if (n == null) return new List<Dictionary<string, object>>();
            if (n.ContainsKey("versionen")) { von = Str(n, "von"); return Arr(n, "versionen").OfType<Dictionary<string, object>>().ToList(); }
            return string.IsNullOrEmpty(Str(n, "version")) ? new List<Dictionary<string, object>>() : new List<Dictionary<string, object>> { n };
        }

        static void NeuigkeitenSpeichern(List<Dictionary<string, object>> liste, string von)
        {
            Directory.CreateDirectory(UpdateOrdner);
            SicherSchreiben(NeuigkeitenDatei, Json.Serialize(new Dictionary<string, object> { { "von", von }, { "versionen", liste.ToArray() } }));
        }

        // Beim Herunterladen: Notizen aller Versionen nach der laufenden bis zur neuen merken
        // (das Einspielen geschieht vielleicht erst beim nächsten Start ohne Internet)
        static void NeuigkeitenMerken(string neu)
        {
            List<Dictionary<string, object>> liste = null;
            try { liste = NeuigkeitenListeVonGitHub(); } catch (Exception e) { AktLog("Neuigkeiten-Liste: " + e.Message); }
            if (liste == null)
            {
                Dictionary<string, object> rel;
                lock (ProgUpdateLk) rel = progRelease;
                var n = rel != null ? NeuigkeitAusRelease(rel) : null;
                liste = n != null ? new List<Dictionary<string, object>> { n } : new List<Dictionary<string, object>>();
            }
            liste = liste.Where(n => VersionNeuer(Str(n, "version"), Version) && !VersionNeuer(Str(n, "version"), neu)).ToList();
            if (liste.Count > 0) NeuigkeitenSpeichern(liste, Version);
        }

        static Dictionary<string, object> Neuigkeiten(bool nurOffen)
        {
            bool offen;
            string vorher;
            lock (Lk) { offen = Str(einst, "neuigkeitenOffen") == Version; vorher = Str(einst, "versionVorher"); }
            var erg = new Dictionary<string, object> { { "version", Version }, { "offen", offen } };
            if (nurOffen && !offen) return erg;
            // Gezeigt werden alle Versionen nach der, von der aktualisiert wurde (unbekannt: nur die laufende)
            Func<List<Dictionary<string, object>>, List<Dictionary<string, object>>> passend = l => l
                .Where(n => !VersionNeuer(Str(n, "version"), Version) && (vorher != null ? VersionNeuer(Str(n, "version"), vorher) : Str(n, "version") == Version))
                .OrderByDescending(n => { System.Version v; return System.Version.TryParse(Str(n, "version"), out v) ? v : new System.Version(0, 0); })
                .ToList();
            string von;
            var auswahl = passend(NeuigkeitenGemerkt(out von));
            // Fehlt die laufende Version (Update mit 0.8.6 oder älter geladen, von Hand ausgepackt) oder reicht die Liste
            // nicht bis zur vorigen Version zurück, einmal bei GitHub fragen
            bool vollstaendig = vorher == null || (von != null && !VersionNeuer(von, vorher));
            if (!auswahl.Any(n => Str(n, "version") == Version) || !vollstaendig)
            {
                var geholt = NeuigkeitenVonGitHub();
                if (geholt != null) auswahl = passend(geholt);
            }
            erg["vorher"] = vorher;
            erg["versionen"] = auswahl.ToArray();
            return erg;
        }

        static List<Dictionary<string, object>> NeuigkeitenVonGitHub()
        {
            lock (ProgUpdateLk)
            {
                // Höchstens einmal je Programmstart (GitHub erlaubt ohne Anmeldung nur 60 Anfragen pro Stunde)
                if (neuigkeitenVersucht) return neuigkeitenGeholt;
                neuigkeitenVersucht = true;
            }
            try
            {
                var liste = NeuigkeitenListeVonGitHub();
                if (liste == null || liste.Count == 0) return null;
                try { NeuigkeitenSpeichern(liste.Where(n => !VersionNeuer(Str(n, "version"), Version)).ToList(), "0.0"); } catch { }
                lock (ProgUpdateLk) neuigkeitenGeholt = liste;
                return liste;
            }
            catch (Exception e) { Log("Neuigkeiten bei GitHub: " + e.Message); return null; }
        }

        // Knopf "Jetzt aktualisieren" in den Einstellungen: laden, dann neu starten
        static Dictionary<string, object> ProgrammUpdateJetzt()
        {
            lock (Lk)
            {
                if (worker != null && worker.IsAlive) return new Dictionary<string, object> { { "fehler", "Es läuft bereits ein Download." } };
                if (IstEntwicklungsordner()) return new Dictionary<string, object> { { "fehler", "Das ist der Entwicklungsordner (Git). Hier wird Fieldbook nicht automatisch aktualisiert." } };
                var u = progUpdate;
                if (BereitVersion() != null && (u == null || !Bool(u, "verfuegbar"))) { Neustart(); return new Dictionary<string, object> { { "ok", true }, { "neustart", true }, { "neu", BereitVersion() } }; }
                if (u == null || !Bool(u, "verfuegbar")) return new Dictionary<string, object> { { "fehler", "Keine neue Version gefunden." } };
                var probe = UpdateSperre();
                if (probe == null) return new Dictionary<string, object> { { "fehler", "Im Hintergrund läuft schon ein Update." } };
                UpdateSperreFrei(probe);
                abbrechen = false;
                var j = new Job { Art = "programm-update", Titel = "Fieldbook " + Str(u, "neu") + " (Programm)", Gesamt = (long)Num(u, "bytes") };
                jobs = new List<Job> { j };
                warteschlange = false;
                worker = new Thread(delegate ()
                {
                    var sperre = UpdateSperre();
                    if (sperre == null) { j.Status = "fehler"; j.Fehler = "Im Hintergrund läuft schon ein Update."; return; }
                    j.Status = "laeuft";
                    bool ok = false;
                    try
                    {
                        ProgrammUpdateLaden(j, Str(u, "zip"), Str(u, "sha"), Str(u, "neu"));
                        j.Status = "fertig";
                        ok = true;
                    }
                    catch (Exception e) { j.Status = abbrechen ? "abgebrochen" : "fehler"; j.Fehler = e.Message; Log("Programm-Update: " + e.Message); StatFehler("programmupdate", e.Message); }
                    finally { UpdateSperreFrei(sperre); }
                    if (ok) Neustart();
                }) { IsBackground = true };
                worker.Start();
                return new Dictionary<string, object> { { "ok", true }, { "neu", Str(u, "neu") } };
            }
        }

        // Fieldbook beenden und sofort neu starten (die neue Instanz spielt das Update ein)
        static void Neustart()
        {
            if (neustartAktiv) return;
            neustartAktiv = true;
            new Thread(delegate ()
            {
                Thread.Sleep(1500); // Antwort an den Browser noch rausgeben
                Log("Fieldbook wird neu gestartet ...");
                // Erst die Warteschlange merken, dann stoppen: unterbrochene Downloads gehen nach dem Neustart weiter
                BeendenVorbereiten();
                AlleDownloadsStoppen(); StoppeKi(); StoppeKiwix(); StoppeRouting();
                try { File.WriteAllText(Path.Combine(Daten, "cache", "neustart"), DateTime.Now.ToString("s")); } catch { }
                string exe = Path.Combine(Root, "Fieldbook.exe");
                string ziel = File.Exists(exe) ? exe : Path.Combine(AppDir, "Start.bat");
                // Über den Explorer starten: so läuft die neue Instanz unabhängig von diesem Prozess weiter
                try { Process.Start(new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe"), "\"" + ziel + "\"") { UseShellExecute = false }); }
                catch (Exception e) { Log("Neustart fehlgeschlagen: " + e.Message); }
                try { listener.Stop(); } catch { }
                Thread.Sleep(5000);
                Environment.Exit(0);
            }).Start();
        }

        // ------------------------------------------------------------------ Routenplanung (BRouter)

        const string SegmentBasis = "https://brouter.de/brouter/segments4/";
        static Dictionary<string, long> segmente;

        // Verfügbare Wegedaten-Kacheln (5 x 5 Grad) mit Grösse
        static Dictionary<string, long> SegmentListe()
        {
            if (segmente != null) return segmente;
            var d = new Dictionary<string, long>();
            string cache = Path.Combine(Daten, "cache", "brouter-segmente.html");
            string html = null;
            try { html = HoleText(SegmentBasis, 30000); File.WriteAllText(cache, html, Utf8); }
            catch { if (File.Exists(cache)) html = File.ReadAllText(cache, Utf8); }
            if (html != null)
                foreach (Match m in Regex.Matches(html, @"href=""([EW]\d+_[NS]\d+)\.rd5"".*?(\d+)\s*$", RegexOptions.Multiline))
                    d[m.Groups[1].Value] = long.Parse(m.Groups[2].Value);
            if (d.Count > 0) segmente = d;
            return d;
        }

        static List<string> RoutenKacheln(Dictionary<string, object> r)
        {
            var b = Arr(r, "bbox").Select(x => Convert.ToDouble(x, CultureInfo.InvariantCulture)).ToArray();
            var l = new List<string>();
            if (Str(r, "routen") == "False" || b.Length < 4) return l;
            // Kacheln, die nur um wenige Kilometer angeschnitten werden (unter 0,15 Grad), weglassen
            const double rand = 0.15;
            for (int lon = (int)Math.Floor((b[0] + rand) / 5) * 5; lon < b[2] - rand; lon += 5)
                for (int lat = (int)Math.Floor((b[1] + rand) / 5) * 5; lat < b[3] - rand; lat += 5)
                    l.Add((lon < 0 ? "W" + (-lon) : "E" + lon) + "_" + (lat < 0 ? "S" + (-lat) : "N" + lat));
            return l;
        }

        static Dictionary<string, object> RoutenGroesse(string[] ids)
        {
            var liste = SegmentListe();
            long summe = 0;
            var kacheln = new HashSet<string>();
            foreach (var id in ids)
            {
                var r = Region(id.Trim());
                if (r == null) continue;
                foreach (var k in RoutenKacheln(r))
                    if (liste.ContainsKey(k) && kacheln.Add(k) && !File.Exists(Path.Combine(Daten, "routen", k + ".rd5"))) summe += liste[k];
            }
            return new Dictionary<string, object> { { "bytes", summe }, { "kacheln", kacheln.ToArray() }, { "online", liste.Count > 0 } };
        }

        static void StarteRouting()
        {
            lock (Lk)
            {
                StoppeRouting();
                string routen = Path.Combine(Daten, "routen");
                var rd5 = Directory.GetFiles(routen, "*.rd5");
                string java = ProgrammPfad("java"), jar = ProgrammPfad("brouter");
                if (rd5.Length == 0 || java == null || jar == null) return;
                string profile = Path.Combine(Path.GetDirectoryName(jar), "profiles2");
                // maxRunningTime: BRouter bricht sonst nach 60 s ab; Wuppertal–Nordschweden mit dem Auto braucht gut 2 Minuten,
                // auf schwachen Laptops mehr.
                // Nur eine Berechnung gleichzeitig: Eine neue Anfrage bricht die laufende ab. So rechnet eine verworfene
                // Route nicht minutenlang weiter (routen.js schickt beim Abbrechen eine Mini-Anfrage hinterher).
                string args = "-DmaxRunningTime=600 -Xmx512m -Xms64m -Xss16m -cp \"" + jar + "\" btools.server.RouteServer \"" + routen + "\" \"" + profile + "\" \"" + Path.Combine(routen, "profile") + "\" " + RoutePort + " 1 127.0.0.1";
                // Für die Routenplanung gibt es keine Fehleranzeige; sie bleibt dann aus ("nicht eingerichtet")
                try { brouter = StarteDienst(java, args, Path.Combine(Logs, "routen.log")); }
                catch (Exception e) { brouter = null; Log("Routenplanung konnte nicht starten (oft blockiert ein Virenscanner das Programm): " + e.Message); return; }
                Log("Routenplanung gestartet (" + rd5.Length + " Gebiete).");
            }
        }

        static void StoppeRouting()
        {
            lock (Lk)
            {
                try { if (brouter != null && !brouter.HasExited) { brouter.Kill(); brouter.WaitForExit(5000); } } catch { }
                brouter = null;
            }
        }

        // ------------------------------------------------------------------ Spracheingabe

        // Sprechen statt Tippen im Übersetzer: Parakeet für europäische Sprachen, Whisper small für den Rest.
        // Beide laufen pro Aufnahme als eigenes Programm (laden in unter einer Sekunde, danach ist der Speicher frei).
        // Ausnahme Sprechmodus: dort hält der Sprech-Dienst Parakeet und das Klang-Modell geladen (siehe SprechDienstSchalten).
        static readonly object sprechenLk = new object();

        static Dictionary<string, object> SpracheingabeKonfig() { return LadeJson(Path.Combine(Config, "spracheingabe.json")); }

        static List<Dictionary<string, object>> SprachModelle() { return Arr(SpracheingabeKonfig(), "modelle").OfType<Dictionary<string, object>>().ToList(); }

        static string SprachModellPfad(Dictionary<string, object> m) { return Path.Combine(Daten, "modelle", "sprache", Str(m, "datei")); }

        static bool SpracheingabeBereit()
        {
            return ProgrammPfad("whisper") != null && SprachModelle().Where(m => !Bool(m, "zusatz")).All(m => File.Exists(SprachModellPfad(m)));
        }

        static void SprachmodellLaden(Job j)
        {
            var m = SprachModelle().FirstOrDefault(x => Str(x, "id") == j.Extra);
            if (m == null) throw new Exception("Unbekanntes Sprachmodell");
            Directory.CreateDirectory(Path.GetDirectoryName(j.Ziel));
            Herunterladen(j, j.Url, j.Ziel);
            if (Sha256Datei(j.Ziel) != Str(m, "sha256")) { File.Delete(j.Ziel); throw new Exception("Die Prüfsumme von " + Path.GetFileName(j.Ziel) + " stimmt nicht. Bitte erneut versuchen."); }
        }

        // Eine Aufnahme erkennen. Mit "sprache" in genau dieser Sprache. Im Sprechmodus mit "paar" (zwei Sprachen)
        // bestimmt Fieldbook selbst, welche es war; "erwartet" ist die Sprache, die nach dem Sprecherwechsel dran wäre.
        static void Sprechen(HttpListenerContext ctx, string sprache, string paar, string erwartet)
        {
            if (!SpracheingabeBereit()) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Die Spracheingabe ist nicht eingerichtet." } }, 503); return; }
            string[] zwei = null;
            if (paar != null)
            {
                zwei = paar.Split(',');
                if (zwei.Length != 2 || zwei.Any(c => !Regex.IsMatch(c, "^[a-z]{2,3}$"))) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Unbekannte Sprachen" } }, 400); return; }
                if (!zwei.Contains(erwartet)) erwartet = zwei[0];
            }
            else if (sprache == null || !Regex.IsMatch(sprache, "^[a-z]{2,3}$")) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Unbekannte Sprache" } }, 400); return; }
            var konf = SpracheingabeKonfig();

            // Aufnahme (WAV, 16 kHz mono) in eine Datei, höchstens etwa eine Minute
            // Zu große Aufnahmen gar nicht erst ganz lesen: angegebene Länge prüfen, sonst beim Lesen abbrechen
            const int MaxAufnahme = 4000000;
            byte[] daten = null;
            if (ctx.Request.ContentLength64 <= MaxAufnahme)
                using (var ms = new MemoryStream())
                {
                    var puffer = new byte[65536];
                    int n;
                    bool zuLang = false;
                    while ((n = ctx.Request.InputStream.Read(puffer, 0, puffer.Length)) > 0)
                    {
                        if (ms.Length + n > MaxAufnahme) { zuLang = true; break; }
                        ms.Write(puffer, 0, n);
                    }
                    if (!zuLang) daten = ms.ToArray();
                }
            if (daten == null || daten.Length < 1000) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Die Aufnahme ist zu kurz oder zu lang." } }, 400); return; }
            string wav = Path.Combine(Daten, "cache", "sprechen-" + Guid.NewGuid().ToString("N") + ".wav");
            File.WriteAllBytes(wav, daten);
            try
            {
                double sekunden = (daten.Length - 44) / 32000.0;
                var uhr = Stopwatch.StartNew();
                string text = null, gewaehlt = sprache, gehoert = null, modell;
                bool sicher = true;
                lock (sprechenLk)
                {
                    if (zwei != null)
                    {
                        // 1. Klang: Wahrscheinlichkeit nur der beiden gewählten Sprachen (tiny: 0,5 s; ohne tiny das größere Modell).
                        // Wert > 0 spricht für zwei[0], < 0 für zwei[1]. Früher galt die wahrscheinlichste von 99 Sprachen,
                        // dabei wurde kurzes Deutsch („Hallo, wie geht es dir?“) oft Englisch.
                        var tiny = SprachModelle().FirstOrDefault(m => Str(m, "id") == "tiny");
                        var lidModell = tiny != null && File.Exists(SprachModellPfad(tiny)) ? tiny : SprachModelle().First(m => Str(m, "id") == "whisper");
                        double klang = KlangWertung(lidModell, wav, zwei, konf, out gehoert);
                        if (zwei.All(c => IstParakeet(c, konf)))
                        {
                            // 2. Parakeet schreibt ohne Sprachvorgabe auf; die Wörter entscheiden mit („danke“ ist deutsch,
                            // „thanks“ englisch). Einzelwörter erkennt der Klang allein nicht sicher, dafür sind die Wortlisten da.
                            text = SpracheErkennen(wav, null, sekunden, konf);
                            double summe = klang + WortWertung(text, zwei[0], zwei[1]);
                            if (summe == 0) { gewaehlt = erwartet; sicher = false; }   // weder Klang noch Wörter sagen etwas
                            else { gewaehlt = summe > 0 ? zwei[0] : zwei[1]; sicher = Math.Abs(summe) >= 1; }
                        }
                        else if (Math.Abs(klang) >= KlangKlar) gewaehlt = klang > 0 ? zwei[0] : zwei[1];
                        else
                        {
                            // 2. Klang unsicher: Whisper small mit eigener Spracherkennung, liefert Sprache und Text in einem Durchgang
                            var r = WhisperStarten(new[] { "-m", SprachModellPfad(SprachModelle().First(m => Str(m, "id") == "whisper")), "-f", wav, "-l", "auto", "-nt", "-sns" });
                            gewaehlt = PaarSprache(WhisperSprache(r[1]), zwei, konf);
                            if (gewaehlt != null) text = r[0];
                            else if (klang != 0) { gewaehlt = klang > 0 ? zwei[0] : zwei[1]; sicher = false; }
                            else { gewaehlt = erwartet; sicher = false; }
                        }
                    }
                    modell = gewaehlt == null || IstParakeet(gewaehlt, konf) ? "parakeet" : "whisper";
                    if (text == null) text = SpracheErkennen(wav, gewaehlt, sekunden, konf);
                }
                // Zeilen zusammenfügen, Geräuschmarken wie [Musik] oder (Lachen) weglassen
                text = string.Join(" ", text.Split('\n').Select(z => z.Trim()).Where(z => z.Length > 0));
                text = Regex.Replace(text, @"\[[^\]]*\]|\([^)]*\)|\*[^*]*\*", " ");
                text = Regex.Replace(text, @"\s+", " ").Trim();
                SendeJson(ctx, new Dictionary<string, object> { { "text", text }, { "sprache", gewaehlt }, { "sicher", sicher }, { "gehoert", gehoert },
                    { "sekunden", Math.Round(uhr.Elapsed.TotalSeconds, 1) }, { "modell", modell } });
            }
            catch (Exception e)
            {
                Log("Spracheingabe: " + e.Message);
                StatFehler("sprechen", e.Message);
                SendeJson(ctx, new Dictionary<string, object> { { "fehler", e.Message } }, 500);
            }
            finally { try { File.Delete(wav); } catch { } }
        }

        static bool IstParakeet(string code, Dictionary<string, object> konf)
        {
            return Arr(konf, "parakeet").Select(x => Convert.ToString(x)).Contains(code);
        }

        // Text einer Aufnahme; sprache == null: Parakeet bestimmt die Sprache selbst
        static string SpracheErkennen(string wav, string sprache, double sekunden, Dictionary<string, object> konf)
        {
            bool para = sprache == null || IstParakeet(sprache, konf);
            if (para)
            {
                var d = SprechDienstFragen("text\t" + wav);
                if (d != null) return d.Length > 0 ? d[0] : "";
            }
            var modell = SprachModelle().First(m => Str(m, "id") == (para ? "parakeet" : "whisper"));
            var args = new List<string> { "-m", SprachModellPfad(modell), "-f", wav };
            if (!para)
            {
                var codes = konf["whisperCodes"] as Dictionary<string, object>;
                string code = codes != null && codes.ContainsKey(sprache) ? Convert.ToString(codes[sprache]) : sprache;
                // Kürzeres Rechenfenster für kurze Aufnahmen (Whisper rechnet sonst immer 30 Sekunden)
                int ac = Math.Max(384, Math.Min(1500, (int)(sekunden * 50) + 128));
                args.AddRange(new[] { "-l", code, "-nt", "-sns" });
                if (ac < 1500) args.AddRange(new[] { "-ac", ac.ToString() });
            }
            return WhisperStarten(args.ToArray(), para)[0];
        }

        // whisper-cli oder parakeet-cli starten; Ergebnis: Ausgabe und Fehlerausgabe (dort steht die erkannte Sprache)
        static string[] WhisperStarten(string[] args, bool parakeet = false)
        {
            string whisper = ProgrammPfad("whisper");
            string exe = parakeet ? Path.Combine(Path.GetDirectoryName(whisper), "parakeet-cli.exe") : whisper;
            int threads = Math.Max(2, Math.Min(8, Environment.ProcessorCount / 2));
            string zeile = string.Join(" ", args.Select(a => a.StartsWith("-") ? a : "\"" + a + "\"")) + " -t " + threads + (args.Contains("auto") ? "" : " -np");   // -np verschluckt auch die erkannte Sprache
            var psi = new ProcessStartInfo(exe, zeile)
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = Utf8, StandardErrorEncoding = Utf8,
                WorkingDirectory = Path.GetDirectoryName(exe)
            };
            using (var p = new Process { StartInfo = psi })
            {
                var fehler = new StringBuilder();
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (fehler) fehler.AppendLine(e.Data); };
                p.Start();
                ChildJob.Add(p);
                p.BeginErrorReadLine();
                var lesen = p.StandardOutput.ReadToEndAsync();
                if (!p.WaitForExit(120000)) { try { p.Kill(); } catch { } throw new Exception("Die Erkennung hat zu lange gedauert."); }
                p.WaitForExit();
                string aus = lesen.Result, err;
                lock (fehler) err = fehler.ToString();
                if (p.ExitCode != 0 && aus.Trim().Length == 0) throw new Exception("Die Erkennung ist fehlgeschlagen (Code " + p.ExitCode + ").");
                return new[] { aus, err };
            }
        }

        // "auto-detected language: no (p = 0.51)" → "nb" (Codes von Whisper in unsere zurück)
        static string WhisperSprache(string stderr)
        {
            var m = Regex.Match(stderr ?? "", @"auto-detected language: ([a-z]+)");
            if (!m.Success) return null;
            string c = m.Groups[1].Value;
            var codes = SpracheingabeKonfig()["whisperCodes"] as Dictionary<string, object>;
            if (codes != null) foreach (var kv in codes) if (Convert.ToString(kv.Value) == c) return kv.Key;
            return c;
        }

        // Klang und Wörter als Log-Verhältnis (ln p1/p2). Ab KlangKlar (= 75 % zu 25 %) gilt der Klang allein;
        // jede Stimme ist auf ±WertungMax begrenzt, damit ein klares Wort einen zweifelnden Klang überstimmen kann.
        const double KlangKlar = 1.1, WertungMax = 4;

        // Klang: ln(p(zwei[0]) / p(zwei[1])) aus whisper.dll über SprachHelfer.exe.
        // Klappt das nicht, wie früher die eine von whisper-cli erkannte Sprache (±1, falls sie zum Paar gehört).
        static double KlangWertung(Dictionary<string, object> modell, string wav, string[] zwei, Dictionary<string, object> konf, out string gehoert)
        {
            gehoert = null;
            var codes = konf["whisperCodes"] as Dictionary<string, object>;
            Func<string, string> wc = c => codes != null && codes.ContainsKey(c) ? Convert.ToString(codes[c]) : c;
            try
            {
                string[] d = sprechKlangModell == SprachModellPfad(modell) ? SprechDienstFragen("klang\t" + wav + "\t" + wc(zwei[0]) + "," + wc(zwei[1])) : null;
                if (d != null)
                {
                    var wd = d.Select(z => z.Trim().Split(' ')).Where(t => t.Length == 2)
                        .Select(t => double.Parse(t[1], System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                    if (wd.Length == 2)
                    {
                        gehoert = wd[0] >= wd[1] ? zwei[0] : zwei[1];
                        return Math.Max(-WertungMax, Math.Min(WertungMax, Math.Log((wd[0] + 1e-4) / (wd[1] + 1e-4))));
                    }
                }
                string exe = SprachHelferExe();
                string whisperOrdner = Path.GetDirectoryName(ProgrammPfad("whisper"));
                int threads = Math.Max(2, Math.Min(8, Environment.ProcessorCount / 2));
                var psi = new ProcessStartInfo(exe, "\"" + whisperOrdner + "\" \"" + SprachModellPfad(modell) + "\" \"" + wav + "\" " + wc(zwei[0]) + "," + wc(zwei[1]) + " " + threads)
                {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true,
                    StandardOutputEncoding = Utf8, WorkingDirectory = whisperOrdner
                };
                using (var p = new Process { StartInfo = psi })
                {
                    p.Start();
                    ChildJob.Add(p);
                    var fehler = p.StandardError.ReadToEndAsync();
                    string aus = p.StandardOutput.ReadToEnd();
                    if (!p.WaitForExit(30000)) { try { p.Kill(); } catch { } throw new Exception("zu langsam"); }
                    var w = aus.Split('\n').Select(z => z.Trim().Split(' ')).Where(t => t.Length == 2)
                        .Select(t => double.Parse(t[1], System.Globalization.CultureInfo.InvariantCulture)).ToArray();
                    if (p.ExitCode != 0 || w.Length != 2) throw new Exception("Code " + p.ExitCode + ": " + fehler.Result.Trim().Split('\n').Last());
                    gehoert = w[0] >= w[1] ? zwei[0] : zwei[1];
                    return Math.Max(-WertungMax, Math.Min(WertungMax, Math.Log((w[0] + 1e-4) / (w[1] + 1e-4))));
                }
            }
            catch (Exception e)
            {
                Log("Spracheingabe: Klang-Helfer geht nicht (" + e.Message + "), nehme whisper-cli");
                var lid = WhisperStarten(new[] { "-m", SprachModellPfad(modell), "-f", wav, "-l", "auto", "-dl" });
                gehoert = WhisperSprache(lid[0] + lid[1]);
                string paar = PaarSprache(gehoert, zwei, konf);
                return paar == null ? 0 : paar == zwei[0] ? 1 : -1;
            }
        }

        // SprachHelfer.cs bei Bedarf zu einer .exe übersetzen (eigener Ordner, start.ps1 räumt daten\cache\programm auf)
        static readonly object sprachHelferLk = new object();
        static string SprachHelferExe()
        {
            lock (sprachHelferLk)
            {
                string quelle = Path.Combine(AppDir, "SprachHelfer.cs");
                string ordner = Path.Combine(Daten, "cache", "sprachhelfer");
                string exe = Path.Combine(ordner, "SprachHelfer-" + Sha256Datei(quelle).Substring(0, 16) + ".exe");
                if (File.Exists(exe)) return exe;
                Directory.CreateDirectory(ordner);
                string tmp = Path.Combine(ordner, "neu-" + Guid.NewGuid().ToString("N") + ".exe");
                using (var cs = new Microsoft.CSharp.CSharpCodeProvider())
                {
                    var cp = new System.CodeDom.Compiler.CompilerParameters { GenerateExecutable = true, OutputAssembly = tmp, CompilerOptions = "/platform:x64 /optimize" };
                    var r = cs.CompileAssemblyFromFile(cp, quelle);
                    if (r.Errors.HasErrors) { try { File.Delete(tmp); } catch { } throw new Exception("SprachHelfer.cs lässt sich nicht übersetzen: " + r.Errors[0].ErrorText); }
                }
                File.Move(tmp, exe);
                foreach (var alt in Directory.GetFiles(ordner)) if (alt != exe) try { File.Delete(alt); } catch { }
                return exe;
            }
        }

        // Sprech-Dienst (Nutzer, 22. Nov. 2026): Im Sprechmodus kommt es beim Hin und Her auf jede Sekunde an. Solange er offen
        // ist, hält SprachHelfer.exe Parakeet (etwa 700 MB) und das Klang-Modell geladen; das spart je Satz etwa 0,9 s.
        // Die Oberfläche schaltet ihn beim Umschalten ein und aus und meldet sich alle 30 s; ohne Lebenszeichen endet er
        // nach 90 s (Browser einfach zugemacht). Im Schreiben-Fenster wird er nie gestartet. Geht er nicht, läuft alles
        // wie vorher über die Einzelprogramme. Alle Sprech-Dienst-Aufrufe nur unter sprechenLk.
        static Process sprechDienst;
        static StreamWriter sprechEin;
        static StreamReader sprechAus;
        static DateTime sprechZuletzt;
        static string sprechKlangModell;
        const int SprechDienstSekunden = 90;

        static Dictionary<string, object> SprechDienstSchalten(bool an)
        {
            lock (sprechenLk)
            {
                if (!an) { SprechDienstStoppen(); return new Dictionary<string, object> { { "ok", true } }; }
                sprechZuletzt = DateTime.Now;
                if (sprechDienst != null && !sprechDienst.HasExited) return new Dictionary<string, object> { { "ok", true } };
                if (!SpracheingabeBereit()) return new Dictionary<string, object> { { "ok", false } };
                try { SprechDienstStarten(); return new Dictionary<string, object> { { "ok", true } }; }
                catch (Exception e)
                {
                    Log("Sprech-Dienst startet nicht: " + e.Message);
                    SprechDienstStoppen();
                    return new Dictionary<string, object> { { "ok", false } };
                }
            }
        }

        static void SprechDienstStoppen()
        {
            var p = sprechDienst;
            sprechDienst = null; sprechEin = null; sprechAus = null; sprechKlangModell = null;
            if (p == null) return;
            try { if (!p.HasExited) p.Kill(); } catch { }
            try { p.Dispose(); } catch { }
        }

        static void SprechDienstStarten()
        {
            var modelle = SprachModelle();
            var tiny = modelle.FirstOrDefault(m => Str(m, "id") == "tiny");
            var klang = tiny != null && File.Exists(SprachModellPfad(tiny)) ? tiny : modelle.First(m => Str(m, "id") == "whisper");
            string parakeet = SprachModellPfad(modelle.First(m => Str(m, "id") == "parakeet"));
            string whisperOrdner = Path.GetDirectoryName(ProgrammPfad("whisper"));
            int threads = Math.Max(2, Math.Min(8, Environment.ProcessorCount / 2));
            var psi = new ProcessStartInfo(SprachHelferExe(), "dienst \"" + whisperOrdner + "\" \"" + parakeet + "\" \"" + SprachModellPfad(klang) + "\" " + threads)
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                StandardOutputEncoding = new UTF8Encoding(false), WorkingDirectory = whisperOrdner
            };
            var p = new Process { StartInfo = psi };
            p.ErrorDataReceived += (o, e) => { };   // Ladeprotokoll von whisper.dll nur abholen, sonst läuft der Puffer voll
            p.Start();
            ChildJob.Add(p);
            p.BeginErrorReadLine();
            sprechDienst = p;
            sprechEin = new StreamWriter(p.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            sprechAus = p.StandardOutput;
            var erste = sprechAus.ReadLineAsync();
            if (!erste.Wait(30000) || erste.Result != "bereit") throw new Exception(erste.IsCompleted ? (erste.Result ?? "beendet") : "zu langsam");
            sprechKlangModell = SprachModellPfad(klang);
            var w = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(10000);
                    lock (sprechenLk)
                    {
                        if (sprechDienst != p) return;
                        if (p.HasExited || (DateTime.Now - sprechZuletzt).TotalSeconds >= SprechDienstSekunden) { SprechDienstStoppen(); return; }
                    }
                }
            }) { IsBackground = true };
            w.Start();
        }

        // Anfrage an den laufenden Dienst; Antwortfelder nach "ok", oder null (Dienst aus oder Fehler, dann Einzelprogramm)
        static string[] SprechDienstFragen(string zeile)
        {
            if (sprechDienst == null) return null;
            try
            {
                if (sprechDienst.HasExited) throw new Exception("beendet");
                sprechZuletzt = DateTime.Now;
                sprechEin.WriteLine(zeile);
                var lesen = sprechAus.ReadLineAsync();
                if (!lesen.Wait(60000)) throw new Exception("zu langsam");
                string a = lesen.Result;
                if (a == null) throw new Exception("beendet");
                sprechZuletzt = DateTime.Now;
                var t = a.Split('\t');
                if (t[0] != "ok") { Log("Sprech-Dienst: " + a); return null; }
                return t.Skip(1).ToArray();
            }
            catch (Exception e)
            {
                Log("Sprech-Dienst: " + e.Message);
                SprechDienstStoppen();
                return null;
            }
        }

        // Wörter: Summe je Wort von ln(Häufigkeit in Sprache 1 / in Sprache 2) nach den Wortlisten in config/woerter
        // (Untertitel, also gesprochene Sprache). Wörter, die in keiner Liste stehen (Namen), zählen nicht.
        static readonly Dictionary<string, Dictionary<string, double>> wortListen = new Dictionary<string, Dictionary<string, double>>();
        static readonly Dictionary<string, double> wortBoden = new Dictionary<string, double>();

        static Dictionary<string, double> WortListe(string sprache)
        {
            lock (wortListen)
            {
                Dictionary<string, double> l;
                if (wortListen.TryGetValue(sprache, out l)) return l;
                l = null;
                string datei = Path.Combine(Config, "woerter", sprache + ".txt");
                if (File.Exists(datei))
                {
                    l = new Dictionary<string, double>();
                    double gesamt = 1, letzte = 1;
                    foreach (var z in File.ReadAllLines(datei, Utf8))
                    {
                        var t = z.Split(' ');
                        if (z.StartsWith("# gesamt ")) { gesamt = double.Parse(t[2], System.Globalization.CultureInfo.InvariantCulture); continue; }
                        double n;
                        if (t.Length != 2 || !double.TryParse(t[1], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out n)) continue;
                        if (!l.ContainsKey(t[0])) l[t[0]] = Math.Log(n / gesamt);
                        letzte = n;
                    }
                    // Nicht in den 5000 häufigsten: höchstens halb so häufig wie das letzte Wort der Liste
                    wortBoden[sprache] = Math.Log(letzte / 2 / gesamt);
                }
                wortListen[sprache] = l;
                return l;
            }
        }

        static double WortWertung(string text, string a, string b)
        {
            var la = WortListe(a);
            var lb = WortListe(b);
            if (la == null || lb == null || string.IsNullOrEmpty(text)) return 0;
            double summe = 0;
            foreach (Match m in Regex.Matches(text.ToLowerInvariant(), @"\p{L}+(?:'\p{L}+)?"))
            {
                double wa, wb;
                bool ia = la.TryGetValue(m.Value, out wa), ib = lb.TryGetValue(m.Value, out wb);
                if (!ia && !ib) continue;
                if (!ia) wa = wortBoden[a];
                if (!ib) wb = wortBoden[b];
                summe += Math.Max(-WertungMax, Math.Min(WertungMax, wa - wb));
            }
            return summe;
        }

        // Welche der beiden Sprachen passt zur erkannten? Bei verwandten Sprachen die gewählte aus derselben Gruppe.
        static string PaarSprache(string erkannt, string[] zwei, Dictionary<string, object> konf)
        {
            if (erkannt == null) return null;
            if (zwei.Contains(erkannt)) return erkannt;
            foreach (var g in Arr(konf, "verwandt").OfType<object[]>().Select(x => x.Select(y => Convert.ToString(y)).ToArray())
                .Concat(Arr(konf, "verwandt").OfType<System.Collections.ArrayList>().Select(x => x.Cast<object>().Select(y => Convert.ToString(y)).ToArray())))
            {
                if (!g.Contains(erkannt)) continue;
                var drin = zwei.Where(c => g.Contains(c)).ToArray();
                if (drin.Length == 1) return drin[0];
            }
            return null;
        }

        // ------------------------------------------------------------------ Vorlesen

        // Übersetzungen vorlesen mit Piper: je Sprache eine Stimme (config\stimmen.json), je Aufruf ein eigenes
        // Programm (lädt in unter einer Sekunde). Stimmen liegen in daten\modelle\stimmen.
        static readonly object vorlesenLk = new object();

        static Dictionary<string, object> StimmenKonfig() { return LadeJson(Path.Combine(Config, "stimmen.json")) ?? new Dictionary<string, object>(); }

        static Dictionary<string, object> StimmeInfo(string code)
        {
            return Arr(StimmenKonfig(), "stimmen").OfType<Dictionary<string, object>>().FirstOrDefault(s => Str(s, "code") == code);
        }

        static string StimmePfad(Dictionary<string, object> s) { return Path.Combine(Daten, "modelle", "stimmen", Str(s, "stimme") + ".onnx"); }

        static bool StimmeDa(string code)
        {
            var s = StimmeInfo(code);
            return s != null && File.Exists(StimmePfad(s)) && File.Exists(StimmePfad(s) + ".json");
        }

        // Sprachen, die vorlesen können (Programm und Stimme da). Das alte Piper (bis 0.8.4) liest weiter vor,
        // bis die Aktualisierung das neue (piper-py) geholt hat.
        static string[] Stimmen()
        {
            if (PiperPyPfad() == null && ProgrammPfad("piper") == null) return new string[0];
            return Arr(StimmenKonfig(), "stimmen").OfType<Dictionary<string, object>>().Select(s => Str(s, "code")).Where(StimmeDa).ToArray();
        }

        // ------------------------------------------------ Piper 1.8 mit portablem Python (piper-py)
        // Python (python.org) und die Pakete (PyPI) liegen in programme\piper-py, gestartet wird app\piper-dienst.py.
        // Der Dienst läuft nur, solange vorgelesen wird: nach 1 Minute ohne Anfrage beendet er sich (Arbeitsspeicher).

        static string PiperPyPfad()
        {
            string exe = Path.Combine(Prog, "piper-py", "python.exe");
            return File.Exists(exe) && File.Exists(Path.Combine(Prog, "piper-py", "fertig.txt")) ? exe : null;
        }

        static long PiperPyBytes()
        {
            var info = ProgrammInfo("piper-py");
            long b = (long)Num(info == null ? null : info["python"] as Dictionary<string, object>, "bytes");
            foreach (var p in Arr(info, "pakete").OfType<Dictionary<string, object>>()) b += (long)Num(p, "bytes");
            return b;
        }

        static Job PiperPyJob()
        {
            var info = ProgrammInfo("piper-py");
            return new Job { Art = "programm", Titel = Str(info, "titel"), Ziel = "piper-py", Gesamt = PiperPyBytes() };
        }

        // Lädt Python und die Pakete in einen neuen Ordner, prüft alles und tauscht dann erst aus
        static void PiperPyLaden(Job j)
        {
            var info = ProgrammInfo("piper-py");
            var dateien = new List<Dictionary<string, object>> { (Dictionary<string, object>)info["python"] };
            dateien.AddRange(Arr(info, "pakete").OfType<Dictionary<string, object>>());
            string ladeDir = Path.Combine(Prog, "piper-py.laden"), neu = Path.Combine(Prog, "piper-py.neu"), ziel = Path.Combine(Prog, "piper-py");
            Directory.CreateDirectory(ladeDir);
            j.Gesamt = PiperPyBytes();
            long fertig = 0;
            foreach (var d in dateien)
            {
                string url = Str(d, "url"), datei = Path.Combine(ladeDir, url.Substring(url.LastIndexOf('/') + 1));
                if (!File.Exists(datei) || Sha256Datei(datei) != Str(d, "sha256"))
                {
                    // Eigener Job je Datei, der Fortschritt wird auf den Gesamt-Job übertragen
                    var t = new Job { Titel = j.Titel, Gesamt = (long)Num(d, "bytes") };
                    long basis = fertig;
                    bool laeuft = true;
                    var uhr = new Thread(() => { while (laeuft) { j.Bytes = basis + t.Bytes; Thread.Sleep(300); } }) { IsBackground = true };
                    uhr.Start();
                    try { Herunterladen(t, url, datei); } finally { laeuft = false; }
                    if (Sha256Datei(datei) != Str(d, "sha256")) { File.Delete(datei); throw new Exception("Die Prüfsumme des Vorleseprogramms stimmt nicht. Bitte erneut versuchen."); }
                }
                fertig += new FileInfo(datei).Length;
                j.Bytes = fertig;
            }
            if (Directory.Exists(neu)) Directory.Delete(neu, true);
            ZipFile.ExtractToDirectory(Path.Combine(ladeDir, Str(dateien[0], "url").Substring(Str(dateien[0], "url").LastIndexOf('/') + 1)), neu);
            string paket = Path.Combine(neu, "paket");
            Directory.CreateDirectory(paket);
            foreach (var d in dateien.Skip(1))
            {
                string url = Str(d, "url");
                ZipFile.ExtractToDirectory(Path.Combine(ladeDir, url.Substring(url.LastIndexOf('/') + 1)), paket);
            }
            // Python sucht seine Bausteine nur dort, wo die ._pth-Datei es sagt
            foreach (var pth in Directory.GetFiles(neu, "python3*._pth"))
                File.WriteAllText(pth, "python312.zip\r\n.\r\npaket\r\n", new UTF8Encoding(false));
            // Hebräisch-Zusatz (21 MB) braucht Fieldbook nicht
            string hebr = Path.Combine(paket, "piper", "hebrew");
            if (Directory.Exists(hebr)) try { Directory.Delete(hebr, true); } catch { }
            File.WriteAllText(Path.Combine(neu, "fertig.txt"), "piper-py", new UTF8Encoding(false));
            lock (vorlesenLk)
            {
                PiperDienstStoppen();
                if (Directory.Exists(ziel)) Directory.Delete(ziel, true);
                Directory.Move(neu, ziel);
                // Das alte Piper wird nicht mehr gebraucht
                string alt = Path.Combine(Prog, "piper");
                if (Directory.Exists(alt)) try { Directory.Delete(alt, true); } catch (Exception e) { Log("Altes Piper löschen: " + e.Message); }
            }
            try { Directory.Delete(ladeDir, true); } catch { }
            // Ältere Fieldbook-Versionen haben aus den Stimm-Einstellungen Doppellaute entfernt (fürs alte Programm);
            // das neue kann sie, also die unveränderten Einstellungen holen (je Stimme etwa 5 KB)
            foreach (var s in Arr(StimmenKonfig(), "stimmen").OfType<Dictionary<string, object>>())
            {
                string onnx = StimmePfad(s);
                if (!File.Exists(onnx + ".json") || Sha256Datei(onnx + ".json") == Str(s, "jsonSha256")) continue;
                try { StimmeJsonLaden(s, Str(StimmenKonfig(), "basis") + Str(s, "pfad") + "/" + Str(s, "stimme") + ".onnx.json"); }
                catch (Exception e) { Log("Stimm-Einstellungen " + Str(s, "code") + ": " + e.Message); }
            }
        }

        static Process piperDienst;
        static StreamWriter piperEin;
        static StreamReader piperAus;
        static DateTime piperZuletzt;

        // Nur unter vorlesenLk aufrufen
        static void PiperDienstStoppen()
        {
            var p = piperDienst;
            piperDienst = null; piperEin = null; piperAus = null;
            if (p == null) return;
            try { if (!p.HasExited) p.Kill(); } catch { }
            try { p.Dispose(); } catch { }
        }

        // Nur unter vorlesenLk aufrufen
        static void PiperDienstStarten(string python)
        {
            var psi = new ProcessStartInfo(python, "-u -X utf8 \"" + Path.Combine(AppDir, "piper-dienst.py") + "\"")
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(python),
                StandardOutputEncoding = new UTF8Encoding(false)
            };
            var p = new Process { StartInfo = psi };
            p.ErrorDataReceived += (o, e) => { if (e.Data != null && e.Data.Trim().Length > 0) Log("Piper: " + e.Data); };
            p.Start();
            ChildJob.Add(p);
            p.BeginErrorReadLine();
            piperDienst = p;
            piperEin = new StreamWriter(p.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
            piperAus = p.StandardOutput;
            string erste = piperAus.ReadLine();
            if (erste == null || !erste.Contains("bereit")) { PiperDienstStoppen(); throw new Exception("Das Vorleseprogramm startet nicht."); }
            // Wächter: nach 1 Minute ohne Anfrage beenden
            var w = new Thread(() =>
            {
                while (true)
                {
                    Thread.Sleep(10000);
                    lock (vorlesenLk)
                    {
                        if (piperDienst != p) return;
                        if (p.HasExited) { PiperDienstStoppen(); return; }
                        if ((DateTime.Now - piperZuletzt).TotalSeconds >= 60) { PiperDienstStoppen(); return; }
                    }
                }
            }) { IsBackground = true };
            w.Start();
        }

        // Erzeugt die WAV-Datei und gibt die Wortzeiten als JSON-Liste zurück (nur unter vorlesenLk aufrufen)
        static string PiperDienstVorlesen(string python, string stimme, string text, string wav)
        {
            for (int versuch = 0; ; versuch++)
            {
                if (piperDienst == null || piperDienst.HasExited) { PiperDienstStoppen(); PiperDienstStarten(python); }
                piperZuletzt = DateTime.Now;
                string antwort = null;
                try
                {
                    piperEin.WriteLine(Json.Serialize(new Dictionary<string, object> { { "stimme", stimme }, { "text", text }, { "wav", wav } }));
                    var lesen = piperAus.ReadLineAsync();
                    if (!lesen.Wait(60000)) { PiperDienstStoppen(); throw new Exception("Das Vorlesen hat zu lange gedauert."); }
                    antwort = lesen.Result;
                }
                catch (IOException) { antwort = null; }
                piperZuletzt = DateTime.Now;
                if (antwort == null)
                {
                    PiperDienstStoppen();
                    if (versuch == 0) continue;   // abgestürzt: einmal neu starten
                    throw new Exception("Das Vorleseprogramm ist abgestürzt.");
                }
                Dictionary<string, object> r;
                try { r = Json.Deserialize<Dictionary<string, object>>(antwort); } catch { r = null; }
                if (r == null) throw new Exception("Unerwartete Antwort vom Vorleseprogramm.");
                if (Str(r, "fehler") != null) { Log("Vorlesen: " + Str(r, "fehler")); throw new Exception("Das Vorlesen ist fehlgeschlagen."); }
                return r.ContainsKey("woerter") && Bool(r, "genau") ? Json.Serialize(r["woerter"]) : null;
            }
        }

        // Fehlende Stimmen für diese Sprachen (Deutsch immer dazu) samt Programm als Jobs
        static List<Job> StimmenJobs(IEnumerable<string> sprachen)
        {
            var jobs = new List<Job>();
            foreach (var c in new[] { "de" }.Concat(sprachen).Distinct())
            {
                var s = StimmeInfo(c);
                if (s == null || StimmeDa(c)) continue;
                var si = SprachInfo(c);
                jobs.Add(new Job { Art = "stimme", Titel = "Stimme: " + (c == "de" ? "Deutsch" : Str(si, "name") ?? c), Url = Str(StimmenKonfig(), "basis") + Str(s, "pfad") + "/" + Str(s, "stimme") + ".onnx", Ziel = c, Gesamt = (long)Num(s, "bytes") });
            }
            if (jobs.Count > 0 && PiperPyPfad() == null) jobs.Insert(0, PiperPyJob());
            return jobs;
        }

        static void StimmeLaden(Job j)
        {
            var s = StimmeInfo(j.Ziel);
            if (s == null) throw new Exception("Keine Stimme für " + j.Ziel);
            string onnx = StimmePfad(s), json = onnx + ".json";
            Directory.CreateDirectory(Path.GetDirectoryName(onnx));
            if (!File.Exists(onnx) || Sha256Datei(onnx) != Str(s, "sha256"))
            {
                Herunterladen(j, j.Url, onnx);
                if (Sha256Datei(onnx) != Str(s, "sha256")) { File.Delete(onnx); throw new Exception("Die Prüfsumme der Stimme stimmt nicht. Bitte erneut versuchen."); }
            }
            StimmeJsonLaden(s, j.Url + ".json");
        }

        // Einstellungen der Stimme (.onnx.json) unverändert laden; das neue Piper versteht auch die Doppellaute,
        // die ältere Fieldbook-Versionen fürs alte Programm entfernt haben
        static void StimmeJsonLaden(Dictionary<string, object> s, string url)
        {
            string json = StimmePfad(s) + ".json", tmp = json + ".neu";
            if (File.Exists(tmp)) File.Delete(tmp);
            Herunterladen(new Job { Titel = "Stimme" }, url, tmp);
            if (Sha256Datei(tmp) != Str(s, "jsonSha256")) { File.Delete(tmp); throw new Exception("Die Prüfsumme der Stimme stimmt nicht. Bitte erneut versuchen."); }
            lock (vorlesenLk)
            {
                PiperDienstStoppen();   // hält die alte Fassung sonst im Speicher
                if (File.Exists(json)) File.Delete(json);
                File.Move(tmp, json);
            }
        }

        static void StimmeLoeschen(string code)
        {
            var s = StimmeInfo(code);
            if (s == null) return;
            lock (vorlesenLk)
            {
                PiperDienstStoppen();
                string onnx = StimmePfad(s);
                if (File.Exists(onnx)) File.Delete(onnx);
                if (File.Exists(onnx + ".json")) File.Delete(onnx + ".json");
            }
        }

        static void Vorlesen(HttpListenerContext ctx)
        {
            var b = LeseBody(ctx);
            string sprache = Str(b, "sprache"), text = Str(b, "text") ?? "";
            var s = sprache == null ? null : StimmeInfo(sprache);
            string python = PiperPyPfad(), exe = python == null ? ProgrammPfad("piper") : null;
            if (s == null || (python == null && exe == null) || !StimmeDa(sprache)) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Für diese Sprache ist keine Stimme da." } }, 404); return; }
            // Eine Zeile pro Aufruf (Piper liest zeilenweise), höchstens etwa eine Bildschirmseite
            text = Regex.Replace(text, @"\s+", " ").Trim();
            if (text.Length == 0 || text.Length > 3000) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Der Text ist leer oder zu lang." } }, 400); return; }
            string wav = Path.Combine(Daten, "cache", "vorlesen-" + Guid.NewGuid().ToString("N") + ".wav");
            string zeiten = null;
            try
            {
                // Neues Piper: Dienst im Hintergrund, liefert die Zeit jedes Wortes (Kopfzeile X-Wortzeiten)
                if (python != null) lock (vorlesenLk) zeiten = PiperDienstVorlesen(python, StimmePfad(s), text, wav);
                else lock (vorlesenLk)
                {
                    var psi = new ProcessStartInfo(exe, "-m \"" + StimmePfad(s) + "\" -f \"" + wav + "\" -q")
                    {
                        UseShellExecute = false, CreateNoWindow = true,
                        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                        WorkingDirectory = Path.GetDirectoryName(exe)
                    };
                    using (var p = new Process { StartInfo = psi })
                    {
                        var fehler = new StringBuilder();
                        p.ErrorDataReceived += (o, e) => { if (e.Data != null) lock (fehler) fehler.AppendLine(e.Data); };
                        p.OutputDataReceived += (o, e) => { };
                        p.Start();
                        ChildJob.Add(p);
                        p.BeginErrorReadLine();
                        p.BeginOutputReadLine();
                        // Text als UTF-8 ohne BOM (.NET Framework kennt keine Kodierung für die Eingabe)
                        var bytes = new UTF8Encoding(false).GetBytes(text + "\n");
                        p.StandardInput.BaseStream.Write(bytes, 0, bytes.Length);
                        p.StandardInput.Close();
                        if (!p.WaitForExit(60000)) { try { p.Kill(); } catch { } throw new Exception("Das Vorlesen hat zu lange gedauert."); }
                        p.WaitForExit();
                        if (p.ExitCode != 0 || !File.Exists(wav))
                        {
                            string f; lock (fehler) f = fehler.ToString().Trim();
                            Log("Vorlesen: Code " + p.ExitCode + " " + f);
                            throw new Exception("Das Vorlesen ist fehlgeschlagen (Code " + p.ExitCode + ").");
                        }
                    }
                }
                var daten = File.ReadAllBytes(wav);
                ctx.Response.StatusCode = 200;
                ctx.Response.ContentType = "audio/wav";
                ctx.Response.AddHeader("Cache-Control", "no-store");
                if (zeiten != null) ctx.Response.AddHeader("X-Wortzeiten", zeiten);
                ctx.Response.ContentLength64 = daten.Length;
                ctx.Response.OutputStream.Write(daten, 0, daten.Length);
            }
            catch (Exception e)
            {
                StatFehler("vorlesen", e.Message);
                SendeJson(ctx, new Dictionary<string, object> { { "fehler", e.Message } }, 500);
            }
            finally { try { File.Delete(wav); } catch { } }
        }

        // ------------------------------------------------------------------ KI

        static Dictionary<string, object> AktuellesModell()
        {
            string id = Str(einst, "modell");
            if (id == null) return null;
            foreach (var o in Arr(LadeJson(Path.Combine(Config, "modelle.json")), "modelle"))
            {
                var m = (Dictionary<string, object>)o;
                if (Str(m, "id") == id) return m;
            }
            return null;
        }

        static int AktuellesModellKontext()
        {
            var m = AktuellesModell();
            return m == null ? 8192 : (int)Num(m, "kontext");
        }

        // Läuft oft in eigenem Thread: ein ungefangener Fehler würde Fieldbook beenden.
        // Typisch: ein Virenscanner sperrt llama-server.exe oder die Logdatei.
        static void StarteKi()
        {
            try { StarteKiIntern(); }
            catch (Exception e)
            {
                llmStatus = "fehler";
                llmFehler = "Die KI konnte nicht starten, oft blockiert ein Virenscanner das Programm.";
                Log("KI konnte nicht starten: " + e.Message);
                StatFehler("ki", llmFehler + " " + e.Message);
            }
        }

        static void StarteKiIntern()
        {
            int gen;
            string exe, args;
            lock (Lk)
            {
                if (llama != null && !llama.HasExited) return;
                var m = AktuellesModell();
                if (m == null) { llmStatus = "aus"; return; }
                string datei = Path.Combine(Daten, "modelle", Str(m, "datei"));
                if (!File.Exists(datei)) { llmStatus = "aus"; return; }
                string backend = Str(einst, "backend") ?? "cpu";
                // Nur zum Messen der Laptop-Zeit: OW_KI_CPU=1 rechnet die KI auf dem Prozessor, ohne die Einstellung zu ändern
                if (Environment.GetEnvironmentVariable("OW_KI_CPU") == "1") backend = "cpu";
                exe = ProgrammPfad("llama-" + backend);
                if (exe == null && backend != "cpu") { backend = "cpu"; exe = ProgrammPfad("llama-cpu"); }
                if (exe == null) { llmStatus = "fehler"; llmFehler = "llama.cpp fehlt. Bitte im Setup die KI neu einrichten."; return; }
                // Nur zum Testen vieler Fragen: OW_KI_PARALLEL=4 lässt die KI mehrere Fragen gleichzeitig bearbeiten
                // (jede mit dem vollen Kontext). Normal ist eine Frage zur Zeit.
                int parallel = 1;
                int.TryParse(Environment.GetEnvironmentVariable("OW_KI_PARALLEL") ?? "1", out parallel);
                parallel = Math.Max(1, Math.Min(8, parallel));
                args = "-m \"" + datei + "\" --host 127.0.0.1 --port " + LlmPort + " -c " + ((int)Num(m, "kontext") * parallel) + " --parallel " + parallel + " --jinja";
                if (backend != "cpu") args += " -ngl 999";
                // Der Prompt-Zwischenspeicher von llama-server wächst sonst bis 8 GB (gemessen: +1 GB nach zwei Fragen)
                // und spart nur etwa 7 s je Folgefrage. Unter 16 GB RAM ganz aus, sonst auf 2 GB begrenzt.
                var speicher = new MEMORYSTATUSEX();
                double ramGB = GlobalMemoryStatusEx(speicher) ? speicher.ullTotalPhys / 1073741824.0 : 0;
                args += ramGB >= 15.5 ? " --cache-ram 2048" : " --cache-ram 0";
                llmModell =Str(m, "name") + " (" + Str(m, "modell") + ")";
                llmStatus = "laedt";
                llmFehler = "";
                gen = ++llmGen;
                llama = StarteDienst(exe, args + " --reasoning-budget 0", Path.Combine(Logs, "ki.log"));
                Log("KI wird geladen: " + llmModell + " [" + backend + "]");
                kiBackend = backend;
                // Auf dem Prozessor gleich mitstarten. Mit Grafikkarte erst, wenn die KI geladen ist (siehe StarteSuchhilfe)
                if (backend == "cpu") StarteSuchhilfe();
            }
            bool zweiterVersuch = false;
            var ladeUhr = Stopwatch.StartNew();
            while (gen == llmGen)
            {
                Thread.Sleep(500);
                // Feld einmal lesen: StoppeKi kann es zwischendurch auf null setzen
                var l = llama;
                if (l == null) return;
                if (l.HasExited)
                {
                    string log = "";
                    try { log = File.ReadAllText(Path.Combine(Logs, "ki.log")); } catch { }
                    if (!zweiterVersuch && Regex.IsMatch(log, "reasoning-budget|invalid argument|unknown argument", RegexOptions.IgnoreCase))
                    {
                        zweiterVersuch = true;
                        lock (Lk)
                        {
                            // Inzwischen gestoppt oder neu gestartet: nicht noch einmal starten
                            if (gen != llmGen) return;
                            llama = StarteDienst(exe, args, Path.Combine(Logs, "ki.log"));
                        }
                        continue;
                    }
                    llmStatus = "fehler";
                    // Der Fehlerbericht wird nach 300 Zeichen gekürzt: Code und Grund zuerst, Startzeilen ohne Aussage weglassen
                    var zeilen = log.Split('\n').Where(z => z.Trim().Length > 0 && !Regex.IsMatch(z, "common_params_print_info|no API key is set|llama_server: initializing")).ToArray();
                    var wichtig = zeilen.Where(z => Regex.IsMatch(z, @"error|fail|unable|cannot|out of memory|exception|abort", RegexOptions.IgnoreCase)).ToArray();
                    if (wichtig.Length > 0) zeilen = wichtig;
                    string code = "";
                    try { code = "0x" + ((uint)l.ExitCode).ToString("X8"); } catch { }
                    string grund = "";
                    if (code == "0xC0000017" || code == "0xC000012D") grund = " Zu wenig freier Arbeitsspeicher.";
                    else if (code == "0xC000001D") grund = " Der Prozessor kann das KI-Programm nicht ausführen.";
                    else if (code == "0xC0000135" || code == "0xC000007B") grund = " Eine Programmdatei fehlt oder ist beschädigt.";
                    else if (code == "0xC0000005") grund = " Das KI-Programm ist abgestürzt (oft zu wenig Arbeitsspeicher).";
                    llmFehler = "KI konnte nicht starten" + (code.Length > 0 ? " (Code " + code + ")" : "") + "." + grund + " " +
                        string.Join(" ", zeilen.Skip(Math.Max(0, zeilen.Length - 3))).Trim();
                    Log(llmFehler);
                    StatFehler("ki", llmFehler);
                    return;
                }
                if (HttpOk("http://127.0.0.1:" + LlmPort + "/health"))
                {
                    llmStatus = "bereit";
                    Log("KI ist bereit.");
                    StatKi("laden", ladeUhr.Elapsed.TotalSeconds);
                    // Mit Grafikkarte jetzt die Suchhilfe dazuladen (die KI hat ihren Speicher schon)
                    StarteSuchhilfe();
                    return;
                }
                // Nicht endlos warten: nach 10 Minuten aufgeben, damit der Status nicht für immer "laedt" zeigt
                if (ladeUhr.Elapsed.TotalMinutes >= 10)
                {
                    lock (Lk)
                    {
                        if (gen != llmGen) return;
                        llmGen++;
                        var h = llama;
                        try { if (h != null && !h.HasExited) { h.Kill(); h.WaitForExit(5000); } } catch { }
                        llama = null;
                        StoppeSuchhilfe();
                        llmStatus = "fehler";
                        llmFehler = "Die KI hat nach 10 Minuten noch nicht geantwortet und wurde beendet. Vielleicht ist das Modell zu groß für diesen Computer.";
                    }
                    Log(llmFehler);
                    StatFehler("ki", llmFehler);
                    return;
                }
            }
        }

        static void StoppeKi()
        {
            lock (Lk)
            {
                llmGen++;
                var l = llama;
                try { if (l != null && !l.HasExited) { l.Kill(); l.WaitForExit(5000); } } catch { }
                llama = null;
                llmStatus = "aus";
                llmFehler = "";
                StoppeSuchhilfe();
            }
        }

        // ------------------------------------------------------------------ Suchhilfe (Bedeutungsmodell)
        // Ein kleines Modell (EmbeddingGemma) sortiert die Treffer der KI-Suche nach Bedeutung statt nach
        // gleichen Wörtern. Läuft als zweiter llama-server mit --embedding, mit der KI auf der Grafikkarte, sonst auf dem Prozessor
        // (etwa 1 s je Frage). Fehlt es oder läuft es nicht, sucht die KI wie vorher.

        static Dictionary<string, object> SuchhilfeInfo()
        {
            var m = LadeJson(Path.Combine(Config, "modelle.json"));
            return m != null && m.ContainsKey("suchhilfe") ? m["suchhilfe"] as Dictionary<string, object> : null;
        }

        static string SuchhilfeDatei()
        {
            var s = SuchhilfeInfo();
            return s == null ? null : Path.Combine(Daten, "modelle", "suchhilfe", Str(s, "datei"));
        }

        static bool SuchhilfeDa()
        {
            string f = SuchhilfeDatei();
            return f != null && File.Exists(f);
        }

        static bool KiInstalliert()
        {
            return Arr(LadeJson(Path.Combine(Config, "modelle.json")), "modelle").OfType<Dictionary<string, object>>()
                .Any(m => File.Exists(Path.Combine(Daten, "modelle", Str(m, "datei"))));
        }

        // KI-Modell oder Suchhilfe nach dem Download mit der Prüfsumme aus modelle.json vergleichen (gefunden über den Dateinamen,
        // damit auch ein nach dem Neustart fortgesetzter Download geprüft wird). Ohne Eintrag wird die Datei nicht benutzt.
        static void ModellPruefen(Job j)
        {
            var konf = LadeJson(Path.Combine(Config, "modelle.json"));
            string name = Path.GetFileName(j.Ziel);
            var alle = Arr(konf, "modelle").OfType<Dictionary<string, object>>().ToList();
            var s = konf != null && konf.ContainsKey("suchhilfe") ? konf["suchhilfe"] as Dictionary<string, object> : null;
            if (s != null) alle.Add(s);
            var m = alle.FirstOrDefault(x => string.Equals(Str(x, "datei"), name, StringComparison.OrdinalIgnoreCase));
            string soll = m != null ? Str(m, "sha256") : null;
            if (string.IsNullOrEmpty(soll)) { File.Delete(j.Ziel); throw new Exception("Zu " + name + " fehlt die Prüfsumme, die Datei wird deshalb nicht benutzt."); }
            if (Sha256Datei(j.Ziel) != soll.ToLowerInvariant()) { File.Delete(j.Ziel); throw new Exception("Die Prüfsumme von " + name + " stimmt nicht. Bitte erneut versuchen."); }
        }

        static Job SuchhilfeJob()
        {
            var s = SuchhilfeInfo();
            if (s == null) return null;
            string ziel = SuchhilfeDatei();
            Directory.CreateDirectory(Path.GetDirectoryName(ziel));
            return new Job { Art = "datei", Titel = "KI: Suchhilfe (" + Str(s, "modell") + ")", Url = Str(s, "url"), Ziel = ziel, Gesamt = (long)Num(s, "bytes") };
        }

        static void StarteSuchhilfe()
        {
            lock (Lk)
            {
                if (suchhilfe != null && !suchhilfe.HasExited) return;
                if (!SuchhilfeDa()) return;
                // Läuft die KI auf der Grafikkarte, kommt die Suchhilfe dazu (40 Absätze 0,8 s statt 4,8 s). Erst wenn die KI
                // geladen ist, damit sie ihren Speicher sicher hat. Passt die Suchhilfe nicht mehr drauf oder startet sie dort
                // nicht, läuft sie wie früher auf dem Prozessor (PruefeSuchhilfeGpu).
                string gpuExe = kiBackend != "cpu" && llmStatus == "bereit" ? ProgrammPfad("llama-" + kiBackend) : null;
                if (gpuExe != null)
                {
                    try
                    {
                        var p = StarteDienst(gpuExe, SuchhilfeArgs(true), Path.Combine(Logs, "suchhilfe.log"));
                        suchhilfe = p;
                        new Thread(() => PruefeSuchhilfeGpu(p)) { IsBackground = true }.Start();
                        return;
                    }
                    catch (Exception e) { suchhilfe = null; Log("Suchhilfe auf der Grafikkarte nicht gestartet: " + e.Message); }
                }
                StarteSuchhilfeCpu();
            }
        }

        static string SuchhilfeArgs(bool gpu)
        {
            return "-m \"" + SuchhilfeDatei() + "\" --host 127.0.0.1 --port " + SuchPort + " --embedding -c 8192 -b 2048 -ub 2048 --parallel 4 -ngl " + (gpu ? "99" : "0");
        }

        // Auf dem Prozessor: das Programm für den Prozessor, sonst das der KI ohne Grafikkarte. Aufruf nur unter lock (Lk).
        static void StarteSuchhilfeCpu()
        {
            string exe = ProgrammPfad("llama-cpu") ?? ProgrammPfad("llama-" + kiBackend);
            if (exe == null) return;
            try { suchhilfe = StarteDienst(exe, SuchhilfeArgs(false), Path.Combine(Logs, "suchhilfe.log")); }
            catch (Exception e) { suchhilfe = null; Log("Suchhilfe konnte nicht starten: " + e.Message); }
        }

        // Suchhilfe auf der Grafikkarte bis 60 s beobachten: Beendet sie sich (z. B. Grafikspeicher voll) oder antwortet sie
        // nicht, wird sie auf dem Prozessor neu gestartet.
        static void PruefeSuchhilfeGpu(Process p)
        {
            var uhr = Stopwatch.StartNew();
            while (uhr.Elapsed.TotalSeconds < 60)
            {
                Thread.Sleep(1000);
                if (suchhilfe != p) return; // inzwischen gestoppt oder ersetzt
                if (p.HasExited) break;
                if (HttpOk("http://127.0.0.1:" + SuchPort + "/health")) { Log("Suchhilfe läuft auf der Grafikkarte."); return; }
            }
            lock (Lk)
            {
                if (suchhilfe != p) return;
                try { if (!p.HasExited) { p.Kill(); p.WaitForExit(5000); } } catch { }
                Log("Suchhilfe passt nicht auf die Grafikkarte, läuft auf dem Prozessor.");
                suchhilfe = null;
                StarteSuchhilfeCpu();
            }
        }

        static void StoppeSuchhilfe()
        {
            lock (Lk)
            {
                try { if (suchhilfe != null && !suchhilfe.HasExited) { suchhilfe.Kill(); suchhilfe.WaitForExit(5000); } } catch { }
                suchhilfe = null;
            }
        }

        static Process StarteDienst(string exe, string args, string logDatei)
        {
            var psi = new ProcessStartInfo(exe, args)
            {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = Path.GetDirectoryName(exe)
            };
            StreamWriter log;
            try { log = new StreamWriter(new FileStream(logDatei, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), Utf8) { AutoFlush = true }; }
            catch (Exception ex)
            {
                // Logdatei gesperrt (z. B. Virenscanner oder ein altes Programm läuft noch): ohne Log weiter
                Log("Logdatei " + Path.GetFileName(logDatei) + " nicht beschreibbar: " + ex.Message);
                log = new StreamWriter(Stream.Null);
            }
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            DataReceivedEventHandler h = (s, e) => { if (e.Data != null) lock (log) { try { log.WriteLine(e.Data); } catch { } } };
            p.OutputDataReceived += h;
            p.ErrorDataReceived += h;
            p.Exited += (s, e) => { lock (log) { try { log.Dispose(); } catch { } } };
            try { p.Start(); }
            catch { lock (log) { try { log.Dispose(); } catch { } } throw; }
            ChildJob.Add(p);
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            return p;
        }

        static bool HttpOk(string url)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 2000;
                req.Proxy = null;
                using (var r = (HttpWebResponse)req.GetResponse()) return (int)r.StatusCode < 400;
            }
            catch { return false; }
        }

        // ------------------------------------------------------------------ Ortssuche (GeoNames)

        static readonly Dictionary<string, string> OrtArten = new Dictionary<string, string>
        {
            {"HSP","Krankenhaus"},{"HSPC","Klinik"},{"MT","Berg"},{"PK","Gipfel"},{"PASS","Pass"},{"HUT","Hütte"},{"HUTS","Hütten"},
            {"LK","See"},{"STM","Fluss"},{"RSTN","Bahnhof"},{"AIRP","Flughafen"},{"CH","Kirche"},{"CSTL","Burg"},{"MUS","Museum"},
            {"SCH","Schule"},{"UNIV","Universität"},{"HTL","Hotel"},{"PRK","Park"},{"ISL","Insel"},{"VAL","Tal"},{"FRST","Wald"},
            {"PPLC","Hauptstadt"},{"PPLA","Stadt"},{"PPLA2","Stadt"},{"PPLA3","Ort"},{"PPLA4","Ort"},{"PPL","Ort"},{"PPLX","Ortsteil"},
            {"SPNG","Quelle"},{"WTRW","Wasserwerk"},{"PO","Post"},{"PS","Polizei"},{"FIRE","Feuerwehr"},{"CMP","Lager"},{"GLCR","Gletscher"}
        };

        static string Norm(string s)
        {
            if (s == null) return "";
            s = s.ToLowerInvariant().Replace("ß", "ss");
            var sb = new StringBuilder(s.Length);
            foreach (char c in s.Normalize(NormalizationForm.FormD))
                if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
            return sb.ToString();
        }

        // Gibt die Liste zurück: Der Aufrufer arbeitet damit, auch wenn ein Download das Feld gleich wieder leert
        static List<Ort> LadeOrte()
        {
            lock (OrteLk)
            {
                if (orte != null) return orte;
                var liste = new List<Ort>();
                var gesehen = new HashSet<string>();
                // Ortsart und Land kommen hunderttausendfach vor: je Wert nur eine Zeichenkette im Speicher
                var geteilt = new Dictionary<string, string>();
                Func<string, string> teilen = s => { string vorhanden; if (geteilt.TryGetValue(s, out vorhanden)) return vorhanden; geteilt[s] = s; return s; };
                foreach (var f in Directory.GetFiles(Path.Combine(Daten, "orte"), "*.txt"))
                {
                    foreach (var zeile in File.ReadLines(f, Encoding.UTF8))
                    {
                        var c = zeile.Split('\t');
                        if (c.Length < 15) continue;
                        char kl = c[6].Length > 0 ? c[6][0] : '?';
                        if (kl == 'R' || kl == 'U' || kl == 'A') continue;
                        // gleiche Orte stehen in mehreren Dateien (z. B. DE.txt und cities15000.txt): nur einmal laden
                        if (!gesehen.Add(c[0])) continue;
                        long pop; long.TryParse(c[14], out pop);
                        double lat, lon;
                        // kaputte Zeile überspringen statt die ganze Ortsliste scheitern zu lassen
                        if (!double.TryParse(c[4], NumberStyles.Float, CultureInfo.InvariantCulture, out lat)
                            || !double.TryParse(c[5], NumberStyles.Float, CultureInfo.InvariantCulture, out lon)) continue;
                        string alt = (kl == 'P' || kl == 'T' || kl == 'H') ? c[3] : "";
                        // Einige Großstädte stehen in der Ortsliste englisch: deutschen Namen zeigen,
                        // der englische bleibt suchbar
                        string name = c[1];
                        if (kl == 'P')
                        {
                            string deutsch = name == "Munich" ? "München" : name == "Nuremberg" ? "Nürnberg"
                                : name == "Vienna" ? "Wien" : name == "Geneva" ? "Genf" : null;
                            if (deutsch != null && (c[8] == "DE" || c[8] == "AT" || c[8] == "CH")) { alt = name + "," + alt; name = deutsch; }
                        }
                        string[] normAlt = null;
                        if (alt.Length > 0)
                        {
                            var teile = alt.Split(',');
                            normAlt = new string[teile.Length];
                            for (int i = 0; i < teile.Length; i++) normAlt[i] = Norm(teile[i]);
                        }
                        var o = new Ort
                        {
                            Name = name, NormName = Norm(name), Alt = alt, NormAlt = normAlt,
                            Lat = lat, Lon = lon,
                            Klasse = kl, Code = teilen(c[7]), Land = teilen(c[8]), Pop = pop
                        };
                        if (kl == 'P')
                        {
                            string gem = c[13].Length > 0 ? c[13] : c[12];
                            // Wien ist Land und Gemeinde zugleich, die Bezirke haben eigene Schlüssel
                            if (c[8] == "AT" && c[10] == "09") gem = "Wien";
                            if (gem.Length > 0) o.Gemeinde = teilen(c[8] + "|" + c[10] + "|" + c[11] + "|" + gem);
                        }
                        liste.Add(o);
                    }
                }
                orte = liste;
                return liste;
            }
        }

        static List<object> OrteSuchen(string q, int max)
        {
            var erg = new List<object>();
            string nq = Norm(q.Trim());
            if (nq.Length < 2) return erg;
            // Lokale Kopie: ein fertiger Orte-Download setzt das Feld auf null
            var liste = LadeOrte();
            string nqLeer = " " + nq, nqStrich = "-" + nq;
            // Erst nur Punktzahl, Ort und Anzeigename sammeln; die Ergebnisse nur für die besten bauen
            var treffer = new List<Tuple<double, Ort, string>>();
            foreach (var o in liste)
            {
                string nn = o.NormName;
                double score = 0;
                string anzeige = o.Name;
                // Stufen: exakter Name vor Wortanfang vor Teiltreffer (Gross-/Kleinschreibung egal)
                if (nn == nq) score = 3000;
                else if (nn.StartsWith(nq, StringComparison.Ordinal)) score = 2000;
                else if (nn.Contains(nqLeer) || nn.Contains(nqStrich)) score = 1000;
                if (score < 3000 && o.NormAlt != null)
                {
                    int beste = -1;
                    for (int i = 0; i < o.NormAlt.Length; i++)
                    {
                        string na = o.NormAlt[i];
                        double s2 = na == nq ? 2900 : na.StartsWith(nq, StringComparison.Ordinal) ? 1900 : 0;
                        if (s2 > score) { score = s2; beste = i; }
                    }
                    // Originalschreibweise nur für den Treffer heraussuchen
                    if (beste >= 0) anzeige = o.Alt.Split(',')[beste];
                }
                if (score <= 0) continue;
                // innerhalb der Stufe: Orte vor Strassen/Gebaeuden, dann Ortsart, dann Einwohner
                if (o.Klasse == 'P') score += 200;
                if (o.Code == "PPLC") score += 60;
                else if (o.Code == "PPLA") score += 50;
                else if (o.Code == "PPLA2") score += 40;
                else if (o.Code == "PPLA3") score += 30;
                else if (o.Code == "PPLA4") score += 20;
                else if (o.Code == "PPL") score += 10;
                score += Math.Min(Math.Log10(o.Pop + 1) * 10, 79);
                treffer.Add(Tuple.Create(score, o, anzeige));
            }
            // OrderByDescending sortiert stabil: gleiche Reihenfolge wie vorher
            foreach (var t in treffer.OrderByDescending(x => x.Item1).Take(max))
            {
                var o = t.Item2;
                string art;
                if (!OrtArten.TryGetValue(o.Code, out art)) art = o.Klasse == 'P' ? "Ort" : o.Klasse == 'T' ? "Gelände" : o.Klasse == 'H' ? "Gewässer" : o.Klasse == 'S' ? "Gebäude/Einrichtung" : "Ort";
                erg.Add(new Dictionary<string, object>
                {
                    {"name", t.Item3}, {"original", o.Name}, {"land", o.Land}, {"lat", o.Lat}, {"lon", o.Lon}, {"art", art}, {"einwohner", o.Pop}
                });
            }
            return erg;
        }

        // ------------------------------------------------------------------ Straßensuche („Hauptstraße Schwelm“)
        // Der Server zerlegt die Eingabe nur: Welcher Teil ist der Ort bzw. die Postleitzahl, welcher die Straße?
        // Die Straßen selbst liest die Oberfläche aus den Kartenkacheln rund um den Ort (karten.js).
        // Postleitzahlen kommen aus der GeoNames-Liste daten/orte/plz/<Land>.txt (je Postleitzahl Ort und Mittelpunkt).

        class Plz { public string Code, Anzeige, Ort, Land; public double Lat, Lon; }
        static List<Plz> plzListe;
        static Dictionary<string, List<Ort>> orteGenau;
        static List<Ort> orteGenauVon;
        static readonly object PlzLk = new object();

        static string PlzNorm(string s) { return Regex.Replace((s ?? "").ToUpperInvariant(), @"[\s\-]", ""); }

        // Wer die Ortslisten schon vor der Straßensuche hatte, bekommt die kleinen Postleitzahlen-Listen
        // (je Land höchstens 2 MB) bei der ersten Straßensuche still nachgeladen. Ohne Internet bleibt es ohne.
        static bool plzNachgeholt;
        static void PlzNachholen()
        {
            lock (PlzLk) { if (plzNachgeholt) return; plzNachgeholt = true; }
            var fehlend = new List<string>();
            try
            {
                foreach (var f in Directory.GetFiles(Path.Combine(Daten, "orte"), "*.txt"))
                {
                    string cc = Path.GetFileNameWithoutExtension(f);
                    if (Regex.IsMatch(cc, "^[A-Z]{2}$") && !File.Exists(Path.Combine(Daten, "orte", "plz", cc + ".txt"))) fehlend.Add(cc);
                }
            }
            catch { return; }
            if (fehlend.Count == 0) return;
            new Thread(() =>
            {
                foreach (var cc in fehlend)
                {
                    if (beenden) return;
                    var j = new Job { Art = "plz", Titel = "Postleitzahlen: " + cc, Url = "https://download.geonames.org/export/zip/" + cc + ".zip", Ziel = Path.Combine(Daten, "orte", "plz", cc + ".txt") };
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(j.Ziel));
                        OrteLaden(j);
                        lock (PlzLk) plzListe = null;
                    }
                    catch (Exception e)
                    {
                        Log("Postleitzahlen " + cc + " nicht geladen: " + e.Message);
                        try { File.Delete(j.Ziel + ".zip.part"); File.Delete(j.Ziel + ".zip"); } catch { }
                    }
                }
            }) { IsBackground = true }.Start();
        }

        static List<Plz> LadePlz()
        {
            lock (PlzLk)
            {
                if (plzListe != null) return plzListe;
                var liste = new List<Plz>();
                // In Deutschland haben auch Firmen und Behörden eigene Postleitzahlen („akf Bank GmbH“). Die passen
                // zu keiner Straße: nur Einträge, deren Name (oder sein Anfang, z. B. „Hamburg Klostertor“) ein Ort ist.
                // Nur Hauptnamen: unter den anderen Schreibweisen stecken viele Allerweltswörter („First“)
                var namen = new HashSet<string>();
                foreach (var o in LadeOrte()) if (o.Klasse == 'P') namen.Add(o.NormName);
                Func<string, bool> istOrt = name =>
                {
                    string n = Norm(name);
                    if (namen.Contains(n)) return true;
                    int t = n.IndexOfAny(new[] { ' ', '/', ',', '(' });
                    return t > 0 && namen.Contains(n.Substring(0, t));
                };
                string ordner = Path.Combine(Daten, "orte", "plz");
                if (Directory.Exists(ordner))
                    foreach (var f in Directory.GetFiles(ordner, "*.txt"))
                    {
                        try
                        {
                            foreach (var zeile in File.ReadLines(f, Encoding.UTF8))
                            {
                                var c = zeile.Split('\t');
                                if (c.Length < 11 || c[1].Length == 0) continue;
                                double lat, lon;
                                if (!double.TryParse(c[9], NumberStyles.Float, CultureInfo.InvariantCulture, out lat)
                                    || !double.TryParse(c[10], NumberStyles.Float, CultureInfo.InvariantCulture, out lon)) continue;
                                if (!istOrt(c[2])) continue;
                                liste.Add(new Plz { Code = PlzNorm(c[1]), Anzeige = c[1], Ort = c[2], Land = c[0], Lat = lat, Lon = lon });
                            }
                        }
                        catch { }
                    }
                plzListe = liste;
                return liste;
            }
        }

        // Bewohnte Orte nach genauem (vereinfachtem) Namen, auch andere Schreibweisen
        static Dictionary<string, List<Ort>> OrteGenau()
        {
            var liste = LadeOrte();
            lock (PlzLk)
            {
                if (orteGenau != null && orteGenauVon == liste) return orteGenau;
                var d = new Dictionary<string, List<Ort>>();
                Action<string, Ort> dazu = (n, o) =>
                {
                    if (string.IsNullOrEmpty(n)) return;
                    List<Ort> l;
                    if (!d.TryGetValue(n, out l)) d[n] = l = new List<Ort>();
                    if (!l.Contains(o)) l.Add(o);
                };
                foreach (var o in liste)
                {
                    if (o.Klasse != 'P') continue;
                    dazu(o.NormName, o);
                    if (o.NormAlt != null) foreach (var a in o.NormAlt) dazu(a, o);
                }
                orteGenau = d; orteGenauVon = liste;
                return d;
            }
        }

        static double Km(double lat1, double lon1, double lat2, double lon2)
        {
            double rad = Math.PI / 180, dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
            double a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) + Math.Cos(lat1 * rad) * Math.Cos(lat2 * rad) * Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
            return 2 * 6371 * Math.Asin(Math.Sqrt(a));
        }

        // Suchradius um den Ort: Großstädte brauchen mehr Kacheln
        static double OrtRadius(Ort o)
        {
            if (o.Code == "PPLX") return 2.5;
            return o.Pop >= 1000000 ? 15 : o.Pop >= 300000 ? 10 : o.Pop >= 100000 ? 7 : o.Pop >= 20000 ? 5 : 3;
        }

        static Dictionary<string, object> AdresseSuchen(string q)
        {
            var kandidaten = new List<Dictionary<string, object>>();
            var plzTreffer = new List<object>();
            var erg = new Dictionary<string, object> { { "kandidaten", kandidaten }, { "plz", plzTreffer } };
            q = (q ?? "").Trim();
            if (q.Length < 2 || q.Length > 200) return erg;
            PlzNachholen();
            var plz = LadePlz();
            var plzIndex = new Dictionary<string, List<Plz>>();
            foreach (var p in plz) { List<Plz> l; if (!plzIndex.TryGetValue(p.Code, out l)) plzIndex[p.Code] = l = new List<Plz>(); l.Add(p); }

            // Wörter mit Abschnitt (Komma trennt Abschnitte); Punkte wie in „Hauptstr.“ weg
            var woerter = new List<string>();
            var abschnitt = new List<int>();
            var teile = q.Split(',');
            for (int i = 0; i < teile.Length; i++)
                foreach (var w in teile[i].Split(new[] { ' ', '\t' }, StringSplitOptions.RemoveEmptyEntries))
                {
                    string t = w.Trim('.', ';', ':', '(', ')');
                    if (t.Length > 0) { woerter.Add(t); abschnitt.Add(i); }
                }

            // Postleitzahl: auch aus zwei Wörtern („802 50“, „SW1A 1AA“ → nur „SW1A“ steht in der Liste)
            List<Plz> gefunden = null;
            for (int i = 0; i < woerter.Count && gefunden == null; i++)
            {
                if (!Regex.IsMatch(woerter[i], @"\d")) continue;
                List<Plz> l;
                if (i + 1 < woerter.Count && Regex.IsMatch(woerter[i + 1], @"^\w{2,4}$") && Regex.IsMatch(woerter[i + 1], @"\d")
                    && plzIndex.TryGetValue(PlzNorm(woerter[i] + woerter[i + 1]), out l))
                { gefunden = l; woerter.RemoveRange(i, 2); abschnitt.RemoveRange(i, 2); }
                else if (Regex.IsMatch(woerter[i], @"^[A-Za-z0-9\-]{3,8}$") && plzIndex.TryGetValue(PlzNorm(woerter[i]), out l))
                { gefunden = l; woerter.RemoveAt(i); abschnitt.RemoveAt(i); }
            }
            // Hausnummern (5, 12a, 3-5) und Reste britischer Postleitzahlen weglassen: alles mit Ziffern
            for (int i = woerter.Count - 1; i >= 0; i--)
                if (Regex.IsMatch(woerter[i], @"\d")) { woerter.RemoveAt(i); abschnitt.RemoveAt(i); }

            Func<int, int, string> norm = (von, bis) => Norm(string.Join(" ", woerter.GetRange(von, bis - von)));
            Func<string, bool> strasseOk = s => Regex.Replace(s, @"[^\p{L}\p{N}]", "").Length >= 3;

            if (gefunden != null)
            {
                // Je Ort nur ein Eintrag (eine Postleitzahl kann mehrere Orte haben)
                var orteDerPlz = new List<Plz>();
                foreach (var p in gefunden) if (!orteDerPlz.Any(x => Norm(x.Ort) == Norm(p.Ort))) orteDerPlz.Add(p);
                foreach (var p in orteDerPlz)
                {
                    // Ortsname zusätzlich eingegeben („58332 Schwelm Hauptstraße“): aus der Straße herausnehmen
                    string ortN = Norm(p.Ort);
                    int von = 0, bis = woerter.Count;
                    for (int k = woerter.Count; k >= 1; k--)
                    {
                        if (norm(0, k) == ortN) { von = k; break; }
                        if (norm(woerter.Count - k, woerter.Count) == ortN) { bis = woerter.Count - k; break; }
                    }
                    string strasse = bis > von ? string.Join(" ", woerter.GetRange(von, bis - von)) : "";
                    if (strasseOk(strasse))
                        kandidaten.Add(new Dictionary<string, object> {
                            { "ort", p.Ort }, { "land", p.Land }, { "plz", p.Anzeige }, { "lat", p.Lat }, { "lon", p.Lon }, { "km", 3.0 }, { "strasse", strasse } });
                    else
                        plzTreffer.Add(new Dictionary<string, object> { { "plz", p.Anzeige }, { "ort", p.Ort }, { "land", p.Land }, { "lat", p.Lat }, { "lon", p.Lon } });
                }
            }
            else if (woerter.Count >= 2)
            {
                // Ort vorne oder hinten, aus einem oder mehreren Wörtern; längere Ortsnamen zuerst.
                // Mit Komma muss der Ort ein ganzer Abschnitt sein.
                bool komma = abschnitt.Count > 0 && abschnitt[abschnitt.Count - 1] != abschnitt[0];
                var genau = OrteGenau();
                var gesehen = new HashSet<string>();
                var hintenGenau = new HashSet<int>(); // Anfang von Ortsnamen hinten, die genau so existieren
                for (int k = woerter.Count - 1; k >= 1 && kandidaten.Count < 8; k--)
                {
                    foreach (bool vorne in new[] { true, false })
                    {
                        int ov = vorne ? 0 : woerter.Count - k, ob = vorne ? k : woerter.Count;
                        int sv = vorne ? k : 0, sb = vorne ? woerter.Count : woerter.Count - k;
                        if (komma && (abschnitt[ov] == abschnitt[sv] || abschnitt[ob - 1] == abschnitt[sb - 1]
                            || abschnitt[ov] != abschnitt[ob - 1] || abschnitt[sv] != abschnitt[sb - 1])) continue;
                        List<Ort> l;
                        if (!genau.TryGetValue(norm(ov, ob), out l)) continue;
                        if (!vorne) hintenGenau.Add(ov);
                        string strasse = string.Join(" ", woerter.GetRange(sv, sb - sv));
                        if (!strasseOk(strasse)) continue;
                        // Gleichnamige Orte: die größten, nicht doppelt (Ort und Ortsteil an derselben Stelle)
                        var gewaehlt = new List<Ort>();
                        foreach (var o in l.OrderByDescending(x => x.Pop).ThenBy(x => x.Code == "PPLX" ? 1 : 0))
                        {
                            if (gewaehlt.Count >= 4) break;
                            if (gewaehlt.Any(g => Km(g.Lat, g.Lon, o.Lat, o.Lon) < 5)) continue;
                            gewaehlt.Add(o);
                        }
                        foreach (var o in gewaehlt)
                        {
                            if (!gesehen.Add(o.Lat + "|" + o.Lon + "|" + strasse)) continue;
                            kandidaten.Add(new Dictionary<string, object> {
                                { "ort", o.Name }, { "land", o.Land }, { "plz", "" }, { "lat", o.Lat }, { "lon", o.Lon }, { "km", OrtRadius(o) }, { "strasse", strasse } });
                        }
                    }
                }
                // Ort hinten noch nicht fertig getippt („Hauptstraße Bad Tö“): Orte, die so anfangen, die größten zuerst.
                // Nur ab drei Buchstaben, nur die längste Wortfolge, zu der es solche Orte gibt, und nicht, wenn ein Ort
                // genau so heißt (fertig getipptes „Bad Tölz“ soll nicht noch „Tölzkirchen“ bringen).
                for (int k = woerter.Count - 1; k >= 1 && kandidaten.Count < 8; k--)
                {
                    int ov = woerter.Count - k;
                    if (hintenGenau.Contains(ov)) break;
                    if (komma && (abschnitt[ov] == abschnitt[ov - 1] || abschnitt[ov] != abschnitt[woerter.Count - 1])) continue;
                    string anfang = norm(ov, woerter.Count);
                    if (anfang.Replace(" ", "").Length < 3) continue;
                    string strasse = string.Join(" ", woerter.GetRange(0, ov));
                    if (!strasseOk(strasse)) continue;
                    var passend = new List<Ort>();
                    foreach (var kv in genau)
                        if (kv.Key.Length > anfang.Length && kv.Key.StartsWith(anfang, StringComparison.Ordinal)) passend.AddRange(kv.Value);
                    if (passend.Count == 0) continue;
                    var gewaehlt = new List<Ort>();
                    foreach (var o in passend.OrderByDescending(x => x.Pop).ThenBy(x => x.Code == "PPLX" ? 1 : 0))
                    {
                        if (gewaehlt.Count >= 3) break;
                        if (gewaehlt.Any(g => Km(g.Lat, g.Lon, o.Lat, o.Lon) < 5)) continue;
                        gewaehlt.Add(o);
                    }
                    foreach (var o in gewaehlt)
                    {
                        if (!gesehen.Add(o.Lat + "|" + o.Lon + "|" + strasse) || kandidaten.Count >= 8) continue;
                        kandidaten.Add(new Dictionary<string, object> {
                            { "ort", o.Name }, { "land", o.Land }, { "plz", "" }, { "lat", o.Lat }, { "lon", o.Lon }, { "km", OrtRadius(o) }, { "strasse", strasse } });
                    }
                    break;
                }
            }

            // Postleitzahlen in der Nähe jedes Orts, damit die Oberfläche zu jeder Straße die nächste zeigen kann
            foreach (var kd in kandidaten)
            {
                double lat = (double)kd["lat"], lon = (double)kd["lon"], km = (double)kd["km"] + 3;
                // Mehrere Postleitzahlen am selben Punkt (in Schweden oft alle einer Stadt): welche zu einer Straße
                // gehört, lässt sich nicht sagen, dann nur der Ort
                var nah = new List<object>();
                var amPunkt = new Dictionary<string, object[]>();
                foreach (var p in plz)
                {
                    if (Math.Abs(p.Lat - lat) >= km / 100 || Km(lat, lon, p.Lat, p.Lon) > km) continue;
                    string punkt = p.Lat.ToString(CultureInfo.InvariantCulture) + "|" + p.Lon.ToString(CultureInfo.InvariantCulture);
                    object[] da;
                    if (amPunkt.TryGetValue(punkt, out da)) { if ((string)da[0] != p.Anzeige) da[0] = ""; continue; }
                    da = new object[] { p.Anzeige, p.Ort, p.Lat, p.Lon };
                    amPunkt[punkt] = da;
                    nah.Add(da);
                }
                kd["plzNah"] = nah;
            }
            return erg;
        }

        // Rundgang: einfache Zerlegung nur für die Orte der Beispielkarte (Ortsname vorne oder hinten bzw.
        // Postleitzahl, der Rest ist die Straße), Antwort wie AdresseSuchen
        static Dictionary<string, object> UebungAdresse(string q, Dictionary<string, object> info)
        {
            var kandidaten = new List<object>();
            var plzTreffer = new List<object>();
            var erg = new Dictionary<string, object> { { "kandidaten", kandidaten }, { "plz", plzTreffer } };
            string s = " " + Regex.Replace(Norm(q ?? ""), @"[,.;:]", " ").Trim() + " ";
            s = Regex.Replace(s, @"\s+", " ");
            if (info == null || s.Trim().Length < 2) return erg;
            foreach (var e in Arr(info, "orte").OfType<Dictionary<string, object>>())
            {
                string plz = Str(e, "plz") ?? "", rest = null;
                bool perPlz = plz.Length > 0 && s.Contains(" " + plz + " ");
                if (perPlz) rest = s.Replace(" " + plz + " ", " ");
                if (rest == null || perPlz)
                    foreach (var n in Arr(e, "namen").Select(x => Norm(Convert.ToString(x))).OrderByDescending(x => x.Length))
                    {
                        string t = rest ?? s;
                        if (t.StartsWith(" " + n + " ")) { rest = t.Substring(n.Length + 1); break; }
                        if (t.EndsWith(" " + n + " ")) { rest = t.Substring(0, t.Length - n.Length - 1); break; }
                    }
                // Ort hinten noch nicht fertig getippt („Bahnhofstraße Garm“): wie AdresseSuchen ab drei Buchstaben,
                // die längste passende Wortfolge zuerst
                if (rest == null)
                {
                    var woerter = s.Trim().Split(' ');
                    var namen = Arr(e, "namen").Select(x => Norm(Convert.ToString(x))).ToList();
                    for (int k = woerter.Length - 1; k >= 1 && rest == null; k--)
                    {
                        string anfang = string.Join(" ", woerter, woerter.Length - k, k);
                        if (anfang.Replace(" ", "").Length < 3 || !namen.Any(n => n.Length > anfang.Length && n.StartsWith(anfang, StringComparison.Ordinal))) continue;
                        rest = " " + string.Join(" ", woerter, 0, woerter.Length - k) + " ";
                    }
                }
                if (rest == null) continue;
                string strasse = Regex.Replace(Regex.Replace(rest, @"\S*\d\S*", " "), @"\s+", " ").Trim();
                double lat = Num(e, "lat"), lon = Num(e, "lon");
                object nah = e.ContainsKey("plzNah") ? e["plzNah"] : new object[] { new object[] { plz, Str(e, "ort"), lat, lon } };
                if (Regex.Replace(strasse, @"[^\p{L}\p{N}]", "").Length >= 3)
                    kandidaten.Add(new Dictionary<string, object> {
                        { "ort", Str(e, "ort") }, { "land", "DE" }, { "plz", plz }, { "lat", lat }, { "lon", lon }, { "km", Num(e, "km") }, { "strasse", strasse }, { "plzNah", nah } });
                else if (perPlz && strasse.Length == 0)
                    plzTreffer.Add(new Dictionary<string, object> { { "plz", plz }, { "ort", Str(e, "ort") }, { "land", "DE" }, { "lat", lat }, { "lon", lon } });
            }
            return erg;
        }

        // Zusätzliche Ortsnamen für die Karte: In dünn besiedelten Gegenden (z. B. Nordschweden) enthalten die
        // Kartendaten bei mittlerem Zoom kaum Orte. Die Welt wird in ein festes Raster geteilt (2^stufe Felder je
        // Richtung, in Mercator wie die Kartenkacheln), je Feld kommt der wichtigste Ort zurück. Weil das Raster
        // fest ist, bleiben die Orte beim Verschieben gleich; beim Hineinzoomen teilt sich jedes Feld in vier, der
        // bisherige Ort bleibt also und es kommen nur neue dazu. Felder am Rand werden ganz berechnet.
        // Wo die Karte schon Namen hat, blendet MapLibre die zusätzlichen wegen Überlappung von selbst aus.
        // Schnellsuche der Karte: schon gelesene Kacheln mit ihren Einrichtungen, eine Zeile je Kachel
        // ("z/x/y", bei Treffern dahinter Tab und JSON). Nur abgeleitete Daten, darum im Zwischenspeicher.
        // Der Dateiname hängt an den installierten Karten (Name, Größe, Datum) und der Version der Oberfläche:
        // Neue oder geänderte Karten fangen mit einer neuen Datei an, alte Dateien werden dann gelöscht.
        static readonly object EinrichtungenLk = new object();
        static readonly Regex EinrichtungsZeile = new Regex(@"^\d{1,2}/\d{1,7}/\d{1,7}(\t\[.*\])?$");

        // Straßennamen je gelesener Kachel (Straßensuche), gleiche Form wie bei den Einrichtungen
        static string EinrichtungsDatei(string version) { return KachelDatei(version, "einrichtungen"); }
        static string StrassenDatei(string version) { return KachelDatei(version, "strassen"); }

        static string KachelDatei(string version, string art)
        {
            var sb = new StringBuilder("v" + (version ?? "1"));
            var ordner = Path.Combine(Daten, "karten");
            if (Directory.Exists(ordner))
                foreach (var f in Directory.GetFiles(ordner, "*.pmtiles").OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
                {
                    if (f.EndsWith(".neu.pmtiles") || f.EndsWith(".tmp.pmtiles")) continue;
                    var fi = new FileInfo(f);
                    sb.Append("|" + fi.Name + ":" + fi.Length + ":" + fi.LastWriteTimeUtc.Ticks);
                }
            string kennung;
            using (var h = System.Security.Cryptography.SHA256.Create())
                kennung = BitConverter.ToString(h.ComputeHash(Utf8.GetBytes(sb.ToString())), 0, 8).Replace("-", "").ToLowerInvariant();
            return Path.Combine(Daten, "cache", art, kennung + ".txt");
        }

        static string EinrichtungenLesen(string version) { return KachelnLesen(EinrichtungsDatei(version)); }

        static string KachelnLesen(string datei)
        {
            lock (EinrichtungenLk)
            {
                try { return File.Exists(datei) ? File.ReadAllText(datei, Utf8) : ""; }
                catch { return ""; }
            }
        }

        static Dictionary<string, object> EinrichtungenMerken(HttpListenerContext ctx, string version) { return KachelnMerken(ctx, EinrichtungsDatei(version)); }

        static Dictionary<string, object> KachelnMerken(HttpListenerContext ctx, string datei)
        {
            string text;
            using (var r = new StreamReader(ctx.Request.InputStream, Encoding.UTF8)) text = r.ReadToEnd();
            if (text.Length > 20000000) return new Dictionary<string, object> { { "fehler", "zu groß" } };
            var gut = new StringBuilder();
            int n = 0;
            foreach (var zeile in text.Split('\n'))
            {
                string z = zeile.TrimEnd('\r');
                if (z.Length == 0 || z.Length > 100000 || !EinrichtungsZeile.IsMatch(z)) continue;
                gut.Append(z).Append('\n');
                n++;
            }
            if (n == 0) return new Dictionary<string, object> { { "ok", true }, { "zeilen", 0 } };
            lock (EinrichtungenLk)
            {
                try
                {
                    string ordner = Path.GetDirectoryName(datei);
                    Directory.CreateDirectory(ordner);
                    // Dateien zu einem alten Kartenstand weg (die Kacheln darin gibt es so nicht mehr)
                    if (!File.Exists(datei))
                        foreach (var alt in Directory.GetFiles(ordner, "*.txt"))
                            try { File.Delete(alt); } catch { }
                    File.AppendAllText(datei, gut.ToString(), new UTF8Encoding(false));
                }
                catch (Exception e) { return new Dictionary<string, object> { { "fehler", e.Message } }; }
            }
            return new Dictionary<string, object> { { "ok", true }, { "zeilen", n } };
        }

        static List<object> OrteImAusschnitt(string bbox, string stufeText)
        {
            var erg = new List<object>();
            var t = (bbox ?? "").Split(',');
            double w, s, o, n;
            int stufe;
            if (t.Length != 4
                || !double.TryParse(t[0], NumberStyles.Float, CultureInfo.InvariantCulture, out w)
                || !double.TryParse(t[1], NumberStyles.Float, CultureInfo.InvariantCulture, out s)
                || !double.TryParse(t[2], NumberStyles.Float, CultureInfo.InvariantCulture, out o)
                || !double.TryParse(t[3], NumberStyles.Float, CultureInfo.InvariantCulture, out n)
                || !int.TryParse(stufeText, out stufe)) return erg;
            stufe = Math.Max(1, Math.Min(stufe, 14));
            s = Math.Max(s, -85); n = Math.Min(n, 85);
            if (o <= w || n <= s) return erg;
            long felder = 1L << stufe;
            Func<double, long> feldX = l => Math.Max(0, Math.Min(felder - 1, (long)Math.Floor((l + 180) / 360 * felder)));
            Func<double, long> feldY = b => Math.Max(0, Math.Min(felder - 1, (long)Math.Floor((1 - Math.Log(Math.Tan(Math.PI / 4 + b * Math.PI / 360)) / Math.PI) / 2 * felder)));
            long x0 = feldX(w), x1 = feldX(o), y0 = feldY(n), y1 = feldY(s);
            if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4000) return erg;
            // Grob vorfiltern (eine Feldbreite Rand), genau entscheidet das Feld
            double randLon = 360.0 / felder, randLat = randLon;
            var beste = new Dictionary<long, Tuple<double, Ort>>();
            foreach (var ort in LadeOrte())
            {
                if (ort.Klasse != 'P' || ort.Lon < w - randLon || ort.Lon > o + randLon || ort.Lat < s - randLat || ort.Lat > n + randLat) continue;
                long x = feldX(ort.Lon), y = feldY(ort.Lat);
                if (x < x0 || x > x1 || y < y0 || y > y1) continue;
                // Ortsteile, verlassene, zerstörte und historische Orte nicht
                string c = ort.Code;
                if (c == "PPLX" || c == "PPLQ" || c == "PPLW" || c == "PPLH" || c == "PPLCH" || c == "PPLR") continue;
                double wert = (c == "PPLC" ? 60 : c == "PPLA" ? 50 : c == "PPLA2" ? 40 : c == "PPLA3" ? 30 : c == "PPLA4" ? 20 : 10)
                    + Math.Log10(ort.Pop + 1) * 12;
                long feld = y * felder + x;
                Tuple<double, Ort> bisher;
                if (!beste.TryGetValue(feld, out bisher) || bisher.Item1 < wert) beste[feld] = Tuple.Create(wert, ort);
            }
            foreach (var b in beste.Values.OrderByDescending(v => v.Item1))
                erg.Add(new Dictionary<string, object> { { "name", b.Item2.Name }, { "lat", b.Item2.Lat }, { "lon", b.Item2.Lon }, { "rang", Math.Round(b.Item1) } });
            return erg;
        }

        // Nächster Ort zu einem angeklickten Punkt der Karte (Name, Entfernung in km, Richtung vom Ort aus).
        // Nur bewohnte Orte, ohne verlassene, zerstörte und historische. Leeres Ergebnis, wenn im Umkreis
        // von 50 km nichts liegt oder die Ortsliste fehlt.
        static Dictionary<string, object> OrtNah(string latText, string lonText)
        {
            var erg = new Dictionary<string, object>();
            double lat, lon;
            if (!double.TryParse(latText, NumberStyles.Float, CultureInfo.InvariantCulture, out lat)
                || !double.TryParse(lonText, NumberStyles.Float, CultureInfo.InvariantCulture, out lon)) return erg;
            double kosLat = Math.Cos(lat * Math.PI / 180), bester = double.MaxValue;
            Ort treffer = null;
            foreach (var ort in LadeOrte())
            {
                if (ort.Klasse != 'P') continue;
                double dLat = ort.Lat - lat;
                if (dLat > 0.5 || dLat < -0.5) continue;
                string c = ort.Code;
                if (c == "PPLQ" || c == "PPLW" || c == "PPLH" || c == "PPLCH" || c == "PPLR") continue;
                double dLon = (ort.Lon - lon) * kosLat;
                double d2 = dLat * dLat + dLon * dLon;
                if (d2 < bester) { bester = d2; treffer = ort; }
            }
            if (treffer == null) return erg;
            double km = Math.Sqrt(bester) * 111.2;
            if (km > 50) return erg;
            // Richtung vom Ort zum Punkt in acht Stufen
            double winkel = Math.Atan2((lon - treffer.Lon) * kosLat, lat - treffer.Lat) * 180 / Math.PI;
            string[] richtungen = { "nördlich", "nordöstlich", "östlich", "südöstlich", "südlich", "südwestlich", "westlich", "nordwestlich" };
            int stufe = (int)Math.Round(((winkel + 360) % 360) / 45) % 8;
            erg["name"] = treffer.Name;
            erg["km"] = Math.Round(km, 1);
            erg["richtung"] = richtungen[stufe];
            // Stadt bzw. Gemeinde dazu: der größte Ort mit demselben Gemeinde-Schlüssel (Stadtteile ausgenommen).
            // Nur wenn er anders heißt als der nächste Ort, sonst stünde derselbe Name zweimal da.
            if (treffer.Gemeinde != null)
            {
                Ort haupt = null;
                long besterWert = -1;
                foreach (var ort in LadeOrte())
                {
                    if (ort.Gemeinde != treffer.Gemeinde) continue;
                    string c = ort.Code;
                    if (c == "PPLX" || c == "PPLQ" || c == "PPLW" || c == "PPLH" || c == "PPLCH" || c == "PPLR") continue;
                    long rang = c == "PPLC" ? 5 : c == "PPLA" ? 4 : c == "PPLA2" ? 3 : c == "PPLA3" ? 2 : c == "PPLA4" ? 1 : 0;
                    long wert = ort.Pop * 10 + rang;
                    if (wert > besterWert) { besterWert = wert; haupt = ort; }
                }
                if (haupt != null && besterWert > 0 && haupt.Name != treffer.Name) erg["stadt"] = haupt.Name;
            }
            return erg;
        }

        // ------------------------------------------------------------------ Hilfen

        // Chat-Verlauf: eine JSON-Datei pro Chat in daten\chats
        static string ChatDatei(string id)
        {
            if (string.IsNullOrEmpty(id) || !System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-z0-9-]{1,40}$")) return null;
            return Path.Combine(Daten, "chats", id + ".json");
        }

        // Titel und Zeit je Chat-Datei, gemerkt mit dem Änderungszeitpunkt: nur geänderte Dateien neu lesen
        // (fragen.js holt die Liste nach jeder Antwort). Schlüssel: Dateiname; Wert: Änderungszeit, Titel, Zeit.
        static readonly Dictionary<string, Tuple<DateTime, string, string>> chatKoepfe = new Dictionary<string, Tuple<DateTime, string, string>>(StringComparer.OrdinalIgnoreCase);

        static Dictionary<string, object> ChatListe()
        {
            var liste = new List<object>();
            string ordner = Path.Combine(Daten, "chats");
            if (Directory.Exists(ordner))
            {
                var dateien = new DirectoryInfo(ordner).GetFiles("*.json").OrderByDescending(x => x.LastWriteTimeUtc).Take(300).ToList();
                lock (chatKoepfe)
                {
                    foreach (var f in dateien)
                    {
                        Tuple<DateTime, string, string> kopf;
                        if (!chatKoepfe.TryGetValue(f.Name, out kopf) || kopf.Item1 != f.LastWriteTimeUtc)
                        {
                            var c = LadeJson(f.FullName);
                            // Unlesbar: nicht merken, beim nächsten Mal erneut versuchen
                            if (c == null) { chatKoepfe.Remove(f.Name); continue; }
                            kopf = Tuple.Create(f.LastWriteTimeUtc, Str(c, "titel") ?? "Chat", Str(c, "zeit") ?? f.LastWriteTime.ToString("s"));
                            chatKoepfe[f.Name] = kopf;
                        }
                        liste.Add(new Dictionary<string, object> {
                            { "id", Path.GetFileNameWithoutExtension(f.Name) },
                            { "titel", kopf.Item2 },
                            { "zeit", kopf.Item3 } });
                    }
                    // Gelöschte (und nicht mehr gelistete) Chats vergessen
                    var da = new HashSet<string>(dateien.Select(x => x.Name), StringComparer.OrdinalIgnoreCase);
                    foreach (var weg in chatKoepfe.Keys.Where(k => !da.Contains(k)).ToList()) chatKoepfe.Remove(weg);
                }
            }
            return new Dictionary<string, object> { { "chats", liste } };
        }

        // ------------------------------------------------------------------ Zuletzt gelesen

        static readonly object ZuletztLk = new object();
        const int ZuletztMax = 10;

        static Dictionary<string, object> ZuletztListe()
        {
            lock (ZuletztLk)
            {
                return new Dictionary<string, object> { { "liste", Arr(LadeJson(Path.Combine(Daten, "zuletzt.json")), "liste") } };
            }
        }

        // Eintrag nach oben setzen; derselbe Artikel bzw. dasselbe Buch steht nur einmal drin, höchstens zehn Einträge
        static Dictionary<string, object> ZuletztMerken(Dictionary<string, object> b)
        {
            string url = Str(b, "url"), titel = Str(b, "titel");
            if (string.IsNullOrEmpty(url) || !(url.StartsWith("/kiwix/") || url.StartsWith("/api/eigene/datei/") || url.StartsWith("/gesichert/")) || string.IsNullOrEmpty(titel))
                return new Dictionary<string, object> { { "fehler", "Ungültiger Eintrag." } };
            var neu = new Dictionary<string, object> {
                { "url", url.Length > 2000 ? url.Substring(0, 2000) : url },
                { "titel", titel.Length > 200 ? titel.Substring(0, 200) : titel },
                { "paket", Str(b, "paket") ?? "" },
                { "pdf", Bool(b, "pdf") },
                { "zeit", DateTime.Now.ToString("s") } };
            int seite;
            if (int.TryParse(Convert.ToString(b.ContainsKey("seite") ? b["seite"] : null), out seite) && seite > 0) neu["seite"] = seite;
            lock (ZuletztLk)
            {
                var alt = ZuletztListe()["liste"] as object[];
                var liste = new List<object> { neu };
                foreach (var o in alt)
                {
                    var e = o as Dictionary<string, object>;
                    if (e == null || Str(e, "url") == url) continue;
                    if (liste.Count >= ZuletztMax) break;
                    liste.Add(e);
                }
                SicherSchreiben(Path.Combine(Daten, "zuletzt.json"), Json.Serialize(new Dictionary<string, object> { { "liste", liste } }));
            }
            return new Dictionary<string, object> { { "ok", true } };
        }

        // ------------------------------------------------------------------ Merkliste

        // Selbst gemerkte Sachen aus allen Bereichen (daten/merkliste.json): { ordner: [{ id, name }], liste: [...] }.
        // Ein Eintrag: id, titel, bereich (bibliothek, kochen, erstehilfe, vorsorge), ordner ("" = ohne Ordner), zeit und
        // entweder url (Artikel, PDF-Buch mit pdf/seite, eigene Unterlage) oder link (Seite in Fieldbook, z. B.
        // "#erstehilfe?l=…"). Mit stelle ist es eine markierte Textstelle. Die früheren Lesezeichen
        // (daten/lesezeichen.json) werden beim ersten Laden übernommen.
        static readonly object MerkLk = new object();
        static string MerkDatei { get { return Path.Combine(Daten, "merkliste.json"); } }
        const int MerkMax = 1000, MerkOrdnerMax = 100;

        static string MerkId() { return Guid.NewGuid().ToString("N").Substring(0, 12); }

        static Dictionary<string, object> MerkLaden()
        {
            var d = LadeJson(MerkDatei);
            if (d != null) return d;
            var liste = new List<object>();
            foreach (var o in Arr(LadeJson(Path.Combine(Daten, "lesezeichen.json")), "liste"))
            {
                var e = o as Dictionary<string, object>;
                if (e == null || string.IsNullOrEmpty(Str(e, "url"))) continue;
                e["id"] = MerkId();
                e["bereich"] = "bibliothek";
                e["ordner"] = "";
                liste.Add(e);
            }
            d = new Dictionary<string, object> { { "ordner", new object[0] }, { "liste", liste.ToArray() } };
            // Gleich speichern, sonst bekämen die übernommenen Einträge bei jedem Laden neue Kennungen
            if (liste.Count > 0) try { SicherSchreiben(MerkDatei, Json.Serialize(d)); } catch (Exception e) { Log("Merkliste speichern: " + e.Message); }
            return d;
        }

        static string Kuerzen(string s, int n) { s = (s ?? "").Trim(); return s.Length > n ? s.Substring(0, n) : s; }

        static int MerkSeite(Dictionary<string, object> e)
        {
            int s;
            return int.TryParse(Convert.ToString(e.ContainsKey("seite") ? e["seite"] : null, CultureInfo.InvariantCulture), out s) && s > 0 ? s : 0;
        }

        // Gleich sind Einträge mit derselben Adresse, Seite und Textstelle
        static bool MerkGleich(Dictionary<string, object> a, Dictionary<string, object> b)
        {
            return (Str(a, "url") ?? "") == (Str(b, "url") ?? "") && (Str(a, "link") ?? "") == (Str(b, "link") ?? "") &&
                MerkSeite(a) == MerkSeite(b) && (Str(a, "stelle") ?? "") == (Str(b, "stelle") ?? "");
        }

        static Dictionary<string, object> MerkFehler(string text) { return new Dictionary<string, object> { { "fehler", text } }; }

        static Dictionary<string, object> MerkAendern(Dictionary<string, object> b)
        {
            string aktion = Str(b, "aktion") ?? "", id = Str(b, "id") ?? "";
            lock (MerkLk)
            {
                var d = MerkLaden();
                var liste = Arr(d, "liste").OfType<Dictionary<string, object>>().ToList();
                var ordner = Arr(d, "ordner").OfType<Dictionary<string, object>>().ToList();
                Dictionary<string, object> eintrag = liste.FirstOrDefault(x => Str(x, "id") == id);
                Dictionary<string, object> ord = ordner.FirstOrDefault(x => Str(x, "id") == id);
                string neueId = null;
                switch (aktion)
                {
                    case "setzen":
                    {
                        string url = Str(b, "url") ?? "", link = Str(b, "link") ?? "";
                        bool urlOk = url.StartsWith("/kiwix/") || url.StartsWith("/api/eigene/datei/") || url.StartsWith("/gesichert/");
                        bool linkOk = Regex.IsMatch(link, "^#(erstehilfe|vorsorge|kochen)\\?[^\\s]{1,300}$");
                        if (urlOk == linkOk || url.Length > 2000) return MerkFehler("Ungültiger Eintrag für die Merkliste.");
                        var neu = new Dictionary<string, object>();
                        if (urlOk) neu["url"] = url; else neu["link"] = link;
                        int seite = MerkSeite(b);
                        if (seite > 0) neu["seite"] = seite;
                        string stelle = Kuerzen(Str(b, "stelle"), 1500);
                        if (stelle.Length > 0) neu["stelle"] = stelle;
                        liste.RemoveAll(x => MerkGleich(x, neu));
                        if (Bool(b, "an"))
                        {
                            string titel = Kuerzen(Str(b, "titel"), 200);
                            if (titel.Length == 0) return MerkFehler("Ungültiger Eintrag für die Merkliste.");
                            string bereich = Str(b, "bereich") ?? "";
                            if (!new[] { "bibliothek", "kochen", "erstehilfe", "vorsorge" }.Contains(bereich)) bereich = "bibliothek";
                            string o = Str(b, "ordner") ?? "";
                            if (!ordner.Any(x => Str(x, "id") == o)) o = "";
                            neu["id"] = neueId = MerkId();
                            neu["titel"] = titel;
                            neu["bereich"] = bereich;
                            neu["ordner"] = o;
                            neu["paket"] = Kuerzen(Str(b, "paket"), 200);
                            neu["pdf"] = Bool(b, "pdf");
                            neu["zeit"] = DateTime.Now.ToString("s");
                            liste.Insert(0, neu);
                            if (liste.Count > MerkMax) liste.RemoveRange(MerkMax, liste.Count - MerkMax);
                        }
                        break;
                    }
                    case "entfernen":
                        if (eintrag != null) liste.Remove(eintrag);
                        break;
                    case "umbenennen":
                    {
                        string titel = Kuerzen(Str(b, "titel"), 200);
                        if (eintrag == null || titel.Length == 0) return MerkFehler("Der Name konnte nicht geändert werden.");
                        eintrag["titel"] = titel;
                        break;
                    }
                    case "verschieben":
                    {
                        string o = Str(b, "ordner") ?? "";
                        if (eintrag == null || (o != "" && !ordner.Any(x => Str(x, "id") == o))) return MerkFehler("Der Eintrag konnte nicht verschoben werden.");
                        eintrag["ordner"] = o;
                        break;
                    }
                    case "ordnerNeu":
                    {
                        string name = Kuerzen(Str(b, "name"), 60);
                        if (name.Length == 0) return MerkFehler("Bitte gib dem Ordner einen Namen.");
                        if (ordner.Count >= MerkOrdnerMax) return MerkFehler("Es gibt schon " + MerkOrdnerMax + " Ordner.");
                        ordner.Add(new Dictionary<string, object> { { "id", neueId = MerkId() }, { "name", name } });
                        break;
                    }
                    case "ordnerUmbenennen":
                    {
                        string name = Kuerzen(Str(b, "name"), 60);
                        if (ord == null || name.Length == 0) return MerkFehler("Der Ordner konnte nicht umbenannt werden.");
                        ord["name"] = name;
                        break;
                    }
                    case "ordnerLoeschen":
                        // Die Einträge bleiben erhalten und stehen danach ohne Ordner da
                        if (ord != null) { ordner.Remove(ord); foreach (var x in liste) if (Str(x, "ordner") == id) x["ordner"] = ""; }
                        break;
                    default:
                        return MerkFehler("Unbekannte Aktion.");
                }
                var neuD = new Dictionary<string, object> { { "ordner", ordner.ToArray() }, { "liste", liste.ToArray() } };
                SicherSchreiben(MerkDatei, Json.Serialize(neuD));
                if (neueId != null) neuD["neu"] = neueId;
                return neuD;
            }
        }

        static Dictionary<string, object> LadeJson(string pfad)
        {
            return LadeJsonRoh(pfad) as Dictionary<string, object>;
        }

        static readonly HashSet<string> sicherungGemeldet = new HashSet<string>();

        // JSON lesen (Objekt oder Liste). Fehlt die Datei oder ist sie kaputt (z. B. Stromausfall beim Schreiben),
        // die vorige Fassung (.bak) nehmen, die SicherSchreiben hinterlässt.
        static object LadeJsonRoh(string pfad)
        {
            object d = JsonLesen(pfad);
            if (d != null) return d;
            string bak = pfad + ".bak";
            if (!File.Exists(bak)) return null;
            d = JsonLesen(bak);
            if (d != null)
                lock (sicherungGemeldet)
                    if (sicherungGemeldet.Add(pfad))
                        Log(Path.GetFileName(pfad) + (File.Exists(pfad) ? " ist beschädigt" : " fehlt") + ", die vorige Fassung (.bak) wird benutzt.");
            return d;
        }

        static object JsonLesen(string pfad)
        {
            try
            {
                if (!File.Exists(pfad)) return null;
                return Json.DeserializeObject(File.ReadAllText(pfad, Encoding.UTF8));
            }
            catch { return null; }
        }

        // Datei sicher schreiben: erst in <ziel>.tmp, dann austauschen; die alte Fassung bleibt als <ziel>.bak.
        // So liegt auch nach einem Stromausfall mittendrin immer eine lesbare Fassung da.
        static void SicherSchreiben(string ziel, string text)
        {
            string tmp = ziel + ".tmp", bak = ziel + ".bak";
            byte[] b = Utf8.GetBytes(text);
            using (var fs = new FileStream(tmp, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                fs.Write(b, 0, b.Length);
                fs.Flush(true); // wirklich auf den Datenträger, nicht nur in den Zwischenspeicher
            }
            if (File.Exists(ziel))
            {
                try { File.Replace(tmp, ziel, bak, true); return; }
                catch (Exception e)
                {
                    // Manche Laufwerke (z. B. Netzlaufwerke) können das nicht: von Hand sichern und ersetzen
                    Log("Austauschen von " + Path.GetFileName(ziel) + " ging nicht (" + e.Message + "), wird kopiert.");
                    if (File.Exists(ziel)) { File.Copy(ziel, bak, true); File.Delete(ziel); }
                }
            }
            File.Move(tmp, ziel);
        }

        // Gegenstück zu SicherSchreiben: auch .bak und .tmp löschen, sonst käme die alte Fassung beim Lesen zurück
        static void SicherLoeschen(string ziel)
        {
            foreach (var f in new[] { ziel + ".tmp", ziel + ".bak", ziel })
                if (File.Exists(f)) File.Delete(f);
        }

        static void SpeichereEinst()
        {
            try { SicherSchreiben(Path.Combine(Daten, "einstellungen.json"), Json.Serialize(einst)); }
            catch (Exception e) { Log("Einstellungen speichern: " + e.Message); }
            StatusCacheLeeren();
        }

        static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return null;
            return Convert.ToString(v, CultureInfo.InvariantCulture);
        }

        static double Num(Dictionary<string, object> d, string k)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return 0;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return 0; }
        }

        static bool Bool(Dictionary<string, object> d, string k)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return false;
            return v is bool ? (bool)v : Convert.ToString(v) == "true";
        }

        static object[] Arr(Dictionary<string, object> d, string k)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null) return new object[0];
            var a = v as object[];
            if (a != null) return a;
            var l = v as System.Collections.ArrayList;
            return l != null ? l.ToArray() : new object[0];
        }
    }

    // Sorgt dafür, dass Kiwix, KI und Downloads beendet werden, wenn das Fenster geschlossen wird.
    public static class ChildJob
    {
        [StructLayout(LayoutKind.Sequential)]
        struct BASIC { public long a, b; public uint LimitFlags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
        [StructLayout(LayoutKind.Sequential)]
        struct IOC { public ulong a, b, c, d, e, f; }
        [StructLayout(LayoutKind.Sequential)]
        struct EXT { public BASIC Basic; public IOC Io; public UIntPtr a, b, c, d; }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, uint len);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);

        static IntPtr handle;

        public static void Init()
        {
            handle = CreateJobObject(IntPtr.Zero, null);
            var info = new EXT();
            info.Basic.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            int len = Marshal.SizeOf(typeof(EXT));
            IntPtr p = Marshal.AllocHGlobal(len);
            Marshal.StructureToPtr(info, p, false);
            SetInformationJobObject(handle, 9, p, (uint)len);
            Marshal.FreeHGlobal(p);
        }

        public static void Add(Process p)
        {
            try { if (handle != IntPtr.Zero) AssignProcessToJobObject(handle, p.Handle); } catch { }
        }
    }
}

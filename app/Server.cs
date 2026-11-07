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
        public double Lat, Lon;
        public long Pop;
        public char Klasse;
    }

    public static class App
    {
        public const string Version = "0.7.3.1";
        static string Root, AppDir, Web, Config, Daten, Prog, Logs;
        static int Port, KiwixPort, LlmPort, SuchPort, RoutePort;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
        static readonly object Lk = new object();
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        static Process kiwix, llama, brouter, suchhilfe;
        static string llmStatus = "aus", llmFehler = "", llmModell = "";
        static int llmGen = 0;

        static List<Job> jobs = new List<Job>();
        static Thread worker;
        static volatile bool abbrechen;
        static readonly HashSet<Process> jobProzesse = new HashSet<Process>();

        static void ProzessMerken(Process p, bool an) { lock (jobProzesse) { if (an) jobProzesse.Add(p); else jobProzesse.Remove(p); } }

        static void AlleDownloadsStoppen()
        {
            lock (jobProzesse) foreach (var p in jobProzesse) try { if (!p.HasExited) p.Kill(); } catch { }
        }

        static Dictionary<string, object> einst;
        static Dictionary<string, Dictionary<string, object>> katalog;
        static bool katalogOnline;
        static string planetUrl;

        static List<Ort> orte;
        static readonly object OrteLk = new object();

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

            Log("Fieldbook " + Version + " läuft.");

            new Thread(delegate ()
            {
                Aufraeumen();
                AufgabenPfadPruefen();
                try { DesktopSymbolPruefen(); } catch { }
                StarteKiwix();
                StarteRouting();
                if (!Bool(einst, "sparmodus")) StarteKi();
                try { FortsetzenBeimStart(); } catch (Exception e) { Log("Fortsetzen: " + e.Message); }
                // Einmal beim Start kurz nach einer neuen Fieldbook-Version fragen (eine kleine Anfrage, abschaltbar)
                try { if (UpdateBeimStart() && UpdateApi() != null && !IstEntwicklungsordner()) ProgrammUpdateSuchen(); } catch { }
            }) { IsBackground = true }.Start();
            // Gemerkte Rückmeldungen verschicken, sobald Internet da ist
            new Thread(FeedbackHintergrund) { IsBackground = true }.Start();
            // Wochenpaket der Nutzungsstatistik (nur mit Zustimmung)
            new Thread(StatHintergrund) { IsBackground = true }.Start();

            // Nach einem Neustart durch das Programm-Update ist der Browser schon offen
            string neustartMarke = Path.Combine(Daten, "cache", "neustart");
            bool nachNeustart = File.Exists(neustartMarke);
            if (nachNeustart) try { File.Delete(neustartMarke); } catch { }
            // Ist vom letzten Mal noch ein Fieldbook-Tab offen, meldet er sich gleich wieder (alle 5 s).
            // Dann diesen Tab nutzen statt einen neuen zu öffnen.
            if (Environment.GetEnvironmentVariable("OW_KEIN_BROWSER") == null && !nachNeustart)
                new Thread(delegate ()
                {
                    for (int i = 0; i < 14 && !TabOffen(10); i++) Thread.Sleep(500);
                    if (TabOffen(10) && BrowserNachVorne()) Log("Der offene Fieldbook-Tab im Browser wird weiter benutzt.");
                    else BrowserOeffnen();
                }) { IsBackground = true }.Start();

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

        static void BrowserOeffnen()
        {
            try { Process.Start(new ProcessStartInfo("http://localhost:" + Port + "/") { UseShellExecute = true }); } catch { }
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
            string pfad = ctx.Request.Url.AbsolutePath;
            try
            {
                if (pfad == "/kiwix" || pfad.StartsWith("/kiwix/"))
                {
                    // Abgestürzt (Prozess beendet, ohne dass Fieldbook ihn gestoppt hat): gleich neu starten
                    if (kiwix != null && kiwix.HasExited) KiwixWiederbeleben();
                    if (kiwix == null || kiwix.HasExited) { SendeText(ctx, 503, "Die Bibliothek ist nicht gestartet (keine Wissenspakete installiert?)."); return; }
                    // RawUrl statt Url.PathAndQuery: Url entschlüsselt "%25" zu "%", dann findet Kiwix
                    // Dateien mit Sonderzeichen im Namen nicht mehr (z. B. "%252C" für ein Komma)
                    if (IfixitUmleiten(ctx)) return;
                    Weiterleiten(ctx, KiwixPort, ctx.Request.RawUrl);
                }
                else if (pfad.StartsWith("/route/"))
                {
                    if (brouter == null || brouter.HasExited) { SendeText(ctx, 503, "Die Routenplanung ist nicht eingerichtet."); return; }
                    Weiterleiten(ctx, RoutePort, ctx.Request.RawUrl.Substring(6));
                }
                else if (pfad.StartsWith("/llm/"))
                {
                    if (llmStatus != "bereit") { SendeJson(ctx, new Dictionary<string, object> { { "error", "KI ist nicht bereit (" + llmStatus + ")" } }, 503); return; }
                    Weiterleiten(ctx, LlmPort, ctx.Request.RawUrl.Substring(4));
                }
                else if (pfad.StartsWith("/suchhilfe/"))
                {
                    if (suchhilfe == null || suchhilfe.HasExited) { SendeJson(ctx, new Dictionary<string, object> { { "error", "Suchhilfe läuft nicht" } }, 503); return; }
                    Weiterleiten(ctx, SuchPort, ctx.Request.RawUrl.Substring(10));
                }
                else if (pfad.StartsWith("/api/")) Api(ctx, pfad.Substring(5));
                else if (pfad.StartsWith("/karten/")) SendeDatei(ctx, SichererPfad(Path.Combine(Daten, "karten"), pfad.Substring(8)));
                else if (pfad.StartsWith("/karten-assets/")) SendeDatei(ctx, SichererPfad(Path.Combine(Prog, "karten-assets"), pfad.Substring(15)));
                else if (pfad.StartsWith("/config/")) SendeDatei(ctx, SichererPfad(Config, pfad.Substring(8)));
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
            {".md","text/plain; charset=utf-8"},{".jpg","image/jpeg"},{".webp","image/webp"},{".wasm","application/wasm"}
        };

        static void SendeDatei(HttpListenerContext ctx, string pfad)
        {
            var res = ctx.Response;
            if (pfad == null || !File.Exists(pfad)) { SendeText(ctx, 404, "Nicht gefunden"); return; }
            var fi = new FileInfo(pfad);
            string typ;
            res.ContentType = Mime.TryGetValue(fi.Extension, out typ) ? typ : "application/octet-stream";
            res.AddHeader("Accept-Ranges", "bytes");
            res.AddHeader("Cache-Control", fi.Extension == ".pmtiles" || fi.Extension == ".pbf" ? "max-age=86400" : "no-cache");
            long start = 0, ende = fi.Length - 1;
            string range = ctx.Request.Headers["Range"];
            if (range != null)
            {
                var m = Regex.Match(range, @"bytes=(\d*)-(\d*)");
                if (m.Success)
                {
                    if (m.Groups[1].Value == "") { long n = long.Parse(m.Groups[2].Value); start = Math.Max(0, fi.Length - n); }
                    else
                    {
                        start = long.Parse(m.Groups[1].Value);
                        if (m.Groups[2].Value != "") ende = Math.Min(ende, long.Parse(m.Groups[2].Value));
                    }
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
            req.Timeout = 15 * 60 * 1000;
            req.ReadWriteTimeout = 15 * 60 * 1000;
            req.AutomaticDecompression = DecompressionMethods.None;
            if (rq.Headers["Accept"] != null) req.Accept = rq.Headers["Accept"];
            if (rq.Headers["Range"] != null)
            {
                var m = Regex.Match(rq.Headers["Range"], @"bytes=(\d+)-(\d*)");
                if (m.Success)
                {
                    if (m.Groups[2].Value == "") req.AddRange(long.Parse(m.Groups[1].Value));
                    else req.AddRange(long.Parse(m.Groups[1].Value), long.Parse(m.Groups[2].Value));
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
                    try { res.AddHeader(h, resp.Headers[h]); } catch { }
                }
                string loc = resp.Headers["Location"];
                if (loc != null) res.RedirectLocation = loc.Replace("http://127.0.0.1:" + port, "");
                byte[] zusatz = resp.StatusCode == HttpStatusCode.OK ? KiwixZusatz(rq.Url.AbsolutePath) : null;
                if (zusatz != null) { res.Headers.Remove("ETag"); res.Headers.Set("Cache-Control", "no-cache"); }
                // Artikel aus Kiwix bekommen das Fieldbook-Design (Schriften, dunkle Farben), schon vor dem ersten Zeichnen
                if (rq.HttpMethod != "HEAD" && rq.Url.AbsolutePath.StartsWith("/kiwix/")
                    && resp.ContentType != null && resp.ContentType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase))
                {
                    byte[] html;
                    using (var s = resp.GetResponseStream())
                    using (var ms = new MemoryStream()) { s.CopyTo(ms); html = ArtikelDesign(IfixitSeiteFiltern(rq, ms.ToArray())); }
                    res.Headers.Remove("ETag");
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
                    if (!File.Exists(Path.Combine(Daten, "wissen", buch + ".zim"))) { File.Delete(d); Log("iFixit-Übersicht der alten Version gelöscht: " + buch); }
                }
            }
            catch (Exception e) { Log("iFixit-Übersicht aufräumen: " + e.Message); }
        }

        static void IfixitVorbereiten()
        {
            try
            {
                if (kiwix == null || kiwix.HasExited) return;
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
                if (ifixitBaum == null && ifixitStatus != "laeuft")
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
                    var opt = new System.Threading.Tasks.ParallelOptions { MaxDegreeOfParallelism = 6 };
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
                if (fehlgeschlagen <= baum.Count / 100)
                {
                    Directory.CreateDirectory(Path.Combine(Daten, "cache"));
                    File.WriteAllText(Path.Combine(Daten, "cache", "ifixit-" + buch + ".json"), Json.Serialize(voll), Utf8);
                }
                lock (IfixitLk) if (ifixitBuch == buch) { ifixitBaum = voll; ifixitStatus = "fertig"; IfixitFilterBauen(buch, voll); }
                Log("iFixit-Übersicht: " + baum.Count + " Geräteseiten (" + leer + " ohne Anleitung), " + wurzel.Anzahl + " Anleitungen, " + fehlgeschlagen + " Seiten nicht lesbar.");
            }
            catch (Exception e)
            {
                lock (IfixitLk) if (ifixitBuch == buch) { ifixitStatus = "fehler"; ifixitFehler = e.Message; }
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
                if (fehlgeschlagen <= gefunden.Count / 100)
                {
                    Directory.CreateDirectory(Path.Combine(Daten, "cache"));
                    File.WriteAllText(Path.Combine(Daten, "cache", "artikel-" + buch + ".json"), Json.Serialize(liste), Utf8);
                }
                lock (ArtikelLk) { artikelListen[buch] = liste; artikelGelesen.Remove(buch); }
                Log("Artikelliste " + buch + ": " + liste.Count + " Artikel, " + fehlgeschlagen + " Seiten nicht lesbar.");
            }
            catch (Exception e)
            {
                lock (ArtikelLk) artikelGelesen.Remove(buch);
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
                else if (n.EndsWith(".json")) d[n.Substring(0, n.Length - 5)] = true;
            }
            return d;
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
            string f = PdfFertigDatei(buch);
            bool fertig = File.Exists(f);
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
            if (File.Exists(PdfFertigDatei(buch))) return new Dictionary<string, object> { { "fertig", true }, { "dateien", new string[0] } };
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
                    File.WriteAllText(PdfFertigDatei(buch), Json.Serialize(new Dictionary<string, object> { { "buch", buch }, { "dateien", alle } }), Utf8);
                    try { File.Delete(PdfTeilDatei(buch)); } catch { }
                    Log("PDF-Text für " + buch + ": " + alle.Count + " Bücher ausgelesen.");
                    return new Dictionary<string, object> { { "ok", true } };
                }
                string datei = Str(b, "datei");
                if (string.IsNullOrEmpty(datei)) return new Dictionary<string, object> { { "fehler", "Datei fehlt." } };
                var zeile = new Dictionary<string, object> { { "datei", datei }, { "titel", Str(b, "titel") ?? datei }, { "seiten", Arr(b, "seiten") } };
                File.AppendAllText(PdfTeilDatei(buch), Json.Serialize(zeile) + "\n", Utf8);
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
                        try { File.Delete(PdfFertigDatei(kv.Key)); } catch { }
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

        // Volltextsuche über die Seiten (BM25). Seiten mit allen Suchwörtern zählen mehr; von zwei
        // benachbarten Seiten derselben Stelle kommt nur die bessere, die nächste Seite liest die KI ohnehin mit.
        static List<object> PdfSuche(string buch, string q, int max)
        {
            var erg = new List<object>();
            if (!PdfPaketOk(buch) || string.IsNullOrWhiteSpace(q)) return erg;
            var b = PdfLaden(buch);
            if (b == null) return erg;
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
                double norm = 1.2 * (0.25 + 0.75 * s.Length / b.Schnitt);
                double p = 0;
                int abgedeckt = 0;
                for (int w = 0; w < woerter.Count; w++)
                {
                    int tf = z[w + 2];
                    if (tf == 0) continue;
                    abgedeckt++;
                    double idf = Math.Log(1 + (gesamt - df[w] + 0.5) / (df[w] + 0.5));
                    p += idf * tf * 2.2 / (tf + norm);
                }
                p *= (double)abgedeckt / woerter.Count;
                if (woerter.Count > 1 && s.IndexOf(satz, StringComparison.OrdinalIgnoreCase) >= 0) p *= 1.5;
                // Inhaltsverzeichnisse und Stichwortlisten nennen das Wort, erklären aber nichts
                if (Regex.Matches(s, @"(\. ?){5,}").Count > 4) p *= 0.3;
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
                erg.Add(new Dictionary<string, object> {
                    { "titel", d.Titel + ", Seite " + seite },
                    { "url", "/api/pdftext/seite/" + buch + "/" + z[0] + "/" + seite },
                    { "pdf", "/kiwix/content/" + buch + "/files/" + Uri.EscapeDataString(d.Datei) + "#page=" + seite },
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
            string titel = WebUtility.HtmlEncode(d.Titel + ", Seite " + seite);
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
            switch (was)
            {
                case "pdftext/stand": SendeJson(ctx, PdfStand(Q("buch"))); return;
                case "pdftext/speichern": SendeJson(ctx, PdfSpeichern(LeseBody(ctx))); return;
                case "pdftext/suche":
                    {
                        int n;
                        if (!int.TryParse(Q("n"), out n)) n = 5;
                        SendeJson(ctx, PdfSuche(Q("buch"), Q("q"), Math.Min(20, Math.Max(1, n))));
                        return;
                    }
                case "status":
                    // Nur Anfragen aus einem Fieldbook-Tab zählen (der Browser schickt die Herkunftsseite mit)
                    if (ctx.Request.UrlReferrer != null) Interlocked.Exchange(ref tabZuletzt, DateTime.UtcNow.Ticks);
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
                    try { SendeJson(ctx, ProgrammUpdateSuchen()); }
                    catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "version", Version }, { "fehler", e.Message }, { "bereit", BereitVersion() }, { "eingerichtet", UpdateApi() != null } }); }
                    return;
                case "programmupdate/installieren":
                    SendeJson(ctx, ProgrammUpdateJetzt());
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
                        File.WriteAllText(d, Json.Serialize(b), Utf8);
                        SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        return;
                    }
                case "chat/loeschen":
                    {
                        string d = ChatDatei(Str(LeseBody(ctx), "id"));
                        try { if (d != null && File.Exists(d)) File.Delete(d); } catch { }
                        SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        return;
                    }
                // Lernstand im Erste-Hilfe-Kurs (wandert mit dem daten-Ordner mit)
                case "erstehilfe":
                    SendeJson(ctx, (object)LadeJson(Path.Combine(Daten, "erstehilfe.json")) ?? new Dictionary<string, object>());
                    return;
                case "erstehilfe/speichern":
                    {
                        var b = LeseBody(ctx);
                        try { File.WriteAllText(Path.Combine(Daten, "erstehilfe.json"), Json.Serialize(b), Utf8); }
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
                        try { File.WriteAllText(Path.Combine(Daten, "vorsorge.json"), Json.Serialize(b), Utf8); }
                        catch (Exception e) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", e.Message } }); return; }
                        SendeJson(ctx, new Dictionary<string, object> { { "ok", true } });
                        return;
                    }
                case "routengroesse": SendeJson(ctx, RoutenGroesse((Q("ids") ?? "").Split(','))); return;
                case "installieren": SendeJson(ctx, Installieren(LeseBody(ctx))); return;
                case "sprechen": Sprechen(ctx, Q("sprache"), Q("paar"), Q("erwartet")); return;
                case "vorlesen": Vorlesen(ctx); return;
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
                    new Thread(delegate () { Thread.Sleep(400); StoppeKi(); StoppeKiwix(); StoppeRouting(); Environment.Exit(0); }).Start();
                    return;
                default: SendeText(ctx, 404, "Unbekannt"); return;
            }
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

            var karten = new List<object>();
            var reg = LadeJson(Path.Combine(Config, "karten.json"));
            foreach (var r in Arr(reg, "regionen"))
            {
                var d = (Dictionary<string, object>)r;
                if (File.Exists(Path.Combine(Daten, "karten", Str(d, "id") + ".pmtiles"))) karten.Add(d);
            }
            bool aktiv = worker != null && worker.IsAlive;
            return new Dictionary<string, object>
            {
                {"version", Version},
                {"setupFertig", Bool(einst, "setupFertig")},
                {"wissen", Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim").Length},
                {"bibliothek", kiwix != null && !kiwix.HasExited},
                {"bibliothekFehler", kiwixFehler},
                {"desktopSymbol", File.Exists(DesktopLnk())},
                {"proxy", Str(einst, "proxy") ?? ""},
                {"unterbrochen", unterbrochen},
                {"uebersetzer", UebersetzerBereit()},
                {"uebersetzerAlt", UebersetzerBereit() && !UebersetzerNeu()},
                {"sprachen", InstallierteSprachen()},
                {"spracheingabe", SpracheingabeBereit()},
                {"spracheingabeKomplett", SpracheingabeBereit() && SprachModelle().All(m => File.Exists(SprachModellPfad(m)))},
                {"stimmen", Stimmen()},
                {"stimmenFehlen", StimmenJobs(InstallierteSprachen()).Where(x => x.Art == "stimme").Select(x => x.Ziel).ToArray()},
                {"defektePakete", kiwixDefekt.ToArray()},
                {"pdfTexte", PdfTexte()},
                {"ki", new Dictionary<string, object> { {"status", llmStatus}, {"fehler", llmFehler}, {"modell", llmModell}, {"kontext", AktuellesModellKontext()}, {"suchhilfe", suchhilfe != null && !suchhilfe.HasExited} }},
                {"modell", Str(einst, "modell")},
                {"backend", Str(einst, "backend") ?? "cpu"},
                {"sparmodus", Bool(einst, "sparmodus")},
                {"akku", akku},
                {"karten", karten},
                {"kartenAssets", Directory.Exists(Path.Combine(Prog, "karten-assets", "fonts"))},
                {"orte", Directory.GetFiles(Path.Combine(Daten, "orte"), "*.txt").Length > 0},
                {"routen", brouter != null && !brouter.HasExited},
                {"routenKacheln", Directory.GetFiles(Path.Combine(Daten, "routen"), "*.rd5").Select(f => Path.GetFileNameWithoutExtension(f)).ToArray()},
                {"downloadAktiv", aktiv},
                {"land", Str(einst, "land")},
                {"landErkannt", WindowsLand()},
                {"sprache", Str(einst, "sprache") ?? "de"},
                {"programmNeu", progUpdate != null && Bool(progUpdate, "verfuegbar") ? Str(progUpdate, "neu") : null},
                {"programmBereit", BereitVersion()},
                {"start", StartKennung},
                {"updateBeimStart", UpdateBeimStart()},
                {"statistikFehler", StatFehlerAn()},
                {"statistikNutzung", StatNutzungAn()},
                {"statistikGefragt", Bool(einst, "statistikGefragt")},
                {"statistikEingerichtet", FeedbackUrl() != null}
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

        static Dictionary<string, object> Hardware()
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

            var ms = new MEMORYSTATUSEX();
            double ram = 0, ramFrei = 0;
            if (GlobalMemoryStatusEx(ms)) { ram = ms.ullTotalPhys / 1073741824.0; ramFrei = ms.ullAvailPhys / 1073741824.0; }
            h["ramGB"] = Math.Round(ram, 1);
            h["ramFreiGB"] = Math.Round(ramFrei, 1);

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
                string datei = ZimDatei(name, fl);
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
            var eigene = new List<object>();
            foreach (var f in Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim")) eigene.Add(Path.GetFileName(f));
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
                {"einstellungen", einst}
            };
        }

        static string ZimDatei(string name, string flavour)
        {
            string muster = "^" + Regex.Escape(name) + (string.IsNullOrEmpty(flavour) ? "" : "_" + Regex.Escape(flavour)) + @"_\d{4}-\d{2}[a-z]?\.zim$";
            string treffer = null;
            foreach (var f in Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim"))
            {
                string n = Path.GetFileName(f);
                if (Regex.IsMatch(n, muster, RegexOptions.IgnoreCase) && (treffer == null || string.CompareOrdinal(n, treffer) > 0)) treffer = n;
            }
            return treffer;
        }

        static void LadeKiwixKatalog(bool neu)
        {
            string cache = Path.Combine(Daten, "cache", "kiwix-katalog.xml");
            if (katalog != null && !neu) return;
            string xml = null;
            bool alt = !File.Exists(cache) || (DateTime.Now - File.GetLastWriteTime(cache)).TotalHours > 24;
            if (neu || alt)
            {
                try
                {
                    xml = HoleText("https://library.kiwix.org/catalog/v2/entries?count=20000", 90000);
                    File.WriteAllText(cache, xml, Utf8);
                    katalogOnline = true;
                }
                catch { xml = null; }
            }
            else katalogOnline = true;
            if (xml == null && File.Exists(cache)) xml = File.ReadAllText(cache, Utf8);
            katalog = ParseKatalog(xml);
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
            File.WriteAllText(datei, Json.Serialize(daten), Utf8);

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

        static bool StatFehlerAn() { return Bool(einst, "statistikFehler"); }
        static bool StatNutzungAn() { return Bool(einst, "statistikNutzung"); }

        // Nur unter StatLk aufrufen
        static Dictionary<string, object> StatLaden()
        {
            if (stat == null) stat = LadeJson(StatDatei) ?? new Dictionary<string, object>();
            if (Str(stat, "id") == null) stat["id"] = NeueStatId();
            return stat;
        }

        static void StatSpeichern() { try { File.WriteAllText(StatDatei, Json.Serialize(stat), Utf8); } catch { } }

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
        static void StatKi(string feld, double wert)
        {
            if (!StatFehlerAn() || double.IsNaN(wert) || wert <= 0 || wert > 100000) return;
            lock (StatLk)
            {
                string m = (Str(einst, "modell") ?? "?") + "|" + (Str(einst, "backend") ?? "cpu");
                var k = Unter(Unter(StatLaden(), "ki"), m);
                k[feld + "Summe"] = Math.Round(Num(k, feld + "Summe") + wert, 2);
                k[feld + "Anzahl"] = (int)Num(k, feld + "Anzahl") + 1;
                StatSpeichern();
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
                        if (!f.EndsWith(".neu.pmtiles")) karten.Add(Path.GetFileNameWithoutExtension(f));
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
                { "gesendet", gesendet }, { "paket", an ? (object)StatPaket() : null } };
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
                    try { if (File.Exists(StatDatei)) File.Delete(StatDatei); } catch { }
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
                    StatKi("antwort", Num(b, "antwort"));
                    StatKi("lesen", Num(b, "lesen"));
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
            string p = (Str(einst, "proxy") ?? "").Trim();
            if (p == "") return null;
            return p.Contains("://") ? p : "http://" + p;
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
            string eigen = EigenerProxy();
            IWebProxy p = eigen != null ? new WebProxy(eigen) : WebRequest.GetSystemWebProxy();
            p.Credentials = CredentialCache.DefaultCredentials;
            WebRequest.DefaultWebProxy = p;
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
                    d["meldung"] = "Die sichere Verbindung wird gestört, oft durch eine Firewall oder einen Virenscanner, der verschlüsselte Verbindungen prüft.";
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
            return string.Join(",", Arr(r, "bbox").Select(x => Convert.ToDouble(x).ToString(CultureInfo.InvariantCulture)));
        }

        static readonly Dictionary<string, Dictionary<string, object>> groessenCache = new Dictionary<string, Dictionary<string, object>>();

        static Dictionary<string, object> KartenGroesse(string id, string maxzoom)
        {
            var r = Region(id);
            if (r == null) return new Dictionary<string, object> { { "fehler", "Unbekannte Region" } };
            string mz = string.IsNullOrEmpty(maxzoom) ? (Str(r, "maxzoom") ?? "15") : maxzoom;
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

        static string Ausfuehren(string exe, string args, int timeout)
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
            return LadeJson(Path.Combine(Config, "programme.json"))[id] as Dictionary<string, object>;
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
            lock (Lk)
            {
                // Laufen schon Downloads, kommen die neuen in dieselbe Warteschlange
                bool dazu = worker != null && worker.IsAlive;
                if (dazu && !warteschlange) return new Dictionary<string, object> { { "fehler", "Gerade läuft eine Aktualisierung. Neue Downloads gehen danach." } };
                if (dazu && (abschluss || abbrechen)) return new Dictionary<string, object> { { "fehler", "Die laufenden Downloads werden gerade beendet. Bitte gleich noch einmal versuchen." } };
                var bisher = jobs;
                if (!dazu) abbrechen = false;
                jobs = new List<Job>();
                LadeKiwixKatalog(false);

                // Einrichtungs-Assistent abgeschlossen: ab jetzt startet das Dashboard, auch wenn noch geladen wird
                if (Bool(b, "abschliessen")) einst["setupFertig"] = true;
                string modellId = Str(b, "modell");
                string backend = Str(b, "backend") ?? Str(einst, "backend") ?? "cpu";
                var pakete = Arr(b, "pakete").Select(x => Convert.ToString(x)).ToList();
                var karten = Arr(b, "karten");

                if (pakete.Count > 0 && ProgrammPfad("kiwix") == null) jobs.Add(ProgrammJob("kiwix"));

                // "modell" wird die aktive KI, "modelle" (Seite Inhalte) werden nur geladen
                var modellIds = Arr(b, "modelle").Select(x => Convert.ToString(x)).ToList();
                if (!string.IsNullOrEmpty(modellId) && !modellIds.Contains(modellId)) modellIds.Add(modellId);
                if (modellIds.Count > 0)
                {
                    if (ProgrammPfad("llama-" + backend) == null) jobs.Add(ProgrammJob("llama-" + backend));
                    foreach (var o in Arr(LadeJson(Path.Combine(Config, "modelle.json")), "modelle"))
                    {
                        var m = (Dictionary<string, object>)o;
                        if (!modellIds.Contains(Str(m, "id"))) continue;
                        string ziel = Path.Combine(Daten, "modelle", Str(m, "datei"));
                        if (!File.Exists(ziel))
                            jobs.Add(new Job { Art = "datei", Titel = "KI: " + Str(m, "name") + " (" + Str(m, "modell") + ")", Url = Str(m, "url"), Ziel = ziel, Gesamt = (long)Num(m, "bytes") });
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
                        if (ProgrammPfad("llama-" + backend) == null && ProgrammPfad("llama-cpu") == null && !jobs.Any(x => x.Art == "programm" && x.Ziel == "llama-" + backend)) jobs.Add(ProgrammJob("llama-" + backend));
                        jobs.Add(sj);
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
                        jobs.Add(new Job { Art = "zim", Titel = Str(p, "titel"), Url = url, Ziel = ziel, Gesamt = (long)e["bytes"], Extra = Str(p, "name") + "|" + (Str(p, "flavour") ?? "") });
                    }
                }

                if (karten.Length > 0)
                {
                    if (ProgrammPfad("pmtiles") == null) jobs.Add(ProgrammJob("pmtiles"));
                    if (ProgrammPfad("karten-assets") == null) jobs.Add(ProgrammJob("karten-assets"));
                }
                var orteNoetig = new List<string>();
                foreach (var o in karten)
                {
                    var k = o as Dictionary<string, object>;
                    string id = k != null ? Str(k, "id") : Convert.ToString(o);
                    var r = Region(id);
                    if (r == null) continue;
                    string mz = (k != null ? Str(k, "maxzoom") : null) ?? Str(r, "maxzoom") ?? "15";
                    long gesamt = k != null ? (long)Num(k, "bytes") : 0;
                    string ziel = Path.Combine(Daten, "karten", id + ".pmtiles");
                    if (!File.Exists(ziel))
                        jobs.Add(new Job { Art = "karte", Titel = "Karte: " + Str(r, "titel"), Ziel = ziel, Gesamt = gesamt, Extra = BboxText(r) + "|" + mz });
                    foreach (var cc in Arr(r, "orte")) if (!orteNoetig.Contains(Convert.ToString(cc))) orteNoetig.Add(Convert.ToString(cc));
                }
                // Routenplanung: Java, BRouter und Wegedaten für die gewählten Regionen
                var routenRegionen = Arr(b, "routen").Select(x => Convert.ToString(x)).ToList();
                if (routenRegionen.Count > 0)
                {
                    if (ProgrammPfad("java") == null) jobs.Add(ProgrammJob("java"));
                    if (ProgrammPfad("brouter") == null) jobs.Add(ProgrammJob("brouter"));
                    var liste = SegmentListe();
                    var geplant = new HashSet<string>();
                    foreach (var rid in routenRegionen)
                    {
                        var r = Region(rid);
                        if (r == null) continue;
                        foreach (var kachel in RoutenKacheln(r))
                        {
                            string ziel = Path.Combine(Daten, "routen", kachel + ".rd5");
                            if (!liste.ContainsKey(kachel) || File.Exists(ziel) || !geplant.Add(kachel)) continue;
                            jobs.Add(new Job { Art = "route", Titel = "Wegedaten " + kachel, Url = SegmentBasis + kachel + ".rd5", Ziel = ziel, Gesamt = liste[kachel] });
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
                    jobs.Add(new Job { Art = "uebersetzer", Titel = Str(u, "titel") ?? "Übersetzer", Gesamt = (long)(Num(u, "mb") * 1048576) });
                }
                foreach (var c in sprachen)
                {
                    if (sprachenDa.Contains(c)) continue;
                    var si = SprachInfo(c);
                    jobs.Add(new Job { Art = "sprache", Titel = "Sprache: " + Str(si, "name"), Ziel = c, Gesamt = (long)(Num(si, "mb") * 1048576) });
                }
                // Stimmen zum Vorlesen nur auf Wunsch („Text + Sprache“), für neue oder schon installierte Sprachen;
                // Deutsch kommt mit der ersten Stimme mit
                var mitStimme = Arr(b, "stimmen").Select(x => Convert.ToString(x))
                    .Where(c => sprachen.Contains(c) || sprachenDa.Contains(c)).ToList();
                if (mitStimme.Count > 0) jobs.AddRange(StimmenJobs(mitStimme).Where(x => x.Art != "programm" || !jobs.Any(y => y.Art == "programm" && y.Ziel == x.Ziel)));
                // Spracheingabe: Programm (whisper.cpp) und die beiden Modelle
                if (Bool(b, "spracheingabe"))
                {
                    if (ProgrammPfad("whisper") == null) jobs.Add(ProgrammJob("whisper"));
                    foreach (var m in SprachModelle())
                        if (!File.Exists(SprachModellPfad(m)))
                            jobs.Add(new Job { Art = "sprachmodell", Titel = Str(m, "titel"), Url = Str(m, "url"), Ziel = SprachModellPfad(m), Gesamt = (long)Num(m, "bytes"), Extra = Str(m, "id") });
                }
                foreach (var cc in orteNoetig)
                {
                    string ziel = Path.Combine(Daten, "orte", cc + ".txt");
                    if (!File.Exists(ziel))
                        jobs.Add(new Job { Art = "orte", Titel = "Ortsnamen: " + cc, Url = "https://download.geonames.org/export/dump/" + cc + ".zip", Ziel = ziel });
                }
                // Kleine Downloads zuerst (Hilfsprogramme ganz vorne, die brauchen andere Schritte;
                // pmtiles als allererstes, ohne es kann keine Karte laden)
                var neu = jobs.OrderBy(x => x.Art == "programm" ? 0 : 1).ThenBy(x => x.Art == "programm" && x.Ziel == "pmtiles" ? 0 : 1).ThenBy(x => x.Gesamt).ToList();
                if (dazu)
                {
                    // Was schon wartet oder lädt, nicht doppelt aufnehmen
                    var offen = new HashSet<string>(bisher.Where(x => x.Status == "wartet" || x.Status == "laeuft").Select(x => x.Art + "|" + x.Ziel));
                    neu = neu.Where(x => !offen.Contains(x.Art + "|" + x.Ziel)).ToList();
                    jobs = bisher.Concat(neu).ToList();
                }
                else jobs = neu;
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

        // Bis zu 3 Downloads gleichzeitig aus einer gemeinsamen Warteschlange (jobs). Während ein Durchgang
        // läuft, kann Installieren() neue Jobs anhängen; die Helfer holen sie sich von selbst.
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

        // Nächster Job: erst die Hilfsprogramme (Karten brauchen z. B. pmtiles), dann der kleinste.
        // Kleine Pakete sind so nebenbei fertig, und langsame Spiegel bremsen weniger.
        static Job NaechsterJob(out bool warten)
        {
            warten = false;
            var wartend = jobs.Where(x => x.Status == "wartet").ToList();
            var programm = wartend.FirstOrDefault(x => x.Art == "programm");
            if (programm != null) return programm;
            if (jobs.Any(x => x.Art == "programm" && x.Status == "laeuft")) { warten = wartend.Count > 0; return null; }
            return wartend.OrderBy(x => x.Gesamt).FirstOrDefault();
        }

        static void Helfer()
        {
            while (true)
            {
                Job j;
                bool warten;
                lock (Lk)
                {
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
                lock (Lk) WarteschlangeMerken();
            }
        }

        static void JobAusfuehren(Job j)
        {
            try
            {
                switch (j.Art)
                {
                    case "programm":
                        if (j.Ziel.StartsWith("llama")) StoppeKi();
                        if (j.Ziel == "kiwix") StoppeKiwix();
                        if (j.Ziel == "java" || j.Ziel == "brouter") StoppeRouting();
                        ProgrammLaden(j);
                        if (j.Ziel.StartsWith("llama")) neueKi = true;
                        break;
                    case "datei":
                        Herunterladen(j, j.Url, j.Ziel);
                        neueKi = true;
                        // KI gleich starten, nicht erst wenn alle anderen Downloads fertig sind
                        if (!Bool(einst, "sparmodus")) new Thread(delegate () { StoppeKi(); StarteKi(); }) { IsBackground = true }.Start();
                        break;
                    case "zim":
                        Herunterladen(j, j.Url, j.Ziel);
                        AlteVersionenLoeschen(j);
                        // Bibliothek sofort mit dem neuen Paket (neu) starten
                        StarteKiwix();
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
                j.Status = abbrechen ? "abgebrochen" : "fehler";
                j.Fehler = e.Message;
                Log("Fehler bei " + j.Titel + ": " + e.Message);
                if (!abbrechen) StatFehler("download", j.Art + " " + j.Titel + ": " + e.Message);
            }
        }

        static void AbschlussArbeiten()
        {
            if (neueOrte) lock (OrteLk) orte = null;
            if (brouter == null || brouter.HasExited) StarteRouting();
            if (kiwix == null || kiwix.HasExited) StarteKiwix();
            lock (Lk)
            {
                if (jobs.All(x => x.Status == "fertig")) einst["setupFertig"] = true;
                SpeichereEinst();
                WarteschlangeMerken();
            }
            // Neue KI-Programme (llama.cpp) oder KI noch nicht gestartet
            if (llmStatus == "aus" || llmStatus == "fehler" || (neueKi && llmStatus != "bereit" && llmStatus != "laedt"))
            {
                if (!Bool(einst, "sparmodus")) { StoppeKi(); StarteKi(); }
            }
        }

        static void AlteVersionenLoeschen(Job j)
        {
            // Ältere Ausgaben desselben Pakets und andere Varianten derselben Gruppe (z. B. Wikipedia kompakt,
            // wenn jetzt die mit Bildern geladen wurde): je Gruppe bleibt nur eine Variante
            var arten = new List<string> { j.Extra };
            try
            {
                var liste = Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete").Cast<Dictionary<string, object>>().ToList();
                var selbst = liste.FirstOrDefault(p => Str(p, "name") + "|" + (Str(p, "flavour") ?? "") == j.Extra);
                string gruppe = selbst == null ? null : Str(selbst, "gruppeExklusiv");
                if (!string.IsNullOrEmpty(gruppe))
                    foreach (var p in liste) if (Str(p, "gruppeExklusiv") == gruppe) arten.Add(Str(p, "name") + "|" + (Str(p, "flavour") ?? ""));
            }
            catch { }
            var muster = arten.Distinct().Select(a =>
            {
                var t = a.Split('|');
                return "^" + Regex.Escape(t[0]) + (t[1] == "" ? "" : "_" + Regex.Escape(t[1])) + @"_\d{4}-\d{2}[a-z]?\.zim$";
            }).ToList();
            string neu = Path.GetFileName(j.Ziel);
            foreach (var f in Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim"))
            {
                string n = Path.GetFileName(f);
                if (n != neu && muster.Any(m => Regex.IsMatch(n, m, RegexOptions.IgnoreCase)))
                {
                    StoppeKiwix();
                    try { File.Delete(f); } catch { }
                }
            }
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
                if (remote > 0 && new FileInfo(part).Length == remote)
                {
                    File.Move(part, ziel);
                    j.Bytes = remote;
                    return;
                }
            }
            int code = CurlLaden(j, url, part);
            // Kiwix verteilt Downloads auf Spiegelserver. Scheitert einer, beim nächsten weitermachen
            // (curl setzt die .part-Datei fort, alle Spiegel haben dieselbe Datei).
            if (code != 0 && Regex.IsMatch(url, @"^https?://download\.kiwix\.org/", RegexOptions.IgnoreCase))
            {
                foreach (var spiegel in KiwixSpiegel(url).Take(4))
                {
                    if (abbrechen) break;
                    Log("Download " + j.Titel + ": versuche Spiegelserver " + new Uri(spiegel).Host);
                    code = CurlLaden(j, spiegel, part);
                    if (code == 0) break;
                }
            }
            if (abbrechen) throw new Exception("Abgebrochen");
            if (code != 0) throw new Exception(CurlMeldung(code));
            if (File.Exists(ziel)) File.Delete(ziel);
            File.Move(part, ziel);
            j.Bytes = new FileInfo(ziel).Length;
            if (j.Gesamt <= 0) j.Gesamt = j.Bytes;
        }

        // Ein Durchlauf von curl; gibt den Rückgabewert zurück (0 = fertig). Fehlertexte kommen ins Protokoll.
        static int CurlLaden(Job j, string url, string part)
        {
            string curl = Path.Combine(Environment.SystemDirectory, "curl.exe");
            string proxy = ProxyFuer(url);
            string args = "-L --fail -sS --retry 5 --retry-delay 3 --connect-timeout 30 -A \"Fieldbook/" + Version + "\" -C - -o \"" + part + "\" \"" + url + "\"" + (ladeLimit > 0 ? " --limit-rate " + Math.Max(8, ladeLimit / 1000) + "k" : "")
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
                p.BeginErrorReadLine();
                p.BeginOutputReadLine();
                while (!p.WaitForExit(500))
                {
                    try { if (File.Exists(part)) j.Bytes = new FileInfo(part).Length; } catch { }
                    if (abbrechen) { try { p.Kill(); } catch { } throw new Exception("Abgebrochen"); }
                }
                p.WaitForExit();
                ProzessMerken(p, false);
                if (p.ExitCode != 0)
                {
                    string text;
                    lock (fehler) text = fehler.ToString().Trim();
                    Log("Download " + j.Titel + " fehlgeschlagen (curl " + p.ExitCode + ", " + new Uri(url).Host + "): " + text);
                    try { File.AppendAllText(Path.Combine(Logs, "downloads.log"), DateTime.Now.ToString("yyyy-MM-dd HH:mm") + " " + j.Titel + " (curl " + p.ExitCode + ", " + url + "): " + text + Environment.NewLine, Utf8); } catch { }
                }
                return p.ExitCode;
            }
        }

        // Verständliche Meldung zu curl-Rückgabewerten (Einzelheiten in daten\logs\downloads.log)
        static string CurlMeldung(int code)
        {
            switch (code)
            {
                case 5: return "Der Proxy wurde nicht gefunden. Bitte unter Einstellungen → Internetverbindung prüfen.";
                case 6: return "Server nicht gefunden. Kein Internet, oder ein Werbeblocker/DNS-Filter sperrt die Adresse. „Verbindung prüfen“ zeigt, welche.";
                case 7: return "Verbindung abgelehnt. Eine Firewall könnte die Adresse sperren. „Verbindung prüfen“ zeigt, welche.";
                case 22: return "Der Server hat die Datei verweigert oder nicht gefunden. Vielleicht gibt es inzwischen eine neuere Version; bitte später erneut versuchen.";
                case 23: return "Die Datei konnte nicht gespeichert werden. Ist genug Platz auf dem Laufwerk?";
                case 28: return "Zeitüberschreitung: Der Server antwortet nicht. Bitte später erneut versuchen.";
                case 35: case 60: return "Die sichere Verbindung wird gestört, oft durch eine Firewall oder einen Virenscanner, der verschlüsselte Verbindungen prüft.";
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
            string name = Path.GetFileName(datei);
            string endung = Path.GetExtension(name).ToLowerInvariant();
            string art = null, titel = null, ziel = null;
            if (endung == ".zim")
            {
                art = "wissen"; ziel = Path.Combine(Daten, "wissen", name); titel = name;
                foreach (var o in pakete)
                {
                    var p = (Dictionary<string, object>)o;
                    if (Regex.IsMatch(name, "^" + Regex.Escape(Str(p, "name")) + (string.IsNullOrEmpty(Str(p, "flavour")) ? "" : "_" + Regex.Escape(Str(p, "flavour"))) + @"_\d{4}-\d{2}[a-z]?\.zim$"))
                    { titel = Str(p, "titel"); break; }
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
            return new Dictionary<string, object> { { "datei", datei }, { "art", art }, { "titel", titel }, { "ziel", ziel }, { "bytes", bytes }, { "vorhanden", vorhanden } };
        }

        static Dictionary<string, object> ImportPruefen(string ordner)
        {
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
                if (!File.Exists(datei)) continue;
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
        static void WarteschlangeMerken()
        {
            if (!warteschlange) return;
            var laufend = jobs.Where(x => x.Status == "wartet" || x.Status == "laeuft").ToList();
            // Warten noch unterbrochene Downloads auf "Fortsetzen", diese nicht vergessen
            if (unterbrochen > 0) laufend.AddRange(GemerkteDownloads().Where(g => !laufend.Any(x => x.Ziel == g.Ziel)));
            var offen = laufend.Select(x => (object)new Dictionary<string, object>
            {
                { "art", x.Art }, { "titel", x.Titel }, { "url", x.Url }, { "ziel", x.Ziel }, { "gesamt", x.Gesamt }, { "extra", x.Extra }
            }).ToList();
            try
            {
                if (offen.Count == 0) { if (File.Exists(DownloadDatei())) File.Delete(DownloadDatei()); }
                else File.WriteAllText(DownloadDatei(), Json.Serialize(offen), Utf8);
            }
            catch (Exception e) { Log("Warteschlange merken: " + e.Message); }
        }

        static List<Job> GemerkteDownloads()
        {
            var liste = new List<Job>();
            if (!File.Exists(DownloadDatei())) return liste;
            try
            {
                foreach (var o in (Json.DeserializeObject(File.ReadAllText(DownloadDatei(), Utf8)) as object[]) ?? new object[0])
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
            Einreihen(liste);
        }

        static Dictionary<string, object> Fortsetzen()
        {
            var liste = GemerkteDownloads();
            unterbrochen = 0;
            if (liste.Count == 0) return new Dictionary<string, object> { { "fehler", "Es gibt keine unterbrochenen Downloads." } };
            return Einreihen(liste);
        }

        // Jobs in die Warteschlange stellen (wie Installieren, aber mit fertigen Jobs)
        static Dictionary<string, object> Einreihen(List<Job> neu)
        {
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
            if (File.Exists(j.Ziel))
            {
                if (j.Extra == "wissen") StoppeKiwix();
                File.Delete(j.Ziel);
            }
            File.Move(part, j.Ziel);
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
                    TeilLaden(j, fertig, Str(f, "url"), ziel);
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
            Herunterladen(j, j.Url, zip);
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
            var t = j.Extra.Split('|');
            string tmp = j.Ziel.Replace(".pmtiles", ".tmp.pmtiles");
            const int Versuche = 3;
            for (int versuch = 1; ; versuch++)
            {
                string fehler = KarteVersuch(j, exe, t, tmp);
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
                File.WriteAllText(Path.Combine(Daten, "karten", id + ".json"), Json.Serialize(new Dictionary<string, object> { { "bbox", t[0] }, { "maxzoom", t[1] } }), Utf8);
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
                p.BeginErrorReadLine();
                p.BeginOutputReadLine();
                while (!p.WaitForExit(500))
                {
                    if (abbrechen) { try { p.Kill(); } catch { } throw new Exception("Abgebrochen"); }
                }
                p.WaitForExit();
                ProzessMerken(p, false);
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
                        string f = ZimDatei(Str(p, "name"), Str(p, "flavour") ?? "");
                        if (f != null) { StoppeKiwix(); File.Delete(Path.Combine(Daten, "wissen", f)); StarteKiwix(); }
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
                        string pd = Path.Combine(Prog, "piper");
                        lock (vorlesenLk) if (Directory.Exists(pd)) Directory.Delete(pd, true);
                    }
                }
                else if (art == "spracheingabe")
                {
                    lock (sprechenLk)
                    {
                        foreach (var m in SprachModelle()) if (File.Exists(SprachModellPfad(m))) File.Delete(SprachModellPfad(m));
                        string d = Path.Combine(Prog, "whisper");
                        if (Directory.Exists(d)) Directory.Delete(d, true);
                    }
                }
                return new Dictionary<string, object> { { "ok", true } };
            }
            catch (Exception e) { return new Dictionary<string, object> { { "fehler", e.Message } }; }
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
            StarteKiwixDienst();
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
        static DateTime kiwixWiederbelebt = DateTime.MinValue;
        static void KiwixWiederbeleben()
        {
            lock (KiwixLk)
            {
                if (kiwix == null || !kiwix.HasExited) return;
                if ((DateTime.Now - kiwixWiederbelebt).TotalSeconds < 30) return;
                kiwixWiederbelebt = DateTime.Now;
                int code = -1;
                try { code = kiwix.ExitCode; } catch { }
                Log("Bibliothek war abgestürzt (Code " + code + "), wird neu gestartet.");
                StarteKiwix();
            }
        }

        static bool KiwixLaeuft(string exe, string args, string log, int versuche)
        {
            kiwix = StarteDienst(exe, args, log);
            for (int i = 0; i < versuche; i++)
            {
                if (kiwix.HasExited) { kiwix = null; return false; }
                if (HttpOk("http://127.0.0.1:" + KiwixPort + "/kiwix/")) return true;
                Thread.Sleep(250);
            }
            // Große Pakete brauchen manchmal länger: läuft der Prozess noch, gilt der Start als gelungen
            return kiwix != null && !kiwix.HasExited;
        }

        static void StoppeKiwix()
        {
            lock (Lk)
            {
                try { if (kiwix != null && !kiwix.HasExited) { kiwix.Kill(); kiwix.WaitForExit(5000); } } catch { }
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
                if (a != null && Bool(a, "an") && Str(einst, "aufgabenPfad") != Root) AufgabenAnlegen();
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
                "<Triggers><LogonTrigger><Delay>PT5M</Delay><UserId>" + System.Security.SecurityElement.Escape(Environment.UserDomainName + "\\" + Environment.UserName) + "</UserId></LogonTrigger><CalendarTrigger><StartBoundary>" + start + "</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>" +
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
                catch { }
            }
            // Wissenspakete: neuere Ausgabe im Kiwix-Katalog?
            foreach (var o in Arr(LadeJson(Path.Combine(Config, "pakete.json")), "pakete"))
            {
                var p = (Dictionary<string, object>)o;
                string name = Str(p, "name"), fl = Str(p, "flavour") ?? "";
                string datei = ZimDatei(name, fl);
                if (datei == null) continue;
                Dictionary<string, object> e;
                if (!KatalogFuerName(name).TryGetValue(name + "|" + fl, out e)) continue;
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
                string mz = Str(meta, "maxzoom") ?? Str(r, "maxzoom") ?? "15";
                liste.Add(new Dictionary<string, object> { { "art", "karte" }, { "titel", "Karte: " + Str(r, "titel") }, { "ziel", Path.Combine(Daten, "karten", id + ".neu.pmtiles") }, { "bytes", fi.Length }, { "extra", BboxText(r) + "|" + mz } });
            }
            return liste;
        }

        static void Pruefen(bool popup, bool mitProgramm = true)
        {
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
                    if (ok && getaktet) d["getaktetErlaubt"] = true;
                    if (wahl == 2) KuenftigAutomatisch();
                }
            }
            d["freigegeben"] = ok;
            File.WriteAllText(AktDatei, Json.Serialize(d), Utf8);
            if (ok) File.WriteAllText(AktFlag, DateTime.Now.ToString("s")); else try { File.Delete(AktFlag); } catch { }
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
                    var req = (HttpWebRequest)WebRequest.Create("http://localhost:8090/api/aktualisierung");
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
            if (Environment.GetEnvironmentVariable("OW_GETAKTET") == "1" && !Bool(d, "getaktetErlaubt")) { AktLog("Getaktete Verbindung, Download später."); return; }
            bool nurLeerlauf = Str(AktEinst(), "wann") == "leerlauf";
            try { Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.Idle; } catch { }
            Aufraeumen();
            bool fertig = false;
            string grund = null;
            var waechter = new Thread(delegate ()
            {
                while (!fertig)
                {
                    if (nurLeerlauf && NutzerAktiv()) grund = "Computer wird benutzt";
                    else if (nurLeerlauf && AufAkku()) grund = "Akkubetrieb";
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

        // Im Programm: Knopf "Jetzt herunterladen" in den Einstellungen
        static Dictionary<string, object> UpdatesJetztLaden()
        {
            lock (Lk)
            {
                if (worker != null && worker.IsAlive) return new Dictionary<string, object> { { "fehler", "Es läuft bereits ein Download." } };
                var d = LadeJson(AktDatei);
                if (d == null || Arr(d, "updates").Length == 0) return new Dictionary<string, object> { { "fehler", "Keine Aktualisierungen gefunden." } };
                abbrechen = false;
                warteschlange = false;
                jobs = new List<Job>();
                worker = new Thread(delegate ()
                {
                    UpdatesAusfuehren(d, jobs);
                    if (Arr(d, "updates").Length == 0) try { File.Delete(AktFlag); } catch { }
                    Aufraeumen();
                    // Neue Fieldbook-Version bereitgelegt? Dann gleich neu starten, das spielt sie ein.
                    if (BereitVersion() != null) { Neustart(); return; }
                    StarteKiwix();
                    StarteRouting();
                    if (llmStatus == "bereit") StarteSuchhilfe();
                }) { IsBackground = true };
                foreach (var o in Arr(d, "updates")) { var u = (Dictionary<string, object>)o; jobs.Add(new Job { Titel = Str(u, "titel"), Gesamt = (long)Num(u, "bytes") }); }
                worker.Start();
                return new Dictionary<string, object> { { "ok", true } };
            }
        }

        // Neue Versionen liegen kurz neben den alten (Karten als .neu.pmtiles, Pakete bis die alte gelöscht ist).
        // Reicht der Platz nicht, das Update auslassen; es bleibt in der Liste und wird später erneut versucht.
        static void PlatzPruefen(Job j)
        {
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
                if (abbrechen) break;
                j.Art = Str(u, "art"); j.Url = Str(u, "url"); j.Ziel = Str(u, "ziel"); j.Extra = Str(u, "extra"); j.Gesamt = (long)Num(u, "bytes"); j.Titel = Str(u, "titel");
                j.Status = "laeuft";
                try
                {
                    PlatzPruefen(j);
                    if (j.Art == "zim") { Herunterladen(j, j.Url, j.Ziel); try { AlteVersionenLoeschen(j); } catch { } }
                    else if (j.Art == "route") Herunterladen(j, j.Url, j.Ziel + ".neu");
                    else if (j.Art == "karte") KarteLaden(j);
                    else if (j.Art == "datei") { Directory.CreateDirectory(Path.GetDirectoryName(j.Ziel)); Herunterladen(j, j.Url, j.Ziel); }
                    else if (j.Art == "programm-update") { var t = (j.Extra ?? "|").Split('|'); ProgrammUpdateLaden(j, j.Url, t[0], t.Length > 1 ? t[1] : ""); }
                    j.Status = "fertig";
                    offen.Remove(u);
                    erledigt++;
                    d["updates"] = offen.ToArray();
                    File.WriteAllText(AktDatei, Json.Serialize(d), Utf8);
                    AktLog("Fertig: " + j.Titel);
                }
                catch (Exception e) { j.Status = abbrechen ? "abgebrochen" : "fehler"; j.Fehler = e.Message; if (!abbrechen) { AktLog("Fehler bei " + j.Titel + ": " + e.Message); StatFehler("aktualisierung", j.Art + " " + j.Titel + ": " + e.Message); } }
            }
            } finally { ladeLimit = 0; }
            Aufraeumen();
            return erledigt;
        }

        // Fertige neue Dateien einsetzen und alte Versionen löschen (beim Start und nach Updates)
        static void Aufraeumen()
        {
            foreach (var f in Directory.GetFiles(Path.Combine(Daten, "routen"), "*.rd5.neu"))
            {
                string ziel = f.Substring(0, f.Length - 4);
                try { if (File.Exists(ziel)) File.Delete(ziel); File.Move(f, ziel); } catch { }
            }
            foreach (var f in Directory.GetFiles(Path.Combine(Daten, "karten"), "*.neu.pmtiles"))
            {
                string ziel = f.Replace(".neu.pmtiles", ".pmtiles");
                try { if (File.Exists(ziel)) File.Delete(ziel); File.Move(f, ziel); } catch { }
            }
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

        static Dictionary<string, object> ProgrammUpdateSuchen()
        {
            var erg = new Dictionary<string, object>
            {
                {"version", Version}, {"verfuegbar", false}, {"bereit", BereitVersion()},
                {"eingerichtet", UpdateApi() != null}, {"entwicklung", IstEntwicklungsordner()}
            };
            string api = UpdateApi();
            if (api == null) return erg;
            var rel = Json.DeserializeObject(HoleText(api, 20000)) as Dictionary<string, object>;
            string neu = (Str(rel, "tag_name") ?? "").TrimStart('v', 'V');
            string zip = null, sha = null;
            long bytes = 0;
            foreach (var o in Arr(rel, "assets"))
            {
                var a = (Dictionary<string, object>)o;
                string n = Str(a, "name") ?? "";
                if (n.EndsWith(".zip.sha256", StringComparison.OrdinalIgnoreCase)) sha = Str(a, "browser_download_url");
                // Fieldbook-<version>.zip bevorzugen, falls weitere ZIP-Dateien im Release liegen
                else if (n.EndsWith(".zip", StringComparison.OrdinalIgnoreCase) && n.StartsWith("Fieldbook", StringComparison.OrdinalIgnoreCase)
                    && (zip == null || n.Equals("Fieldbook-" + neu + ".zip", StringComparison.OrdinalIgnoreCase))) { zip = Str(a, "browser_download_url"); bytes = (long)Num(a, "size"); }
            }
            erg["neu"] = neu;
            erg["titel"] = Str(rel, "name") ?? ("Fieldbook " + neu);
            erg["notizen"] = Str(rel, "body") ?? "";
            erg["datum"] = Str(rel, "published_at") ?? "";
            erg["zip"] = zip; erg["sha"] = sha; erg["bytes"] = bytes;
            erg["verfuegbar"] = zip != null && VersionNeuer(neu, Version) && BereitVersion() != neu;
            progUpdate = erg;
            return erg;
        }

        // Herunterladen, prüfen, entpacken und bereitlegen
        static void ProgrammUpdateLaden(Job j, string zipUrl, string shaUrl, string neu)
        {
            if (IstEntwicklungsordner()) throw new Exception("Im Entwicklungsordner wird Fieldbook nicht automatisch aktualisiert.");
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
            if (Directory.Exists(UpdateBereit)) Directory.Delete(UpdateBereit, true);
            Directory.Move(quelle, UpdateBereit);
            File.WriteAllText(Path.Combine(UpdateBereit, "version.txt"), neu);
            try { if (Directory.Exists(tmp)) Directory.Delete(tmp, true); } catch { }
            try { File.Delete(zip); } catch { }
            AktLog("Fieldbook " + neu + " heruntergeladen und bereitgelegt.");
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
                abbrechen = false;
                var j = new Job { Art = "programm-update", Titel = "Fieldbook " + Str(u, "neu") + " (Programm)", Gesamt = (long)Num(u, "bytes") };
                jobs = new List<Job> { j };
                warteschlange = false;
                worker = new Thread(delegate ()
                {
                    j.Status = "laeuft";
                    try
                    {
                        ProgrammUpdateLaden(j, Str(u, "zip"), Str(u, "sha"), Str(u, "neu"));
                        j.Status = "fertig";
                        Neustart();
                    }
                    catch (Exception e) { j.Status = abbrechen ? "abgebrochen" : "fehler"; j.Fehler = e.Message; Log("Programm-Update: " + e.Message); StatFehler("programmupdate", e.Message); }
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
                StoppeKi(); StoppeKiwix(); StoppeRouting(); AlleDownloadsStoppen();
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
                string args = "-Xmx512m -Xms64m -Xss16m -cp \"" + jar + "\" btools.server.RouteServer \"" + routen + "\" \"" + profile + "\" \"" + Path.Combine(routen, "profile") + "\" " + RoutePort + " 4 127.0.0.1";
                brouter = StarteDienst(java, args, Path.Combine(Logs, "routen.log"));
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
            byte[] daten;
            using (var ms = new MemoryStream())
            {
                ctx.Request.InputStream.CopyTo(ms);
                daten = ms.ToArray();
            }
            if (daten.Length < 1000 || daten.Length > 4000000) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Die Aufnahme ist zu kurz oder zu lang." } }, 400); return; }
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
                        // 1. Sprache am Klang bestimmen (tiny: 0,5 s; ohne tiny das größere Modell)
                        var tiny = SprachModelle().FirstOrDefault(m => Str(m, "id") == "tiny");
                        var lidModell = tiny != null && File.Exists(SprachModellPfad(tiny)) ? tiny : SprachModelle().First(m => Str(m, "id") == "whisper");
                        var lid = WhisperStarten(new[] { "-m", SprachModellPfad(lidModell), "-f", wav, "-l", "auto", "-dl" });
                        gehoert = WhisperSprache(lid[0] + lid[1]);
                        gewaehlt = PaarSprache(gehoert, zwei, konf);
                        if (gewaehlt == null)
                        {
                            if (zwei.All(c => IstParakeet(c, konf))) { /* Parakeet erkennt selbst, der Browser entscheidet am Text */ }
                            else
                            {
                                // 2. Whisper small mit eigener Spracherkennung, liefert Sprache und Text in einem Durchgang
                                var r = WhisperStarten(new[] { "-m", SprachModellPfad(SprachModelle().First(m => Str(m, "id") == "whisper")), "-f", wav, "-l", "auto", "-nt", "-sns" });
                                gewaehlt = PaarSprache(WhisperSprache(r[1]), zwei, konf);
                                if (gewaehlt != null) text = r[0];
                                else { gewaehlt = erwartet; sicher = false; }
                            }
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

        // Sprachen, die vorlesen können (Programm und Stimme da)
        static string[] Stimmen()
        {
            if (ProgrammPfad("piper") == null) return new string[0];
            return Arr(StimmenKonfig(), "stimmen").OfType<Dictionary<string, object>>().Select(s => Str(s, "code")).Where(StimmeDa).ToArray();
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
            if (jobs.Count > 0 && ProgrammPfad("piper") == null) jobs.Insert(0, ProgrammJob("piper"));
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
            string tmp = json + ".neu";
            if (File.Exists(tmp)) File.Delete(tmp);
            Herunterladen(new Job { Titel = j.Titel }, j.Url + ".json", tmp);
            if (Sha256Datei(tmp) != Str(s, "jsonSha256")) { File.Delete(tmp); throw new Exception("Die Prüfsumme der Stimme stimmt nicht. Bitte erneut versuchen."); }
            // Neuere Stimmen enthalten Einträge aus mehreren Zeichen (Doppellaute wie "aɪ"), die das
            // Windows-Programm von Piper nicht lesen kann. Das Programm erzeugt sie ohnehin nie, also weg damit.
            string text = File.ReadAllText(tmp, Encoding.UTF8);
            text = Regex.Replace(text, @",\s*""[^""\\]{2,}""\s*:\s*\[\s*\d+\s*\]", "");
            File.WriteAllText(json, text, new UTF8Encoding(false));
            File.Delete(tmp);
        }

        static void StimmeLoeschen(string code)
        {
            var s = StimmeInfo(code);
            if (s == null) return;
            lock (vorlesenLk)
            {
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
            string exe = ProgrammPfad("piper");
            if (s == null || exe == null || !StimmeDa(sprache)) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Für diese Sprache ist keine Stimme da." } }, 404); return; }
            // Eine Zeile pro Aufruf (Piper liest zeilenweise), höchstens etwa eine Bildschirmseite
            text = Regex.Replace(text, @"\s+", " ").Trim();
            if (text.Length == 0 || text.Length > 3000) { SendeJson(ctx, new Dictionary<string, object> { { "fehler", "Der Text ist leer oder zu lang." } }, 400); return; }
            string wav = Path.Combine(Daten, "cache", "vorlesen-" + Guid.NewGuid().ToString("N") + ".wav");
            try
            {
                lock (vorlesenLk)
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

        static void StarteKi()
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
                llmModell = Str(m, "name") + " (" + Str(m, "modell") + ")";
                llmStatus = "laedt";
                llmFehler = "";
                gen = ++llmGen;
                llama = StarteDienst(exe, args + " --reasoning-budget 0", Path.Combine(Logs, "ki.log"));
                Log("KI wird geladen: " + llmModell + " [" + backend + "]");
                StarteSuchhilfe();
            }
            bool zweiterVersuch = false;
            var ladeUhr = Stopwatch.StartNew();
            while (gen == llmGen)
            {
                Thread.Sleep(500);
                if (llama == null) return;
                if (llama.HasExited)
                {
                    string log = "";
                    try { log = File.ReadAllText(Path.Combine(Logs, "ki.log")); } catch { }
                    if (!zweiterVersuch && Regex.IsMatch(log, "reasoning-budget|invalid argument|unknown argument", RegexOptions.IgnoreCase))
                    {
                        zweiterVersuch = true;
                        lock (Lk) llama = StarteDienst(exe, args, Path.Combine(Logs, "ki.log"));
                        continue;
                    }
                    llmStatus = "fehler";
                    var zeilen = log.Split('\n').Where(z => z.Trim().Length > 0).ToArray();
                    llmFehler = "KI konnte nicht starten. " + string.Join(" ", zeilen.Skip(Math.Max(0, zeilen.Length - 3))).Trim();
                    Log(llmFehler);
                    StatFehler("ki", llmFehler);
                    return;
                }
                if (HttpOk("http://127.0.0.1:" + LlmPort + "/health"))
                {
                    llmStatus = "bereit";
                    Log("KI ist bereit.");
                    StatKi("laden", ladeUhr.Elapsed.TotalSeconds);
                    return;
                }
            }
        }

        static void StoppeKi()
        {
            lock (Lk)
            {
                llmGen++;
                try { if (llama != null && !llama.HasExited) { llama.Kill(); llama.WaitForExit(5000); } } catch { }
                llama = null;
                llmStatus = "aus";
                llmFehler = "";
                StoppeSuchhilfe();
            }
        }

        // ------------------------------------------------------------------ Suchhilfe (Bedeutungsmodell)
        // Ein kleines Modell (EmbeddingGemma) sortiert die Treffer der KI-Suche nach Bedeutung statt nach
        // gleichen Wörtern. Läuft als zweiter llama-server mit --embedding, immer auf dem Prozessor
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
                // Immer auf dem Prozessor: das Programm für den Prozessor, sonst das der KI ohne Grafikkarte
                string exe = ProgrammPfad("llama-cpu") ?? ProgrammPfad("llama-" + (Str(einst, "backend") ?? "cpu"));
                if (exe == null) return;
                string args = "-m \"" + SuchhilfeDatei() + "\" --host 127.0.0.1 --port " + SuchPort + " --embedding -c 8192 -b 2048 -ub 2048 --parallel 4 -ngl 0";
                try { suchhilfe = StarteDienst(exe, args, Path.Combine(Logs, "suchhilfe.log")); }
                catch (Exception e) { suchhilfe = null; Log("Suchhilfe konnte nicht starten: " + e.Message); }
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
            var log = new StreamWriter(new FileStream(logDatei, FileMode.Create, FileAccess.Write, FileShare.ReadWrite), Utf8) { AutoFlush = true };
            var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
            DataReceivedEventHandler h = (s, e) => { if (e.Data != null) lock (log) { try { log.WriteLine(e.Data); } catch { } } };
            p.OutputDataReceived += h;
            p.ErrorDataReceived += h;
            p.Exited += (s, e) => { lock (log) { try { log.Dispose(); } catch { } } };
            p.Start();
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

        static void LadeOrte()
        {
            lock (OrteLk)
            {
                if (orte != null) return;
                var liste = new List<Ort>();
                foreach (var f in Directory.GetFiles(Path.Combine(Daten, "orte"), "*.txt"))
                {
                    foreach (var zeile in File.ReadLines(f, Encoding.UTF8))
                    {
                        var c = zeile.Split('\t');
                        if (c.Length < 15) continue;
                        char kl = c[6].Length > 0 ? c[6][0] : '?';
                        if (kl == 'R' || kl == 'U' || kl == 'A') continue;
                        long pop; long.TryParse(c[14], out pop);
                        var o = new Ort
                        {
                            Name = c[1],
                            Alt = (kl == 'P' || kl == 'T' || kl == 'H') ? c[3] : "",
                            Lat = double.Parse(c[4], CultureInfo.InvariantCulture),
                            Lon = double.Parse(c[5], CultureInfo.InvariantCulture),
                            Klasse = kl, Code = c[7], Land = c[8], Pop = pop
                        };
                        liste.Add(o);
                    }
                }
                orte = liste;
            }
        }

        static List<object> OrteSuchen(string q, int max)
        {
            var erg = new List<object>();
            string nq = Norm(q.Trim());
            if (nq.Length < 2) return erg;
            LadeOrte();
            var treffer = new List<KeyValuePair<double, object>>();
            foreach (var o in orte)
            {
                string nn = Norm(o.Name);
                double score = 0;
                string anzeige = o.Name;
                if (nn == nq) score = 100;
                else if (nn.StartsWith(nq)) score = 60;
                else if (nn.Contains(" " + nq) || nn.Contains("-" + nq)) score = 30;
                if (score < 100 && o.Alt.Length > 0)
                {
                    foreach (var a in o.Alt.Split(','))
                    {
                        string na = Norm(a);
                        double s2 = na == nq ? 95 : na.StartsWith(nq) ? 55 : 0;
                        if (s2 > score) { score = s2; anzeige = a; }
                    }
                }
                if (score <= 0) continue;
                score += Math.Log10(o.Pop + 1) * 4 + (o.Klasse == 'P' ? 8 : 0);
                string art;
                if (!OrtArten.TryGetValue(o.Code, out art)) art = o.Klasse == 'P' ? "Ort" : o.Klasse == 'T' ? "Gelände" : o.Klasse == 'H' ? "Gewässer" : o.Klasse == 'S' ? "Gebäude/Einrichtung" : "Ort";
                treffer.Add(new KeyValuePair<double, object>(score, new Dictionary<string, object>
                {
                    {"name", anzeige}, {"original", o.Name}, {"land", o.Land}, {"lat", o.Lat}, {"lon", o.Lon}, {"art", art}, {"einwohner", o.Pop}
                }));
            }
            foreach (var t in treffer.OrderByDescending(x => x.Key).Take(max)) erg.Add(t.Value);
            return erg;
        }

        // ------------------------------------------------------------------ Hilfen

        // Chat-Verlauf: eine JSON-Datei pro Chat in daten\chats
        static string ChatDatei(string id)
        {
            if (string.IsNullOrEmpty(id) || !System.Text.RegularExpressions.Regex.IsMatch(id, "^[a-z0-9-]{1,40}$")) return null;
            return Path.Combine(Daten, "chats", id + ".json");
        }

        static Dictionary<string, object> ChatListe()
        {
            var liste = new List<object>();
            string ordner = Path.Combine(Daten, "chats");
            if (Directory.Exists(ordner))
            {
                foreach (var f in new DirectoryInfo(ordner).GetFiles("*.json").OrderByDescending(x => x.LastWriteTimeUtc).Take(300))
                {
                    var c = LadeJson(f.FullName);
                    if (c == null) continue;
                    liste.Add(new Dictionary<string, object> {
                        { "id", Path.GetFileNameWithoutExtension(f.Name) },
                        { "titel", Str(c, "titel") ?? "Chat" },
                        { "zeit", Str(c, "zeit") ?? f.LastWriteTime.ToString("s") } });
                }
            }
            return new Dictionary<string, object> { { "chats", liste } };
        }

        static Dictionary<string, object> LadeJson(string pfad)
        {
            try
            {
                if (!File.Exists(pfad)) return null;
                return Json.DeserializeObject(File.ReadAllText(pfad, Encoding.UTF8)) as Dictionary<string, object>;
            }
            catch { return null; }
        }

        static void SpeichereEinst()
        {
            try { File.WriteAllText(Path.Combine(Daten, "einstellungen.json"), Json.Serialize(einst), Utf8); } catch { }
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

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

    public class Ort
    {
        public string Name, Alt, Land, Code;
        public double Lat, Lon;
        public long Pop;
        public char Klasse;
    }

    public static class App
    {
        public const string Version = "0.5.0";
        static string Root, AppDir, Web, Config, Daten, Prog, Logs;
        static int Port, KiwixPort, LlmPort, RoutePort;
        static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 200 };
        static readonly object Lk = new object();
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        static Process kiwix, llama, brouter;
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
                    if (kiwix == null || kiwix.HasExited) { SendeText(ctx, 503, "Die Bibliothek ist nicht gestartet (keine Wissenspakete installiert?)."); return; }
                    // RawUrl statt Url.PathAndQuery: Url entschlüsselt "%25" zu "%", dann findet Kiwix
                    // Dateien mit Sonderzeichen im Namen nicht mehr (z. B. "%252C" für ein Komma)
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

        static void Weiterleiten(HttpListenerContext ctx, int port, string pfadUndQuery)
        {
            var rq = ctx.Request;
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + port + pfadUndQuery);
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
        // zeigt Fieldbook nur Zweige mit Anleitungen.

        public class IfixitKnoten
        {
            public string Titel, Pfad;
            public List<string> Kinder = new List<string>();
            public List<string[]> Anleitungen = new List<string[]>(); // { Titel, Pfad }
            public int Anzahl;
        }

        static readonly object IfixitLk = new object();
        static string ifixitBuch, ifixitStatus = "", ifixitFehler = "";
        static Dictionary<string, IfixitKnoten> ifixitBaum;
        static int ifixitGelesen;

        static Dictionary<string, object> Ifixit(string buch, string pfad)
        {
            if (string.IsNullOrEmpty(buch) || !Regex.IsMatch(buch, @"^ifixit_[\w.-]+$")) return new Dictionary<string, object> { { "fehler", "Unbekanntes Paket" } };
            lock (IfixitLk)
            {
                if (ifixitBuch != buch)
                {
                    ifixitBuch = buch; ifixitBaum = null; ifixitStatus = ""; ifixitFehler = "";
                    string cache = Path.Combine(Daten, "cache", "ifixit-" + buch + ".json");
                    if (File.Exists(cache))
                        try { ifixitBaum = Json.Deserialize<Dictionary<string, IfixitKnoten>>(File.ReadAllText(cache, Utf8)); ifixitStatus = "fertig"; } catch { ifixitBaum = null; }
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
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + KiwixPort + "/kiwix/content/" + buch + "/" + pfad);
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
                var wurzel = new IfixitKnoten { Titel = "iFixit", Pfad = "" };
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
                        try { html = KiwixSeite(buch, pfad); } catch { Interlocked.Increment(ref fehlgeschlagen); return; }
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
                // Leere Zweige gar nicht erst speichern
                var voll = baum.Values.Where(x => x.Anzahl > 0).ToDictionary(x => x.Pfad);
                foreach (var k in voll.Values) k.Kinder = k.Kinder.Where(voll.ContainsKey).ToList();
                // Nur (fast) vollständig gelesene Bäume dauerhaft merken (z. B. nicht, wenn Kiwix zwischendurch neu startete)
                if (fehlgeschlagen <= baum.Count / 100)
                {
                    Directory.CreateDirectory(Path.Combine(Daten, "cache"));
                    File.WriteAllText(Path.Combine(Daten, "cache", "ifixit-" + buch + ".json"), Json.Serialize(voll), Utf8);
                }
                lock (IfixitLk) if (ifixitBuch == buch) { ifixitBaum = voll; ifixitStatus = "fertig"; }
                Log("iFixit-Übersicht: " + baum.Count + " Geräteseiten, " + wurzel.Anzahl + " Anleitungen, " + fehlgeschlagen + " Seiten nicht lesbar.");
            }
            catch (Exception e)
            {
                lock (IfixitLk) if (ifixitBuch == buch) { ifixitStatus = "fehler"; ifixitFehler = e.Message; }
                Log("iFixit-Übersicht: " + e.Message);
            }
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
            switch (was)
            {
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
                case "orte": SendeJson(ctx, OrteSuchen(Q("q") ?? "", 25)); return;
                case "ifixit": SendeJson(ctx, Ifixit(Q("buch"), Q("pfad") ?? "")); return;
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
                {"defektePakete", kiwixDefekt.ToArray()},
                {"ki", new Dictionary<string, object> { {"status", llmStatus}, {"fehler", llmFehler}, {"modell", llmModell}, {"kontext", AktuellesModellKontext()} }},
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
                {"updateBeimStart", UpdateBeimStart()}
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
                new[] { "Übersetzer", "https://storage.googleapis.com/" },
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

                if (!string.IsNullOrEmpty(modellId))
                {
                    if (ProgrammPfad("llama-" + backend) == null) jobs.Add(ProgrammJob("llama-" + backend));
                    foreach (var o in Arr(LadeJson(Path.Combine(Config, "modelle.json")), "modelle"))
                    {
                        var m = (Dictionary<string, object>)o;
                        if (Str(m, "id") != modellId) continue;
                        string ziel = Path.Combine(Daten, "modelle", Str(m, "datei"));
                        if (!File.Exists(ziel))
                            jobs.Add(new Job { Art = "datei", Titel = "KI: " + Str(m, "name") + " (" + Str(m, "modell") + ")", Url = Str(m, "url"), Ziel = ziel, Gesamt = (long)Num(m, "bytes") });
                    }
                    einst["modell"] = modellId;
                    einst["backend"] = backend;
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
                // Offline-Übersetzer Englisch → Deutsch: ein Job für alle Dateien
                if (Bool(b, "uebersetzer") && !UebersetzerBereit())
                {
                    var u = LadeJson(Path.Combine(Config, "uebersetzer.json"));
                    jobs.Add(new Job { Art = "uebersetzer", Titel = Str(u, "titel") ?? "Übersetzer", Gesamt = (long)(Num(u, "mb") * 1048576) });
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
            var t = j.Extra.Split('|');
            string muster = "^" + Regex.Escape(t[0]) + (t[1] == "" ? "" : "_" + Regex.Escape(t[1])) + @"_\d{4}-\d{2}[a-z]?\.zim$";
            string neu = Path.GetFileName(j.Ziel);
            foreach (var f in Directory.GetFiles(Path.Combine(Daten, "wissen"), "*.zim"))
            {
                string n = Path.GetFileName(f);
                if (n != neu && Regex.IsMatch(n, muster, RegexOptions.IgnoreCase))
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

        // Windows-Fenster zur Ordnerauswahl (eigener STA-Thread, immer im Vordergrund)
        static string OrdnerWaehlen()
        {
            string pfad = null;
            var t = new Thread(delegate ()
            {
                using (var vorne = new System.Windows.Forms.Form { TopMost = true, ShowInTaskbar = false, Opacity = 0, FormBorderStyle = System.Windows.Forms.FormBorderStyle.None })
                using (var d = new System.Windows.Forms.FolderBrowserDialog { Description = "Ordner oder USB-Stick mit Fieldbook-Daten wählen", ShowNewFolderButton = false })
                {
                    vorne.Show();
                    vorne.Activate();
                    if (d.ShowDialog(vorne) == System.Windows.Forms.DialogResult.OK) pfad = d.SelectedPath;
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

        static bool UebersetzerBereit()
        {
            var d = UebersetzerDateien();
            return d.Count > 0 && d.All(f => { string z = SichererPfad(UebersetzerDir, Str(f, "ziel")); return z != null && File.Exists(z); });
        }

        static void UebersetzerLaden(Job j)
        {
            long fertig = 0;
            foreach (var f in UebersetzerDateien())
            {
                string ziel = SichererPfad(UebersetzerDir, Str(f, "ziel"));
                if (ziel == null) continue;
                if (!File.Exists(ziel))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(ziel));
                    var teil = new Job { Titel = j.Titel };
                    bool laeuft = true;
                    long basis = fertig;
                    var anzeige = new Thread(delegate () { while (laeuft) { j.Bytes = basis + teil.Bytes; Thread.Sleep(300); } }) { IsBackground = true };
                    anzeige.Start();
                    try { Herunterladen(teil, Str(f, "url"), ziel); }
                    finally { laeuft = false; }
                }
                fertig += new FileInfo(ziel).Length;
                j.Bytes = fertig;
            }
            j.Gesamt = fertig;
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
                }
                else if (art == "karte")
                {
                    string f = SichererPfad(Path.Combine(Daten, "karten"), id + ".pmtiles");
                    if (f != null && File.Exists(f)) File.Delete(f);
                }
                else if (art == "uebersetzer")
                {
                    if (Directory.Exists(UebersetzerDir)) Directory.Delete(UebersetzerDir, true);
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
                else if (popup) { ok = FrageNutzer(updates, getaktet); if (ok && getaktet) d["getaktetErlaubt"] = true; }
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

        static bool FrageNutzer(List<Dictionary<string, object>> updates, bool getaktet)
        {
            bool ja = false;
            var t = new Thread(delegate ()
            {
                long bytes = updates.Sum(u => (long)Num(u, "bytes"));
                string liste = string.Join("\n", updates.Select(u => "  •  " + Str(u, "titel")));
                bool leerlauf = Str(AktEinst(), "wann") == "leerlauf";
                string text = "Für Fieldbook gibt es neue Daten:\n\n" + liste + "\n\nGröße insgesamt: ca. " + (bytes / 1e9).ToString("0.0", CultureInfo.GetCultureInfo("de-DE")) + " GB\n\n" +
                    (getaktet ? "ACHTUNG: Du bist gerade mit einer getakteten Verbindung verbunden (z. B. Handy-Hotspot). Das Herunterladen kann dein Datenvolumen verbrauchen.\n\n" : "") +
                    (leerlauf ? "Herunterladen? Das passiert nur, wenn der Computer am Strom hängt und gerade nicht benutzt wird."
                              : "Jetzt herunterladen? Das läuft mit niedriger Priorität im Hintergrund, du kannst normal weiterarbeiten.");
                var r = System.Windows.Forms.MessageBox.Show(text, "Fieldbook: neue Daten", System.Windows.Forms.MessageBoxButtons.YesNo,
                    System.Windows.Forms.MessageBoxIcon.Information, System.Windows.Forms.MessageBoxDefaultButton.Button1, System.Windows.Forms.MessageBoxOptions.DefaultDesktopOnly);
                ja = r == System.Windows.Forms.DialogResult.Yes;
            });
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
            t.Join();
            return ja;
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
                    else if (j.Art == "programm-update") { var t = (j.Extra ?? "|").Split('|'); ProgrammUpdateLaden(j, j.Url, t[0], t.Length > 1 ? t[1] : ""); }
                    j.Status = "fertig";
                    offen.Remove(u);
                    erledigt++;
                    d["updates"] = offen.ToArray();
                    File.WriteAllText(AktDatei, Json.Serialize(d), Utf8);
                    AktLog("Fertig: " + j.Titel);
                }
                catch (Exception e) { j.Status = abbrechen ? "abgebrochen" : "fehler"; j.Fehler = e.Message; if (!abbrechen) AktLog("Fehler bei " + j.Titel + ": " + e.Message); }
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
                    catch (Exception e) { j.Status = abbrechen ? "abgebrochen" : "fehler"; j.Fehler = e.Message; Log("Programm-Update: " + e.Message); }
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
                args = "-m \"" + datei + "\" --host 127.0.0.1 --port " + LlmPort + " -c " + (int)Num(m, "kontext") + " --parallel 1 --jinja";
                if (backend != "cpu") args += " -ngl 999";
                llmModell = Str(m, "name") + " (" + Str(m, "modell") + ")";
                llmStatus = "laedt";
                llmFehler = "";
                gen = ++llmGen;
                llama = StarteDienst(exe, args + " --reasoning-budget 0", Path.Combine(Logs, "ki.log"));
                Log("KI wird geladen: " + llmModell + " [" + backend + "]");
            }
            bool zweiterVersuch = false;
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
                    return;
                }
                if (HttpOk("http://127.0.0.1:" + LlmPort + "/health"))
                {
                    llmStatus = "bereit";
                    Log("KI ist bereit.");
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

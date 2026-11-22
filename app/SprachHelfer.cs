// Hilfsprogramm für den Sprechmodus im Übersetzer. Server.cs übersetzt diese Datei bei Bedarf zu einer .exe
// (daten\cache\sprachhelfer) und startet sie als eigenen Prozess, damit whisper.dll und parakeet.dll nicht im
// Server geladen bleiben (Programm-Updates und Löschen könnten sie sonst nicht ersetzen).
//
// 1. Einmal-Aufruf: Wie wahrscheinlich ist jede der gewünschten Sprachen am Klang?
//    whisper-cli nennt nur die eine wahrscheinlichste von 99 Sprachen (kurzes Deutsch wird dort oft Englisch),
//    whisper.dll kann alle Wahrscheinlichkeiten liefern.
//    Aufruf: SprachHelfer.exe <whisper-Ordner> <Modell> <WAV> <de,en> <Threads>
//    Ausgabe: je Sprache eine Zeile "de 0.759" (Punkt als Dezimalzeichen)
//
// 2. Dienst (nur solange der Sprechmodus offen ist): hält Parakeet und das Klang-Modell geladen,
//    spart je Satz das Laden von Parakeet (etwa 0,65 s).
//    Aufruf: SprachHelfer.exe dienst <whisper-Ordner> <Parakeet-Modell> <Klang-Modell> <Threads>
//    Meldet "bereit", dann je Anfrage-Zeile eine Antwort-Zeile (Felder mit Tabulator getrennt):
//      "klang\t<WAV>\tde,en" → "ok\tde 0.759\ten 0.120"
//      "text\t<WAV>"         → "ok\t<Text in einer Zeile>"
//    Bei Fehlern "fehler\t<Meldung>". Endet, wenn die Eingabe geschlossen wird.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class SprachHelfer
{
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetDllDirectory(string p);
    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibrary(string p);
    [DllImport("ggml.dll", CallingConvention = CallingConvention.Cdecl)] static extern void ggml_backend_load_all_from_path(string dir);
    [DllImport("whisper.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr whisper_init_from_file(string path);
    [DllImport("whisper.dll", CallingConvention = CallingConvention.Cdecl)] static extern void whisper_free(IntPtr ctx);
    [DllImport("whisper.dll", CallingConvention = CallingConvention.Cdecl)] static extern int whisper_pcm_to_mel(IntPtr ctx, float[] samples, int n, int threads);
    [DllImport("whisper.dll", CallingConvention = CallingConvention.Cdecl)] static extern int whisper_lang_auto_detect(IntPtr ctx, int offsetMs, int threads, float[] probs);
    [DllImport("whisper.dll", CallingConvention = CallingConvention.Cdecl)] static extern int whisper_lang_id(string lang);
    [DllImport("whisper.dll", CallingConvention = CallingConvention.Cdecl)] static extern int whisper_lang_max_id();

    // parakeet.h (whisper.cpp b5454). parakeet_context_params ist 8 Byte groß (bool use_gpu, int gpu_device) und wird
    // unter x64 als ein 64-Bit-Wert übergeben; die große parakeet_full_params übergibt x64 als Zeiger auf eine Kopie,
    // daher reicht der Zeiger aus parakeet_full_default_params_by_ref. n_threads liegt dort an Stelle 4.
    [DllImport("parakeet.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr parakeet_init_from_file_with_params(byte[] pfadUtf8, long ctxParams);
    [DllImport("parakeet.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr parakeet_full_default_params_by_ref(int strategie);
    [DllImport("parakeet.dll", CallingConvention = CallingConvention.Cdecl)] static extern int parakeet_full(IntPtr ctx, IntPtr fullParams, float[] samples, int n);
    [DllImport("parakeet.dll", CallingConvention = CallingConvention.Cdecl)] static extern int parakeet_full_n_segments(IntPtr ctx);
    [DllImport("parakeet.dll", CallingConvention = CallingConvention.Cdecl)] static extern IntPtr parakeet_full_get_segment_text(IntPtr ctx, int i);
    [DllImport("parakeet.dll", CallingConvention = CallingConvention.Cdecl)] static extern void parakeet_log_set(IntPtr cb, IntPtr userData);

    [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void LogRueckruf(int level, IntPtr text, IntPtr userData);
    static LogRueckruf stumm = (l, t, u) => { };   // Feld, damit der Rückruf nicht weggeräumt wird

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length >= 5 && args[0] == "dienst") return Dienst(args[1], args[2], args[3], int.Parse(args[4], CultureInfo.InvariantCulture));
            if (args.Length < 5) { Console.Error.WriteLine("Aufruf: SprachHelfer <whisper-Ordner> <Modell> <WAV> <Sprachen> <Threads>"); return 2; }
            string dir = args[0];
            int threads = int.Parse(args[4], CultureInfo.InvariantCulture);
            DllsLaden(dir, false);
            IntPtr ctx = whisper_init_from_file(args[1]);
            if (ctx == IntPtr.Zero) { Console.Error.WriteLine("Modell lässt sich nicht laden"); return 3; }
            try
            {
                foreach (string zeile in Klang(ctx, args[2], args[3], threads)) Console.WriteLine(zeile);
            }
            finally { whisper_free(ctx); }
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
    }

    static void DllsLaden(string dir, bool parakeet)
    {
        SetDllDirectory(dir);
        LoadLibrary(Path.Combine(dir, "ggml.dll"));
        LoadLibrary(Path.Combine(dir, "whisper.dll"));
        if (parakeet) LoadLibrary(Path.Combine(dir, "parakeet.dll"));
        ggml_backend_load_all_from_path(dir);
    }

    // Wahrscheinlichkeit der gewünschten Sprachen ("de,en") am Klang, je Sprache eine Zeile "de 0.759"
    static List<string> Klang(IntPtr ctx, string wav, string sprachen, int threads)
    {
        float[] pcm = Lesen(wav);
        if (whisper_pcm_to_mel(ctx, pcm, pcm.Length, threads) != 0) throw new Exception("Aufnahme lässt sich nicht auswerten");
        var probs = new float[whisper_lang_max_id() + 1];
        if (whisper_lang_auto_detect(ctx, 0, threads, probs) < 0) throw new Exception("Spracherkennung fehlgeschlagen");
        var aus = new List<string>();
        foreach (string l in sprachen.Split(','))
        {
            int id = whisper_lang_id(l);
            aus.Add(l + " " + (id >= 0 ? probs[id] : 0f).ToString("0.000000", CultureInfo.InvariantCulture));
        }
        return aus;
    }

    static int Dienst(string dir, string parakeetModell, string klangModell, int threads)
    {
        var ein = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var aus = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
        DllsLaden(dir, true);
        parakeet_log_set(Marshal.GetFunctionPointerForDelegate(stumm), IntPtr.Zero);
        IntPtr para = parakeet_init_from_file_with_params(Utf8(parakeetModell), 0);
        if (para == IntPtr.Zero) { aus.WriteLine("fehler\tParakeet lässt sich nicht laden"); return 3; }
        IntPtr klang = File.Exists(klangModell) ? whisper_init_from_file(klangModell) : IntPtr.Zero;
        IntPtr fp = parakeet_full_default_params_by_ref(0);
        Marshal.WriteInt32(fp, 4, threads);
        aus.WriteLine("bereit");
        string zeile;
        while ((zeile = ein.ReadLine()) != null)
        {
            string[] t = zeile.Split('\t');
            try
            {
                if (t[0] == "text" && t.Length >= 2)
                {
                    float[] pcm = Lesen(t[1]);
                    if (parakeet_full(para, fp, pcm, pcm.Length) != 0) throw new Exception("Erkennung fehlgeschlagen");
                    var sb = new StringBuilder();
                    int n = parakeet_full_n_segments(para);
                    for (int i = 0; i < n; i++) sb.Append(Utf8Text(parakeet_full_get_segment_text(para, i))).Append(' ');
                    aus.WriteLine("ok\t" + sb.ToString().Replace('\r', ' ').Replace('\n', ' ').Replace('\t', ' ').Trim());
                }
                else if (t[0] == "klang" && t.Length >= 3)
                {
                    if (klang == IntPtr.Zero) throw new Exception("Klang-Modell fehlt");
                    aus.WriteLine("ok\t" + string.Join("\t", Klang(klang, t[1], t[2], threads).ToArray()));
                }
                else aus.WriteLine("fehler\tUnbekannte Anfrage");
            }
            catch (Exception e) { aus.WriteLine("fehler\t" + e.Message.Replace('\n', ' ')); }
        }
        return 0;   // Prozessende gibt den Speicher frei
    }

    static byte[] Utf8(string s)
    {
        byte[] b = Encoding.UTF8.GetBytes(s);
        Array.Resize(ref b, b.Length + 1);
        return b;
    }

    static string Utf8Text(IntPtr p)
    {
        if (p == IntPtr.Zero) return "";
        int n = 0;
        while (Marshal.ReadByte(p, n) != 0) n++;
        var b = new byte[n];
        Marshal.Copy(p, b, 0, n);
        return Encoding.UTF8.GetString(b);
    }

    // WAV mit 16 Bit, mono; andere Abtastraten werden linear auf 16 kHz umgerechnet
    static float[] Lesen(string wav)
    {
        byte[] b = File.ReadAllBytes(wav);
        int rate = BitConverter.ToInt32(b, 24);
        int pos = 12, start = 44, len = b.Length - 44;
        while (pos + 8 <= b.Length)
        {
            string id = System.Text.Encoding.ASCII.GetString(b, pos, 4);
            int groesse = BitConverter.ToInt32(b, pos + 4);
            if (id == "data") { start = pos + 8; len = Math.Min(groesse, b.Length - start); break; }
            pos += 8 + groesse;
        }
        int n = len / 2;
        var roh = new float[n];
        for (int i = 0; i < n; i++) roh[i] = BitConverter.ToInt16(b, start + 2 * i) / 32768f;
        if (rate == 16000 || rate <= 0) return roh;
        int m = (int)((long)n * 16000 / rate);
        var aus = new float[m];
        for (int i = 0; i < m; i++)
        {
            double q = (double)i * rate / 16000;
            int k = (int)q;
            double f = q - k;
            aus[i] = (float)(roh[Math.Min(k, n - 1)] * (1 - f) + roh[Math.Min(k + 1, n - 1)] * f);
        }
        return aus;
    }
}

// Hilfsprogramm für den Sprechmodus im Übersetzer: Wie wahrscheinlich ist jede der gewünschten Sprachen am Klang?
// whisper-cli nennt nur die eine wahrscheinlichste von 99 Sprachen (kurzes Deutsch wird dort oft Englisch),
// whisper.dll kann alle Wahrscheinlichkeiten liefern. Server.cs übersetzt diese Datei bei Bedarf zu einer .exe
// (daten\cache\sprachhelfer) und startet sie je Aufnahme als eigenen Prozess, damit whisper.dll nicht im
// Server geladen bleibt (Programm-Updates könnten sie sonst nicht ersetzen).
// Aufruf: SprachHelfer.exe <whisper-Ordner> <Modell> <WAV> <de,en> <Threads>
// Ausgabe: je Sprache eine Zeile "de 0.759" (Punkt als Dezimalzeichen)
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;

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

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length < 5) { Console.Error.WriteLine("Aufruf: SprachHelfer <whisper-Ordner> <Modell> <WAV> <Sprachen> <Threads>"); return 2; }
            string dir = args[0];
            int threads = int.Parse(args[4], CultureInfo.InvariantCulture);
            SetDllDirectory(dir);
            LoadLibrary(Path.Combine(dir, "ggml.dll"));
            LoadLibrary(Path.Combine(dir, "whisper.dll"));
            ggml_backend_load_all_from_path(dir);
            IntPtr ctx = whisper_init_from_file(args[1]);
            if (ctx == IntPtr.Zero) { Console.Error.WriteLine("Modell lässt sich nicht laden"); return 3; }
            try
            {
                float[] pcm = Lesen(args[2]);
                if (whisper_pcm_to_mel(ctx, pcm, pcm.Length, threads) != 0) { Console.Error.WriteLine("Aufnahme lässt sich nicht auswerten"); return 4; }
                var probs = new float[whisper_lang_max_id() + 1];
                if (whisper_lang_auto_detect(ctx, 0, threads, probs) < 0) { Console.Error.WriteLine("Spracherkennung fehlgeschlagen"); return 5; }
                foreach (string l in args[3].Split(','))
                {
                    int id = whisper_lang_id(l);
                    Console.WriteLine(l + " " + (id >= 0 ? probs[id] : 0f).ToString("0.000000", CultureInfo.InvariantCulture));
                }
            }
            finally { whisper_free(ctx); }
            return 0;
        }
        catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
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

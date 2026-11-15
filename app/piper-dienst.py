# Fieldbook: Vorlesen mit Piper 1.8 (piper1-gpl) als Dienst im Hintergrund.
# Server.cs startet dieses Skript mit dem portablen Python aus programme\piper-py und schickt je Zeile eine
# Anfrage als JSON: {"stimme": Pfad zur .onnx, "text": Text, "wav": Zieldatei}.
# Antwort, ebenfalls eine Zeile JSON: {"ok": true, "dauer": Sekunden, "woerter": [[start, ende] oder null, ...]}
# mit einem Eintrag je Wort im Text (Wörter = durch Leerzeichen getrennt), oder {"fehler": "..."}.
# Die Wortzeiten kommen von Piper selbst (Laute und wie viele Samples jeder Laut dauert), sind also genau.
import sys, json, wave, traceback

from piper import PiperVoice

stimmen = {}   # Pfad -> geladene Stimme; höchstens zwei behalten (Arbeitsspeicher)


def stimme(pfad):
    v = stimmen.pop(pfad, None)
    if v is None:
        # Bestehende Stimmen werden im Speicher um die Zeitangaben ergänzt (Paket onnx), die Datei bleibt gleich
        v = PiperVoice.load(pfad, include_alignments=True)
        while len(stimmen) >= 2:
            stimmen.pop(next(iter(stimmen)))
    stimmen[pfad] = v   # zuletzt benutzt ans Ende
    return v


def lautwoerter_zaehlen(v, wort):
    # Wie viele Lautwörter spricht Piper für dieses Textwort? („1980“ sind vier, „–“ keins)
    try:
        return sum(len("".join(satz).split()) for satz in v.phonemize(wort))
    except Exception:
        return 1


def vorlesen(anfrage):
    v = stimme(anfrage["stimme"])
    text = anfrage["text"]
    rate = v.config.sample_rate
    id_zu = {}
    for laut, ids in v.config.phoneme_id_map.items():
        for i in ids:
            id_zu[i] = laut
    laute, teile, pos, genau = [], [], 0, True
    for ch in v.synthesize(text, include_alignments=True):
        if ch.phoneme_id_samples is None:
            genau = False
        else:
            s, start = pos, None
            for i, n in zip(ch.phoneme_ids, ch.phoneme_id_samples):
                p = id_zu.get(i)
                if p == " ":
                    if start is not None:
                        laute.append((start, s)); start = None
                elif p not in ("^", "$", "_", None):
                    if start is None:
                        start = s
                s += int(n)
            if start is not None:
                laute.append((start, s))
        b = ch.audio_int16_bytes
        teile.append(b)
        pos += len(b) // 2
    with wave.open(anfrage["wav"], "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(teile))
    woerter = text.split(" ")
    zeiten = [None] * len(woerter)
    if genau and laute:
        anz = [lautwoerter_zaehlen(v, w) for w in woerter]
        summe = sum(anz)
        # Passt die Zählung nicht genau (Abkürzungen klingen im Satz manchmal anders), gleichmäßig strecken
        faktor = len(laute) / summe if summe else 0
        k = 0.0
        for nr, a in enumerate(anz):
            if a == 0:
                continue
            von, bis = int(round(k * faktor)), int(round((k + a) * faktor)) - 1
            k += a
            von, bis = min(von, len(laute) - 1), min(max(bis, von), len(laute) - 1)
            zeiten[nr] = [round(laute[von][0] / rate, 3), round(laute[bis][1] / rate, 3)]
    return {"ok": True, "dauer": round(pos / rate, 3), "genau": genau and bool(laute), "woerter": zeiten}


def main():
    ein = sys.stdin.buffer
    aus = sys.stdout.buffer
    aus.write(b'{"bereit": true}\n')
    aus.flush()
    for zeile in ein:
        zeile = zeile.strip()
        if not zeile:
            continue
        try:
            antwort = vorlesen(json.loads(zeile.decode("utf-8")))
        except Exception as e:
            traceback.print_exc(file=sys.stderr)
            antwort = {"fehler": str(e) or type(e).__name__}
        aus.write(json.dumps(antwort, ensure_ascii=True).encode("ascii") + b"\n")
        aus.flush()


if __name__ == "__main__":
    main()

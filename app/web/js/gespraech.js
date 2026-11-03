// Übersetzer: Gespräch in zwei Sprachen. Beide schreiben abwechselnd,
// Fieldbook übersetzt offline (Bergamot von Mozilla, über Englisch). Sprachen lädt man unter Inhalte.
"use strict";

const Gespraech = (() => {
  const DEUTSCH = { code: "de", name: "Deutsch", eigen: "Deutsch" };
  let sprachen = null;          // aus config/sprachen.json
  let translator = null, translatorSig = "";
  let ich = "de", du = null;
  const verlauf = [];           // { wer: "ich" | "du", von, nach, text, uebers, zurueck, fehler }
  let zeichneVerlauf = () => { };
  const zurueckMarke = { de: "Zurückübersetzt:" };   // Beschriftung je Sprache, für das Gegenüber übersetzt

  function marke(code) {
    if (zurueckMarke[code] == null) {
      zurueckMarke[code] = "";
      uebersetze("de", code, "Zurückübersetzt").then(t => { zurueckMarke[code] = t.replace(/[.:。]+$/, "") + ":"; zeichneVerlauf(); }).catch(() => { });
    }
    return zurueckMarke[code];
  }

  let modus = "schreiben";       // "schreiben" | "sprechen"; startet immer mit Schreiben (Mikrofon nie ungefragt an)
  try { du = localStorage.getItem("fb-gespraech-du"); } catch { }
  // Seite verlassen: Mikrofon im Sprechmodus aus, Vorlesen anhalten
  window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#uebersetzen")) { smStopp(); vorlesenStopp(); modus = "schreiben"; } });

  async function zeigen() {
    const c = $("#gs-inhalt");
    if (!sprachen) {
      try { sprachen = (await ladeKonfig("sprachen")).sprachen || []; }
      catch (e) { c.innerHTML = '<div class="fehlerbox">Fehler: ' + esc(e.message) + "</div>"; return; }
    }
    await aktualisiereStatus();
    zeichne();
  }

  // Deutsch plus alle geladenen Sprachen; ohne Englisch geht nichts, weil über Englisch übersetzt wird
  function verfuegbar() {
    const da = new Set((OW.status && OW.status.sprachen) || []);
    if (!da.has("en") || !(OW.status && OW.status.uebersetzer)) return [];
    return [DEUTSCH, ...sprachen.filter(s => da.has(s.code))];
  }
  const info = (code) => code === "de" ? DEUTSCH : sprachen.find(s => s.code === code) || { code, name: code, eigen: code };
  const richtung = (code) => info(code).rtl ? "rtl" : "ltr";

  function holen() {
    const sig = ((OW.status && OW.status.sprachen) || []).join(",");
    if (translator && sig === translatorSig) return translator;
    translatorSig = sig;
    translator = import("/uebersetzer/lib/translator.js").then((mod) => {
      const kerne = Math.max(1, Math.min(2, (navigator.hardwareConcurrency || 2) - 1));
      return new mod.BatchTranslator({ registryUrl: "/api/uebersetzer/modelle", pivotLanguage: "en", downloadTimeout: 0, workers: kerne, batchSize: 8 });
    }).catch((e) => { translator = null; throw e; });
    return translator;
  }

  async function uebersetze(von, nach, text) {
    if (von === nach || !text.trim()) return text;
    const t = await holen();
    const r = await t.translate({ from: von, to: nach, text, html: false });
    return r.target.text;
  }

  function zeichne() {
    if (aufnahme) aufnahme.abbrechen();
    smStopp();
    vorlesenStopp();
    const c = $("#gs-inhalt");
    c.innerHTML = "";
    const liste = verfuegbar();
    if (!liste.length) {
      c.append(el("div", { class: "karte-box" },
        el("p", { style: "margin-top:0" }, "Mit dem Übersetzer kannst du dich mit jemandem unterhalten, der eine andere Sprache spricht. Ihr schreibt abwechselnd, Fieldbook übersetzt ohne Internet."),
        el("p", {}, "Dafür brauchst du mindestens eine Sprache. Unter Inhalte im Abschnitt „Übersetzer“ kannst du Sprachen laden, zum Beispiel Englisch, Französisch oder Türkisch."),
        OW.status && OW.status.uebersetzer ? el("p", { class: "hinweis" }, "„Artikel übersetzen“ hast du schon, das übersetzt nur von Englisch nach Deutsch. Für ein Gespräch braucht es beide Richtungen, die kommen mit jeder Sprache dazu.") : null,
        el("a", { class: "knopf knopf-haupt", href: "#inhalte" }, sym("download"), "Sprachen laden")));
      return;
    }
    const codes = liste.map(s => s.code);
    if (!codes.includes(ich)) ich = "de";
    if (!du || !codes.includes(du) || du === ich) du = (liste.find(s => s.code !== ich && s.code !== "en") || liste.find(s => s.code !== ich)).code;
    const sprechbar = OW.status && OW.status.spracheingabe && info(ich).sprechen !== false && info(du).sprechen !== false;
    const sprechmodus = modus === "sprechen" && sprechbar;

    // Umschalter Schreiben | Sprechen (nur mit Spracheingabe)
    if (OW.status && OW.status.spracheingabe) {
      // Ein Schiebeschalter: der grüne Knopf gleitet zur gewählten Seite, danach wird neu gezeichnet
      const an = modus === "sprechen";
      const schalter = el("button", { class: "gs-modus" + (an ? " an" : ""), type: "button", role: "switch", "aria-checked": String(an),
        "aria-label": "Sprechmodus", disabled: !sprechbar && !an,
        title: sprechbar ? "" : "Für eine der beiden Sprachen gibt es keine Spracheingabe" },
        el("span", { class: "gs-modus-knopf", "aria-hidden": "true" }),
        el("span", { class: "gs-modus-seite" }, sym("send"), "Schreiben"),
        el("span", { class: "gs-modus-seite" }, sym("mic"), "Sprechen"));
      schalter.addEventListener("click", () => {
        modus = an ? "schreiben" : "sprechen";
        schalter.classList.toggle("an", !an);
        setTimeout(zeichne, 220);   // Gleiten erst zeigen
      });
      c.append(el("div", { class: "gs-modus-zeile" }, schalter));
    }

    const auswahl = (wert, onWahl, label) => {
      const s = el("select", { "aria-label": label, onchange: (e) => onWahl(e.target.value) },
        ...liste.map(x => el("option", { value: x.code, selected: x.code === wert }, x.code === "de" || x.name === x.eigen ? x.name : x.name + " · " + x.eigen)));
      return s;
    };
    const setzeDu = (v) => { if (v === ich) ich = du; du = v; try { localStorage.setItem("fb-gespraech-du", du); } catch { } zeichne(); };
    const setzeIch = (v) => { if (v === du) du = ich; ich = v; zeichne(); };

    // Überall gleich: ich links, Gegenüber rechts
    c.append(el("div", { class: "karte-box gs-kopf" },
      el("label", { class: "gs-sprache" }, el("span", {}, "Ich spreche"), auswahl(ich, setzeIch, "Meine Sprache")),
      el("button", { class: "knopf knopf-klein gs-tauschen", type: "button", title: "Sprachen tauschen", onclick: () => { [ich, du] = [du, ich]; zeichne(); } }, sym("arrow-left-right"), "Tauschen"),
      el("label", { class: "gs-sprache" }, el("span", {}, "Gegenüber spricht"), auswahl(du, setzeDu, "Sprache des Gegenübers")),
      el("button", { class: "knopf knopf-klein gs-neu", type: "button", disabled: !verlauf.length, onclick: () => { verlauf.length = 0; zeichne(); } }, sym("rotate-ccw"), "Neues Gespräch")));

    // Spracheingabe: einrichten, oder Hinweis bei Sprachen, die oft falsch erkannt werden
    if (!(OW.status && OW.status.spracheingabe)) {
      c.append(el("p", { class: "hinweis klein", style: "margin:-6px 0 14px" }, "Sprechen statt tippen: ",
        el("a", { href: "#inhalte?zu=sprechen" }, "Spracheingabe einrichten"), " (ca. 990 MB)"));
    } else {
      const schlecht = [ich, du].map(info).filter(x => x.sprechen === "schlecht");
      if (schlecht.length) c.append(el("div", { class: "warnung", style: "margin:-6px 0 14px" },
        schlecht.map(x => x.name).join(" und ") + (schlecht.length > 1 ? " werden" : " wird") + " beim Sprechen oft falsch erkannt. Prüfe den erkannten Text vor dem Übersetzen und danach die Rückübersetzung."));
    }
    // Sprache nur als Text geladen, obwohl es eine Stimme gäbe: kleiner Hinweis, wie man sie dazuholt
    const ohneStimme = [ich, du].filter(x => x !== "de" && ((OW.status && OW.status.stimmenFehlen) || []).includes(x)).map(x => info(x).name);
    if (ohneStimme.length) c.append(el("p", { class: "hinweis klein", style: "margin:-6px 0 14px" }, "Übersetzungen vorlesen lassen: ",
      el("a", { href: "#inhalte?zu=sprachen" }, "Sprache für " + ohneStimme.join(" und ") + " dazuladen")));

    const chat = el("div", { class: "gs-chat", "aria-live": "polite" });
    c.append(chat);
    zeichneVerlauf = () => {
      chat.innerHTML = "";
      if (!verlauf.length) chat.append(el("p", { class: "hinweis gs-leer" }, sprechmodus
        ? "Sprecht abwechselnd und macht nach jedem Satz eine kurze Pause. Fieldbook erkennt, wer gesprochen hat, übersetzt und liest die Übersetzung vor."
        : "Schreibt abwechselnd: du links, dein Gegenüber rechts. Mit „Groß zeigen“ erscheint deine Übersetzung bildschirmfüllend, dann kannst du den Laptop umdrehen."));
      for (const m of verlauf) chat.append(nachricht(m));
    };
    zeichneVerlauf();

    if (sprechmodus) {
      c.append(sprechFeld());
    } else {
      // Eingabe: links ich, rechts das Gegenüber (Beschriftung in seiner Sprache)
      const feldIch = eingabe("ich", ich, du);
      const feldDu = eingabe("du", du, ich);
      c.append(el("div", { class: "gs-eingabe" }, feldIch, feldDu));
    }
    c.append(el("p", { class: "hinweis klein" }, "Übersetzt offline mit Technik von Mozilla (wie in Firefox). Maschinelle Übersetzungen können Fehler machen, besonders bei sehr kurzen Sätzen. Die Rückübersetzung zeigt, ob der Sinn angekommen ist. Bei Medikamenten und wichtigen Dingen lieber noch einmal anders nachfragen."));
  }

  // Nachricht anlegen und übersetzen; fertig, sobald die Übersetzung da ist. Die Rückübersetzung zur
  // Kontrolle (in die Sprache dessen, der gesprochen oder geschrieben hat) läuft danach weiter.
  async function neueNachricht(wer, von, nach, t, gesprochen) {
    const m = { wer, von, nach, text: t, uebers: null, zurueck: null, fehler: null, gesprochen: !!gesprochen };
    verlauf.push(m);
    const neu = $(".gs-neu"); if (neu) neu.disabled = false;
    zeichneVerlauf();
    try {
      m.uebers = await uebersetze(von, nach, t);
      zeichneVerlauf();
      uebersetze(nach, von, m.uebers).then(z => { m.zurueck = z; zeichneVerlauf(); }).catch(() => { m.zurueck = "–"; zeichneVerlauf(); });
    } catch (e) {
      m.fehler = "Die Übersetzung hat nicht geklappt (" + (e && e.message || e) + ").";
      Statistik.fehler("Übersetzen " + von + "→" + nach + ": " + (e && e.message || e));
      zeichneVerlauf();
    }
    return m;
  }

  function eingabe(wer, sprache, andere) {
    const s = info(sprache);
    const text = el("textarea", { rows: 3, dir: "auto", lang: sprache, placeholder: wer === "ich" ? "Hier schreiben …" : "…" });
    const knopf = el("button", { class: "knopf" + (wer === "ich" ? " knopf-haupt" : ""), type: "button" }, sym("send"), wer === "ich" ? "Übersetzen" : "…");
    const titel = el("b", { dir: "auto", lang: sprache }, wer === "ich" ? "Ich (" + s.name + ")" : s.eigen);
    const senden = async () => {
      const t = text.value.trim();
      if (!t) { text.focus(); return; }
      text.value = "";
      const fertig = neueNachricht(wer, sprache, andere, t);
      text.focus();
      await fertig;
      text.closest(".gs-feld").scrollIntoView({ block: "nearest" });
    };
    text.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); senden(); } });
    knopf.addEventListener("click", senden);

    // Spracheingabe: Knopf „Sprechen“, wenn eingerichtet und die Sprache erkannt werden kann
    const meldung = el("p", { class: "hinweis klein gs-sprech-info", hidden: true });
    const pegel = el("div", { class: "gs-pegel", hidden: true }, el("span"));
    const sprechen = OW.status && OW.status.spracheingabe && s.sprechen !== false
      ? el("button", { class: "knopf", type: "button" }, sym("mic"), el("span", {}, wer === "ich" ? "Sprechen" : "…")) : null;
    if (sprechen) sprechen.addEventListener("click", () => aufnehmen({ wer, sprache, text, knopf: sprechen, pegel, meldung }));

    // Für das Gegenüber: Hinweis und Knöpfe in seiner Sprache
    if (wer === "du") {
      uebersetze("de", sprache, "Schreiben Sie hier in Ihrer Sprache.").then(t => { text.placeholder = t; }).catch(() => { text.placeholder = ""; });
      uebersetze("de", sprache, "Übersetzen").then(t => { knopf.lastChild.textContent = t; }).catch(() => { knopf.lastChild.textContent = "OK"; });
      if (sprechen) uebersetze("de", sprache, "Sprechen").then(t => { if (!aufnahme) sprechen.lastChild.textContent = t; }).catch(() => { sprechen.lastChild.textContent = "Sprechen"; });
    }
    return el("div", { class: "gs-feld gs-feld-" + wer }, titel, text, pegel, meldung,
      el("div", { class: "knopfreihe", style: "margin:0;justify-content:flex-end" }, sprechen, knopf));
  }

  // ------------------------------------------------ Spracheingabe
  // Ein Klick startet die Aufnahme, der zweite beendet sie. Der erkannte Text kommt ins Feld zum Prüfen.

  let aufnahme = null;   // laufende Aufnahme { f (Feld), fertig(), abbrechen() }
  const MAX_SEKUNDEN = 30;

  function zeigeMeldung(f, text) { f.meldung.textContent = text || ""; f.meldung.hidden = !text; }

  async function aufnehmen(f) {
    if (aufnahme) {
      const a = aufnahme;
      if (a.f.knopf === f.knopf) { a.fertig(); return; }
      a.abbrechen();   // anderes Feld: alte Aufnahme verwerfen, neue starten
    }
    zeigeMeldung(f, "");
    if (wiedergabe) { vorlesenStopp(); zeichneVerlauf(); }   // nicht gleichzeitig vorlesen und aufnehmen
    let strom;
    try {
      strom = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const n = e && e.name;
      zeigeMeldung(f, n === "NotAllowedError" || n === "SecurityError"
        ? "Der Browser darf das Mikrofon nicht benutzen. Klicke links in der Adresszeile auf das Schloss- oder Mikrofon-Symbol und erlaube das Mikrofon für diese Seite."
        : n === "NotFoundError" ? "Kein Mikrofon gefunden. Ist eines angeschlossen und in Windows eingeschaltet?"
        : "Das Mikrofon lässt sich nicht starten (" + (e && e.message || e) + ").");
      return;
    }
    const ctx = new AudioContext({ sampleRate: 16000 });
    const quelle = ctx.createMediaStreamSource(strom);
    const proz = ctx.createScriptProcessor(4096, 1, 1);
    const stuecke = [];
    let laenge = 0, spitze = 0, ende = false;
    proz.onaudioprocess = (e) => {
      if (ende) return;
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      stuecke.push(d); laenge += d.length;
      let summe = 0;
      for (let i = 0; i < d.length; i++) { summe += d[i] * d[i]; const b = Math.abs(d[i]); if (b > spitze) spitze = b; }
      const rms = Math.sqrt(summe / d.length);
      f.pegel.firstChild.style.width = Math.min(100, Math.round(rms * 400)) + "%";
      if (laenge >= MAX_SEKUNDEN * ctx.sampleRate) a.fertig();
    };
    quelle.connect(proz); proz.connect(ctx.destination);

    const textVorher = f.knopf.lastChild.textContent;
    const aufraeumen = () => {
      ende = true;
      try { proz.disconnect(); quelle.disconnect(); } catch { }
      strom.getTracks().forEach(t => t.stop());
      ctx.close().catch(() => { });
      if (aufnahme === a) aufnahme = null;
      f.knopf.classList.remove("gs-aufnahme");
      f.knopf.lastChild.textContent = textVorher;
      f.knopf.querySelector("use").setAttribute("href", "symbole.svg#mic");
      f.pegel.hidden = true;
    };
    const a = {
      f,
      abbrechen: aufraeumen,
      fertig: () => {
        if (ende) return;
        const rate = ctx.sampleRate;
        aufraeumen();
        if (laenge < rate * 0.5 || spitze < 0.02) { zeigeMeldung(f, "Nichts gehört. Klicke auf den Knopf, sprich, und klicke dann noch einmal."); return; }
        erkennen(f, wav(stuecke, laenge, rate));
      }
    };
    aufnahme = a;
    f.knopf.classList.add("gs-aufnahme");
    f.knopf.lastChild.textContent = f.wer === "ich" ? "Fertig" : "…";
    if (f.wer === "du") uebersetze("de", f.sprache, "Aufnahme beenden").then(t => { if (aufnahme === a) f.knopf.lastChild.textContent = t; }).catch(() => { });
    f.knopf.querySelector("use").setAttribute("href", "symbole.svg#square");
    f.pegel.hidden = false;
    zeigeMeldung(f, f.wer === "ich" ? "Ich höre zu …" : "");
  }

  // Aufnahme als WAV (16 Bit, mono); rechnet auf 16 kHz um, falls der Browser eine andere Rate liefert
  function wav(stuecke, laenge, rate) {
    const alle = new Float32Array(laenge);
    let pos = 0;
    for (const s of stuecke) { alle.set(s, pos); pos += s.length; }
    const faktor = rate / 16000, n = Math.floor(laenge / faktor);
    const puffer = new ArrayBuffer(44 + n * 2), v = new DataView(puffer);
    const schreib = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); };
    schreib(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); schreib(8, "WAVE"); schreib(12, "fmt ");
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true);
    v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); schreib(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const x = Math.max(-1, Math.min(1, alle[Math.floor(i * faktor)]));
      v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return new Blob([puffer], { type: "audio/wav" });
  }

  async function erkennen(f, blob) {
    const platzhalter = f.text.placeholder;
    f.text.disabled = true; f.knopf.disabled = true;
    f.text.placeholder = "Wird erkannt …";
    zeigeMeldung(f, "");
    try {
      const r = await fetch("/api/sprechen?sprache=" + encodeURIComponent(f.sprache), { method: "POST", headers: { "Content-Type": "audio/wav" }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.fehler) throw new Error(j.fehler || ("Fehler " + r.status));
      if (!j.text) zeigeMeldung(f, "Es wurde kein Text erkannt. Bitte noch einmal deutlicher sprechen.");
      else f.text.value = (f.text.value.trim() ? f.text.value.trim() + " " : "") + j.text;
    } catch (e) {
      zeigeMeldung(f, "Die Spracherkennung hat nicht geklappt (" + (e && e.message || e) + ").");
    } finally {
      f.text.disabled = false; f.knopf.disabled = false;
      f.text.placeholder = platzhalter;
      f.text.focus();
    }
  }

  // ------------------------------------------------ Sprechmodus
  // Fieldbook hört dauerhaft zu. Eine Sprechpause beendet den Satz; der Server bestimmt, welche der beiden
  // Sprachen es war, danach übersetzen und vorlesen. Während Erkennen, Übersetzen und Vorlesen hört es nicht zu.

  const BLOCK = 1024;                 // Samples je Messung (64 ms bei 16 kHz)
  // So lange Stille beendet einen Satz; einstellbar im Statusfeld, gemerkt im Browser
  const PAUSEN = { kurz: 500, mittel: 800, lang: 1300 };
  let pauseWahl = "mittel";
  try { const p = localStorage.getItem("fb-gespraech-pause"); if (PAUSEN[p]) pauseWahl = p; } catch { }
  const VORLAUF = 5;                  // Blöcke vor dem Sprechbeginn mitnehmen (Silbenanfang)
  const MAX_SATZ = 25;                // Sekunden, danach wird abgeschnitten
  // Codes für die Texterkennung (franc), nur für Sprachen, die Parakeet kann
  const ISO3 = { de: "deu", en: "eng", fr: "fra", nl: "nld", sv: "swe", nb: "nob", fi: "fin", da: "dan", es: "spa", it: "ita", pt: "por", pl: "pol",
    cs: "ces", sk: "slk", sl: "slv", hr: "hrv", bs: "bos", sr: "srp", hu: "hun", el: "ell", ru: "rus", lt: "lit", lv: "lvs", et: "ekk", bg: "bul", ro: "ron", uk: "ukr" };

  let sm = null;   // laufender Sprechmodus

  function smStopp() {
    if (!sm) return;
    const s = sm;
    sm = null;
    s.aus = true;
    try { s.proz.disconnect(); s.quelle.disconnect(); } catch { }
    if (s.strom) s.strom.getTracks().forEach(t => t.stop());
    if (s.ctx) s.ctx.close().catch(() => { });
  }

  const micFehler = (e) => {
    const n = e && e.name;
    return n === "NotAllowedError" || n === "SecurityError"
      ? "Der Browser darf das Mikrofon nicht benutzen. Klicke links in der Adresszeile auf das Schloss- oder Mikrofon-Symbol und erlaube das Mikrofon für diese Seite."
      : n === "NotFoundError" ? "Kein Mikrofon gefunden. Ist eines angeschlossen und in Windows eingeschaltet?"
      : "Das Mikrofon lässt sich nicht starten (" + (e && e.message || e) + ").";
  };

  // Wie lange Stille einen Satz beendet: kurz (schnell, schneidet bei Denkpausen ab) bis lang (geduldiger)
  function pausenWahl() {
    const gruppe = el("div", { class: "gs-sm-pausen", role: "group", "aria-label": "Sprechpause bis zum Übersetzen" },
      el("span", { class: "hinweis klein" }, "Sprechpause:"));
    const knoepfe = Object.keys(PAUSEN).map(w => el("button", { class: "knopf knopf-klein" + (w === pauseWahl ? " knopf-haupt" : ""), type: "button",
      "aria-pressed": String(w === pauseWahl), title: (PAUSEN[w] / 1000).toLocaleString("de-DE") + " Sekunden Stille beenden einen Satz",
      onclick: () => {
        pauseWahl = w;
        try { localStorage.setItem("fb-gespraech-pause", w); } catch { }
        knoepfe.forEach(k => { const an = k === knoepfe[Object.keys(PAUSEN).indexOf(w)]; k.classList.toggle("knopf-haupt", an); k.setAttribute("aria-pressed", String(an)); });
      } }, w));
    gruppe.append(...knoepfe);
    return gruppe;
  }

  // Statusfeld unter dem Chat: großer Zustand, Pegel, Pause
  function sprechFeld() {
    const status = el("div", { class: "gs-sm-status" }, "Mikrofon wird gestartet …");
    const fremd = el("div", { class: "gs-sm-fremd", dir: richtung(du), lang: du });
    const pegel = el("div", { class: "gs-pegel gs-sm-pegel" }, el("span"));
    const meldung = el("p", { class: "hinweis klein gs-sm-meldung", hidden: true });
    const pause = el("button", { class: "knopf", type: "button" }, sym("square"), "Stop");
    const ohneStimme = [ich, du].filter(x => !kannVorlesen(x)).map(x => info(x).name);
    const feld = el("div", { class: "karte-box gs-sprechmodus", "aria-live": "polite" }, status, fremd, pegel,
      el("div", { class: "knopfreihe gs-sm-knoepfe" }, pause, pausenWahl()), meldung,
      ohneStimme.length ? el("p", { class: "hinweis klein", style: "margin:10px 0 0" }, "Für " + ohneStimme.join(" und ") + " ist keine Stimme geladen: Die Übersetzung steht dann nur im Chat.") : null);
    uebersetze("de", du, "Bitte sprechen Sie. Ich übersetze.").then(t => { fremd.textContent = t; }).catch(() => { });

    // Zustand: schlange = fertige Aufnahmen, die noch erkannt werden; ungelesen = übersetzte Nachrichten,
    // die noch vorgelesen werden; schritt = was die Arbeit gerade tut; spricht = jemand redet gerade
    const s = { aus: false, pausiert: false, spricht: false, laeuft: false, liest: false, schritt: "", schlange: [], ungelesen: [], erwartet: ich, feld };
    s.anzeigen = () => {
      if (sm !== s) return;
      const [text, zustand] = s.pausiert ? ["Gestoppt", "pause"]
        : s.liest ? ["Liest vor …", "liest"]
        : s.spricht ? ["Hört zu … (spricht)", "hoert"]
        : s.schritt ? [s.schritt, "arbeitet"]
        : ["Hört zu …", "hoert"];
      status.textContent = text;
      feld.dataset.zustand = zustand;
      pegel.hidden = s.pausiert || s.liest;
    };
    s.fehler = (text) => { meldung.textContent = text || ""; meldung.hidden = !text; };
    pause.addEventListener("click", () => {
      s.pausiert = !s.pausiert;
      pause.replaceChildren(sym(s.pausiert ? "mic" : "square"), s.pausiert ? "Weiter" : "Stop");
      if (s.pausiert) { vorlesenStopp(); s.ungelesen = []; }
      s.anzeigen();
      if (!s.pausiert) smArbeiten(s);
    });
    smStarten(s);
    return feld;
  }

  async function smStarten(s) {
    smStopp();
    sm = s;
    try {
      s.strom = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      if (sm === s) { s.feld.querySelector(".gs-sm-status").textContent = "Mikrofon aus"; s.feld.dataset.zustand = "fehler"; s.fehler(micFehler(e)); }
      return;
    }
    if (sm !== s) { s.strom.getTracks().forEach(t => t.stop()); return; }
    s.ctx = new AudioContext({ sampleRate: 16000 });
    s.ctx.resume().catch(() => { });
    s.quelle = s.ctx.createMediaStreamSource(s.strom);
    s.proz = s.ctx.createScriptProcessor(BLOCK, 1, 1);
    const rate = s.ctx.sampleRate, blockMs = BLOCK / rate * 1000;
    let rausch = 0, laut = 0, stille = 0, satz = [], vorlauf = [], laenge = 0, spitze = 0;
    const balken = s.feld.querySelector(".gs-sm-pegel span");
    const sprichtSetzen = (an) => { if (s.spricht !== an) { s.spricht = an; s.anzeigen(); } };
    s.anzeigen();
    s.proz.onaudioprocess = (e) => {
      if (s.aus) return;
      const d = new Float32Array(e.inputBuffer.getChannelData(0));
      let summe = 0, max = 0;
      for (let i = 0; i < d.length; i++) { summe += d[i] * d[i]; const b = Math.abs(d[i]); if (b > max) max = b; }
      const rms = Math.sqrt(summe / d.length);
      // Nicht zuhören bei Pause, beim Vorlesen und kurz danach. Beim Erkennen und Übersetzen hört es weiter zu.
      if (s.pausiert || wiedergabe || performance.now() < stummBis) {
        satz = []; vorlauf = []; laut = 0;
        if (s.spricht) { sprichtSetzen(false); smArbeiten(s); }
        return;
      }
      balken.style.width = Math.min(100, Math.round(rms * 400)) + "%";
      // Grundrauschen langsam nachführen (sinkt schnell, steigt langsam)
      rausch = !rausch ? rms : rms < rausch ? rausch * 0.9 + rms * 0.1 : rausch * 0.998 + rms * 0.002;
      const schwelle = Math.max(0.012, rausch * 3.5);
      if (!s.spricht) {
        vorlauf.push(d); if (vorlauf.length > VORLAUF) vorlauf.shift();
        laut = rms > schwelle ? laut + 1 : 0;
        if (laut >= 3) { satz = vorlauf.slice(); vorlauf = []; laenge = satz.reduce((n, x) => n + x.length, 0); stille = 0; spitze = 0; sprichtSetzen(true); }
        return;
      }
      satz.push(d); laenge += d.length; if (max > spitze) spitze = max;
      stille = rms > schwelle ? 0 : stille + blockMs;
      if (stille >= PAUSEN[pauseWahl] || laenge >= MAX_SATZ * rate) {
        const sprechzeit = laenge / rate - stille / 1000;
        const teile = satz; satz = [];
        // Räuspern oder Klopfen nicht schicken
        if (sprechzeit >= 0.5 && spitze >= 0.03) s.schlange.push(wav(teile, laenge, rate));
        sprichtSetzen(false);
        smArbeiten(s);
      }
    };
    s.quelle.connect(s.proz); s.proz.connect(s.ctx.destination);
  }

  // Arbeitet die Aufnahmen der Reihe nach ab. Vorgelesen wird erst, wenn nichts mehr wartet und
  // gerade niemand spricht; redet jemand weiter, wird sein nächster Satz vorher angehängt.
  async function smArbeiten(s) {
    if (s.laeuft) return;
    s.laeuft = true;
    try {
      while (sm === s) {
        if (s.schlange.length) { await smSatz(s, s.schlange.shift()); continue; }
        if (s.spricht || s.pausiert || !s.ungelesen.length) break;
        const m = s.ungelesen.shift();
        if (!m.uebers || !kannVorlesen(m.nach)) continue;
        s.liest = true; s.anzeigen();
        await vorlesen(m, () => zeichneVerlauf());
        // „Hört zu“ erst zeigen, wenn wirklich zugehört wird (nach dem Vorlesen kurz Nachhall abwarten)
        const warten = stummBis - performance.now();
        if (warten > 0) await new Promise(r => setTimeout(r, warten));
        s.liest = false;
      }
    } finally {
      s.laeuft = false;
      s.liest = false;
      s.schritt = "";
      s.anzeigen();
    }
  }

  // Ein Satz: erkennen (welche Sprache?), übersetzen. Spricht dieselbe Person weiter, bevor ihre letzte
  // Nachricht vorgelesen wurde, kommt der Satz dazu und alles wird zusammen neu übersetzt.
  async function smSatz(s, blob) {
    s.fehler("");
    s.schritt = "Wird erkannt …"; s.anzeigen();
    try {
      // Wartet noch eine Nachricht aufs Vorlesen, redet vermutlich dieselbe Person weiter
      const offen = s.ungelesen[s.ungelesen.length - 1];
      const erwartet = offen ? offen.von : s.erwartet;
      const r = await fetch("/api/sprechen?paar=" + encodeURIComponent(ich + "," + du) + "&erwartet=" + encodeURIComponent(erwartet), { method: "POST", headers: { "Content-Type": "audio/wav" }, body: blob });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.fehler) throw new Error(j.fehler || ("Fehler " + r.status));
      if (sm !== s) return;
      if (!j.text) { if (!offen) s.fehler("Nichts verstanden. Bitte noch einmal etwas deutlicher sprechen."); return; }
      const sprache = j.sprache || await textSprache(j.text, erwartet);
      s.schritt = "Wird übersetzt …"; s.anzeigen();
      s.erwartet = sprache === ich ? du : ich;   // im Gespräch spricht als Nächstes meist der andere
      if (offen && offen.von === sprache && !offen.fehler) {
        offen.text += " " + j.text;
        offen.zurueck = null;
        zeichneVerlauf();
        await neuUebersetzen(offen);
      } else {
        const m = await neueNachricht(sprache === ich ? "ich" : "du", sprache, sprache === ich ? du : ich, j.text, true);
        s.ungelesen.push(m);
      }
      s.feld.scrollIntoView({ block: "nearest" });
    } catch (e) {
      if (sm === s) s.fehler("Das hat nicht geklappt (" + (e && e.message || e) + ").");
    }
  }

  // Den ganzen (gewachsenen) Text einer Nachricht neu übersetzen, Rückübersetzung danach
  async function neuUebersetzen(m) {
    try {
      m.uebers = await uebersetze(m.von, m.nach, m.text);
      zeichneVerlauf();
      uebersetze(m.nach, m.von, m.uebers).then(z => { m.zurueck = z; zeichneVerlauf(); }).catch(() => { m.zurueck = "–"; zeichneVerlauf(); });
    } catch (e) {
      m.fehler = "Die Übersetzung hat nicht geklappt (" + (e && e.message || e) + ").";
      zeichneVerlauf();
    }
  }

  // Parakeet hat erkannt, aber nicht gesagt, welche der beiden Sprachen: am Text entscheiden,
  // bei knappem Ergebnis gilt der Sprecherwechsel
  async function textSprache(text, erwartet) {
    const a = ISO3[ich], b = ISO3[du];
    if (!a || !b) return erwartet;
    try {
      const { francAll } = await import("/vendor/franc/franc.js");
      const r = francAll(text, { only: [a, b], minLength: 1 });
      if (!r.length || r[0][0] === "und") return erwartet;
      if (r.length > 1 && r[1][1] > 0.6) return erwartet;
      return r[0][0] === a ? ich : du;
    } catch { return erwartet; }
  }

  function nachricht(m) {
    const laedt = !m.uebers && !m.fehler;
    const haupt = m.fehler ? el("div", { class: "gs-fehler" }, m.fehler)
      : laedt ? el("div", { class: "gs-text hinweis" }, "Wird übersetzt …")
      : el("div", { class: "gs-text", dir: richtung(m.nach), lang: m.nach }, m.uebers);
    const original = el("div", { class: "gs-klein" }, el("span", { class: "gs-marke" }, m.wer === "ich" ? (m.gesprochen ? "Du hast gesagt:" : "Du hast geschrieben:") : "Original (" + info(m.von).name + "):"),
      " ", el("span", { dir: richtung(m.von), lang: m.von }, m.text));
    const zurueck = m.uebers ? el("div", { class: "gs-klein" }, el("span", { class: "gs-marke", dir: richtung(m.von), lang: m.von }, marke(m.von)), " ",
      m.zurueck == null ? "…" : el("span", { dir: richtung(m.von), lang: m.von }, m.zurueck)) : null;
    const gross = m.uebers ? el("button", { class: "knopf knopf-klein", type: "button", onclick: () => grossZeigen(m) }, sym("maximize-2"), "Groß zeigen") : null;
    const lesen = m.uebers && kannVorlesen(m.nach) ? vorlesenKnopf(m, () => zeichneVerlauf()) : null;
    const lesenFehler = m.vorlesenFehler ? el("div", { class: "gs-fehler gs-klein" }, m.vorlesenFehler) : null;
    return el("div", { class: "gs-nachricht gs-" + m.wer }, haupt, original, zurueck, lesenFehler, gross ? el("div", { class: "gs-knoepfe" }, lesen, gross) : null);
  }

  // ------------------------------------------------ Vorlesen
  // Piper liest die Übersetzung in der Zielsprache vor, nur auf Knopfdruck. Ein zweiter Klick hält an.

  let wiedergabe = null;   // { m, audio } – audio fehlt, solange der Server noch rechnet
  const kannVorlesen = (code) => ((OW.status && OW.status.stimmen) || []).includes(code);

  let stummBis = 0;        // Sprechmodus: kurz nach dem Vorlesen noch nicht zuhören (Nachhall)

  function vorlesenStopp() {
    const w = wiedergabe;
    wiedergabe = null;
    if (!w) return;
    if (w.audio) { w.audio.pause(); URL.revokeObjectURL(w.audio.src); }
    stummBis = performance.now() + 400;
    if (w.ende) w.ende();
  }

  // Liest m.uebers vor; das Versprechen ist erfüllt, wenn das Vorlesen vorbei ist (oder angehalten wurde)
  async function vorlesen(m, danach) {
    const lief = wiedergabe && wiedergabe.m === m;
    vorlesenStopp();
    if (lief) { danach(); return; }
    const w = { m, audio: null, ende: null };
    wiedergabe = w;
    m.vorlesenFehler = null;
    danach();
    try {
      const r = await fetch("/api/vorlesen", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sprache: m.nach, text: m.uebers }) });
      if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.fehler || ("Fehler " + r.status)); }
      const blob = await r.blob();
      if (wiedergabe !== w) return;
      w.audio = new Audio(URL.createObjectURL(blob));
      const vorbei = new Promise(res => { w.ende = res; });
      w.audio.onended = () => { if (wiedergabe === w) { vorlesenStopp(); danach(); } };
      await w.audio.play();
      danach();
      await vorbei;
    } catch (e) {
      if (wiedergabe !== w) return;
      vorlesenStopp();
      m.vorlesenFehler = "Vorlesen hat nicht geklappt (" + (e && e.message || e) + ").";
      danach();
    }
  }

  function vorlesenKnopf(m, danach) {
    const aktiv = !!(wiedergabe && wiedergabe.m === m);
    const rechnet = aktiv && !wiedergabe.audio;
    return el("button", { class: "knopf knopf-klein", type: "button", "aria-pressed": String(aktiv), onclick: (e) => { e.stopPropagation(); vorlesen(m, danach); } },
      sym(aktiv ? "square" : "volume-2"), rechnet ? "Wird vorbereitet …" : aktiv ? "Anhalten" : "Vorlesen");
  }

  // Übersetzung bildschirmfüllend, zum Herzeigen
  function grossZeigen(m) {
    const zu = () => { hinter.remove(); document.removeEventListener("keydown", taste); };
    const taste = (e) => { if (e.key === "Escape") zu(); };
    // Vorlesen-Knopf neben „Schließen“, aktualisiert sich selbst und den Chat
    const lesen = el("span");
    const neu = () => { lesen.replaceChildren(vorlesenKnopf(m, () => { neu(); zeichneVerlauf(); })); lesen.firstChild.classList.remove("knopf-klein"); };
    if (kannVorlesen(m.nach)) neu();
    const hinter = el("div", { class: "gs-gross", role: "dialog", "aria-modal": "true", onclick: zu },
      el("div", { class: "gs-gross-knoepfe" }, lesen, el("button", { class: "knopf gs-gross-zu", type: "button" }, sym("x"), "Schließen")),
      el("div", { class: "gs-gross-text", dir: richtung(m.nach), lang: m.nach }, m.uebers),
      el("div", { class: "gs-gross-original", dir: richtung(m.von), lang: m.von }, m.text));
    document.addEventListener("keydown", taste);
    document.body.append(hinter);
    hinter.querySelector(".gs-gross-zu").focus();
  }

  return { zeigen };
})();

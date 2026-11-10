// Inhalte: Downloads verfolgen und installierte Inhalte verwalten (unabhängig vom Einrichtungs-Assistenten).
"use strict";

const Inhalte = (() => {
  let kat = null, hw = null, timer = null, verlauf = [], gruppen = {}, sprachen = [], stimmen = [], alleSprachen = false, sprachSort = "standard";
  try { if (localStorage.getItem("fb-sprachen-sortierung") === "nord") sprachSort = "nord"; } catch { }
  // Aufgeklappte Abschnitte (bleiben beim Neuzeichnen offen)
  const aufgeklappt = new Set();
  const auswahl = { modelle: new Set(), pakete: new Set(), karten: new Map(), routen: false, routenGroesse: null, sprachen: new Set(), stimmen: new Set() };

  let lauf = 0;
  async function zeigen(params) {
    const nr = ++lauf; // zweites zeigen() während des Ladens: nur das letzte gilt
    clearInterval(timer);
    warAktiv = null; // Liste beim Öffnen immer neu zeichnen
    $("#inhalte-liste").innerHTML = '<p class="hinweis">Wird geladen …</p>';
    try {
      let konf, sk, st;
      [kat, hw, konf, sk, st] = await Promise.all([api("katalog"), api("hardware"), ladeKonfig("pakete").catch(() => ({})), ladeKonfig("sprachen").catch(() => ({})), ladeKonfig("stimmen").catch(() => ({}))]);
      gruppen = konf.variantenGruppen || {};
      sprachen = sk.sprachen || [];
      stimmen = st.stimmen || [];
    }
    catch (e) { if (nr === lauf) $("#inhalte-liste").innerHTML = '<div class="fehlerbox">Fehler: ' + esc(e.message) + "</div>"; return; }
    if (nr !== lauf) return;
    // Vom Übersetzer aus den Bereich „Sprachen“ gleich aufgeklappt zeigen
    const zuUe = params && params.get("zu");
    // (nur dieser, es ist immer höchstens ein Abschnitt offen)
    if (zuUe === "sprachen" || zuUe === "sprechen" || zuUe === "vorlesen") { aufgeklappt.clear(); aufgeklappt.add("sprachen"); }
    if (zuUe === "karten") { aufgeklappt.clear(); aufgeklappt.add("karten"); }
    await fortschritt();
    if (nr !== lauf) return;
    // Vom Übersetzer aus („Sprachen hinzufügen“) direkt zu den Sprachen springen, von der Karte aus zu den Karten
    const zu = params && params.get("zu");
    const ziel = zu === "sprachen" ? $("#inh-sprachen") : zu === "sprechen" ? $("#inh-sprechen") : zu === "vorlesen" ? $("#inh-sprachen")
      : zu === "karten" ? $("#inh-bereich-karten") : null;
    if (ziel) ziel.scrollIntoView({ block: "start" });
    timer = setInterval(() => { if (!location.hash.startsWith("#inhalte")) { clearInterval(timer); return; } fortschritt(); }, 1000);
  }

  $("#inhalte-update").addEventListener("click", (e) => jetztAktualisieren(e.currentTarget));
  $("#inhalte-import").addEventListener("click", () => importDialog());

  // ------------------------------------------------ Übernahme vom USB-Stick oder aus einem Ordner

  async function importDialog() {
    const feld = el("input", { type: "text", placeholder: "z. B. E:\\ oder E:\\Fieldbook\\daten", "aria-label": "Ordner", style: "flex:1;min-width:0" });
    const status = el("p", { class: "hinweis klein", style: "margin-top:0" },
      "Wähle den USB-Stick oder einen Ordner. Fieldbook sucht darin nach Wissenspaketen, Karten, KI-Modellen und Wegedaten, auch im daten-Ordner eines anderen Fieldbook-Laptops.");
    const liste = el("div", {});
    let gefunden = [], basis = "";
    const gewaehlt = new Set();
    // Pfad nur ab dem gewählten Ordner zeigen ("…\wissen\paket.zim")
    const kurz = (p) => p.toLowerCase().startsWith(basis.toLowerCase()) ? "…" + p.slice(basis.replace(/\\$/, "").length) : p;

    const zeichne = () => {
      liste.innerHTML = "";
      for (const d of gefunden) {
        const tags = d.vorhanden ? [tag("✓ schon vorhanden", "tag-ok")] : [];
        liste.append(auswahlZeile("checkbox", "imp", gewaehlt.has(d.datei), d.vorhanden, (e) => {
          if (e.target.checked) gewaehlt.add(d.datei); else gewaehlt.delete(d.datei);
          zeichne();
        }, [d.titel, ...tags], kurz(d.datei), groesse(d.bytes)));
      }
    };
    const suchen = async () => {
      const ordner = feld.value.trim();
      if (!ordner) return;
      status.textContent = "Wird durchsucht …";
      liste.innerHTML = "";
      const r = await api("import/pruefen?ordner=" + encodeURIComponent(ordner)).catch(e => ({ fehler: e.message }));
      if (r.fehler) { status.textContent = r.fehler; return; }
      gefunden = r.dateien;
      basis = r.ordner || ordner;
      gewaehlt.clear();
      gefunden.filter(d => !d.vorhanden).forEach(d => gewaehlt.add(d.datei));
      const neu = gefunden.filter(d => !d.vorhanden);
      status.textContent = !gefunden.length ? "Keine passenden Dateien gefunden."
        : neu.length + " neue von " + gefunden.length + " gefundenen Dateien, zusammen " + groesse(neu.reduce((s, d) => s + d.bytes, 0)) + ".";
      zeichne();
    };
    feld.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); suchen(); } });
    const waehlen = el("button", { class: "knopf", type: "button", onclick: async (e) => {
      const k = e.currentTarget;
      k.disabled = true;
      status.textContent = "Das Fenster zur Ordnerauswahl ist offen. Falls du es nicht siehst: unten in der Taskleiste auf „Fieldbook: Ordner wählen“ klicken.";
      const r = await api("import/ordner", {}).catch(() => ({}));
      k.disabled = false;
      if (r.ordner) { feld.value = r.ordner; suchen(); } else status.textContent = "Kein Ordner gewählt.";
    } }, sym("folder"), "Ordner wählen …");

    const inhalt = el("div", {}, status,
      el("div", { class: "knopfreihe", style: "margin:8px 0 12px;flex-wrap:nowrap" }, waehlen, feld, el("button", { class: "knopf", type: "button", onclick: suchen }, "Suchen")),
      liste);
    const ok = await dialog("Von USB-Stick oder Ordner übernehmen", inhalt, [{ text: "Abbrechen", wert: false }, { text: "Übernehmen", wert: true, haupt: true }]);
    if (!ok || !gewaehlt.size) return;
    const r = await api("import/uebernehmen", { dateien: [...gewaehlt] });
    if (r.fehler) { await dialog("Hinweis", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); return; }
    // Aus dem Assistenten heraus (ohne Internet): zur Seite Inhalte, dort läuft die Übernahme
    if (!location.hash.startsWith("#inhalte")) { location.hash = "#inhalte"; return; }
    warAktiv = null;
    window.scrollTo(0, 0);
    fortschritt();
  }

  // ------------------------------------------------ Download-Fortschritt

  let warAktiv = null;
  // Was gerade wartet oder lädt: Pakete (name|flavour) und übrige Downloads (Titel), damit sie nicht doppelt wählbar sind
  let offen = { pakete: new Set(), titel: new Set() }, offenSig = "";
  let fortschrittLaeuft = false, abrufFehler = 0, updateLief = false;
  async function fortschritt() {
    // Nie zwei Abrufe zugleich
    if (fortschrittLaeuft) return;
    fortschrittLaeuft = true;
    try { await fortschrittHolen(); } finally { fortschrittLaeuft = false; }
  }

  async function fortschrittHolen() {
    let f;
    try { f = await api("fortschritt"); abrufFehler = 0; }
    catch {
      // Ein einzelner Fehler zählt nicht: erst nach 3 in Folge oder wenn ein Programm-Update lief
      abrufFehler++;
      if (warAktiv && (abrufFehler >= 3 || updateLief)) { clearInterval(timer); neustartAnzeigen(null); }
      return;
    }
    updateLief = f.jobs.some(j => j.art === "programm-update");
    const box = $("#inhalte-downloads");
    if (!f.jobs.length) { box.hidden = true; box.dataset.sig = ""; } else { box.hidden = false; zeichneFortschritt(box, f); }
    const laufend = f.aktiv ? f.jobs.filter(j => j.status === "wartet" || j.status === "laeuft") : [];
    const sig = laufend.map(j => j.titel).join("|");
    // Liste beim Start, nach dem Ende eines Downloads und wenn sich die Warteschlange ändert neu zeichnen
    if (warAktiv === null || warAktiv !== f.aktiv || sig !== offenSig) {
      if (warAktiv && !f.aktiv && f.jobs.some(j => j.art === "programm-update" && j.status === "fertig")) { clearInterval(timer); neustartAnzeigen(null); return; }
      if (warAktiv !== null) {
        kat = await api("katalog");
        OW.buecher = null;
        aktualisiereStatus();
      }
      offen = { pakete: new Set(laufend.filter(j => j.paket).map(j => j.paket)), titel: new Set(laufend.map(j => j.titel)) };
      offenSig = sig;
      warAktiv = f.aktiv;
      zeichneListe(f.aktiv);
    }
  }

  const JOB_REIHENFOLGE = { laeuft: 0, wartet: 1, fehler: 2, abgebrochen: 2, fertig: 3 };

  function zeichneFortschritt(box, f) {
    verlauf.push({ t: Date.now(), b: f.bytes });
    verlauf = verlauf.filter(v => Date.now() - v.t < 20000);
    let tempo = "", rest = "";
    // Solange die Hilfsprogramme laden, läuft oft nur ein Download: Die Restzeit wäre viel zu hoch
    const programme = f.aktiv && f.jobs.some(j => j.art === "programm" && (j.status === "laeuft" || j.status === "wartet"));
    if (f.aktiv && verlauf.length > 2) {
      const v = (verlauf[verlauf.length - 1].b - verlauf[0].b) / ((verlauf[verlauf.length - 1].t - verlauf[0].t) / 1000);
      if (v > 0) { tempo = mbit(v); rest = programme ? "Restzeit folgt" : "noch " + dauer((f.gesamt - f.bytes) / v); }
    }
    if (!f.aktiv) verlauf = [];
    const anteil = f.gesamt > 0 ? Math.min(100, f.bytes / f.gesamt * 100) : 0;
    // Laufende oben, dann wartende, dann Fehler, fertige unten (innerhalb der Gruppen in Warteschlangen-Reihenfolge)
    const sortiert = [...f.jobs].sort((a, b) => JOB_REIHENFOLGE[a.status] - JOB_REIHENFOLGE[b.status]);
    const jobAnzeige = (j) => {
      const p = j.gesamt > 0 ? Math.min(100, j.bytes / j.gesamt * 100) : (j.status === "fertig" ? 100 : 0);
      const st = { wartet: "wartet", laeuft: j.gesamt > 0 ? Math.floor(p) + " %" : groesse(j.bytes), fertig: "✓ fertig", fehler: "✗ Fehler", abgebrochen: "abgebrochen" }[j.status];
      return { p, st };
    };
    // Ändert sich nur Prozent oder Tempo, werden nur Zahlen und Balken aktualisiert, damit Klicks nicht verloren gehen
    const sig = [f.aktiv, programme, ...sortiert.map(j => [j.titel, j.status, j.art, j.fehler, j.gesamt > 0].join("~"))].join("|");
    if (box.dataset.sig === sig && box.firstChild) {
      box.querySelector(".dl-menge").textContent = groesse(f.bytes) + " von " + groesse(f.gesamt);
      box.querySelector(".dl-tempo").textContent = tempo;
      box.querySelector(".dl-rest").textContent = rest;
      box.querySelector(".balken > div").style.width = anteil + "%";
      box.querySelectorAll(".job").forEach((d, i) => {
        const a = jobAnzeige(sortiert[i]);
        d.querySelector(".dl-status").textContent = a.st;
        d.querySelector(".balken > div").style.width = a.p + "%";
      });
      return;
    }
    box.dataset.sig = sig;
    box.innerHTML = "";
    const fehler =f.jobs.filter(j => j.status === "fehler" || j.status === "abgebrochen");
    // Fertige Einträge aus der Liste nehmen (die Inhalte bleiben installiert), auch während noch geladen wird
    const fertige = f.jobs.filter(j => j.status === "fertig" && j.art !== "programm-update").length;
    const aufraeumen = fertige ? el("button", { class: "knopf knopf-klein", title: "Nimmt die fertigen Downloads aus dieser Liste. Die Inhalte bleiben installiert.", onclick: async (e) => {
      e.currentTarget.disabled = true;
      await api("downloads/aufraeumen", {}).catch(() => { });
      verlauf = [];
      fortschritt();
    } }, "Liste aufräumen (" + fertige + " fertig)") : null;
    box.append(el("div", {},
      el("div", { class: "titel-zeile", style: "margin-bottom:8px" },
        el("h2", { style: "margin:0" }, f.aktiv ? "Wird heruntergeladen …" : fehler.length ? "Downloads unvollständig" : "✓ Downloads fertig"),
        el("div", { class: "knopfreihe", style: "margin:0" }, aufraeumen,
          f.aktiv ? el("button", { class: "knopf knopf-klein knopf-rot", onclick: async () => {
            if (await dialog("Downloads abbrechen?", "Bereits geladene Teile bleiben erhalten. Mit „Erneut versuchen“ oder wenn du das Paket wieder auswählst, geht es an derselben Stelle weiter. Karten beginnen dann von vorn.",
              [{ text: "Weiterladen", wert: false }, { text: "Abbrechen", wert: true, haupt: true }])) await api("abbrechen", {});
          } }, "Abbrechen")
            : fehler.length ? [
              el("button", { class: "knopf knopf-klein", onclick: (e) => verbindungPruefen(e.currentTarget) }, sym("search"), "Verbindung prüfen"),
              el("button", { class: "knopf knopf-klein knopf-haupt", onclick: async () => { const r = await api("wiederholen", {}); if (r.fehler) alert(r.fehler); } }, "⟳ Erneut versuchen")] : null)),
      el("div", { class: "job-kopf" }, el("b", {}, "Gesamt"),
        el("span", { class: "dl-zahlen" },
          el("span", { class: "dl-menge" }, groesse(f.bytes) + " von " + groesse(f.gesamt)),
          el("span", { class: "dl-tempo" }, tempo),
          el("span", { class: "dl-rest" }, rest))),
      el("div", { class: "balken" }, el("div", { style: "width:" + anteil + "%" })),
      programme ? el("p", { class: "hinweis klein", style: "margin:6px 0 0" }, "Zuerst lädt Fieldbook die Hilfsprogramme. Danach laden bis zu drei Inhalte gleichzeitig. Das geht meist deutlich schneller, und Fieldbook zeigt dann auch die Restzeit.") : null,
      ...sortiert.map(j => {
        const { p, st } = jobAnzeige(j);
        return el("div", { class: "job" },
          el("div", { class: "job-kopf" }, el("span", {}, j.titel), el("span", { class: "dl-status" }, st)),
          el("div", { class: "balken" }, el("div", { style: "width:" + p + "%" })),
          j.fehler && j.status !== "fertig" ? el("small", { style: "color:var(--rot)" }, j.fehler) : null);
      }),
      f.aktiv ? el("p", { class: "hinweis klein" }, "Fertige Pakete kannst du schon benutzen. Das Browserfenster kannst du schließen, die Downloads laufen weiter. Wird Fieldbook beendet, geht es beim nächsten Start weiter" +
        (f.jobs.some(j => j.art === "karte" && (j.status === "wartet" || j.status === "laeuft")) ? " (Karten beginnen dann von vorn)." : ".")) : null));
  }

  // ------------------------------------------------ Liste der Inhalte

  function zeichneListe(aktiv) {
    const c = $("#inhalte-liste");
    c.innerHTML = "";
    const s = OW.status || {};
    if (aktiv) c.append(el("p", { class: "hinweis" }, "Downloads laufen. Was du jetzt auswählst, kommt mit in die Warteschlange."));
    const ladeTag = () => tag("wird geladen", "tag-warn");
    if (s.bibliothekFehler) c.append(el("p", { class: "fehlerbox" }, s.bibliothekFehler));
    // Nach einem Neustart ohne Internet oder über einen Handy-Hotspot wird nicht von selbst weitergeladen
    if (s.unterbrochen > 0 && !aktiv) c.append(el("div", { class: "warnung", style: "display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;margin-bottom:14px" },
      el("span", {}, s.unterbrochen + " Download(s) wurden beim letzten Beenden unterbrochen. Ohne Internet oder über einen Handy-Hotspot lädt Fieldbook nicht von selbst weiter."),
      el("button", { class: "knopf knopf-klein knopf-haupt", onclick: async () => {
        const r = await api("fortsetzen", {});
        if (r.fehler) { await dialog("Hinweis", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); }
        await aktualisiereStatus();
        warAktiv = null;
        fortschritt();
      } }, "⟳ Jetzt fortsetzen")));

    // KI-Modelle
    const emp0 = Setup.empfehlung(hw, kat.modelle);
    const backend = (kat.einstellungen && kat.einstellungen.backend) || emp0.backend;
    // Empfehlung passend zum eingestellten Rechenweg (Prozessor oder Grafikkarte)
    const passend = kat.modelle.filter(m => !m.ausgemustert && ["gpu", "cpu"].includes(Setup.passung(m, hw, backend))).sort((a, b) => b.bytes - a.bytes);
    const emp = { modell: passend[0] ? passend[0].id : emp0.modell };
    // Alle Bereiche als aufklappbare Zeilen; zugeklappt steht darunter, was schon installiert ist
    const liste = el("div", { class: "klapp-liste-abschnitte" });
    c.append(liste);
    // Vier Bereiche wie im Assistenten (KI, Wissen, Karten, Sprachen); die Wissens-Kategorien klappen im Bereich Wissen auf.
    // fehlen: noch nicht installierte Namen (für „Alles installiert“ / „Es fehlt: …“); ziel: Liste, in die der Abschnitt kommt
    const abschnitt = (schluessel, icon, titel, namen, ausgewaehlt, rechts, fehlen, ziel) => {
      const a = klappAbschnitt(aufgeklappt, schluessel, icon, titel, klappZusammenfassung(namen, ausgewaehlt, fehlen), rechts, true);
      a.box.id = "inh-bereich-" + schluessel;
      a.box.style.scrollMarginTop = "110px";
      (ziel || liste).append(a.box);
      return a.innen;
    };
    const vonInst = (n, gesamt) => n + " von " + gesamt + " installiert";
    const kiDa = kat.modelle.filter(m => m.installiert);
    const ki = abschnitt("ki", "message-circle", "KI-Assistent",
      kiDa.map(m => m.name + " · " + m.modell + (s.modell === m.id && kiDa.length > 1 ? " (aktiv)" : "")), auswahl.modelle.size, vonInst(kiDa.length, kat.modelle.length));
    ki.append(el("p", { class: "hinweis klein", style: "margin:-6px 0 12px" }, "Im Moment bietet Fieldbook nur Qwen 3.5 (4B) an.", el("br"), "Es läuft auf jedem Laptop mit 8 GB Arbeitsspeicher.", el("br"), "Weitere KIs folgen, sobald sie getestet sind."));
    if (kat.modelle.length > 1) ki.append(el("p", { class: "hinweis klein", style: "margin:-6px 0 12px" }, "Du kannst mehrere KIs laden und jederzeit mit „Benutzen“ zwischen ihnen wechseln.", el("br"), "Es läuft immer nur eine, die anderen belegen nur Platz auf der Festplatte.", el("br"), "Ein neuer Download ändert die aktive KI nicht."));
    // Rechenweg: Grafikkarte oder Prozessor. Fehlt das Grafikkarten-Programm, lädt Fieldbook es nach.
    const gpu = Setup.besteGpu(hw);
    if (gpu && gpu.vramGB >= 4) {
      ki.append(el("label", { class: "schalter", style: "margin-bottom:12px" },
        el("input", { type: "checkbox", checked: backend === "vulkan", onchange: async (e) => {
          const box = e.target;
          box.disabled = true;
          try {
            await rechenwegSetzen(box.checked ? "vulkan" : "cpu");
            kat = await api("katalog");
            await aktualisiereStatus();
            warAktiv = null;
            fortschritt();
          } catch (err) {
            box.checked = !box.checked;
            await dialog("Hinweis", el("div", {}, "Der Rechenweg konnte nicht umgestellt werden.", el("br"), err.message), [{ text: "OK", wert: 1, haupt: true }]);
          } finally { box.disabled = false; }
        } }),
        el("span", {}, "Grafikkarte für die KI nutzen (" + gpu.name + ", " + gpu.vramGB + " GB)",
          el("small", { class: "hinweis", style: "display:block" }, "Antwortet viel schneller.", el("br"), "Ohne Häkchen rechnet der Prozessor."))));
    }
    for (const m of kat.modelle.slice().sort((a, b) => a.bytes - b.bytes)) {
      const aktivModell = s.modell === m.id;
      const p = Setup.passung(m, hw, backend);
      const tags = [];
      if (m.id === emp.modell) tags.push(tag("Empfohlen", "tag-empf"));
      if (m.ausgemustert) tags.push(tag(m.ungetestet ? "noch nicht getestet" : "nicht mehr empfohlen", "tag-warn"));
      if (p === "zu-gross") tags.push(tag("zu groß für dein Gerät", "tag-warn"));
      if (p === "langsam") tags.push(tag("ohne Grafikkarte sehr langsam", "tag-warn"));
      if (m.installiert) {
        ki.append(zeile([m.name + " · " + m.modell, ...tags, tag(aktivModell ? "Aktiv" : "Installiert", "tag-ok")], m.beschreibung, groesse(m.bytes),
          aktivModell ? null : knopf("Benutzen", async () => { await api("einstellungen", { modell: m.id }); await aktualisiereStatus(); zeichneListe(aktiv); }),
          knopf("Löschen", () => loeschen("modell", m.id, m.name), true)));
      } else {
        const laedt = offen.titel.has("KI: " + m.name + " (" + m.modell + ")");
        if (laedt) tags.push(ladeTag());
        ki.append(auswahlZeile("checkbox", "inh-modell", auswahl.modelle.has(m.id), laedt, (e) => { if (e.target.checked) auswahl.modelle.add(m.id); else auswahl.modelle.delete(m.id); zeichneListe(aktiv); },
          [m.name + " · " + m.modell, ...tags], m.beschreibung, groesse(m.bytes)));
      }
    }
    // Suchhilfe: kommt mit jeder neuen KI mit, ältere Installationen laden sie hier nach
    const sh = kat.suchhilfe;
    if (sh && kiDa.length && !sh.installiert) {
      const laedt = offen.titel.has("KI: Suchhilfe (" + sh.modell + ")");
      if (laedt) auswahl.suchhilfe = false;
      ki.append(auswahlZeile("checkbox", "inh-suchhilfe", !!auswahl.suchhilfe, laedt, (e) => { auswahl.suchhilfe = e.target.checked; zeichneListe(aktiv); },
        ["Suchhilfe für die KI", tag("Ergänzung verfügbar", "tag-warn"), ...(laedt ? [ladeTag()] : [])],
        "Findet passendere Artikel für die Antworten der KI.", groesse(sh.bytes)));
    }

    // Wissenspakete: ein Bereich, darin jede Kategorie zum Aufklappen
    // Jedes Paket unter seiner Hauptkategorie (der ersten); Varianten einer Gruppe (z. B. Wikipedia) zählen als ein Eintrag
    const kategorien = [];
    for (const gr of kat.kategorien) {
      const pakete = kat.pakete.filter(p => (p.kategorien || [])[0] === gr.id);
      if (!pakete.length) continue;
      const eintraege = [], namen = [], fehlen = [];
      for (const p of pakete) {
        if (!p.gruppeExklusiv) { eintraege.push(p.id); (p.installiert ? namen : fehlen).push(p.titel); continue; }
        if (eintraege.includes("g:" + p.gruppeExklusiv)) continue;
        eintraege.push("g:" + p.gruppeExklusiv);
        const gTitel = (gruppen[p.gruppeExklusiv] || {}).titel || p.titel;
        const da = pakete.filter(x => x.gruppeExklusiv === p.gruppeExklusiv && x.installiert);
        if (da.length) namen.push(gTitel + " (" + da.map(x => x.variante || x.titel).join(", ") + ")"); else fehlen.push(gTitel);
      }
      kategorien.push({ gr, pakete, eintraege, namen, fehlen });
    }
    const wDa = kategorien.reduce((n, k) => n + k.namen.length, 0), wAlle = kategorien.reduce((n, k) => n + k.eintraege.length, 0);
    const wGewaehlt = kat.pakete.filter(p => auswahl.pakete.has(p.id)).length;
    const wLuecken = kategorien.filter(k => k.fehlen.length && k.namen.length);
    const wUnter = !wDa ? "Noch nichts installiert" : wDa === wAlle ? "Alles installiert"
      : wLuecken.length && wLuecken.length <= 2 && kategorien.every(k => k.namen.length) ? "Es fehlt etwas in: " + wLuecken.map(k => k.gr.titel).join(", ")
      : wDa + " Pakete installiert";
    const wissenBox = klappAbschnitt(aufgeklappt, "wissen", "library", "Wissen", wUnter + (wGewaehlt ? " · " + wGewaehlt + " zum Laden ausgewählt" : ""), vonInst(wDa, wAlle), true);
    wissenBox.box.id = "inh-bereich-wissen";
    wissenBox.box.style.scrollMarginTop = "110px";
    liste.append(wissenBox.box);
    const wissenListe = el("div", { class: "klapp-liste-abschnitte" });
    wissenBox.innen.append(wissenListe);
    for (const { gr, pakete, eintraege, namen, fehlen } of kategorien) {
      const g = abschnitt("k:" + gr.id, gr.icon, gr.titel, namen, pakete.filter(p => auswahl.pakete.has(p.id)).length, vonInst(namen.length, eintraege.length), fehlen, wissenListe);
      const fertigeGruppen = new Set();
      for (const p of pakete) {
        if (!p.gruppeExklusiv) { g.append(paketZeile(p, p.titel)); continue; }
        // Varianten (z. B. Wikipedia kompakt, ohne und mit Bildern) stehen zusammen in einem Kasten
        if (fertigeGruppen.has(p.gruppeExklusiv)) continue;
        fertigeGruppen.add(p.gruppeExklusiv);
        g.append(variantenKasten(p.gruppeExklusiv, pakete.filter(x => x.gruppeExklusiv === p.gruppeExklusiv)));
      }
    }

    function paketZeile(p, titel, hinweis) {
      const tags = [];
      if (p.sprache === "en") tags.push(tag("Englisch", "tag-en"));
      const defekt = (s.defektePakete || []).some(d => d.startsWith(p.name + "_"));
      if (defekt) tags.push(tag("beschädigt", "tag-warn"));
      const loeschKnopf = p.installiert ? knopf("Löschen", () => loeschen("paket", p.id, p.titel), true) : null;
      if (p.installiert && !p.update) return zeile([titel, ...tags, tag("Installiert · Stand " + p.installiertDatum, "tag-ok")], p.text, groesse(p.bytes), loeschKnopf);
      if (p.update) tags.push(tag("neue Version " + (p.datum || "").slice(0, 7), "tag-warn"));
      const laedt = offen.pakete.has(p.name + "|" + (p.flavour || ""));
      if (laedt) { tags.push(ladeTag()); auswahl.pakete.delete(p.id); }
      const z = auswahlZeile("checkbox", "inh-p-" + p.id, auswahl.pakete.has(p.id), laedt || (!p.verfuegbar && kat.katalogOnline), (e) => {
        if (e.target.checked) auswahl.pakete.add(p.id); else auswahl.pakete.delete(p.id);
        zeichneListe(aktiv);
      }, [titel, ...tags], p.text, groesse(p.bytes), loeschKnopf);
      if (hinweis) z.querySelector(".w-text").append(el("small", { class: "w-hinweis" }, hinweis));
      return z;
    }

    // Varianten (z. B. Wikipedia kompakt, ohne oder mit Bildern) als eine Zeile mit Schalter.
    // Je Gruppe bleibt nur eine Variante: Eine neue ersetzt die installierte nach dem Download (Server).
    function variantenKasten(id, varianten) {
      const info = gruppen[id] || {};
      const titel = info.titel || varianten[0].titel;
      const da = varianten.filter(p => p.installiert).sort((a, b) => b.bytes - a.bytes);
      const laedt = varianten.find(p => offen.pakete.has(p.name + "|" + (p.flavour || "")));
      if (laedt) varianten.forEach(p => auswahl.pakete.delete(p.id));
      const neu = varianten.find(p => auswahl.pakete.has(p.id));
      const gew = laedt || neu || da[0] || null;
      const p = gew || varianten.find(x => x.id === info.standard) || varianten[0];
      const tags = [];
      if (p.sprache === "en") tags.push(tag("Englisch", "tag-en"));
      if (laedt) tags.push(ladeTag());
      else if (p.installiert && !neu) tags.push(tag("Installiert · Stand " + p.installiertDatum, "tag-ok"));
      if (p.update && !laedt) tags.push(tag("neue Version " + (p.datum || "").slice(0, 7) + (neu ? " ausgewählt" : ""), "tag-warn"));
      const hinweis = [];
      if (neu && !neu.installiert && da.length) hinweis.push("Ersetzt „" + da.map(x => x.variante).join("“ und „") + "“, " + (da.length > 1 ? "die werden" : "die wird") + " nach dem Download gelöscht.");
      else if (!neu && da.length > 1) hinweis.push("Zusätzlich installiert: „" + da.slice(1).map(x => x.variante).join("“, „") + "“.", el("br"), "Die brauchst du nicht, du kannst sie löschen.");
      const knoepfe = [];
      if (!neu && !laedt && da[0] && da[0].update)
        knoepfe.push(knopf("Neue Version laden", () => { auswahl.pakete.add(da[0].id); zeichneListe(aktiv); }));
      if (!neu && !laedt) {
        da.slice(1).forEach(x => knoepfe.push(knopf("„" + x.variante + "“ löschen", () => loeschen("paket", x.id, x.titel), true)));
        if (da[0]) knoepfe.push(knopf("Löschen", () => loeschen("paket", da[0].id, da[0].titel), true));
      }
      // Gewählt: die neue Variante oder (ohne Auswahl) die installierte bzw. ladende
      return variantenZeile({ titel, varianten, gewaehlt: gew ? gew.id : null, installiert: da.length ? da[0].id : null, standard: info.standard,
        tags, gesperrt: !!laedt, hinweis: hinweis.length ? hinweis : null, knoepfe,
        onWahl: (wahlId) => {
          varianten.forEach(x => auswahl.pakete.delete(x.id));
          // Die installierte Variante ist nichts Neues zum Laden, außer es gibt eine neue Version
          const x = varianten.find(v => v.id === wahlId);
          if (x && (!x.installiert || x.update)) auswahl.pakete.add(x.id);
          zeichneListe(aktiv);
        } });
    }

    // Karten
    const kDa = kat.karten.filter(r => r.installiert);
    const k = abschnitt("karten", "map", "Karten", kDa.map(r => r.titel).concat(s.routen ? ["Wegedaten für Routen"] : []),
      auswahl.karten.size + (auswahl.routen ? 1 : 0), vonInst(kDa.length, kat.karten.length));
    // Routenplanung ganz oben: gilt für alle vorhandenen und ausgewählten Karten
    const regionen = kat.karten.filter(r => r.installiert || auswahl.karten.has(r.id)).map(r => r.id);
    const rg = auswahl.routenGroesse;
    const routenText = "Routen zu Fuß, mit dem Rad und mit dem Auto.";
    if (s.routen) {
      // Installiert: wie die anderen installierten Inhalte. Nur wenn Wegedaten fehlen (für eine installierte
      // oder eine gerade ausgewählte Karte), wird daraus eine Auswahl zum Nachladen.
      const fehlen = (auswahl.routenFehlen || []).concat(kat.karten.filter(r => auswahl.karten.has(r.id) && r.routen !== false).map(r => r.titel));
      if (!fehlen.length || (rg && rg.bytes === 0)) k.append(zeile(["Routenplanung", tag("Installiert", "tag-ok")], ["Wegedaten für alle installierten Karten.", el("br"), routenText], null));
      else k.append(auswahlZeile("checkbox", "inh-routen", auswahl.routen, false, (e) => { auswahl.routen = e.target.checked; zeichneListe(aktiv); },
        ["Routenplanung", tag("Installiert", "tag-ok"), tag("Ergänzung verfügbar", "tag-warn")],
        "Wegedaten nachladen für " + fehlen.join(", ") + ".",
        rg == null ? "wird berechnet …" : "ca. " + groesse(rg.bytes)));
    } else {
      k.append(auswahlZeile("checkbox", "inh-routen", auswahl.routen && regionen.length > 0, !regionen.length, (e) => { auswahl.routen = e.target.checked; zeichneListe(aktiv); groessen(); },
        ["Routenplanung"],
        !regionen.length ? "Erst eine Karte installieren oder auswählen." : ["Wegedaten für alle vorhandenen und ausgewählten Karten.", el("br"), routenText],
        !regionen.length ? "" : rg == null ? "wird berechnet …" : "ca. " + groesse(rg.bytes + 56e6)));
    }
    if (regionen.length && rg == null) groessen();
    k.append(el("h3", { style: "margin:18px 0 8px" }, "Regionen"));
    const sparen = auswahl.sparen;
    k.append(el("label", { class: "schalter", style: "margin-bottom:8px" },
      el("input", { type: "checkbox", checked: sparen, onchange: (e) => { auswahl.sparen = e.target.checked; for (const v of auswahl.karten.values()) v.bytes = null; zeichneListe(aktiv); groessen(); } }),
      el("span", {}, "Platz sparen (weniger Details beim starken Hineinzoomen)")));
    for (const r of kat.karten) {
      if (r.installiert) {
        k.append(zeile([r.titel, tag("Installiert", "tag-ok")], null, groesse(r.bytesInstalliert), null, knopf("Löschen", () => loeschen("karte", r.id, r.titel), true)));
      } else {
        const laedt = offen.titel.has("Karte: " + r.titel);
        if (laedt) auswahl.karten.delete(r.id);
        const info = auswahl.karten.get(r.id);
        k.append(auswahlZeile("checkbox", "inh-k-" + r.id, !!info, laedt, (e) => {
          if (e.target.checked) auswahl.karten.set(r.id, { bytes: null }); else auswahl.karten.delete(r.id);
          // Wer schon Routen hat, will sie für neue Karten meist auch: vorausgewählt, abwählbar.
          // Ist keine neue Karte mehr ausgewählt, fällt die Vorauswahl wieder weg.
          if (s.routen) {
            if (e.target.checked && auswahl.karten.size === 1) auswahl.routen = true;
            if (!auswahl.karten.size) auswahl.routen = false;
          }
          auswahl.routenGroesse = null;
          zeichneListe(aktiv); groessen();
        }, [r.titel, ...(laedt ? [ladeTag()] : [])], null, info && info.bytes > 0 ? "ca. " + groesse(info.bytes) : kartenSchaetzung(r, sparen) ? "ca. " + groesse(kartenSchaetzung(r, sparen)) : info && info.bytes === -1 ? "?" : info ? "wird berechnet …" : ""));
      }
    }


    // Übersetzer
    const spDa = sprachen.filter(sp => (s.sprachen || []).includes(sp.code));
    const ueNamen = [];
    if (s.uebersetzer) ueNamen.push("Artikel übersetzen");
    if (spDa.length) ueNamen.push(spDa.length === 1 ? "Sprache " + spDa[0].name : spDa.length + " Sprachen (" + spDa.map(sp => sp.name).join(", ") + ")");
    if (s.spracheingabe) ueNamen.push("Spracheingabe");
    const ueGewaehlt = (auswahl.uebersetzer ? 1 : 0) + auswahl.sprachen.size + [...auswahl.stimmen].filter(x => !auswahl.sprachen.has(x)).length + (auswahl.spracheingabe ? 1 : 0);
    const ue = abschnitt("sprachen", "languages", "Sprachen", ueNamen, ueGewaehlt, spDa.length + " von " + sprachen.length + " Sprachen");
    const ueText = "Übersetzt englische Artikel in der Bibliothek beim Lesen ins Deutsche (Knopf „Auf Deutsch“), mit den Sprachen unten auch Artikel in diesen Sprachen. Für Gespräche brauchst du eine der Sprachen unten. Technik von Mozilla, wie in Firefox.";
    const ueLoeschen = () => knopf("Löschen", () => loeschen("uebersetzer", "", "Artikel übersetzen"), true);
    if (s.uebersetzer && !s.uebersetzerAlt) {
      ue.append(zeile(["Artikel übersetzen (Englisch → Deutsch)", tag("Installiert", "tag-ok")], ueText, groesse(42e6), null, ueLoeschen()));
    } else {
      // Nicht installiert, oder ältere Version aus früheren Fieldbook-Versionen (dann zum Ersetzen auswählbar)
      const laedt = basisLaedt();
      const tags = s.uebersetzerAlt ? [tag("Installiert · ältere Version", "tag-ok"), tag("bessere Version verfügbar", "tag-warn")] : [];
      ue.append(auswahlZeile("checkbox", "inh-uebersetzer", auswahl.uebersetzer && !laedt, laedt, (e) => { auswahl.uebersetzer = e.target.checked; zeichneListe(aktiv); },
        ["Artikel übersetzen (Englisch → Deutsch)", ...tags, ...(laedt ? [ladeTag()] : [])], ueText, groesse(42e6), s.uebersetzerAlt ? ueLoeschen() : null));
    }

    // Sprachen für Gespräche (Menü „Übersetzer“), sortiert nach Entfernung
    const da = new Set(s.sprachen || []);
    ue.append(el("h3", { id: "inh-sprachen", style: "margin:18px 0 4px;scroll-margin-top:110px" }, "Sprachen für Gespräche"),
      el("p", { class: "hinweis klein", style: "margin:0 0 10px" }, "Für Gespräche mit Menschen, die eine andere Sprache sprechen (Menü „Übersetzer“).", el("br"), "Jede Sprache übersetzt in beide Richtungen.", el("br"),
        "Übersetzt wird über Englisch, deshalb laden Englisch und „Artikel übersetzen“ automatisch mit.", el("br"),
        "Mit „Text + Sprache“ liest Fieldbook die Übersetzungen auch vor. Die deutsche Stimme kommt dann einmal mit."));
    // Zwei Sortierungen: wie in sprachen.json (erst die häufigsten, dann nach Entfernung) oder von Nord nach Süd (erst Europa, dann der Rest)
    const sortKnopf = (wert, text) => el("button", { class: "knopf knopf-klein" + (sprachSort === wert ? " knopf-haupt" : ""), type: "button", "aria-pressed": String(sprachSort === wert),
      onclick: () => { sprachSort = wert; try { localStorage.setItem("fb-sprachen-sortierung", wert); } catch { } zeichneListe(aktiv); } }, text);
    ue.append(el("div", { class: "knopfreihe", style: "margin:0 0 10px;align-items:center" }, el("span", { class: "hinweis klein" }, "Sortieren:"),
      sortKnopf("standard", "Häufige zuerst"), sortKnopf("nord", "Von Nord nach Süd")));
    const sortiert = sprachSort === "nord"
      ? sprachen.slice().sort((a, b) => (b.europa ? 1 : 0) - (a.europa ? 1 : 0) || b.lat - a.lat)
      : sprachen;
    // Zuerst nur die ersten 21 (die häufigen Sprachen), der Rest auf Knopfdruck
    const zeigeAlle = alleSprachen || sprachen.length <= 23;
    let versteckt = 0, gruppe = null;
    // Zwischenüberschrift Europa / außerhalb, direkt vor der ersten sichtbaren Zeile der Gruppe
    const kopf = (sp) => {
      if (sprachSort !== "nord" || gruppe === !!sp.europa) return;
      gruppe = !!sp.europa;
      ue.append(el("div", { class: "hinweis klein", style: "font-weight:600;margin:12px 0 6px" }, gruppe ? "Europa" : "Außerhalb Europas"));
    };
    // Je Sprache zwei Knöpfe: „Nur Text“ oder „Text + Sprache“ (mit Stimme zum Vorlesen); nochmal klicken hebt die Wahl auf
    const stimmenDa = new Set(s.stimmen || []);
    const wahlKnopf = (an, gesperrt, text, bytes, fn) => el("button", { class: "knopf knopf-klein" + (an ? " knopf-haupt" : ""), type: "button",
      "aria-pressed": String(an), disabled: gesperrt, onclick: fn }, text + " · " + groesse(bytes));
    sortiert.forEach((sp, i) => {
      const c = sp.code;
      const titel = sp.name === sp.eigen ? sp.name : sp.name + " · " + sp.eigen;
      const stimme = stimmeBytes(c);
      const stimmeLaedt = offen.titel.has("Stimme: " + sp.name);
      if (stimmeLaedt) auswahl.stimmen.delete(c);
      if (da.has(c)) {
        kopf(sp);
        const mitStimme = stimmenDa.has(c);
        // Stimme nachträglich dazu
        const dazu = stimme && !mitStimme && !stimmeLaedt ? wahlKnopf(auswahl.stimmen.has(c), false, "+ Sprache", stimme, () => {
          if (auswahl.stimmen.has(c)) auswahl.stimmen.delete(c); else auswahl.stimmen.add(c);
          zeichneListe(aktiv);
        }) : null;
        ue.append(zeile([titel, tag(mitStimme ? "Installiert · Text + Sprache" : "Installiert · Text", "tag-ok"), ...(stimmeLaedt ? [ladeTag()] : [])],
          stimme ? null : "Keine Stimme zum Vorlesen", groesse(sp.mb * 1048576 + (mitStimme ? stimme : 0)), dazu, knopf("Löschen", () => loeschen("sprache", c, sp.name), true)));
        return;
      }
      const laedt = offen.titel.has("Sprache: " + sp.name);
      if (laedt) { auswahl.sprachen.delete(c); auswahl.stimmen.delete(c); }
      if (!zeigeAlle && i >= 21 && !auswahl.sprachen.has(c) && !laedt) { versteckt++; return; }
      kopf(sp);
      const wahl = !auswahl.sprachen.has(c) ? null : auswahl.stimmen.has(c) ? "sprache" : "text";
      const setze = (w) => {
        if (wahl === w) { auswahl.sprachen.delete(c); auswahl.stimmen.delete(c); }
        else { auswahl.sprachen.add(c); if (w === "sprache") auswahl.stimmen.add(c); else auswahl.stimmen.delete(c); }
        zeichneListe(aktiv);
      };
      ue.append(el("div", { class: "wahl" + (wahl ? " gewaehlt" : ""), style: "margin-bottom:8px;align-items:center;cursor:default" },
        el("span", { class: "w-haken", "aria-hidden": "true" }),
        el("div", { class: "w-text" }, el("div", { class: "w-titel" }, titel, ...(laedt ? [ladeTag()] : [])), stimme ? null : el("small", {}, "Keine Stimme zum Vorlesen")),
        el("div", { class: "knopfreihe", style: "margin:0;flex-wrap:nowrap" },
          wahlKnopf(wahl === "text", laedt, "Nur Text", sp.mb * 1048576, () => setze("text")),
          stimme ? wahlKnopf(wahl === "sprache", laedt, "Text + Sprache", sp.mb * 1048576 + stimme, () => setze("sprache")) : null)));
    });
    if (versteckt) ue.append(el("button", { class: "knopf knopf-klein", onclick: () => { alleSprachen = true; zeichneListe(aktiv); } }, "Alle " + sprachen.length + " Sprachen zeigen"));

    // Spracheingabe (Sprechen statt Tippen im Übersetzer)
    ue.append(el("h3", { id: "inh-sprechen", style: "margin:18px 0 8px;scroll-margin-top:110px" }, "Spracheingabe"));
    const sprechText = "Im Übersetzer sprechen statt tippen, für alle Sprachen. Erkennt europäische Sprachen schnell und gut (Parakeet von NVIDIA), alle anderen mit Whisper von OpenAI.";
    if (s.spracheingabe && s.spracheingabeKomplett) {
      ue.append(zeile(["Spracheingabe", tag("Installiert", "tag-ok")], sprechText, groesse(SPRECHEN_BYTES), null, knopf("Löschen", () => loeschen("spracheingabe", "", "Spracheingabe"), true)));
    } else if (s.spracheingabe) {
      // Ältere Installation ohne das kleine Modell für den Sprechmodus
      const laedt = sprechenLaedt();
      if (laedt) auswahl.spracheingabe = false;
      ue.append(auswahlZeile("checkbox", "inh-spracheingabe", auswahl.spracheingabe, laedt, (e) => { auswahl.spracheingabe = e.target.checked; zeichneListe(aktiv); },
        ["Spracheingabe", tag("Installiert", "tag-ok"), tag("Ergänzung verfügbar", "tag-warn"), ...(laedt ? [ladeTag()] : [])],
        "Ergänzung für den Sprechmodus: erkennt schneller, wer gerade spricht.", groesse(SPRECHEN_ZUSATZ), knopf("Löschen", (e) => { e.preventDefault(); loeschen("spracheingabe", "", "Spracheingabe"); }, true)));
    } else {
      const laedt = sprechenLaedt();
      if (laedt) auswahl.spracheingabe = false;
      ue.append(auswahlZeile("checkbox", "inh-spracheingabe", auswahl.spracheingabe, laedt, (e) => { auswahl.spracheingabe = e.target.checked; zeichneListe(aktiv); },
        ["Spracheingabe", ...(laedt ? [ladeTag()] : [])], sprechText, groesse(SPRECHEN_BYTES)));
    }



    // Leiste zum Herunterladen
    const bytes = auswahlBytes();
    const anzahl = auswahl.modelle.size + (auswahl.suchhilfe ? 1 : 0) + auswahl.pakete.size + auswahl.karten.size + (auswahl.routen && rg && rg.bytes > 0 ? 1 : 0) + (basisNoetig() ? 1 : 0) + sprachenNeu().length + (auswahl.spracheingabe ? 1 : 0) + [...auswahl.stimmen].filter(c => !auswahl.sprachen.has(c)).length;
    c.append(el("div", { class: "summe inhalte-leiste" },
      el("span", {}, anzahl ? anzahl + " ausgewählt · " + groesse(bytes) + " · frei: " + groesse(hw.freiGB * 1e9) : "Nichts ausgewählt"),
      el("button", { class: "knopf knopf-haupt", disabled: !anzahl, onclick: herunterladen }, sym("download"), aktiv ? "Zu den Downloads hinzufügen" : "Auswahl herunterladen")));
  }

  function tag(text, klasse) { return el("span", { class: "marke-tag " + klasse }, text); }
  function knopf(text, fn, rot) { return el("button", { class: "knopf knopf-klein" + (rot ? " knopf-rot" : ""), onclick: fn }, text); }

  // Installierter Inhalt: Rahmen wie die Auswahlzeilen, aber mit Häkchen statt Kästchen
  function zeile(titel, text, rechts, ...knoepfe) {
    return el("div", { class: "wahl installiert" }, el("span", { class: "w-haken", "aria-hidden": "true" }, "✓"),
      el("div", { class: "w-text" }, el("div", { class: "w-titel" }, ...titel), text ? el("small", {}, text) : null),
      el("div", { class: "knopfreihe", style: "margin:0;align-items:center;flex-wrap:nowrap" }, el("span", { class: "w-groesse" }, rechts || ""), ...knoepfe.filter(Boolean)));
  }

  function auswahlZeile(typ, name, an, gesperrt, onWahl, titel, text, rechts, extraKnopf) {
    const input = el("input", { type: typ, name, checked: an, disabled: gesperrt });
    input.addEventListener("change", onWahl);
    return el("label", { class: "wahl" + (an ? " gewaehlt" : ""), style: "margin-bottom:8px" }, input,
      el("div", { class: "w-text" }, el("div", { class: "w-titel" }, ...titel), text ? el("small", {}, text) : null),
      el("div", { class: "w-groesse" }, rechts || ""), extraKnopf || null);
  }

  function maxzoom(r) { return r.maxzoom || (auswahl.sparen ? 13 : 15); }

  let rechnet = false;
  async function groessen() {
    if (rechnet) return;
    rechnet = true;
    try {
      for (const [id, info] of auswahl.karten) {
        if (info.bytes) continue;
        const r = kat.karten.find(x => x.id === id);
        const erg = await api("kartengroesse?id=" + encodeURIComponent(id) + "&maxzoom=" + maxzoom(r)).catch(() => ({}));
        if (auswahl.karten.has(id)) auswahl.karten.get(id).bytes = erg.bytes > 0 ? erg.bytes : -1;
      }
      const ids = kat.karten.filter(r => r.installiert || auswahl.karten.has(r.id)).map(r => r.id);
      if (ids.length && auswahl.routenGroesse == null) {
        auswahl.routenGroesse = await api("routengroesse?ids=" + encodeURIComponent(ids.join(","))).catch(() => ({ bytes: 0 }));
        const fehlen = [];
        if ((OW.status || {}).routen)
          for (const r of kat.karten.filter(x => x.installiert && x.routen !== false)) {
            const erg = await api("routengroesse?ids=" + encodeURIComponent(r.id)).catch(() => ({ bytes: 0 }));
            if (erg.bytes > 0) fehlen.push(r.titel);
          }
        auswahl.routenFehlen = fehlen;
      }
    } finally { rechnet = false; }
    if (location.hash.startsWith("#inhalte")) zeichneListe(warAktiv);
  }

  function auswahlBytes() {
    let b = 0;
    for (const m of kat.modelle) if (auswahl.modelle.has(m.id)) b += m.bytes;
    // Die Suchhilfe kommt mit jeder KI mit, falls sie fehlt
    if ((auswahl.suchhilfe || auswahl.modelle.size) && kat.suchhilfe && !kat.suchhilfe.installiert) b += kat.suchhilfe.bytes;
    for (const p of kat.pakete) if (auswahl.pakete.has(p.id)) b += p.bytes || 0;
    for (const [id, v] of auswahl.karten) b += v.bytes > 0 ? v.bytes : kartenSchaetzung(kat.karten.find(x => x.id === id) || {}, auswahl.sparen);
    if (auswahl.routen && auswahl.routenGroesse && auswahl.routenGroesse.bytes > 0) b += auswahl.routenGroesse.bytes;
    if (basisNoetig()) b += 42e6;
    for (const c of sprachenNeu()) { const sp = sprachen.find(x => x.code === c); if (sp) b += sp.mb * 1048576; }
    if (auswahl.spracheingabe) b += (OW.status || {}).spracheingabe ? SPRECHEN_ZUSATZ : SPRECHEN_BYTES;
    b += stimmenBytes([...auswahl.stimmen]);
    return b;
  }

  // Stimmen zum Vorlesen für diese Sprachen, Deutsch und das Programm (22 MB) kommen mit, falls sie fehlen
  const stimmeBytes = (code) => { const v = stimmen.find(x => x.code === code); return v ? v.bytes : 0; };
  function stimmenBytes(codes) {
    const da = new Set((OW.status || {}).stimmen || []);
    const fehlen = [...new Set(codes)].filter(c => stimmeBytes(c) && !da.has(c));
    if (!fehlen.length) return 0;
    if (!da.has("de") && !fehlen.includes("de")) fehlen.push("de");
    return fehlen.reduce((b, c) => b + stimmeBytes(c), da.size ? 0 : 22477236);
  }

  // Programm (9 MB) plus Parakeet und Whisper small (siehe config/spracheingabe.json)
  const SPRECHEN_ZUSATZ = 43537433;   // Whisper tiny für den Sprechmodus
  const SPRECHEN_BYTES = 9e6 + 668757119 + 264464607 + SPRECHEN_ZUSATZ;
  const sprechenLaedt = () => [...offen.titel].some(t => t.startsWith("Spracheingabe") || t.includes("(Spracheingabe)"));

  // „Artikel übersetzen“ wird geladen, wenn ausgewählt oder wenn Sprachen dazukommen (die brauchen die neue Version)
  function basisNoetig() {
    const s = OW.status || {};
    if (basisLaedt() || (s.uebersetzer && !s.uebersetzerAlt)) return false;
    return !!auswahl.uebersetzer || sprachenNeu().length > 0;
  }
  const basisLaedt = () => [...offen.titel].some(t => t.startsWith("Artikel übersetzen") || t.startsWith("Übersetzer"));

  // Ausgewählte Sprachen plus Englisch, falls es noch fehlt (wird über den Server automatisch mitgeladen)
  function sprachenNeu() {
    const da = new Set((OW.status || {}).sprachen || []);
    const neu = [...auswahl.sprachen].filter(c => !da.has(c));
    if (neu.length && !da.has("en") && !neu.includes("en") && !offen.titel.has("Sprache: Englisch")) neu.push("en");
    return neu;
  }

  let ladeLaeuft = false;
  async function herunterladen(ev) {
    // Doppelklick-Sperre
    if (ladeLaeuft) return;
    ladeLaeuft = true;
    const k = ev && ev.currentTarget;
    if (k) k.disabled = true;
    try { await herunterladenStarten(); }
    finally { ladeLaeuft = false; if (k && k.isConnected) k.disabled = false; }
  }

  async function herunterladenStarten() {
    const karten = [...auswahl.karten].map(([id, v]) => ({ id, maxzoom: String(maxzoom(kat.karten.find(x => x.id === id))), bytes: v.bytes > 0 ? v.bytes : 0 }));
    const routen = auswahl.routen ? kat.karten.filter(r => r.installiert || auswahl.karten.has(r.id)).map(r => r.id) : [];
    // Die aktive KI bleibt. Nur wenn noch keine installiert ist, wird die größte neue aktiv.
    const neueModelle = kat.modelle.filter(m => auswahl.modelle.has(m.id)).sort((a, b) => b.bytes - a.bytes);
    const aktivDa = kat.modelle.some(m => m.installiert && m.id === (OW.status || {}).modell);
    const body = { modell: !aktivDa && neueModelle.length ? neueModelle[0].id : "", modelle: neueModelle.map(m => m.id), suchhilfe: !!auswahl.suchhilfe,
      pakete: [...auswahl.pakete], karten, routen, uebersetzer: !!auswahl.uebersetzer, sprachen: [...auswahl.sprachen], spracheingabe: !!auswahl.spracheingabe, stimmen: [...auswahl.stimmen] };
    if (neueModelle.length) body.backend = (kat.einstellungen && kat.einstellungen.backend) || Setup.empfehlung(hw, kat.modelle).backend;
    const r = await api("installieren", body);
    if (r.fehler) { await dialog("Hinweis", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); return; }
    auswahl.modelle.clear(); auswahl.pakete.clear(); auswahl.karten.clear(); auswahl.routen = false; auswahl.routenGroesse = null; auswahl.uebersetzer = false; auswahl.sprachen.clear(); auswahl.spracheingabe = false; auswahl.stimmen.clear(); auswahl.suchhilfe = false;
    warAktiv = null;
    window.scrollTo(0, 0);
    fortschritt();
  }

  async function loeschen(art, id, titel) {
    const ok = await dialog("Löschen?", "„" + titel + "“ wirklich löschen? Zum Wiederherstellen muss es neu heruntergeladen werden.",
      [{ text: "Abbrechen", wert: false }, { text: "Löschen", wert: true, haupt: true }]);
    if (!ok) return;
    const r = await api("entfernen", { art, id });
    if (r.fehler) alert(r.fehler);
    OW.buecher = null;
    kat = await api("katalog");
    await aktualisiereStatus();
    zeichneListe(warAktiv);
  }

  // Größen der Spracheingabe auch für den Assistenten
  return { zeigen, importDialog, SPRECHEN_BYTES, SPRECHEN_ZUSATZ };
})();

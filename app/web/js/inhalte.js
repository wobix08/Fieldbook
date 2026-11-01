// Inhalte: Downloads verfolgen und installierte Inhalte verwalten (unabhängig vom Einrichtungs-Assistenten).
"use strict";

const Inhalte = (() => {
  let kat = null, hw = null, timer = null, verlauf = [];
  const auswahl = { modell: null, pakete: new Set(), karten: new Map(), routen: false, routenGroesse: null };

  async function zeigen() {
    clearInterval(timer);
    warAktiv = null; // Liste beim Öffnen immer neu zeichnen
    $("#inhalte-liste").innerHTML = '<p class="hinweis">Wird geladen …</p>';
    try { [kat, hw] = await Promise.all([api("katalog"), api("hardware")]); }
    catch (e) { $("#inhalte-liste").innerHTML = '<div class="fehlerbox">Fehler: ' + esc(e.message) + "</div>"; return; }
    await fortschritt();
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
    warAktiv = null;
    window.scrollTo(0, 0);
    fortschritt();
  }

  // ------------------------------------------------ Download-Fortschritt

  let warAktiv = null;
  // Was gerade wartet oder lädt: Pakete (name|flavour) und übrige Downloads (Titel), damit sie nicht doppelt wählbar sind
  let offen = { pakete: new Set(), titel: new Set() }, offenSig = "";
  async function fortschritt() {
    let f;
    try { f = await api("fortschritt"); }
    catch { if (warAktiv) { clearInterval(timer); neustartAnzeigen(null); } return; }
    const box = $("#inhalte-downloads");
    if (!f.jobs.length) { box.hidden = true; } else { box.hidden = false; zeichneFortschritt(box, f); }
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
    box.innerHTML = "";
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
    const fehler = f.jobs.filter(j => j.status === "fehler" || j.status === "abgebrochen");
    box.append(el("div", {},
      el("div", { class: "titel-zeile", style: "margin-bottom:8px" },
        el("h2", { style: "margin:0" }, f.aktiv ? "Wird heruntergeladen …" : fehler.length ? "Downloads unvollständig" : "✓ Downloads fertig"),
        f.aktiv ? el("button", { class: "knopf knopf-klein knopf-rot", onclick: async () => {
          if (await dialog("Downloads abbrechen?", "Bereits geladene Teile bleiben erhalten. Mit „Erneut versuchen“ oder wenn du das Paket wieder auswählst, geht es an derselben Stelle weiter. Karten beginnen dann von vorn.",
            [{ text: "Weiterladen", wert: false }, { text: "Abbrechen", wert: true, haupt: true }])) await api("abbrechen", {});
        } }, "Abbrechen")
          : fehler.length ? el("div", { class: "knopfreihe", style: "margin:0" },
            el("button", { class: "knopf knopf-klein", onclick: (e) => verbindungPruefen(e.currentTarget) }, sym("search"), "Verbindung prüfen"),
            el("button", { class: "knopf knopf-klein knopf-haupt", onclick: async () => { const r = await api("wiederholen", {}); if (r.fehler) alert(r.fehler); } }, "⟳ Erneut versuchen")) : null),
      el("div", { class: "job-kopf" }, el("b", {}, "Gesamt"),
        el("span", { class: "dl-zahlen" },
          el("span", { class: "dl-menge" }, groesse(f.bytes) + " von " + groesse(f.gesamt)),
          el("span", { class: "dl-tempo" }, tempo),
          el("span", { class: "dl-rest" }, rest))),
      el("div", { class: "balken" }, el("div", { style: "width:" + anteil + "%" })),
      programme ? el("p", { class: "hinweis klein", style: "margin:6px 0 0" }, "Zuerst lädt Fieldbook die Hilfsprogramme. Danach laden bis zu drei Inhalte gleichzeitig. Das geht meist deutlich schneller, und Fieldbook zeigt dann auch die Restzeit.") : null,
      // Laufende oben, dann wartende, dann Fehler, fertige unten (innerhalb der Gruppen in Warteschlangen-Reihenfolge)
      ...[...f.jobs].sort((a, b) => JOB_REIHENFOLGE[a.status] - JOB_REIHENFOLGE[b.status]).map(j => {
        const p = j.gesamt > 0 ? Math.min(100, j.bytes / j.gesamt * 100) : (j.status === "fertig" ? 100 : 0);
        const st = { wartet: "wartet", laeuft: j.gesamt > 0 ? Math.floor(p) + " %" : groesse(j.bytes), fertig: "✓ fertig", fehler: "✗ Fehler", abgebrochen: "abgebrochen" }[j.status];
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
    const passend = kat.modelle.filter(m => ["gpu", "cpu"].includes(Setup.passung(m, hw, backend))).sort((a, b) => b.bytes - a.bytes);
    const emp = { modell: passend[0] ? passend[0].id : emp0.modell };
    const ki = abschnitt(c, "KI-Assistent");
    for (const m of kat.modelle.slice().sort((a, b) => a.bytes - b.bytes)) {
      const aktivModell = s.modell === m.id;
      const p = Setup.passung(m, hw, backend);
      const tags = [];
      if (m.id === emp.modell) tags.push(tag("Empfohlen", "tag-empf"));
      if (p === "zu-gross") tags.push(tag("zu groß für dein Gerät", "tag-warn"));
      if (p === "langsam") tags.push(tag("ohne Grafikkarte sehr langsam", "tag-warn"));
      if (m.installiert) {
        ki.append(zeile([m.name + " · " + m.modell, ...tags, tag(aktivModell ? "✓ aktiv" : "✓ vorhanden", "tag-ok")], m.beschreibung, groesse(m.bytes),
          aktivModell ? null : knopf("Benutzen", async () => { await api("einstellungen", { modell: m.id }); await aktualisiereStatus(); zeichneListe(aktiv); }),
          knopf("Löschen", () => loeschen("modell", m.id, m.name), true)));
      } else {
        const laedt = offen.titel.has("KI: " + m.name + " (" + m.modell + ")");
        if (laedt) tags.push(ladeTag());
        ki.append(auswahlZeile("radio", "inh-modell", auswahl.modell === m.id, laedt, (e) => { auswahl.modell = e.target.checked ? m.id : null; zeichneListe(aktiv); },
          [m.name + " · " + m.modell, ...tags], m.beschreibung + " Wird nach dem Download die aktive KI.", groesse(m.bytes)));
      }
    }
    if (auswahl.modell) ki.append(el("button", { class: "knopf knopf-klein", onclick: () => { auswahl.modell = null; zeichneListe(aktiv); } }, "Keine neue KI laden"));

    // Wissenspakete
    // Jedes Paket unter seiner Hauptkategorie (der ersten)
    for (const gr of kat.kategorien) {
      const pakete = kat.pakete.filter(p => (p.kategorien || [])[0] === gr.id);
      if (!pakete.length) continue;
      const g = abschnitt(c, [sym(gr.icon), gr.titel]);
      for (const p of pakete) {
        const tags = [];
        if (p.sprache === "en") tags.push(tag("Englisch", "tag-en"));
        const defekt = (s.defektePakete || []).some(d => d.startsWith(p.name + "_"));
        if (defekt) tags.push(tag("beschädigt", "tag-warn"));
        if (p.installiert && !p.update) {
          g.append(zeile([p.titel, ...tags, tag("✓ Stand " + p.installiertDatum, "tag-ok")], p.text, groesse(p.bytes), null,
            knopf("Löschen", () => loeschen("paket", p.id, p.titel), true)));
        } else {
          if (p.update) tags.push(tag("neue Version " + (p.datum || "").slice(0, 7), "tag-warn"));
          const laedt = offen.pakete.has(p.name + "|" + (p.flavour || ""));
          if (laedt) { tags.push(ladeTag()); auswahl.pakete.delete(p.id); }
          g.append(auswahlZeile("checkbox", "inh-p-" + p.id, auswahl.pakete.has(p.id), laedt || (!p.verfuegbar && kat.katalogOnline), (e) => {
            if (e.target.checked) auswahl.pakete.add(p.id); else auswahl.pakete.delete(p.id);
            zeichneListe(aktiv);
          }, [p.titel, ...tags], p.text, groesse(p.bytes),
            p.installiert ? knopf("Löschen", () => loeschen("paket", p.id, p.titel), true) : null));
        }
      }
    }

    // Übersetzer
    const ue = abschnitt(c, "Übersetzer");
    const ueText = "Übersetzt englische Artikel beim Lesen offline ins Deutsche (Knopf „Auf Deutsch“). Technik von Mozilla, wie in Firefox.";
    if (s.uebersetzer) {
      ue.append(zeile(["Übersetzer Englisch → Deutsch", tag("✓ vorhanden", "tag-ok")], ueText, groesse(27e6), null,
        knopf("Löschen", () => loeschen("uebersetzer", "", "Übersetzer"), true)));
    } else {
      const laedt = [...offen.titel].some(t => t.startsWith("Übersetzer"));
      ue.append(auswahlZeile("checkbox", "inh-uebersetzer", auswahl.uebersetzer && !laedt, laedt, (e) => { auswahl.uebersetzer = e.target.checked; zeichneListe(aktiv); },
        ["Übersetzer Englisch → Deutsch", ...(laedt ? [ladeTag()] : [])], ueText, groesse(27e6)));
    }

    // Karten
    const k = abschnitt(c, "Karten");
    const sparen = auswahl.sparen;
    k.append(el("label", { class: "schalter", style: "margin-bottom:8px" },
      el("input", { type: "checkbox", checked: sparen, onchange: (e) => { auswahl.sparen = e.target.checked; for (const v of auswahl.karten.values()) v.bytes = null; zeichneListe(aktiv); groessen(); } }),
      el("span", {}, "Platz sparen (weniger Details beim starken Hineinzoomen)")));
    for (const r of kat.karten) {
      if (r.installiert) {
        k.append(zeile([r.titel, tag("✓ vorhanden", "tag-ok")], null, groesse(r.bytesInstalliert), null, knopf("Löschen", () => loeschen("karte", r.id, r.titel), true)));
      } else {
        const laedt = offen.titel.has("Karte: " + r.titel);
        if (laedt) auswahl.karten.delete(r.id);
        const info = auswahl.karten.get(r.id);
        k.append(auswahlZeile("checkbox", "inh-k-" + r.id, !!info, laedt, (e) => {
          if (e.target.checked) auswahl.karten.set(r.id, { bytes: null }); else auswahl.karten.delete(r.id);
          auswahl.routenGroesse = null;
          zeichneListe(aktiv); groessen();
        }, [r.titel, ...(laedt ? [ladeTag()] : [])], null, info ? (info.bytes > 0 ? "ca. " + groesse(info.bytes) : info.bytes === -1 ? "?" : "wird berechnet …") : ""));
      }
    }

    // Routenplanung
    const ro = abschnitt(c, "Routenplanung");
    const regionen = kat.karten.filter(r => r.installiert || auswahl.karten.has(r.id)).map(r => r.id);
    const rg = auswahl.routenGroesse;
    ro.append(auswahlZeile("checkbox", "inh-routen", auswahl.routen && regionen.length > 0, !regionen.length, (e) => { auswahl.routen = e.target.checked; zeichneListe(aktiv); groessen(); },
      ["Wegedaten für alle vorhandenen und ausgewählten Karten"],
      !regionen.length ? "Erst eine Karte installieren oder auswählen." : "Routen zu Fuß, mit dem Rad und mit dem Auto.",
      !auswahl.routen ? "" : rg == null ? "wird berechnet …" : rg.bytes > 0 ? "ca. " + groesse(rg.bytes + (s.routen ? 0 : 56e6)) : "✓ vorhanden"));

    // Leiste zum Herunterladen
    const bytes = auswahlBytes();
    const anzahl = (auswahl.modell ? 1 : 0) + auswahl.pakete.size + auswahl.karten.size + (auswahl.routen && rg && rg.bytes > 0 ? 1 : 0) + (auswahl.uebersetzer && !s.uebersetzer ? 1 : 0);
    c.append(el("div", { class: "summe inhalte-leiste" },
      el("span", {}, anzahl ? anzahl + " ausgewählt · " + groesse(bytes) + " · frei: " + groesse(hw.freiGB * 1e9) : "Nichts ausgewählt"),
      el("button", { class: "knopf knopf-haupt", disabled: !anzahl, onclick: herunterladen }, sym("download"), aktiv ? "Zu den Downloads hinzufügen" : "Auswahl herunterladen")));
  }

  function abschnitt(c, titel) {
    const b = el("div", { class: "karte-box", style: "margin-bottom:14px" }, el("h2", { style: "margin-top:0" }, titel));
    c.append(b);
    return b;
  }
  function tag(text, klasse) { return el("span", { class: "marke-tag " + klasse }, text); }
  function knopf(text, fn, rot) { return el("button", { class: "knopf knopf-klein" + (rot ? " knopf-rot" : ""), onclick: fn }, text); }

  function zeile(titel, text, rechts, ...knoepfe) {
    return el("div", { class: "einst-zeile" },
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
      if (auswahl.routen && ids.length && auswahl.routenGroesse == null)
        auswahl.routenGroesse = await api("routengroesse?ids=" + encodeURIComponent(ids.join(","))).catch(() => ({ bytes: 0 }));
    } finally { rechnet = false; }
    if (location.hash.startsWith("#inhalte")) zeichneListe(warAktiv);
  }

  function auswahlBytes() {
    let b = 0;
    const m = kat.modelle.find(x => x.id === auswahl.modell);
    if (m) b += m.bytes;
    for (const p of kat.pakete) if (auswahl.pakete.has(p.id)) b += p.bytes || 0;
    for (const v of auswahl.karten.values()) if (v.bytes > 0) b += v.bytes;
    if (auswahl.routen && auswahl.routenGroesse && auswahl.routenGroesse.bytes > 0) b += auswahl.routenGroesse.bytes;
    if (auswahl.uebersetzer && !(OW.status || {}).uebersetzer) b += 27e6;
    return b;
  }

  async function herunterladen() {
    const karten = [...auswahl.karten].map(([id, v]) => ({ id, maxzoom: String(maxzoom(kat.karten.find(x => x.id === id))), bytes: v.bytes > 0 ? v.bytes : 0 }));
    const routen = auswahl.routen ? kat.karten.filter(r => r.installiert || auswahl.karten.has(r.id)).map(r => r.id) : [];
    const body = { modell: auswahl.modell || "", pakete: [...auswahl.pakete], karten, routen, uebersetzer: !!auswahl.uebersetzer };
    if (auswahl.modell) body.backend = (kat.einstellungen && kat.einstellungen.backend) || Setup.empfehlung(hw, kat.modelle).backend;
    const r = await api("installieren", body);
    if (r.fehler) { await dialog("Hinweis", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); return; }
    auswahl.modell = null; auswahl.pakete.clear(); auswahl.karten.clear(); auswahl.routen = false; auswahl.routenGroesse = null; auswahl.uebersetzer = false;
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

  return { zeigen };
})();

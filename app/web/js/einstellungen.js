// Einstellungen: KI, Version, Aktualisierung, Darstellung. Inhalte verwaltet inhalte.js.
"use strict";

const Einstellungen = (() => {
  async function zeigen() {
    const c = $("#einst-inhalt");
    c.innerHTML = '<p class="hinweis">Wird geladen …</p>';
    const [kat, s] = await Promise.all([api("katalog"), api("status")]);
    c.innerHTML = "";

    // KI
    const ki = el("div", { class: "karte-box" }, el("h2", { style: "margin-top:0" }, "KI-Assistent"));
    const inst = kat.modelle.filter(m => m.installiert);
    if (!inst.length) ki.append(el("p", {}, "Keine KI installiert."));
    for (const m of inst) {
      const aktiv = s.modell === m.id;
      ki.append(el("div", { class: "einst-zeile" },
        el("div", {}, el("b", {}, m.name + " · " + m.modell), el("small", {}, groesse(m.bytes) + (aktiv ? " · aktiv" : ""))),
        el("div", { class: "knopfreihe", style: "margin:0" },
          aktiv ? el("span", { class: "ok-text" }, "✓ aktiv") : el("button", { class: "knopf knopf-klein", onclick: async () => { await api("einstellungen", { modell: m.id }); zeigen(); } }, "Benutzen"),
          el("button", { class: "knopf knopf-klein knopf-rot", onclick: () => entfernen("modell", m.id, m.name) }, "Löschen"))));
    }
    ki.append(el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, "Sparmodus"), el("small", {}, "Schaltet die KI ab. Bibliothek, Karten und Erste Hilfe laufen weiter.")),
      el("label", { class: "schalter" }, el("input", { type: "checkbox", checked: s.sparmodus, onchange: (e) => schalteKi(!e.target.checked) }), "an")));
    if (s.ki.fehler) ki.append(el("p", { class: "fehlerbox" }, s.ki.fehler));
    c.append(ki);

    // Inhalte: Verwaltung ist auf einer eigenen Seite
    const pk = kat.pakete.filter(p => p.installiert).length, kk = kat.karten.filter(r => r.installiert).length;
    const upd = kat.pakete.filter(p => p.update).length;
    c.append(el("div", { class: "karte-box", style: "margin-top:16px" },
      el("div", { class: "einst-zeile", style: "border:0;padding:0" },
        el("div", {}, el("b", {}, "Inhalte"),
          el("small", {}, pk + " Wissenspakete · " + kk + " Karten" + (s.routen ? " · Routenplanung" : "") + (upd ? " · " + upd + " neue Version(en) verfügbar" : ""))),
        el("a", { class: "knopf knopf-klein", href: "#inhalte" }, "Verwalten"))));

    // Fieldbook-Version (Programm-Update)
    const pv = el("div", { class: "karte-box", style: "margin-bottom:16px" });
    c.prepend(pv);
    const zeigeVersion = (u) => {
      pv.innerHTML = "";
      pv.append(el("h2", { style: "margin-top:0" }, "Fieldbook-Version"),
        el("div", { class: "einst-zeile", style: "border:0;padding-top:0" },
          el("div", {}, el("b", {}, "Installiert: " + s.version),
            el("small", {}, !u.eingerichtet ? "Programm-Updates sind noch nicht eingerichtet (kein GitHub-Repository in app\\config\\fieldbook.json)."
              : u.entwicklung ? "Entwicklungsordner: Hier wird nicht automatisch aktualisiert."
              : u.fehler ? "Suche fehlgeschlagen (Internet?)."
              : u.bereit ? "Version " + u.bereit + " ist heruntergeladen und wird beim nächsten Start eingespielt."
              : u.verfuegbar ? "Neue Version " + u.neu + " verfügbar" + (u.bytes ? " (" + groesse(u.bytes) + ")" : "") + "."
              : u.neu ? "Das ist die neueste Version." : "")),
          el("button", { class: "knopf knopf-klein", onclick: async (e) => {
            e.target.disabled = true; e.target.textContent = "Suche …";
            zeigeVersion(await api("programmupdate").catch(err => ({ fehler: err.message, eingerichtet: true })));
          } }, "Nach neuer Version suchen")));
      if (u.verfuegbar && u.notizen) pv.append(el("details", {}, el("summary", {}, "Was ist neu in " + u.neu + "?"), el("pre", { style: "white-space:pre-wrap;font-family:inherit" }, u.notizen)));
      if ((u.verfuegbar || u.bereit) && !u.entwicklung) {
        pv.append(el("div", { class: "knopfreihe" }, el("button", { class: "knopf knopf-haupt", onclick: async () => {
          const ziel = u.verfuegbar ? u.neu : u.bereit;
          const ok = await dialog("Fieldbook aktualisieren?",
            "Fieldbook lädt Version " + ziel + " herunter, beendet sich kurz und startet neu. Deine Wissenspakete, KI-Modelle, Karten und Einstellungen bleiben erhalten. Vom bisherigen Programm wird vorher eine Sicherung angelegt.",
            [{ text: "Abbrechen", wert: false }, { text: "Jetzt aktualisieren", wert: true, haupt: true }]);
          if (!ok) return;
          const r = await api("programmupdate/installieren", {});
          if (r.fehler) { await dialog("Hinweis", r.fehler, [{ text: "OK", wert: 1, haupt: true }]); return; }
          if (r.neustart) neustartAnzeigen(r.neu);
          else location.hash = "#inhalte";
        } }, u.bereit && !u.verfuegbar ? "⟳ Jetzt neu starten und einspielen" : "⟳ Auf Version " + u.neu + " aktualisieren")));
      }
    };
    zeigeVersion({ eingerichtet: true, neu: s.programmNeu, verfuegbar: !!s.programmNeu, bereit: s.programmBereit });
    api("programmupdate").then(zeigeVersion).catch(() => { });

    // Automatische Aktualisierung
    const akt = await api("aktualisierung");
    c.append(aktualisierungBox(akt, true));
    const aktInfo = el("div", { class: "karte-box", style: "margin-top:8px" });
    const zeigeAkt = (a) => {
      aktInfo.innerHTML = "";
      aktInfo.append(el("p", { class: "hinweis klein", style: "margin-top:0" },
        a.geprueft ? "Zuletzt geprüft: " + a.geprueft + " · " + (a.anzahl ? a.anzahl + " Aktualisierung(en), ca. " + groesse(a.bytes) + ": " + a.titel.join(", ") : "alles aktuell") : "Noch nicht geprüft."));
      aktInfo.append(el("div", { class: "knopfreihe", style: "margin-top:0" },
        el("button", { class: "knopf knopf-haupt", onclick: async (e) => {
          const r = await jetztAktualisieren(e.currentTarget);
          if (r && location.hash.startsWith("#einstellungen")) zeigeAkt(r);
        } }, "⟳ Jetzt aktualisieren")));
    };
    zeigeAkt(akt);
    c.append(aktInfo);

    // Internetverbindung: Test und Proxy für Firmen- und Schulnetze
    const netz = el("div", { class: "karte-box", style: "margin-top:16px" }, el("h2", { style: "margin-top:0" }, "Internetverbindung"));
    netz.append(el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, "Verbindung prüfen"), el("small", {}, "Zeigt, ob ein Werbeblocker, eine Firewall oder ein Filter Downloads sperrt.")),
      el("button", { class: "knopf knopf-klein", onclick: (e) => verbindungPruefen(e.currentTarget) }, "Prüfen")));
    const proxyFeld = el("input", { type: "text", value: s.proxy || "", placeholder: "automatisch (wie Windows)", "aria-label": "Proxy", style: "width:260px" });
    const proxyStatus = el("small", {}, "Nur nötig, wenn Downloads im Firmen- oder Schulnetz nicht gehen. Beispiel: proxy.schule.de:8080");
    netz.append(el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, "Proxy"), proxyStatus),
      el("div", { class: "knopfreihe", style: "margin:0;flex-wrap:nowrap" }, proxyFeld,
        el("button", { class: "knopf knopf-klein", onclick: async () => {
          OW.status = await api("einstellungen", { proxy: proxyFeld.value.trim() });
          proxyStatus.textContent = proxyFeld.value.trim() ? "Gespeichert. Downloads laufen jetzt über diesen Proxy." : "Gespeichert. Fieldbook nimmt wieder den Proxy aus Windows (falls vorhanden).";
        } }, "Speichern"))));
    c.append(netz);

    // Darstellung
    const d = el("div", { class: "karte-box", style: "margin-top:16px" }, el("h2", { style: "margin-top:0" }, "Darstellung"));
    const sel = el("select", { onchange: (e) => setzeThema(e.target.value) },
      el("option", { value: "dark" }, "Dunkel (Standard)"), el("option", { value: "light" }, "Hell (gut zum Lernen und Lesen)"), el("option", { value: "system" }, "Wie Windows"));
    sel.value = aktuellesThema();
    d.append(el("div", { class: "einst-zeile" }, el("b", {}, "Farbschema"), sel));
    const land = Land.aktuell();
    const landSel = landAuswahl(land, async (neu) => {
      OW.status = await api("einstellungen", { land: neu.code, sprache: neu.sprache });
    });
    d.append(el("div", { class: "einst-zeile" }, el("div", {}, el("b", {}, "Land"), el("small", {}, "Bestimmt die Notrufnummern")), landSel));
    d.append(el("div", { class: "einst-zeile" },
      el("div", {}, el("b", {}, "Desktop-Symbol"), el("small", {}, "Fieldbook vom Desktop aus starten")),
      el("label", { class: "schalter" }, el("input", { type: "checkbox", checked: !!s.desktopSymbol, onchange: async (e) => {
        const r = await api("desktopsymbol", { an: e.target.checked });
        if (r.fehler) { alert("Das Desktop-Symbol konnte nicht geändert werden: " + r.fehler); e.target.checked = !!r.vorhanden; }
      } }), "an")));
    c.append(d);

    c.append(el("p", { class: "hinweis klein" }, "Fieldbook " + s.version + " · Protokolle im Ordner daten\\logs · Beenden über den Aus-Knopf oben rechts"));
  }

  async function entfernen(art, id, titel) {
    if (!confirm("„" + titel + "“ wirklich löschen? Zum Wiederherstellen muss es neu heruntergeladen werden.")) return;
    const r = await api("entfernen", { art, id });
    if (r.fehler) alert(r.fehler);
    OW.buecher = null;
    await aktualisiereStatus();
    zeigen();
  }

  return { zeigen };
})();

// Farbschema: "dark" (Standard), "light" oder "system" (wie Windows)
function aktuellesThema() {
  try { return localStorage.getItem("thema") || "dark"; } catch { return "dark"; }
}
function wendeThemaAn(t) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const k = document.getElementById("thema-knopf");
  if (k) {
    const dunkel = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    k.replaceChildren(sym(dunkel ? "sun" : "moon"));
    k.title = dunkel ? "Helle Ansicht" : "Dunkle Ansicht";
  }
}
function setzeThema(t) {
  try { localStorage.setItem("thema", t); } catch { }
  wendeThemaAn(t);
  if (typeof Karten !== "undefined" && Karten.themaGeaendert) Karten.themaGeaendert();
}
wendeThemaAn(aktuellesThema());
document.getElementById("thema-knopf").addEventListener("click", () => {
  const dunkel = document.documentElement.dataset.theme === "dark" ||
    (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  setzeThema(dunkel ? "light" : "dark");
});

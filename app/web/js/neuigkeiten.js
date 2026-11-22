// „Was ist neu?“ (Ansicht „#neu“): die Release-Notizen der laufenden Version,
// nach einem Sprung über mehrere Versionen alle seitdem zusammengefasst.
// Nach einem Update landet man beim ersten Öffnen einmal hier (app.js), später über Einstellungen → Fieldbook und Updates.
"use strict";

const Neuigkeiten = (() => {
  // Die Release-Notizen auf GitHub sind einfaches Markdown: „## Überschrift“, „**Gruppe**“ allein in der Zeile,
  // „- Punkt“ und normale Absätze. Nur das wird umgesetzt, alles als Text (kein HTML aus dem Netz).
  // Jeder Satz in eigener Zeile (zeilen()).
  function fett(text) {
    return text.split(/\*\*(.+?)\*\*/).flatMap((t, i) => i % 2 ? [el("b", {}, t)] : zeilen(t));
  }

  function darstellen(md) {
    const teile = [];
    let liste = null;
    for (const roh of String(md).replace(/\r/g, "").split("\n")) {
      const z = roh.trim();
      if (!z) { liste = null; continue; }
      const punkt = /^[-*]\s+(.*)$/.exec(z);
      if (punkt) {
        if (!liste) teile.push(liste = el("ul", { class: "neu-liste" }));
        liste.append(el("li", {}, fett(punkt[1])));
        continue;
      }
      liste = null;
      const kopf = /^#{1,6}\s+(.*)$/.exec(z), gruppe = /^\*\*(.+)\*\*$/.exec(z);
      if (kopf) teile.push(el("p", { class: "neu-seit" }, kopf[1]));
      else if (gruppe) teile.push(el("h2", {}, gruppe[1]));
      else teile.push(el("p", {}, fett(z)));
    }
    return teile;
  }

  // Notizen in Gruppen zerlegen: [{ name, punkte }] und freie Absätze („## Neu seit …“ fällt weg)
  function zerlegen(md) {
    const gruppen = [], absaetze = [];
    let akt = null;
    for (const roh of String(md).replace(/\r/g, "").split("\n")) {
      const z = roh.trim();
      if (!z || /^#{1,6}\s/.test(z)) continue;
      const punkt = /^[-*]\s+(.*)$/.exec(z), gruppe = /^\*\*(.+)\*\*$/.exec(z);
      if (gruppe) gruppen.push(akt = { name: gruppe[1].trim(), punkte: [] });
      else if (punkt) { if (!akt) gruppen.push(akt = { name: "", punkte: [] }); akt.punkte.push(punkt[1].trim()); }
      else absaetze.push(z);
    }
    return { gruppen, absaetze };
  }

  // Sprung über mehrere Versionen: eine gemeinsame Liste statt einer je Version.
  // Oben „Das Wichtigste“ (höchstens 5 Punkte), abwechselnd aus jeder Version, die neueste zuerst.
  // Als wichtig zählt eine eigene Gruppe „Das Wichtigste“ in den Notizen, sonst der erste Punkt jeder Gruppe.
  // Darunter alle übrigen Punkte nach Gruppen, gleiche Punkte und Absätze nur einmal.
  const WICHTIG = "Das Wichtigste";
  function zusammenfassen(versionen) {
    const teile = versionen.map(v => zerlegen(v.notizen));
    // Große Versionen (0.8.6) kommen bei der Auswahl vor kleinen Nachbesserungen (0.8.7.1)
    const gross = versionen.map(v => String(v.version).split(".").length <= 3);
    const wichtig = t => {
      const w = t.gruppen.filter(g => g.name === WICHTIG).flatMap(g => g.punkte);
      return w.length ? w : t.gruppen.map(g => g.punkte[0]).filter(Boolean);
    };
    const oben = [];
    for (const runde of [true, false]) {
      const kandidaten = teile.filter((t, i) => gross[i] === runde).map(wichtig);
      for (let i = 0; oben.length < 5 && kandidaten.some(k => i < k.length); i++)
        for (const k of kandidaten) if (i < k.length && oben.length < 5 && !oben.includes(k[i])) oben.push(k[i]);
    }
    const gesehen = new Set(oben), gruppen = new Map(), absaetze = [];
    for (const t of teile) {
      for (const g of t.gruppen) {
        const name = g.name === WICHTIG ? "" : g.name;
        if (!gruppen.has(name)) gruppen.set(name, []);
        for (const p of g.punkte) if (!gesehen.has(p)) { gesehen.add(p); gruppen.get(name).push(p); }
      }
      // „… Verbesserungen“ und „… Verbesserungen.“ sind derselbe Satz
      for (const a of t.absaetze) if (!absaetze.some(b => b.replace(/\.$/, "") === a.replace(/\.$/, ""))) absaetze.push(a);
    }
    const md = ["**" + WICHTIG + "**", ...oben.map(p => "- " + p), ""];
    const ohneName = gruppen.get("") || [];
    gruppen.delete("");
    for (const [name, punkte] of gruppen) if (punkte.length) md.push("**" + name + "**", ...punkte.map(p => "- " + p), "");
    if (ohneName.length) md.push("**Weitere Neuerungen**", ...ohneName.map(p => "- " + p), "");
    for (const a of absaetze) md.push(a, "");
    return md.join("\n");
  }

  async function zeigen() {
    const ziel = $("#neu-inhalt");
    ziel.replaceChildren(el("p", { class: "leer" }, "Lade …"));
    let n;
    try { n = await api("neuigkeiten"); }
    catch (e) { ziel.replaceChildren(fehlerBox("Die Neuerungen konnten nicht geladen werden.", zeigen, null, e.message)); return; }
    // Einmal gezeigt reicht, auch wenn man gleich weiterklickt
    if (n.offen) api("neuigkeiten/gesehen", {}).catch(() => { });
    const versionen = n.versionen || [];
    const sprung = versionen.length > 1;
    $("#neu-titel").textContent = sprung ? "Neu seit Fieldbook " + n.vorher : "Neu in Fieldbook " + n.version;
    const weiter = el("div", { class: "knopfreihe" },
      el("a", { class: "knopf knopf-haupt", href: "#start" }, "Weiter zur Startseite"));
    if (!versionen.length) {
      ziel.replaceChildren(el("p", {}, "Zu dieser Version liegen keine Notizen vor.", el("br"),
        "Sie werden beim Herunterladen eines Updates gemerkt oder mit Internet nachgeladen."), weiter);
      return;
    }
    const einleitung = [];
    if (n.offen) einleitung.push("Fieldbook wurde aktualisiert.", el("br"), "Deine Inhalte, Karten und Einstellungen sind alle noch da.");
    if (sprung) einleitung.push(...(einleitung.length ? [el("br")] : []), "Du hattest Version " + n.vorher + ", jetzt läuft " + n.version + ".", el("br"),
      "Hier stehen die Neuerungen aller " + versionen.length + " Versionen seitdem zusammengefasst.");
    // replaceChildren würde null als Text „null“ einfügen, deshalb vorher aussortieren
    ziel.replaceChildren(...[
      einleitung.length ? el("p", { class: "neu-einleitung" }, ...einleitung) : null,
      el("div", { class: "neu-notizen" }, darstellen(sprung ? zusammenfassen(versionen) : versionen[0].notizen)),
      weiter].filter(Boolean));
  }

  return { zeigen };
})();

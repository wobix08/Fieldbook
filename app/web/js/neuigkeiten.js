// „Was ist neu?“ (Ansicht „#neu“): die Release-Notizen der laufenden Version.
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

  async function zeigen() {
    const ziel = $("#neu-inhalt");
    ziel.replaceChildren(el("p", { class: "leer" }, "Lade …"));
    let n;
    try { n = await api("neuigkeiten"); }
    catch (e) { ziel.replaceChildren(fehlerBox("Die Neuerungen konnten nicht geladen werden.", zeigen, null, e.message)); return; }
    // Einmal gezeigt reicht, auch wenn man gleich weiterklickt
    if (n.offen) api("neuigkeiten/gesehen", {}).catch(() => { });
    $("#neu-titel").textContent = "Neu in Fieldbook " + n.version;
    const weiter = el("div", { class: "knopfreihe" },
      el("a", { class: "knopf knopf-haupt", href: "#start" }, "Weiter zur Startseite"));
    if (!n.notizen) {
      ziel.replaceChildren(el("p", {}, "Zu dieser Version liegen keine Notizen vor.", el("br"),
        "Sie werden beim Herunterladen eines Updates gemerkt oder mit Internet nachgeladen."), weiter);
      return;
    }
    // replaceChildren würde null als Text „null“ einfügen, deshalb vorher aussortieren
    ziel.replaceChildren(...[
      n.offen ? el("p", { class: "neu-einleitung" }, "Fieldbook wurde aktualisiert.", el("br"),
        "Deine Inhalte, Karten und Einstellungen sind alle noch da.") : null,
      el("div", { class: "neu-notizen" }, darstellen(n.notizen)),
      weiter].filter(Boolean));
  }

  return { zeigen };
})();

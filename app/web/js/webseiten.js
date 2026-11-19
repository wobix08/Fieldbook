// Webseiten sichern: kleiner Browser in Fieldbook (Ansicht „#web“).
// #web?url=<Adresse>   Seite aus dem Internet ansehen (über den Server geholt, ohne Programmcode)
// #web?ordner=<Ordner> gesicherte Seite aus daten/eigene/webseiten ansehen
// Gespeichert wird als Ordner wie die Website aufgebaut ist (landkreis.de/buerger/notfall/index.html), Bilder,
// CSS und Schriften gemeinsam in landkreis.de/_dateien. Links zwischen gesicherten Seiten zeigen auf die lokale
// Kopie (gilt auch beim Öffnen ohne Fieldbook), alle anderen ins Internet. Siehe Server.cs „Webseiten sichern“.
"use strict";

const Webseiten = (() => {
  const rahmen = $("#web-rahmen");
  const feld = $("#web-adresse");
  const status = $("#web-status");
  const knopf = $("#web-speichern");
  const leer = $("#web-leer");
  const fensterKnopf = $("#web-fenster-knopf");
  const fensterLeiste = $("#web-fensterleiste");
  const leerText = [...leer.childNodes];   // Erklärung, nach einer Fehlermeldung wieder einsetzen
  let aktuell = null;   // { url, ordner, seite (gesicherter Eintrag) }

  // ---------------------------------------------------------------- Adressen vergleichen

  // Zum Vergleich: ohne Sprungmarke, ohne „www.“, ohne / am Ende, http und https gleich
  function norm(u) {
    try {
      const x = new URL(u);
      return x.hostname.replace(/^www\./, "").toLowerCase() + (x.port ? ":" + x.port : "") + (x.pathname.replace(/\/+$/, "") || "") + x.search;
    } catch { return String(u); }
  }
  async function gesicherte() {
    try { return (await api("web/liste")).seiten || []; } catch { return []; }
  }
  const hostVon = (ordner) => String(ordner).split("/")[0];
  // Link auf eine Bilddatei (Vorschaubild → großes Bild): wird mitgespeichert und groß über Fieldbook gezeigt
  const istBild = (u) => { try { return /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(new URL(u).pathname); } catch { return false; } };

  // Relativer Pfad von der Seite im Ordner „von“ zur index.html im Ordner „nach“
  function relativ(von, nach) {
    const a = von.split("/"), b = nach.split("/");
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return "../".repeat(a.length - i) + b.slice(i).map(encodeURIComponent).join("/") + (b.length > i ? "/" : "") + "index.html";
  }

  // ---------------------------------------------------------------- Anzeigen

  function zeigen(params) {
    const url = params.get("url"), ordner = params.get("ordner");
    status.textContent = "";
    fensterKnopf.hidden = true;
    fensterBeobachten();
    if (ordner) return gesichertZeigen(ordner);
    if (url) return onlineZeigen(url);
    aktuell = null;
    feld.value = "";
    leer.replaceChildren(...leerText);
    rahmen.hidden = true;
    leer.hidden = false;
    knopf.hidden = true;
    setTimeout(() => feld.focus(), 0);
  }

  async function gesichertZeigen(ordner) {
    const liste = await gesicherte();
    const s = liste.find(x => x.ordner === ordner);
    if (!s) {
      aktuell = null;
      rahmen.hidden = true; leer.hidden = false; knopf.hidden = true;
      leer.replaceChildren(fehlerBox("Diese gesicherte Seite gibt es nicht mehr.\nVielleicht wurde sie gelöscht.", null),
        el("p", {}, el("a", { href: "#bibliothek" }, "Zur Bibliothek")));
      return;
    }
    aktuell = { url: s.url, ordner, seite: s };
    feld.value = s.url;
    leer.hidden = true; rahmen.hidden = false;
    rahmen.src = s.adresse;
    status.textContent = "Gesichert am " + datum(s.datum);
    knopf.hidden = false;
    knopf.replaceChildren(sym("refresh-cw"), "Neu holen");
    knopf.title = "Den aktuellen Stand aus dem Internet holen und die gesicherte Seite ersetzen";
    zuletztMerken({ url: s.adresse, titel: s.name, paket: "eigene" });
  }

  async function onlineZeigen(url) {
    aktuell = { url, ordner: null, seite: null };
    feld.value = url;
    leer.hidden = true; rahmen.hidden = false;
    status.textContent = "Wird geladen …";
    knopf.hidden = true;
    rahmen.src = "/api/web/ansehen?url=" + encodeURIComponent(url);
  }

  const datum = (s) => { const d = new Date(s); return isNaN(d) ? "" : d.toLocaleDateString("de-DE"); };

  // Nach dem Laden: Adresse und Titel übernehmen, Klicks auf Links abfangen
  rahmen.addEventListener("load", async () => {
    let doc;
    try { doc = rahmen.contentDocument; } catch { return; }
    if (!doc || !aktuell || rahmen.hidden) return;
    faulBilder(doc);
    doc.addEventListener("click", klick);
    doc.addEventListener("submit", formular);
    if (aktuell.seite) return;
    const fehler = doc.querySelector('meta[name="fieldbook-fehler"]');
    const echt = doc.querySelector('meta[name="fieldbook-url"]');
    if (echt) { aktuell.url = echt.content; feld.value = echt.content; }
    fensterKnopf.hidden = false;
    if (fehler) {
      status.textContent = ""; knopf.hidden = true;
      // Roboterschutz: der Weg über das Browserfenster ist der einzige, also hervorheben
      fensterKnopf.classList.toggle("knopf-haupt", fehler.content === "schutz");
      return;
    }
    fensterKnopf.classList.remove("knopf-haupt");
    const schon = (await gesicherte()).find(x => norm(x.url) === norm(aktuell.url));
    knopf.hidden = false;
    if (schon) {
      status.replaceChildren("Schon gesichert · ", el("a", { href: "#web?ordner=" + encodeURIComponent(schon.ordner) }, "gesicherte Seite öffnen"));
      knopf.replaceChildren(sym("refresh-cw"), "Neu holen");
      knopf.title = "Den aktuellen Stand sichern und die gesicherte Seite ersetzen";
      aktuell.schon = schon;
    } else {
      status.textContent = "";
      knopf.replaceChildren(sym("save"), "Speichern");
      knopf.title = "Diese Seite mit allen Bildern in Fieldbook speichern";
    }
  });

  // Bilder, die erst ein Skript nachladen würde (data-src): direkt zeigen
  function faulBilder(doc) {
    for (const img of doc.querySelectorAll("img[data-src], img[data-lazy-src], img[data-original]")) {
      const s = img.getAttribute("data-src") || img.getAttribute("data-lazy-src") || img.getAttribute("data-original");
      if (s) img.setAttribute("src", s);
    }
    for (const x of doc.querySelectorAll("[data-srcset]")) x.setAttribute("srcset", x.getAttribute("data-srcset"));
  }

  function klick(e) {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target.closest && e.target.closest("a[href], area[href]");
    if (!a) return;
    const doc = a.ownerDocument;
    const roh = a.getAttribute("href") || "";
    // Sprungmarke auf derselben Seite
    if (roh.startsWith("#")) {
      e.preventDefault();
      let ziel = null;
      try { ziel = doc.getElementById(decodeURIComponent(roh.slice(1))) || doc.querySelector('[name="' + CSS.escape(decodeURIComponent(roh.slice(1))) + '"]'); } catch { }
      if (ziel) ziel.scrollIntoView({ block: "start" });
      return;
    }
    e.preventDefault();
    // Bild zum Vergrößern: gesichert liegt es in _dateien (relativer Link), sonst kommt es aus dem Internet
    let ziel = null;
    try { ziel = new URL(roh, doc.baseURI).href; } catch { }
    if (ziel && (a.hasAttribute("data-fb-bild") || istBild(ziel))) {
      const img = a.querySelector("img");
      bildZeigen(ziel, (img && img.getAttribute("alt")) || a.getAttribute("title") || "");
      return;
    }
    // Gesicherte Seite: data-fb-url ist die echte Adresse; sonst gegen die Adresse der Seite auflösen
    let abs = a.getAttribute("data-fb-url");
    if (!abs) { try { abs = new URL(roh, aktuell.seite ? aktuell.url : (doc.baseURI || aktuell.url)).href; } catch { return; } }
    if (!/^https?:/i.test(abs)) return;   // mailto:, tel:, javascript: nicht
    oeffnen(abs);
  }

  // Großes Bild über ganz Fieldbook, schließen mit Klick, Esc oder dem Kreuz
  function bildZeigen(src, titel) {
    const docs = [document];
    try { if (rahmen.contentDocument) docs.push(rahmen.contentDocument); } catch { }
    const zu = () => { box.remove(); docs.forEach(d => d.removeEventListener("keydown", taste, true)); };
    const taste = (e) => { if (e.key === "Escape") { e.preventDefault(); zu(); } };
    const bild = el("img", { src, alt: titel });
    const box = el("div", { class: "web-bild", role: "dialog", "aria-modal": "true", "aria-label": titel || "Bild", onclick: zu },
      bild, el("button", { type: "button", class: "knopf web-bild-zu", title: "Schließen (Esc)", "aria-label": "Schließen" }, sym("x")));
    bild.addEventListener("error", () => bild.replaceWith(el("p", { class: "web-bild-fehlt" },
      "Dieses Bild wurde nicht mitgespeichert.", el("br"), "Mit Internet erscheint es nach „Neu holen“.")));
    document.body.append(box);
    docs.forEach(d => d.addEventListener("keydown", taste, true));
    box.querySelector("button").focus();
  }

  // Suchfelder und andere GET-Formulare auf Webseiten: als neue Adresse öffnen
  function formular(e) {
    e.preventDefault();
    const f = e.target;
    if (aktuell.seite || (f.method || "get").toLowerCase() !== "get") return;
    try {
      const ziel = new URL(f.getAttribute("action") || "", f.ownerDocument.baseURI);
      ziel.search = new URLSearchParams(new FormData(f)).toString();
      oeffnen(ziel.href);
    } catch { }
  }

  // Link öffnen: gesicherte Kopie, wenn es eine gibt, sonst aus dem Internet
  async function oeffnen(abs) {
    const s = (await gesicherte()).find(x => norm(x.url) === norm(abs));
    location.hash = s ? "#web?ordner=" + encodeURIComponent(s.ordner) : "#web?url=" + encodeURIComponent(abs);
  }

  $("#web-form").addEventListener("submit", (e) => {
    e.preventDefault();
    let u = feld.value.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    oeffnen(u);
  });

  $("#web-zurueck").addEventListener("click", () => {
    if (window.navigation ? navigation.currentEntry.index > 0 : history.length > 1) history.back();
    else location.hash = "#bibliothek";
  });

  knopf.addEventListener("click", () => {
    if (!aktuell) return;
    let name = aktuell.seite ? aktuell.seite.name : aktuell.schon ? aktuell.schon.name : "";
    if (!name) { try { name = (rahmen.contentDocument.title || "").trim(); } catch { } }
    const url = aktuell.url;
    sichern(() => api("web/holen", { url }), name, !!(aktuell.seite || aktuell.schon));
  });

  // ---------------------------------------------------------------- Browserfenster (Seiten mit Roboterschutz)
  // Fieldbook öffnet ein normales Edge-Fenster. Dort besucht man die Seite selbst (und geht selbst durch eine
  // Prüfung); die Leiste unter der Adresszeile zeigt die offenen Seiten mit „Speichern“ (Server.cs „Edge-Fenster“).

  fensterKnopf.addEventListener("click", async () => {
    if (!aktuell) return;
    fensterKnopf.disabled = true;
    let r;
    try { r = await api("web/fenster/oeffnen", { url: aktuell.url }); } catch (e) { r = { fehler: NICHT_ERREICHBAR }; }
    fensterKnopf.disabled = false;
    if (r.fehler) { await dialog("Browserfenster", el("div", {}, zeilen(r.fehler)), [{ text: "OK", wert: 1, haupt: true }]); return; }
    fensterBeobachten(true);
  });

  let fensterTimer = null, fensterLauf = 0, fensterBeschaeftigt = false;
  // Alle 2 Sekunden nachsehen, solange die Ansicht offen ist und das Fenster läuft
  async function fensterBeobachten(sofort) {
    clearTimeout(fensterTimer);
    if (!location.hash.startsWith("#web")) { fensterLeiste.hidden = true; return; }
    const mein = ++fensterLauf;
    let s;
    try { s = await api("web/fenster"); } catch { s = { offen: false }; }
    if (mein !== fensterLauf) return;
    if (!fensterBeschaeftigt) fensterZeichnen(s.offen ? s.seiten || [] : null);
    if (s.offen || sofort) fensterTimer = setTimeout(fensterBeobachten, 2000);
  }

  async function fensterZeichnen(seiten) {
    if (!seiten || !seiten.length) { fensterLeiste.hidden = true; fensterLeiste.replaceChildren(); return; }
    const liste = await gesicherte();
    const zeilen_ = seiten.map(t => {
      const schon = liste.find(x => norm(x.url) === norm(t.url));
      let wo = "";
      try { wo = new URL(t.url).hostname.replace(/^www\./, ""); } catch { }
      return el("div", { class: "wf-zeile" },
        el("span", { class: "wf-titel", title: t.url }, el("b", {}, t.titel || t.url), el("small", {}, wo + (schon ? " · schon gesichert" : ""))),
        el("button", { type: "button", class: "knopf knopf-klein knopf-haupt", onclick: () => {
          fensterBeschaeftigt = true;
          sichern(() => api("web/fenster/holen", { id: t.id }), schon ? schon.name : t.titel, !!schon)
            .finally(() => { fensterBeschaeftigt = false; });
        } }, sym(schon ? "refresh-cw" : "save"), schon ? "Neu holen" : "Speichern"));
    });
    fensterLeiste.replaceChildren(el("span", { class: "hinweis klein" }, "Im Browserfenster offen:"), ...zeilen_);
    fensterLeiste.hidden = false;
  }
  window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#web")) { clearTimeout(fensterTimer); fensterLeiste.hidden = true; } });

  // ---------------------------------------------------------------- Speichern

  // holen: Funktion, die {html, url, gerendert} liefert (aus dem Internet oder aus dem Browserfenster)
  async function sichern(holen, vorschlag, ersetzen) {
    let name = vorschlag, gruppe;
    if (!ersetzen) {
      const eingabe = el("input", { type: "text", class: "eingabe", value: vorschlag || "", "aria-label": "Name", style: "width:100%" });
      eingabe.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); const k = eingabe.closest(".dialog").querySelector(".knopf-haupt"); if (k) k.click(); } });
      setTimeout(() => { eingabe.focus(); eingabe.select(); }, 0);
      // Eigene Ordner zum Sortieren (nur wenn es welche gibt)
      let ordner = [];
      try { ordner = await Eigene.gruppen(true); } catch { }
      const wahl = ordner.length ? el("select", { class: "eingabe", "aria-label": "Ordner", style: "width:100%" },
        el("option", { value: "" }, "Ohne Ordner"), ...ordner.map(o => el("option", { value: o.id }, o.name))) : null;
      const wert = await dialog("Webseite speichern", el("div", {},
        el("p", {}, "Unter diesem Namen erscheint die Seite in den eigenen Unterlagen:"), eingabe,
        wahl ? el("p", { style: "margin-bottom:4px" }, "Ordner:") : null, wahl,
        el("p", { class: "hinweis klein" }, "Gespeichert werden die Seite, ihre Bilder und ihre Gestaltung.", el("br"),
          "Die Suche und die KI finden dann auch, was darauf steht.")),
        [{ text: "Abbrechen", wert: null }, { text: "Speichern", wert: "ok", haupt: true }]);
      if (wert !== "ok") return;
      name = eingabe.value.trim() || vorschlag;
      if (wahl) gruppe = wahl.value;
    }
    knopf.disabled = true;
    try {
      status.textContent = "Seite wird geholt …";
      const r = await holen();
      if (r.fehler) throw Object.assign(new Error(r.fehler), { technisch: r.technisch, schutz: r.schutz });
      const { doc, dateien } = vorbereiten(r.html, r.url, !!r.gerendert);
      status.textContent = dateien.length ? "Bilder und Gestaltung werden geladen (" + dateien.length + ") …" : "Wird gespeichert …";
      const d = await api("web/dateien", { url: r.url, dateien });
      if (d.fehler) throw new Error(d.fehler);
      dateienEinsetzen(doc, d.karte || {}, d.ordner);
      status.textContent = "Wird gespeichert …";
      const s = await api("web/speichern", Object.assign({ url: r.url, name, html: "<!DOCTYPE html>\n" + doc.documentElement.outerHTML }, gruppe !== undefined ? { gruppe } : {}));
      if (s.fehler) throw Object.assign(new Error(s.fehler), { technisch: s.technisch });
      await linksAbgleichen(hostVon(s.ordner));
      Eigene.geaendert();
      Eigene.anstossen();
      status.textContent = "";
      if (location.hash === "#web?ordner=" + encodeURIComponent(s.ordner)) gesichertZeigen(s.ordner);
      else location.hash = "#web?ordner=" + encodeURIComponent(s.ordner);
    } catch (e) {
      console.warn("Webseite sichern:", e);
      status.textContent = "";
      const text = e.message === "Failed to fetch" ? NICHT_ERREICHBAR : e.message || "Das Speichern hat nicht geklappt.";
      await dialog("Webseite speichern", el("div", { title: e.technisch || "" }, zeilen(text)), [{ text: "OK", wert: 1, haupt: true }]);
    } finally { knopf.disabled = false; }
  }

  // Cookie-Hinweise der gängigen Anbieter (bleiben sonst als Kasten über der Seite stehen)
  const COOKIE = ["#onetrust-consent-sdk", "#onetrust-banner-sdk", "#CybotCookiebotDialog", "#CybotCookiebotDialogBodyUnderlay", "#usercentrics-root",
    "#uc-banner", ".cc-window", ".cc-banner", "#cookie-notice", "#cookie-law-info-bar", ".cookie-notice", "#cmplz-cookiebanner-container", ".cmplz-cookiebanner",
    "#borlabs-cookie", "#BorlabsCookieBox", ".borlabs-cookie", "#cookiebanner", "#cookie-banner", ".cookie-banner", "#cookieConsent", ".cookie-consent",
    "#didomi-host", "#sp_message_container", "[id^='sp_message_container']", ".klaro", "#klaro", "#iubenda-cs-banner", "#consent-banner", ".consent-banner",
    "#gdpr-cookie-message", "#tarteaucitronRoot", ".fc-consent-root", "#qc-cmp2-container"];

  // HTML der Seite aufräumen und alle Dateien sammeln, die sie braucht
  function vorbereiten(html, url, gerendert) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let basis = url;
    const b = doc.querySelector("base[href]");
    if (b) { try { basis = new URL(b.getAttribute("href"), url).href; } catch { } }
    const abs = (u) => { try { return new URL(u.trim(), basis).href; } catch { return null; } };

    // Programmcode und alles, was offline nur stört
    doc.querySelectorAll("script, iframe, frame, frameset, embed, object, applet, base, portal").forEach(x => x.remove());
    doc.querySelectorAll('link[rel~="preload" i], link[rel~="prefetch" i], link[rel~="modulepreload" i], link[rel~="dns-prefetch" i], link[rel~="preconnect" i], link[rel~="manifest" i], link[rel~="serviceworker" i]').forEach(x => x.remove());
    doc.querySelectorAll('meta[http-equiv]').forEach(m => { if (/refresh|content-security-policy|set-cookie/i.test(m.getAttribute("http-equiv"))) m.remove(); });
    doc.querySelectorAll("meta[charset]").forEach(m => m.remove());
    // Fertig aufgebaute Seite: <noscript> war nicht zu sehen. Rohe Seite: ohne Skripte gilt der Ersatzinhalt
    doc.querySelectorAll("noscript").forEach(n => {
      if (gerendert) { n.remove(); return; }
      const t = doc.createElement("template");
      t.innerHTML = n.textContent || n.innerHTML;
      n.replaceWith(t.content);
    });
    for (const s of COOKIE) { try { doc.querySelectorAll(s).forEach(x => x.remove()); } catch { } }
    // Eigene Cookie-Hinweise der Seiten (z. B. „SP-CookieUsageNotification“ bei wuppertal.de): kurze Kästen,
    // deren id oder Klasse nach Cookie/Einwilligung klingt
    for (const x of [...doc.body ? doc.body.querySelectorAll("[id], [class]") : []]) {
      if (!x.isConnected || /^(main|article|body)$/i.test(x.tagName)) continue;
      const name = (x.id || "") + " " + (typeof x.className === "string" ? x.className : "");
      if (/cookie|consent|gdpr|dsgvo|einwilligung/i.test(name) && (x.textContent || "").length < 3000) x.remove();
    }
    // Seiten, die wegen eines Cookie-Hinweises nicht scrollen
    for (const x of [doc.documentElement, doc.body]) if (x) { x.style.removeProperty("overflow"); x.classList.remove("no-scroll", "noscroll", "modal-open", "overflow-hidden"); }
    for (const x of doc.querySelectorAll("*")) {
      for (const at of [...x.attributes]) {
        if (/^on/i.test(at.name)) x.removeAttribute(at.name);
        else if (/^(href|src|action|formaction|xlink:href)$/i.test(at.name) && /^\s*javascript:/i.test(at.value)) x.removeAttribute(at.name);
      }
    }
    faulBilder(doc);

    const dateien = new Set();
    const merken = (u) => { const a = u && !/^\s*data:/i.test(u) ? abs(u) : null; if (a && /^https?:/i.test(a)) { dateien.add(a); return a; } return null; };
    // Bilder: aus srcset das größte nehmen, dann reicht eine Datei
    for (const img of doc.querySelectorAll("img")) {
      const best = groesstes(img.getAttribute("srcset"));
      const src = best || img.getAttribute("src");
      img.removeAttribute("srcset"); img.removeAttribute("sizes");
      if (src) { const a = merken(src); if (a) img.setAttribute("src", a); }
    }
    doc.querySelectorAll("picture source").forEach(x => x.remove());
    for (const x of doc.querySelectorAll("video[poster]")) { const a = merken(x.getAttribute("poster")); if (a) x.setAttribute("poster", a); }
    for (const x of doc.querySelectorAll('input[type="image" i][src]')) { const a = merken(x.getAttribute("src")); if (a) x.setAttribute("src", a); }
    for (const x of doc.querySelectorAll("image[href], image[xlink\\:href]")) {
      const at = x.hasAttribute("href") ? "href" : "xlink:href";
      const a = merken(x.getAttribute(at)); if (a) x.setAttribute(at, a);
    }
    for (const l of doc.querySelectorAll("link[href]")) {
      const rel = (l.getAttribute("rel") || "").toLowerCase();
      if (/stylesheet|icon/.test(rel)) { const a = merken(l.getAttribute("href")); if (a) l.setAttribute("href", a); }
      else if (!/canonical/.test(rel)) l.remove();
    }
    // url(...) in style-Attributen und <style>
    const cssUrls = (css) => css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => { const a = merken(u); return a ? 'url("' + a + '")' : m; })
      .replace(/@import\s+(['"])(.*?)\1/gi, (m, q, u) => { const a = merken(u); return a ? '@import url("' + a + '")' : m; });
    for (const x of doc.querySelectorAll("[style]")) if (/url\(/i.test(x.getAttribute("style"))) x.setAttribute("style", cssUrls(x.getAttribute("style")));
    for (const st of doc.querySelectorAll("style")) st.textContent = cssUrls(st.textContent);

    // Links: echte Adresse merken, Ziel setzt linksAbgleichen (lokal, wenn gesichert)
    const hier = norm(url);
    for (const a of doc.querySelectorAll("a[href], area[href]")) {
      const h = a.getAttribute("href");
      if (h.startsWith("#")) continue;
      const z = abs(h);
      if (!z) continue;
      if (norm(z) === hier && z.includes("#")) { a.setAttribute("href", "#" + z.split("#")[1]); continue; }
      // Link auf ein großes Bild: Datei mitladen (data-fb-bild statt data-fb-url, damit linksAbgleichen es nicht anfasst)
      if (/^https?:/i.test(z) && istBild(z)) {
        merken(z);
        a.setAttribute("data-fb-bild", z); a.setAttribute("href", z); a.removeAttribute("target");
        continue;
      }
      if (/^https?:/i.test(z)) { a.setAttribute("data-fb-url", z); a.setAttribute("href", z); }
    }
    for (const f of doc.querySelectorAll("form")) { const z = f.getAttribute("action"); f.setAttribute("action", z ? (abs(z) || "") : url); }

    // Kopf: Zeichensatz, Herkunft, Datum
    const kopf = doc.head || doc.documentElement.insertBefore(doc.createElement("head"), doc.body);
    const meta = (n, c) => { const m = doc.createElement("meta"); m.setAttribute("name", n); m.setAttribute("content", c); return m; };
    const cs = doc.createElement("meta"); cs.setAttribute("charset", "utf-8");
    kopf.prepend(cs, meta("fieldbook-quelle", url), meta("fieldbook-gesichert", new Date().toISOString()));
    if (!doc.title) { const t = doc.createElement("title"); t.textContent = url; kopf.append(t); }
    return { doc, dateien: [...dateien] };
  }

  // Größte Variante aus srcset („a.jpg 480w, b.jpg 1200w“ oder „a.jpg 1x, b.jpg 2x“)
  function groesstes(srcset) {
    if (!srcset) return null;
    let best = null, wert = -1;
    for (const teil of srcset.split(/,\s+(?=\S)/)) {
      const [u, w] = teil.trim().split(/\s+/);
      const n = w ? parseFloat(w) * (/x$/i.test(w) ? 1000 : 1) : 1;
      if (u && n > wert) { best = u; wert = n; }
    }
    return best;
  }

  // Geladene Dateien eintragen: Pfade relativ zur Seite (../../_dateien/abc.png), damit es auch ohne Fieldbook geht
  function dateienEinsetzen(doc, karte, ordner) {
    const tiefe = String(ordner).split("/").length - 1;
    const pfad = (a) => karte[a] ? "../".repeat(tiefe) + "_dateien/" + karte[a] : null;
    const setzen = (x, at) => { const p = pfad(x.getAttribute(at)); if (p) x.setAttribute(at, p); };
    doc.querySelectorAll("img[src], input[src]").forEach(x => setzen(x, "src"));
    doc.querySelectorAll("video[poster]").forEach(x => setzen(x, "poster"));
    doc.querySelectorAll("link[href]").forEach(x => setzen(x, "href"));
    doc.querySelectorAll("image[href]").forEach(x => setzen(x, "href"));
    doc.querySelectorAll("a[data-fb-bild]").forEach(a => { const p = pfad(a.getAttribute("data-fb-bild")); if (p) a.setAttribute("href", p); });
    doc.querySelectorAll("image").forEach(x => { if (x.hasAttribute("xlink:href")) setzen(x, "xlink:href"); });
    const css = (t) => t.replace(/url\("([^"]+)"\)/g, (m, u) => { const p = pfad(u); return p ? 'url("' + p + '")' : m; });
    for (const x of doc.querySelectorAll("[style]")) x.setAttribute("style", css(x.getAttribute("style")));
    for (const st of doc.querySelectorAll("style")) st.textContent = css(st.textContent);
  }

  // Links aller gesicherten Seiten einer Website neu setzen: auf gesicherte Seiten lokal, sonst ins Internet
  async function linksAbgleichen(host) {
    const liste = await gesicherte();
    const seiten = liste.filter(x => hostVon(x.ordner) === host);
    const nachUrl = new Map(liste.map(x => [norm(x.url), x]));
    for (const s of seiten) {
      let html;
      try { const r = await fetch(s.adresse, { cache: "no-store" }); if (!r.ok) continue; html = await r.text(); } catch { continue; }
      const doc = new DOMParser().parseFromString(html, "text/html");
      let geaendert = false;
      for (const a of doc.querySelectorAll("a[data-fb-url], area[data-fb-url]")) {
        const z = a.getAttribute("data-fb-url");
        const ziel = nachUrl.get(norm(z));
        const marke = z.includes("#") ? "#" + z.split("#")[1] : "";
        const soll = ziel ? relativ(s.ordner, ziel.ordner) + marke : z;
        if (a.getAttribute("href") !== soll) { a.setAttribute("href", soll); geaendert = true; }
      }
      if (geaendert) {
        const doctype = /^\s*<!doctype[^>]*>/i.test(html) ? html.match(/^\s*<!doctype[^>]*>/i)[0].trim() + "\n" : "";
        try { await api("web/html", { ordner: s.ordner, html: doctype + doc.documentElement.outerHTML }); } catch (e) { console.warn("Links abgleichen:", e); }
      }
    }
  }

  // Nach dem Löschen einer Seite: Links der übrigen Seiten dieser Website wieder ins Internet
  function nachLoeschen(ordner) { return linksAbgleichen(hostVon(ordner)).catch(() => { }); }

  // Text für Suche und KI: ohne Menüs, Kopf- und Fußzeilen, Absätze getrennt
  async function text(adresse) {
    const r = await fetch(adresse, { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 404 ? "nicht gefunden" : "Fieldbook antwortet mit " + r.status);
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    doc.querySelectorAll("script, style, noscript, template, nav, header, footer, aside, form, button, select, [role=navigation], [role=banner], [role=contentinfo], [aria-hidden=true]").forEach(x => x.remove());
    const wurzel = doc.querySelector("main") || doc.querySelector("article") || doc.querySelector("[role=main]") || doc.body;
    if (!wurzel) return "";
    wurzel.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, dt, dd, tr, blockquote, pre, div, section, article, br, table, ul, ol").forEach(x => x.after(doc.createTextNode("\n\n")));
    const titel = (doc.title || "").trim();
    return (titel ? titel + "\n\n" : "") + wurzel.textContent.split("\n").map(z => z.replace(/[ \t ]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  return { zeigen, nachLoeschen, text, gesicherte };
})();

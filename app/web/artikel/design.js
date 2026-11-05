// Fieldbook-Design für Artikel aus Kiwix (vom Server in jeden Artikel eingesetzt, siehe ArtikelDesign in Server.cs).
// Setzt html[data-fb="dunkel"|"hell"] passend zum Design von Fieldbook, noch bevor die Seite gezeichnet wird.
(function () {
  function thema() {
    var t = null;
    try { t = localStorage.getItem("thema"); } catch (e) { }
    t = t || "dark";
    if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    return t === "light" ? "hell" : "dunkel";
  }
  function setze() {
    var html = document.documentElement, t = thema();
    html.setAttribute("data-fb", t);
    // Farbschema und Grund wie im kleinen Skript vorne im Kopf (Server.cs), damit Umschalten beides mitnimmt
    html.style.colorScheme = t === "hell" ? "light" : "dark";
    html.style.background = t === "hell" ? "#fff" : "#161715";
    // Wikipedia & Co. haben ein eigenes Nachtdesign nach der Systemeinstellung. Das immer abschalten:
    // Hell soll hell bleiben, und Dunkel macht dieses Design selbst.
    if (/\bskin-theme-clientpref-(os|night)\b/.test(html.className))
      html.className = html.className.replace(/\bskin-theme-clientpref-(os|night)\b/, "skin-theme-clientpref-day");
  }
  setze();
  // Geladene Bilder markieren: Erst dann bekommen sie im dunklen Design den hellen Grund (design.css).
  // Das Skript läuft im Kopf, also vor allen Bildern; "load" steigt nicht auf, deshalb in der Fangphase.
  function markiere(img) { if (img.tagName === "IMG" && !img.hasAttribute("data-fb-da")) img.setAttribute("data-fb-da", ""); }
  document.addEventListener("load", function (e) { markiere(e.target); }, true);
  document.addEventListener("DOMContentLoaded", function () {
    var bilder = document.images;
    for (var i = 0; i < bilder.length; i++) if (bilder[i].complete && bilder[i].naturalWidth) markiere(bilder[i]);
  });
  // Links ins Internet: erst fragen, ob es Internet gibt. Mit Internet zeigt Fieldbook einen Hinweis mit dem
  // Ziel und „Im Browser öffnen“ (neuer Tab), ohne Internet „Kein Internet“ statt einer Fehlerseite des Browsers.
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.button !== 0) return;
    var url;
    try { url = new URL(a.href, document.baseURI); } catch (x) { return; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin === location.origin) return;
    e.preventDefault();
    e.stopPropagation();
    var html = document.documentElement;
    html.style.cursor = "progress";
    wikiZiel(url).then(function (wiki) {
      if (wiki.lokal) { html.style.cursor = ""; location.href = wiki.lokal; return; }
      fetch("/api/internet?url=" + encodeURIComponent(url.href)).then(function (r) { return r.json(); })
        .catch(function () { return { online: false }; })
        .then(function (r) {
          html.style.cursor = "";
          if (r.online) linkInsInternet(url, r.erreichbar === false, wiki.suche);
          else keinInternet(wiki.suche);
        });
    });
  }, true);

  // Links auf Wikipedia, Wikivoyage, Wiktionary usw. (z. B. de.wikipedia.org/wiki/GSM): Ist das passende Paket
  // installiert und hat es den Artikel, öffnet Fieldbook ihn dort statt im Internet.
  // Reihenfolge: ganze Pakete („_all_“) vor Auszügen wie „Das Beste von Wikipedia“ oder Medizin.
  // Verweist der Link auf eine Sprache, die nicht installiert ist („en:Titel“ oder en.wikipedia.org), probiert
  // Fieldbook denselben Titel in der Sprache des Links bzw. des offenen Pakets.
  // Ergebnis: { lokal: Adresse }, { suche: { name, adresse } } für den Knopf „In der Wikipedia suchen“ oder {}.
  var paketListe = null;
  function installiertePakete() {
    if (!paketListe) paketListe = fetch("/kiwix/catalog/v2/entries?count=-1").then(function (r) { return r.text(); })
      .then(function (xml) {
        var namen = [], m, re = /\/content\/([^"\/?#]+)"/g;
        while ((m = re.exec(xml))) if (namen.indexOf(m[1]) < 0) namen.push(m[1]);
        return namen;
      }).catch(function () { paketListe = null; return []; });
    return paketListe;
  }
  var projektNamen = { wikipedia: "der Wikipedia", wikivoyage: "Wikivoyage", wiktionary: "Wiktionary", wikibooks: "Wikibooks",
    wikiquote: "Wikiquote", wikisource: "Wikisource", wikiversity: "Wikiversity", wikinews: "Wikinews" };
  function wikiZiel(url) {
    var host = url.hostname.toLowerCase().match(/^([a-z\-]+)\.(?:m\.)?(wikipedia|wikivoyage|wiktionary|wikibooks|wikiquote|wikisource|wikiversity|wikinews)\.org$/);
    var titel = url.pathname.match(/^\/wiki\/(.+)$/);
    if (!host || !titel) return Promise.resolve({});
    var projekt = host[2];
    // Leerzeichen heißen in den Paketen „_“; „en:Titel“ verweist auf eine andere Sprache
    var pfad = titel[1].replace(/%20/g, "_"), sprachen = [host[1]];
    var andere = pfad.match(/^([a-z]{2,3}):(.+)$/);
    if (andere) { sprachen.unshift(andere[1]); pfad = andere[2]; }
    var offen = location.pathname.match(/^\/kiwix\/content\/[^\/]+?_([a-z]{2,3})_/);
    if (offen && sprachen.indexOf(offen[1]) < 0) sprachen.push(offen[1]);
    return installiertePakete().then(function (namen) {
      var passend = [];
      sprachen.forEach(function (sp) {
        var anfang = projekt + "_" + sp + "_";
        var liste = namen.filter(function (n) { return n.indexOf(anfang) === 0; });
        liste.sort(function (a, b) { return (b.indexOf(anfang + "all_") === 0) - (a.indexOf(anfang + "all_") === 0); });
        passend = passend.concat(liste);
      });
      var i = 0;
      function naechstes() {
        if (i >= passend.length) {
          if (!passend.length) return {};
          var wort = pfad;
          try { wort = decodeURIComponent(pfad); } catch (x) { }
          return { suche: { name: projektNamen[projekt], adresse: "/kiwix/search?books.name=" + encodeURIComponent(passend[0]) +
            "&pattern=" + encodeURIComponent(wort.replace(/_/g, " ")) } };
        }
        var ziel = "/kiwix/content/" + passend[i++] + "/" + pfad;
        return fetch(ziel, { method: "HEAD" }).then(function (r) { return r.ok ? { lokal: ziel + url.hash } : naechstes(); })
          .catch(naechstes);
      }
      return naechstes();
    });
  }

  // PhET: Im Fenster vor dem Start steht statt der fehlenden Beschreibung das Wort „undefined“
  document.addEventListener("click", function () {
    setTimeout(function () {
      var d = document.querySelector(".swal2-html-container .description");
      if (d && d.textContent.trim() === "undefined") d.style.display = "none";
    }, 50);
  });

  // Kasten über dem Artikel (wie eine eigene Seite); Escape oder „Zurück“ schließt ihn
  function kasten(inhalt) {
    var alt = document.getElementById("fb-offline");
    if (alt) alt.remove();
    var box = document.createElement("div");
    box.id = "fb-offline";
    box.innerHTML = '<div class="fb-offline-box">' + inhalt + '</div>';
    function zu() { box.remove(); removeEventListener("keydown", taste, true); }
    function taste(e) { if (e.key === "Escape") zu(); }
    addEventListener("keydown", taste, true);
    box.querySelector(".fb-zurueck").addEventListener("click", zu);
    document.body.appendChild(box);
    return { box: box, zu: zu };
  }

  // Knopf „In der Wikipedia suchen“, wenn der Artikel im installierten Paket nicht unter diesem Namen steht
  function sucheText(suche) {
    return suche ? '<p>In ' + suche.name + ' auf diesem Gerät gibt es den Artikel nicht unter diesem Namen.' +
      '<br>Die Suche dort findet vielleicht passende Artikel.</p>' : '';
  }
  function sucheKnopf(suche, zweit) {
    return suche ? '<button type="button" class="fb-suchen' + (zweit ? ' fb-zweit' : '') + '">In ' + suche.name + ' suchen</button>' : '';
  }
  function sucheVerbinden(k, suche) {
    var knopf = k.box.querySelector(".fb-suchen");
    if (knopf) knopf.addEventListener("click", function () { k.zu(); location.href = suche.adresse; });
    return knopf;
  }

  function keinInternet(suche) {
    var k = kasten('<h1>Kein Internet</h1>' +
      '<p>Dieser Link führt zu einer Webseite im Internet.<br>Gerade gibt es keine Verbindung.</p>' + sucheText(suche) +
      '<div class="fb-knoepfe">' + sucheKnopf(suche, false) +
      '<button type="button" class="fb-zurueck' + (suche ? ' fb-zweit' : '') + '">Zurück</button></div>');
    (sucheVerbinden(k, suche) || k.box.querySelector(".fb-zurueck")).focus();
  }

  // Mit Internet: erst zeigen, wohin der Link führt, geöffnet wird nur auf Klick
  // kaputt: Internet ist da, aber die Seite antwortet nicht (gibt es vielleicht nicht mehr)
  function linkInsInternet(url, kaputt, suche) {
    var adresse = url.href;
    try { adresse = decodeURI(url.href); } catch (x) { }
    var pdf = /\.pdf$/i.test(url.pathname);
    var k = kasten('<h1>Link ins Internet</h1>' +
      '<p>Dieser Link führt aus Fieldbook heraus zu einer Webseite im Internet.<br>Ohne Verbindung ist sie nicht verfügbar.' +
      (pdf ? '<br>Das ist eine PDF-Datei, dein Browser lädt sie vielleicht herunter.' : '') + '</p>' +
      (kaputt ? '<p class="fb-warnung">Die Seite antwortet gerade nicht.<br>Vielleicht gibt es sie nicht mehr.</p>' : '') +
      sucheText(suche) +
      '<div class="fb-ziel"><b></b><a target="_blank" rel="noopener"></a></div>' +
      '<div class="fb-knoepfe"><button type="button" class="fb-oeffnen">Im Browser öffnen</button>' +
      sucheKnopf(suche, true) + '<button type="button" class="fb-zurueck fb-zweit">Zurück</button></div>');
    sucheVerbinden(k, suche);
    // Ziel als Text einsetzen (nie als HTML): Domain groß, darunter die ganze Adresse als ein Link
    k.box.querySelector(".fb-ziel b").textContent = url.hostname.replace(/^www\./, "");
    var link = k.box.querySelector(".fb-ziel a");
    link.href = url.href;
    link.textContent = adresse;
    link.addEventListener("click", function () { setTimeout(k.zu, 0); });
    k.box.querySelector(".fb-oeffnen").addEventListener("click", function () { window.open(url.href, "_blank", "noopener"); k.zu(); });
    k.box.querySelector(".fb-oeffnen").focus();
  }

  // Design in Fieldbook umgeschaltet (anderes Dokument, gleicher Speicher) oder im System geändert
  addEventListener("storage", function (e) { if (e.key === "thema") setze(); });
  try { matchMedia("(prefers-color-scheme: dark)").addEventListener("change", setze); } catch (e) { }
})();

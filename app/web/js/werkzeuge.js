// Werkzeuge: kleine Helfer ohne Netz (Umrechnen, Orientierung, Sonne und Mond, Signale).
// Erreichbar über das Werkzeug-Symbol in der Kopfzeile und über die Suche (Werkzeuge.passend).
// Adresse: #werkzeuge?w=umrechnen|orientierung|sonne|signale.
"use strict";

const Werkzeuge = (() => {
  const LISTE = [
    { id: "umrechnen", titel: "Umrechnen", text: "Einheiten und Küchenmaße", symbol: "arrow-left-right",
      worte: /umrechn|einheit|fahrenheit|celsius|grad|meile|zoll|fuß|fuss|inch|pfund|unze|gallone|knoten|tasse|esslöffel|teelöffel|küchenma|gramm|liter/ },
    { id: "orientierung", titel: "Orientierung", text: "Norden ohne GPS finden", symbol: "compass",
      worte: /orientier|himmelsrichtung|norden|süden|polarstern|ohne gps|verlaufen|kompass/ },
    { id: "sonne", titel: "Sonne und Mond", text: "Hell, dunkel, Mondphase", symbol: "sunset",
      worte: /sonnenaufgang|sonnenuntergang|dämmerung|mondphase|vollmond|wann wird es dunkel|wann wird es hell/ },
    { id: "signale", titel: "Signale", text: "Morse und Notzeichen", symbol: "siren",
      worte: /morse|notsignal|notzeichen|\bsos\b|alpines notsignal|bodenzeichen|lichtzeichen|signalpfeife/ },
  ];

  const inhalt = $("#wz-inhalt");
  let aktiv = "umrechnen";

  function zeigen(params) {
    const w = params && params.get("w");
    if (w && LISTE.some(x => x.id === w)) aktiv = w;
    inhalt.replaceChildren(kacheln(), el("div", { class: "wz-flaeche" }, flaeche()));
  }

  function kacheln() {
    return el("div", { class: "wz-kacheln" }, LISTE.map(x => {
      const an = x.id === aktiv;
      return el("a", {
        class: "kachel wz-kachel" + (an ? " aktiv" : ""), href: "#werkzeuge?w=" + x.id, "aria-current": an ? "true" : null,
      }, symFeld(x.symbol), el("span", { class: "k-titel" }, x.titel), el("span", { class: "k-text" }, x.text));
    }));
  }

  const hatKarte = () => !!(OW.status && OW.status.karten && OW.status.karten.length);

  function flaeche() {
    if (aktiv === "orientierung") return orientierung();
    if (aktiv === "signale") return signale();
    if (aktiv === "sonne") return sonne();
    return umrechnen();
  }

  // Suche: passendes Werkzeug zum Suchbegriff (oder null)
  function passend(q) {
    const t = String(q || "").toLowerCase();
    const x = LISTE.find(w => w.worte.test(t));
    return x ? { titel: x.titel, symbol: x.symbol, link: "#werkzeuge?w=" + x.id } : null;
  }

  // ---------- Sonne und Mond ----------
  // Kurze, nützliche Faustregeln; die genauen Zeiten für einen Ort stehen auf der Karte (sonne.js)
  const SONNE = [
    { titel: "Wie lange es noch hell ist", punkte: [
      "Strecke einen Arm ganz nach vorn und halte die Hand quer vor dich, die Finger flach übereinander.",
      "Setze den untersten Finger genau auf den Horizont.",
      "Zähle, wie viele Finger zwischen Horizont und Unterkante der Sonne passen, notfalls mit der zweiten Hand darüber.",
      "Jeder Finger bedeutet bei uns etwa 10 bis 15 Minuten bis zum Sonnenuntergang, eine ganze Hand (vier Finger) also gut eine Stunde.",
      "Nicht in die Sonne starren, nur kurz mit zusammengekniffenen Augen hinsehen."] },
    { titel: "Nach dem Sonnenuntergang", punkte: [
      "Bei uns bleibt es danach noch etwa 30 bis 45 Minuten so hell, dass du draußen ohne Lampe gehen kannst.",
      "Im Sommer dauert diese Dämmerung länger, im Winter kürzer.",
      "Danach wird es schnell richtig dunkel.",
      "Wer ein Lager oder einen Schlafplatz braucht, richtet ihn ein, solange die Sonne noch über dem Horizont steht."] },
    { titel: "Kurze und lange Tage", punkte: [
      "Die Erdachse ist schräg, deshalb ist im Sommer die Nordhalbkugel der Sonne zugeneigt und im Winter abgewandt.",
      "In Deutschland ist es im Dezember nur etwa 8 Stunden hell, im Juni etwa 16 Stunden.",
      "Je weiter nördlich, desto größer der Unterschied.",
      "Im hohen Norden (Nordnorwegen, Nordschweden, Nordfinnland) geht die Sonne im Sommer wochenlang gar nicht unter (Mitternachtssonne) und im Winter gar nicht auf (Polarnacht).",
      "Nahe am Äquator ist es das ganze Jahr etwa 12 Stunden hell.",
      "Dort geht die Sonne steil unter, und schon etwa 20 Minuten danach ist es dunkel."] },
    { titel: "Auf der Südhalbkugel ist es umgekehrt", punkte: [
      "Die Jahreszeiten sind vertauscht: In Australien, Südafrika oder Argentinien ist im Dezember Sommer.",
      "Mittags steht die Sonne dort im Norden, nicht im Süden.",
      "Für die Methode mit der Uhr drehst du dort die 12 zur Sonne, die Mitte zwischen 12 und kleinem Zeiger zeigt dann nach Norden."] },
    { titel: "Licht vom Mond", punkte: [
      "Der Vollmond ist die ganze Nacht zu sehen: Er geht auf, wenn die Sonne untergeht, und unter, wenn sie aufgeht.",
      "Ist die rechte Seite des Mondes hell, nimmt er zu: Er steht am Abend am Himmel und geht vor Mitternacht unter.",
      "Ist die linke Seite hell, nimmt er ab: Er geht erst nach Mitternacht auf und leuchtet bis zum Morgen.",
      "Das gilt für die Nordhalbkugel, auf der Südhalbkugel ist es seitenverkehrt."] },
    { titel: "Wann die Sonne am stärksten brennt", punkte: [
      "Zwischen etwa 11 und 15 Uhr (im Sommer, also mit Sommerzeit) ist die Sonne am stärksten.",
      "Faustregel: Ist dein Schatten kürzer als du groß bist, gibt es schnell Sonnenbrand.",
      "Dann Schatten suchen, Kopf und Haut bedecken und mehr trinken."] },
  ];

  function sonne() {
    return el("div", { class: "wz-panel" },
      hatKarte()
        ? el("div", { class: "wz-oben" },
          el("a", { class: "knopf knopf-haupt", href: "#karten?z=sonne" }, sym("sunset"), "Genaue Zeiten auf der Karte"),
          el("span", { class: "wz-klein" }, "Sonnenauf- und -untergang, Dämmerung und Mondphase für deinen Ort"))
        : el("p", { class: "hinweis wz-oben" }, "Genaue Zeiten für Sonnenauf- und -untergang, Dämmerung und Mondphase zeigt die Karte.", el("br"),
          "Dafür muss eine Karte installiert sein.", el("br"), el("a", { href: "#inhalte?zu=karten" }, "Karte unter „Inhalte“ laden")),
      el("div", { class: "wz-karten" }, SONNE.map(o => el("div", { class: "wz-karte" },
        el("h3", {}, o.titel),
        el("ul", {}, o.punkte.map(s => el("li", {}, s)))))));
  }

  // ---------- Umrechnen ----------
  // Faktor = Wert der Einheit in der Grundeinheit (Meter, Kilogramm, Liter, km/h)
  const ARTEN = [
    { id: "temperatur", titel: "Temperatur", einheiten: [["°C", "Grad Celsius"], ["°F", "Grad Fahrenheit"], ["K", "Kelvin"]] },
    { id: "laenge", titel: "Länge", einheiten: [["km", "Kilometer", 1000], ["m", "Meter", 1], ["cm", "Zentimeter", 0.01], ["mm", "Millimeter", 0.001],
      ["mi", "Meile", 1609.344], ["sm", "Seemeile", 1852], ["ft", "Fuß", 0.3048], ["in", "Zoll", 0.0254], ["yd", "Yard", 0.9144]] },
    { id: "gewicht", titel: "Gewicht", einheiten: [["kg", "Kilogramm", 1], ["g", "Gramm", 0.001], ["lb", "Pfund (englisch)", 0.45359237],
      ["oz", "Unze", 0.028349523], ["st", "Stone", 6.35029318]] },
    { id: "volumen", titel: "Volumen", einheiten: [["l", "Liter", 1], ["ml", "Milliliter", 0.001], ["gal", "Gallone (USA)", 3.785411784],
      ["gal UK", "Gallone (britisch)", 4.54609], ["fl oz", "Flüssigunze (USA)", 0.0295735296], ["pt", "Pint (USA)", 0.473176473]] },
    { id: "tempo", titel: "Geschwindigkeit", einheiten: [["km/h", "Kilometer pro Stunde", 1], ["m/s", "Meter pro Sekunde", 3.6],
      ["mph", "Meilen pro Stunde", 1.609344], ["kn", "Knoten", 1.852]] },
    { id: "kueche", titel: "Küche" },
  ];
  // Gramm je amerikanischer Tasse (240 ml); Esslöffel = 1/16, Teelöffel = 1/48 Tasse
  const ZUTATEN = [["Wasser, Milch", 240], ["Mehl", 125], ["Zucker", 200], ["Puderzucker", 120], ["Reis (roh)", 185],
    ["Haferflocken", 90], ["Butter", 227], ["Öl", 218], ["Honig", 340], ["Salz", 290]];
  const MASSE = [["Tasse (cup)", 1], ["Esslöffel (EL)", 1 / 16], ["Teelöffel (TL)", 1 / 48]];
  let art = "temperatur";
  const wahl = {}; // gemerkte Einheiten je Art

  const zahl = (s) => { const n = parseFloat(String(s).replace(/\s/g, "").replace(",", ".")); return isFinite(n) ? n : null; };
  function schoen(n) {
    if (n == null || !isFinite(n)) return "";
    const st = Math.abs(n) >= 100 ? 1 : Math.abs(n) >= 1 ? 2 : 4;
    return n.toLocaleString("de-DE", { maximumFractionDigits: st });
  }

  function umrechnen() {
    const box = el("div", { class: "wz-panel" });
    const chips = el("div", { class: "chips wz-chips" }, ARTEN.map(a => el("button", {
      type: "button", class: "chip" + (a.id === art ? " aktiv" : ""), "aria-pressed": a.id === art ? "true" : "false",
      onclick: () => { art = a.id; inhalt.querySelector(".wz-flaeche").replaceChildren(umrechnen()); },
    }, a.titel)));
    box.append(chips, art === "kueche" ? kueche() : rechner(ARTEN.find(a => a.id === art)));
    return box;
  }

  function auswahl(liste, wert, beiAenderung) {
    const s = el("select", { onchange: beiAenderung }, liste.map(([k, name], i) => el("option", { value: i, selected: i === wert }, name + (k ? " (" + k + ")" : ""))));
    return s;
  }

  function rechner(a) {
    const w = wahl[a.id] || (wahl[a.id] = { von: 0, nach: 1, wert: a.id === "temperatur" ? "20" : "1" });
    const eingabe = el("input", { type: "text", inputmode: "decimal", class: "wz-zahl", value: w.wert, "aria-label": "Wert" });
    const von = auswahl(a.einheiten, w.von, neu), nach = auswahl(a.einheiten, w.nach, neu);
    const ergebnis = el("output", { class: "wz-ergebnis" });
    const tausch = el("button", { type: "button", class: "knopf knopf-klein", title: "Tauschen", "aria-label": "Einheiten tauschen",
      onclick: () => { const v = von.value; von.value = nach.value; nach.value = v; neu(); } }, sym("arrow-left-right"));
    const hinweis = el("p", { class: "wz-klein" });
    eingabe.addEventListener("input", neu);
    function neu() {
      w.wert = eingabe.value; w.von = +von.value; w.nach = +nach.value;
      const n = zahl(eingabe.value);
      const ziel = a.einheiten[w.nach][0];
      const r = n == null ? null : a.id === "temperatur" ? temperatur(n, w.von, w.nach) : n * a.einheiten[w.von][2] / a.einheiten[w.nach][2];
      ergebnis.textContent = r == null ? "–" : schoen(r) + " " + ziel;
      hinweis.replaceChildren();
      if (a.id === "temperatur" && n != null) {
        const c = temperatur(n, w.von, 0);
        if (c >= 38 && c < 43) hinweis.append("Ab 38 °C Körpertemperatur spricht man von Fieber.");
        else if (c >= 35 && c < 38) hinweis.append("Normale Körpertemperatur liegt etwa zwischen 36 und 37,5 °C.");
        else if (c < 35 && c > 25) hinweis.append("Unter 35 °C Körpertemperatur ist man unterkühlt.");
      }
    }
    neu();
    return el("div", {},
      el("div", { class: "wz-zeile" }, eingabe, von),
      el("div", { class: "wz-zeile" }, tausch, nach),
      el("div", { class: "wz-zeile wz-gleich" }, el("span", {}, "="), ergebnis),
      hinweis);
  }

  function temperatur(n, von, nach) {
    const c = von === 0 ? n : von === 1 ? (n - 32) * 5 / 9 : n - 273.15;
    return nach === 0 ? c : nach === 1 ? c * 9 / 5 + 32 : c + 273.15;
  }

  function kueche() {
    const w = wahl.kueche || (wahl.kueche = { menge: "1", mass: 0, zutat: 1 });
    const eingabe = el("input", { type: "text", inputmode: "decimal", class: "wz-zahl", value: w.menge, "aria-label": "Menge" });
    const mass = auswahl(MASSE.map(m => ["", m[0]]), w.mass, neu), zutat = auswahl(ZUTATEN.map(z => ["", z[0]]), w.zutat, neu);
    const ergebnis = el("output", { class: "wz-ergebnis" });
    eingabe.addEventListener("input", neu);
    function neu() {
      w.menge = eingabe.value; w.mass = +mass.value; w.zutat = +zutat.value;
      const n = zahl(eingabe.value);
      if (n == null) { ergebnis.textContent = "–"; return; }
      const tassen = n * MASSE[w.mass][1];
      ergebnis.textContent = "etwa " + schoen(Math.round(tassen * ZUTATEN[w.zutat][1])) + " g · " + schoen(Math.round(tassen * 240)) + " ml";
    }
    neu();
    return el("div", {},
      el("div", { class: "wz-zeile" }, eingabe, mass),
      el("div", { class: "wz-zeile" }, el("span", { class: "wz-text" }, "von"), zutat),
      el("div", { class: "wz-zeile wz-gleich" }, el("span", {}, "="), ergebnis),
      el("p", { class: "wz-klein" }, "Gemeint sind amerikanische Maße: 1 Tasse = 240 ml, 1 Esslöffel = 15 ml, 1 Teelöffel = 5 ml.", el("br"),
        "Die Gramm sind Richtwerte, je nachdem wie locker gefüllt wird."));
  }

  // ---------- Orientierung ----------
  const ORIENTIERUNG = [
    { titel: "Mit Uhr und Sonne", schritte: [
      "Lege eine Uhr mit Zeigern flach auf die Hand, das Zifferblatt nach oben.",
      "Drehe die Uhr, bis der kleine Zeiger (Stundenzeiger) genau zur Sonne zeigt.",
      "Stell dir eine Linie genau in der Mitte zwischen dem kleinen Zeiger und der 12 vor.",
      "Diese Linie zeigt nach Süden, die Gegenrichtung nach Norden.",
      "Im Sommer (Sommerzeit) nimmst du statt der 12 die 1.",
      "Ohne Zeigeruhr: Zeichne ein Zifferblatt mit der aktuellen Uhrzeit auf Papier oder in den Sand und mach es genauso."] },
    { titel: "Mit dem Sonnenstand", schritte: [
      "Die Sonne steht morgens ungefähr im Osten, mittags im Süden und abends im Westen.",
      "Genau im Süden steht sie bei uns gegen 12:30 Uhr, im Sommer (Sommerzeit) gegen 13:30 Uhr.",
      "Im Winter geht sie eher im Südosten auf und im Südwesten unter, im Sommer eher im Nordosten und Nordwesten.",
      "Das reicht für die grobe Richtung, genauer sind die anderen Methoden."] },
    { titel: "Mit einem Stock und seinem Schatten", schritte: [
      "Stecke einen geraden Stock senkrecht in den Boden.",
      "Lege einen Stein genau an die Spitze seines Schattens.",
      "Warte etwa 15 Minuten, bis der Schatten ein Stück weitergewandert ist.",
      "Lege einen zweiten Stein an die neue Schattenspitze.",
      "Stell dich so hin, dass der erste Stein links und der zweite rechts von dir liegt.",
      "Jetzt schaust du nach Norden."] },
    { titel: "Nachts mit dem Polarstern", schritte: [
      "Suche den Großen Wagen: sieben helle Sterne, vier davon bilden einen Kasten, drei eine gebogene Deichsel.",
      "Nimm die zwei Sterne an der Kastenseite, die von der Deichsel abgewandt ist.",
      "Verlängere ihre Verbindungslinie über den oberen der beiden hinaus, etwa fünfmal so weit wie ihr Abstand.",
      "Dort steht ein einzelner, nicht besonders heller Stern: der Polarstern.",
      "Senkrecht unter ihm am Horizont ist Norden."] },
  ];

  function orientierung() {
    return el("div", { class: "wz-panel" },
      el("div", { class: "wz-karten" }, ORIENTIERUNG.map(o => el("div", { class: "wz-karte" },
        el("h3", {}, o.titel),
        el("ol", {}, o.schritte.map(s => el("li", {}, s)))))),
      el("p", { class: "warnung" }, "Moos an Bäumen oder Ameisenhaufen zeigen nicht zuverlässig nach Norden.", el("br"),
        "Lieber eine der Methoden oben verwenden."),
      hatKarte() ? el("p", {}, el("a", { class: "knopf knopf-klein", href: "#karten?z=sonne" }, sym("sunset"), "Sonnenauf- und -untergang für deinen Ort")) : null);
  }

  // ---------- Signale ----------
  const MORSE = { A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.", H: "....", I: "..", J: ".---", K: "-.-", L: ".-..",
    M: "--", N: "-.", O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-", V: "...-", W: ".--", X: "-..-", Y: "-.--",
    Z: "--..", "Ä": ".-.-", "Ö": "---.", "Ü": "..--", "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
    "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.", ".": ".-.-.-", ",": "--..--", "?": "..--..", "/": "-..-.", "@": ".--.-." };
  const RUECK = Object.fromEntries(Object.entries(MORSE).map(([k, v]) => [v, k]));
  const zeige = (m) => m.replace(/\./g, "·").replace(/-/g, "−");

  function zuMorse(text) {
    return text.toUpperCase().replace(/ß/g, "SS").split(/\s+/).filter(Boolean)
      .map(wort => [...wort].map(z => MORSE[z]).filter(Boolean).join(" ")).filter(Boolean).join(" / ");
  }
  function ausMorse(text) {
    return text.replace(/[·•]/g, ".").replace(/[−–—_]/g, "-").trim().split(/\s*\/\s*|\s{3,}/)
      .map(wort => wort.split(/\s+/).map(z => RUECK[z] || "?").join("")).join(" ");
  }
  const istMorse = (t) => /^[\s.·•\-−–—_/]+$/.test(t) && /[.·•\-−–—_]/.test(t);

  let blinken = null;
  function lichtzeichen(code) {
    stopp();
    const einheit = 300; // ms für einen Punkt
    const folge = []; // [an?, dauer]
    for (const wort of code.split(" / ")) {
      for (const buchstabe of wort.split(" ")) {
        for (const z of buchstabe) folge.push([true, z === "." ? 1 : 3], [false, 1]);
        folge.push([false, 2]); // zusammen 3 Einheiten zwischen Buchstaben
      }
      folge.push([false, 4]); // zusammen 7 Einheiten zwischen Wörtern
    }
    const flaeche = el("div", { class: "wz-licht", role: "button", tabindex: "0", "aria-label": "Lichtzeichen beenden" },
      el("span", {}, "Klicken oder Esc beendet die Lichtzeichen"));
    document.body.append(flaeche);
    flaeche.focus();
    let i = 0;
    const schritt = () => {
      if (!blinken) return;
      if (i >= folge.length) i = 0; // wiederholen, bis man beendet
      const [an, dauer] = folge[i++];
      flaeche.classList.toggle("an", an);
      blinken.zeit = setTimeout(schritt, dauer * einheit);
    };
    blinken = { flaeche, zeit: null };
    flaeche.addEventListener("click", stopp);
    flaeche.addEventListener("keydown", (e) => { if (e.key === "Escape" || e.key === "Enter" || e.key === " ") { e.preventDefault(); stopp(); } });
    schritt();
  }
  function stopp() {
    if (!blinken) return;
    clearTimeout(blinken.zeit);
    blinken.flaeche.remove();
    blinken = null;
  }
  window.addEventListener("hashchange", stopp);

  let morseText = "SOS";
  function signale() {
    const feld = el("textarea", { rows: "2", class: "wz-morse-feld", "aria-label": "Text oder Morsezeichen" }, morseText);
    const aus = el("output", { class: "wz-morse" });
    const licht = el("button", { type: "button", class: "knopf" }, sym("zap"), "Als Lichtzeichen zeigen");
    let code = "";
    function neu() {
      morseText = feld.value;
      const t = feld.value.trim();
      if (!t) { aus.textContent = "–"; code = ""; return; }
      if (istMorse(t)) { code = t.replace(/[·•]/g, ".").replace(/[−–—_]/g, "-"); aus.textContent = ausMorse(t); }
      else { code = zuMorse(t); aus.textContent = zeige(code) || "–"; }
    }
    feld.addEventListener("input", neu);
    licht.addEventListener("click", () => { if (code) lichtzeichen(code); });
    neu();
    return el("div", { class: "wz-panel" },
      el("h3", {}, "Morse"),
      el("p", { class: "wz-klein" }, "Tippe Text ein, darunter erscheinen die Morsezeichen.", el("br"),
        "Umgekehrt geht es auch: Punkte und Striche eintippen, Buchstaben mit Leerzeichen trennen, Wörter mit „/“.", el("br"),
        "„Als Lichtzeichen zeigen“ lässt den ganzen Bildschirm im Morsetakt aufleuchten, nachts weit sichtbar."),
      feld, aus,
      el("div", { class: "knopfreihe" }, licht),
      el("h3", {}, "Notsignale"),
      el("div", { class: "wz-karten" },
        el("div", { class: "wz-karte" }, el("h4", {}, "SOS"),
          el("p", {}, el("b", { class: "wz-code" }, "· · ·  − − −  · · ·")),
          el("p", {}, "Mit Taschenlampe, Pfeife oder Klopfen: dreimal kurz, dreimal lang, dreimal kurz.", el("br"),
            "Danach eine kurze Pause und wiederholen.", el("br"), "Klopfen hilft z. B., wenn man eingeschlossen ist.")),
        el("div", { class: "wz-karte" }, el("h4", {}, "Alpines Notsignal"),
          el("p", {}, "Gilt in den Bergen, wird aber überall verstanden.", el("br"),
            "Gib eine Minute lang alle 10 Sekunden ein Zeichen, also sechs Pfiffe, Lichtblitze oder Rufe.", el("br"),
            "Dann eine Minute Pause und von vorn, bis jemand antwortet."),
          el("p", {}, "Wer dich gehört hat, antwortet mit drei Zeichen pro Minute, also alle 20 Sekunden.")),
        el("div", { class: "wz-karte" }, el("h4", {}, "Zeichen für Hubschrauber"),
          el("p", {}, "Stell dich frei hin, mit dem Gesicht zum Hubschrauber, und halte die Arme ruhig."),
          el("p", {}, el("b", {}, "Beide Arme schräg nach oben (wie ein Y):"), " Ja, wir brauchen Hilfe."),
          el("p", {}, el("b", {}, "Ein Arm schräg nach oben, der andere schräg nach unten (wie ein N):"), " Nein, wir brauchen keine Hilfe."),
          el("p", {}, "Nicht freundlich winken, das sieht aus wie „Alles in Ordnung“.")),
        el("div", { class: "wz-karte" }, el("h4", {}, "Zeichen auf dem Boden"),
          el("p", {}, "Für Suchende aus der Luft: auf freier Fläche groß auslegen, jedes Zeichen mehrere Meter lang.", el("br"),
            "Nimm Material, das sich vom Boden abhebt, z. B. Steine, Äste, helle Kleidung oder Furchen im Schnee."),
          el("ul", {},
            el("li", {}, el("b", {}, "V"), " Hilfe gebraucht"),
            el("li", {}, el("b", {}, "X"), " Ärztliche Hilfe gebraucht"),
            el("li", {}, el("b", {}, "Pfeil"), " In diese Richtung gegangen"),
            el("li", {}, el("b", {}, "Y"), " Ja, ", el("b", {}, "N"), " Nein")))));
  }

  return { zeigen, passend };
})();

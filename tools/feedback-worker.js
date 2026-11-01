// Fieldbook-Rückmeldungen und Nutzungsstatistik: kleiner Dienst für Cloudflare Workers.
//
// 1. Rückmeldungen (Text, freiwillige Kontaktadresse, auf Wunsch Logdateien) werden zu einem Eintrag
//    (Issue) in einem privaten GitHub-Repository.
// 2. Wochenpakete der Nutzungsstatistik (nur mit Zustimmung in Fieldbook) landen in einer D1-Datenbank.
//    Neue Fehlerarten bekommen zusätzlich einen Eintrag im Repository (Label "fehlerbericht").
// 3. /auswertung?k=<Schlüssel> zeigt eine Übersicht der Statistik (nur mit dem geheimen Schlüssel).
// Den GitHub-Schlüssel kennt nur dieser Dienst, in Fieldbook selbst steht kein Passwort.
//
// Einrichtung bei Cloudflare (Workers & Pages → Worker → Einstellungen):
//   Variablen:  GITHUB_TOKEN  (Geheimnis)  Fine-grained Token, nur für das Feedback-Repository, Recht "Issues: Read and write"
//               REPO          (Text)       wobix08/Fieldbook-Feedback
//               AUSWERTUNG    (Geheimnis)  langer zufälliger Text, Schlüssel für die Auswertungsseite
//   Bindungen:  ZAEHLER       KV-Namespace (Schutz gegen Missbrauch bei Rückmeldungen)
//               DB            D1-Datenbank (Nutzungsstatistik; die Tabellen legt der Dienst selbst an)
//
// Schutz gegen Missbrauch (die Adresse steht offen im Quellcode, jeder kann sie aufrufen):
//   - Rückmeldungen: je Absender höchstens 1 pro Minute und 5 pro Stunde, insgesamt 50 pro Tag,
//   - Statistik: je Kennung ein Paket pro Woche (ein neues ersetzt das alte), insgesamt 5000 pro Tag,
//     höchstens 10 neue Fehler-Einträge pro Tag im Repository,
//   - Größengrenzen für alles, unbekannte Felder werden verworfen.
// Absender von Rückmeldungen werden nur als unumkehrbarer Kurzwert (Hash) gezählt, der nach spätestens
// einer Stunde von selbst verfällt. IP-Adressen werden nirgends gespeichert.

const MAX_ANFRAGE = 400 * 1024;   // ganze Anfrage
const MAX_TEXT = 5000;            // Text der Rückmeldung
const MAX_KONTAKT = 200;
const MAX_LOGS = 8;               // Anzahl Logdateien
const MAX_LOG = 60000;            // Zeichen je Logdatei (ein GitHub-Kommentar fasst 65536)
const JE_MINUTE = 1, JE_STUNDE = 5, JE_TAG = 50;

const STAT_JE_TAG = 5000, NEUE_FEHLER_JE_TAG = 10;

export default {
  async fetch(request, env) {
    const pfad = new URL(request.url).pathname;
    if (request.method === "GET" && pfad === "/auswertung") return auswertung(request, env);
    if (request.method !== "POST") return antwort(405, { fehler: "Nur POST" });
    if (!env.GITHUB_TOKEN || !env.REPO || !env.ZAEHLER) return antwort(500, { fehler: "Dienst nicht eingerichtet" });

    // Erst prüfen, ob die Anfrage überhaupt eine Rückmeldung ist (Unsinn verbraucht keine Zähler)
    const roh = await request.text();
    if (roh.length > MAX_ANFRAGE) return antwort(413, { fehler: "Zu groß" });
    let d;
    try { d = JSON.parse(roh); } catch { return antwort(400, { fehler: "Kein JSON" }); }
    if (!d || typeof d !== "object") return antwort(400, { fehler: "Kein JSON" });
    if (d.art === "statistik") return statistik(d, roh.length, env);
    const r = {
      art: d.art === "fehler" ? "fehler" : "feedback",
      text: str(d.text, MAX_TEXT).trim(),
      kontakt: str(d.kontakt, MAX_KONTAKT).trim(),
      version: str(d.version, 30),
      erstellt: str(d.erstellt, 40),
      system: d.system && typeof d.system === "object" && !Array.isArray(d.system) ? d.system : {},
      logs: Array.isArray(d.logs) ? d.logs.slice(0, MAX_LOGS) : []
    };
    if (!/^\d+\.\d+\.\d+(\.\d+)?$/.test(r.version)) return antwort(400, { fehler: "Version fehlt" });
    if (r.art === "feedback" && r.text.length < 3) return antwort(400, { fehler: "Text fehlt" });

    // Dann die Grenzen je Absender und für alle zusammen
    const sperre = await grenzenPruefen(request, env);
    if (sperre) return antwort(429, { fehler: sperre });

    return eintragen(r, env);
  }
};

// Zählt im KV-Speicher mit und gibt einen Text zurück, wenn eine Grenze erreicht ist
async function grenzenPruefen(request, env) {
  const absender = await kurzwert((request.headers.get("CF-Connecting-IP") || "unbekannt") + "|fieldbook");
  const jetzt = Date.now();
  const k = [
    "m:" + absender + ":" + Math.floor(jetzt / 60000),
    "h:" + absender + ":" + Math.floor(jetzt / 3600000),
    "t:" + new Date(jetzt).toISOString().slice(0, 10)
  ];
  const [m, h, t] = await Promise.all(k.map(async s => parseInt(await env.ZAEHLER.get(s) || "0", 10)));
  if (t >= JE_TAG) return "Heute sind schon sehr viele Rückmeldungen eingegangen. Bitte versuch es morgen noch einmal.";
  if (h >= JE_STUNDE) return "Du hast in dieser Stunde schon " + JE_STUNDE + " Rückmeldungen geschickt. Bitte versuch es später noch einmal.";
  if (m >= JE_MINUTE) return "Bitte warte eine Minute bis zur nächsten Rückmeldung.";
  await Promise.all([
    env.ZAEHLER.put(k[0], String(m + 1), { expirationTtl: 120 }),
    env.ZAEHLER.put(k[1], String(h + 1), { expirationTtl: 3700 }),
    env.ZAEHLER.put(k[2], String(t + 1), { expirationTtl: 2 * 86400 })
  ]);
  return null;
}

async function eintragen(r, env) {
  const zeilen = [];
  zeilen.push(r.text ? zitat(r.text) : "_(kein Text)_");
  zeilen.push("");
  zeilen.push("| | |", "|---|---|");
  zeilen.push("| Fieldbook | " + zelle(r.version) + " |");
  for (const [k, v] of Object.entries(r.system).slice(0, 12)) zeilen.push("| " + zelle(k, 40) + " | " + zelle(v, 200) + " |");
  // Als Code, damit sich die Adresse unverändert kopieren lässt und nichts als Erwähnung gilt
  if (r.kontakt) zeilen.push("| Kontakt | `" + r.kontakt.replace(/[\r\n`|]+/g, " ") + "` |");
  if (r.erstellt) zeilen.push("| Geschrieben | " + zelle(r.erstellt, 40) + " |");
  if (r.logs.length) zeilen.push("", "Logdateien: " + r.logs.map(l => "`" + zelle(l && l.name, 60) + "`").join(", ") + " (als Kommentare)");

  const titel = (r.art === "fehler" ? "Fehlerbericht: " : "Rückmeldung: ") +
    (r.text ? kurz(r.text.replace(/\s+/g, " ").replace(/@/g, "@​"), 70) : "Fieldbook " + r.version);
  const labels = [r.art === "fehler" ? "fehlerbericht" : "feedback"];
  if (r.logs.length) labels.push("logs");

  const issue = await github(env, "/issues", { title: titel, body: zeilen.join("\n"), labels });
  if (!issue.ok) return antwort(502, { fehler: "GitHub: " + issue.status });
  const nummer = (await issue.json()).number;

  // Logdateien als Kommentare (je Datei einer, damit nichts an der Größengrenze scheitert)
  for (const l of r.logs) {
    if (!l || typeof l.inhalt !== "string") continue;
    let inhalt = l.inhalt;
    if (inhalt.length > MAX_LOG) inhalt = "… (gekürzt, nur das Ende)\n" + inhalt.slice(-MAX_LOG);
    inhalt = inhalt.replace(/```/g, "ˋˋˋ");
    await github(env, "/issues/" + nummer + "/comments", { body: "**" + zelle(l.name, 60) + "**\n\n```text\n" + inhalt + "\n```" });
  }
  return antwort(200, { ok: true, nummer });
}

function github(env, pfad, daten) {
  return fetch("https://api.github.com/repos/" + env.REPO + pfad, {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.GITHUB_TOKEN,
      "Accept": "application/vnd.github+json",
      "User-Agent": "Fieldbook-Feedback",
      "Content-Type": "application/json"
    },
    body: JSON.stringify(daten)
  });
}

// ------------------------------------------------------------------ Nutzungsstatistik

const TABELLEN = [
  "CREATE TABLE IF NOT EXISTS berichte (id TEXT NOT NULL, woche TEXT NOT NULL, tag TEXT NOT NULL, version TEXT, daten TEXT, PRIMARY KEY (id, woche))",
  "CREATE TABLE IF NOT EXISTS fehlertypen (schluessel TEXT PRIMARY KEY, art TEXT, text TEXT, anzahl INTEGER, meldungen INTEGER, zuerst TEXT, zuletzt TEXT, version TEXT, issue INTEGER)"
];
const BEREICHE = ["start", "fragen", "bibliothek", "lesen", "kochen", "karten", "erstehilfe", "vorsorge", "einstellungen", "inhalte", "setup"];

async function statistik(d, groesse, env) {
  if (!env.DB) return antwort(500, { fehler: "Statistik nicht eingerichtet" });
  if (groesse > 64 * 1024) return antwort(413, { fehler: "Zu groß" });
  const id = str(d.id, 16), version = str(d.version, 30);
  if (!/^[0-9a-f]{16}$/.test(id) || !/^\d+\.\d+\.\d+(\.\d+)?$/.test(version)) return antwort(400, { fehler: "Kennung oder Version fehlt" });

  await env.DB.batch(TABELLEN.map(s => env.DB.prepare(s)));
  const tag = new Date().toISOString().slice(0, 10);
  const heute = await env.DB.prepare("SELECT COUNT(*) AS n FROM berichte WHERE tag = ?").bind(tag).first();
  if (heute && heute.n >= STAT_JE_TAG) return antwort(429, { fehler: "Heute schon zu viele Pakete" });

  // Nur bekannte Felder, alles gekürzt
  const zahl = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n * 10) / 10, max) : 0; };
  const liste = (v, n, l) => Array.isArray(v) ? v.slice(0, n).map(x => str(x, l)).filter(Boolean) : [];
  const p = { version, windows: str(d.windows, 30) };
  if (d.geraet && typeof d.geraet === "object") p.geraet = {
    cpu: str(d.geraet.cpu, 100), kerne: zahl(d.geraet.kerne, 512), threads: zahl(d.geraet.threads, 1024),
    ramGB: zahl(d.geraet.ramGB, 4096), grafik: liste(d.geraet.grafik, 4, 100) };
  if (Array.isArray(d.ki)) p.ki = d.ki.slice(0, 10).filter(k => k && typeof k === "object").map(k => ({
    modell: str(k.modell, 60), backend: str(k.backend, 20), antwortTokenProSek: zahl(k.antwortTokenProSek, 10000),
    leseTokenProSek: zahl(k.leseTokenProSek, 100000), ladeSek: zahl(k.ladeSek, 100000), antworten: zahl(k.antworten, 100000) }));
  const fehler = Array.isArray(d.fehler) ? d.fehler.slice(0, 30).filter(f => f && typeof f === "object")
    .map(f => ({ art: str(f.art, 30), text: str(f.text, 300), anzahl: Math.max(1, zahl(f.anzahl, 100000)) })).filter(f => f.art && f.text) : [];
  if (d.fehler) p.fehler = fehler.length;
  if (d.bereiche && typeof d.bereiche === "object") { p.bereiche = {}; for (const b of BEREICHE) if (d.bereiche[b]) p.bereiche[b] = zahl(d.bereiche[b], 100000); }
  if (d.land !== undefined) p.land = str(d.land, 2).toUpperCase();
  if (d.pakete) p.pakete = liste(d.pakete, 80, 80);
  if (d.karten) p.karten = liste(d.karten, 40, 60);
  if (d.routen !== undefined) p.routen = !!d.routen;
  if (d.uebersetzer !== undefined) p.uebersetzer = !!d.uebersetzer;

  // Ein Paket je Kennung und Woche, ein neues ersetzt das alte. Pakete, die älter als ein Jahr sind, werden gelöscht.
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO berichte (id, woche, tag, version, daten) VALUES (?, ?, ?, ?, ?)")
      .bind(id, woche(new Date()), tag, version, JSON.stringify(p)),
    env.DB.prepare("DELETE FROM berichte WHERE tag < ?").bind(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10))
  ]);

  // Fehlerarten zusammenzählen; eine neue Art bekommt einen Eintrag im Repository
  for (const f of fehler) {
    const schluessel = f.art + "|" + f.text.replace(/\d+/g, "#");
    const z = await env.DB.prepare(
      "INSERT INTO fehlertypen (schluessel, art, text, anzahl, meldungen, zuerst, zuletzt, version) VALUES (?, ?, ?, ?, 1, ?, ?, ?) " +
      "ON CONFLICT(schluessel) DO UPDATE SET anzahl = anzahl + excluded.anzahl, meldungen = meldungen + 1, zuletzt = excluded.zuletzt, version = excluded.version " +
      "RETURNING meldungen, issue").bind(schluessel, f.art, f.text, f.anzahl, tag, tag, version).first();
    if (!z || z.meldungen !== 1 || z.issue) continue;
    const neu = await env.DB.prepare("SELECT COUNT(*) AS n FROM fehlertypen WHERE zuerst = ? AND issue IS NOT NULL").bind(tag).first();
    if (neu && neu.n >= NEUE_FEHLER_JE_TAG) continue;
    const body = zitat(f.text) + "\n\n| | |\n|---|---|\n| Bereich | " + zelle(f.art) + " |\n| Fieldbook | " + zelle(version) + " |\n| Windows | " + zelle(p.windows) + " |\n" +
      (p.geraet ? "| Gerät | " + zelle(p.geraet.cpu) + ", " + p.geraet.ramGB + " GB |\n" : "") +
      "\nAutomatischer Fehlerbericht. Wie oft der Fehler vorkommt, steht in der Auswertung.";
    const issue = await github(env, "/issues", { title: "Fehlerbericht (" + f.art + "): " + kurz(f.text.replace(/@/g, "@​"), 70), body, labels: ["fehlerbericht"] });
    if (issue.ok) await env.DB.prepare("UPDATE fehlertypen SET issue = ? WHERE schluessel = ?").bind((await issue.json()).number, schluessel).run();
  }
  return antwort(200, { ok: true });
}

// ISO-Kalenderwoche, z. B. "2026-W45"
function woche(datum) {
  const d = new Date(Date.UTC(datum.getUTCFullYear(), datum.getUTCMonth(), datum.getUTCDate()));
  const wt = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - wt);
  const jahresAnfang = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return d.getUTCFullYear() + "-W" + String(Math.ceil(((d - jahresAnfang) / 86400000 + 1) / 7)).padStart(2, "0");
}

// ------------------------------------------------------------------ Auswertung (nur mit Schlüssel)

async function auswertung(request, env) {
  const k = new URL(request.url).searchParams.get("k") || "";
  if (!env.AUSWERTUNG || !env.DB || k.length < 16 || !(await gleich(k, env.AUSWERTUNG))) return new Response("Nicht gefunden", { status: 404 });
  await env.DB.batch(TABELLEN.map(s => env.DB.prepare(s)));
  const tageZurueck = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const geraete7 = (await env.DB.prepare("SELECT COUNT(DISTINCT id) AS n FROM berichte WHERE tag >= ?").bind(tageZurueck(7)).first()).n;
  const geraete30 = (await env.DB.prepare("SELECT COUNT(DISTINCT id) AS n FROM berichte WHERE tag >= ?").bind(tageZurueck(30)).first()).n;
  // Je Gerät das neueste Paket der letzten 30 Tage
  const { results } = await env.DB.prepare(
    "SELECT b.daten FROM berichte b WHERE b.tag >= ? AND b.woche = (SELECT MAX(woche) FROM berichte WHERE id = b.id)").bind(tageZurueck(30)).all();
  const pakete = results.map(r => { try { return JSON.parse(r.daten); } catch { return {}; } });
  const fehlertypen = (await env.DB.prepare("SELECT * FROM fehlertypen ORDER BY zuletzt DESC, anzahl DESC LIMIT 40").all()).results;

  const zaehle = (werte) => { const m = new Map(); for (const w of werte) if (w !== undefined && w !== "") m.set(w, (m.get(w) || 0) + 1); return [...m].sort((a, b) => b[1] - a[1]); };
  const ram = p => p.geraet ? (p.geraet.ramGB <= 8 ? "bis 8 GB" : p.geraet.ramGB <= 16 ? "bis 16 GB" : p.geraet.ramGB <= 32 ? "bis 32 GB" : "mehr als 32 GB") : undefined;
  const bereiche = new Map();
  for (const p of pakete) for (const [b, n] of Object.entries(p.bereiche || {})) bereiche.set(b, (bereiche.get(b) || 0) + n);
  const ki = new Map();
  for (const p of pakete) for (const m of p.ki || []) {
    const s = m.modell + " (" + m.backend + ")", e = ki.get(s) || { geraete: 0, antworten: 0, tok: 0, tokN: 0, laden: 0, ladenN: 0 };
    e.geraete++; e.antworten += m.antworten || 0;
    if (m.antwortTokenProSek) { e.tok += m.antwortTokenProSek; e.tokN++; }
    if (m.ladeSek) { e.laden += m.ladeSek; e.ladenN++; }
    ki.set(s, e);
  }

  const tabelle = (kopf, zeilen) => "<table><tr>" + kopf.map(h => "<th>" + esc(h) + "</th>").join("") + "</tr>" +
    (zeilen.length ? zeilen.map(z => "<tr>" + z.map(c => "<td>" + esc(c) + "</td>").join("") + "</tr>").join("") : "<tr><td colspan=" + kopf.length + ">noch keine Daten</td></tr>") + "</table>";
  const runde = x => Math.round(x * 10) / 10;
  const html = "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'><meta name=robots content=noindex><title>Fieldbook-Auswertung</title>" +
    "<style>body{font:15px system-ui,sans-serif;margin:24px auto;max-width:960px;padding:0 16px;background:#1c1d1b;color:#f7f5f1}h1,h2{font-weight:600}h2{margin-top:32px;color:#9fb78f}" +
    "table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border-bottom:1px solid #3a3d38;padding:6px 8px;text-align:left;vertical-align:top}th{color:#c9c5be;font-weight:600}.zahl{font-size:2rem;font-weight:600}</style>" +
    "<h1>Fieldbook-Auswertung</h1><p><span class=zahl>" + geraete7 + "</span> Geräte in den letzten 7 Tagen · <span class=zahl>" + geraete30 + "</span> in 30 Tagen</p>" +
    "<p>Alles Weitere bezieht sich auf das neueste Paket je Gerät der letzten 30 Tage.</p>" +
    "<h2>Versionen</h2>" + tabelle(["Version", "Geräte"], zaehle(pakete.map(p => p.version))) +
    "<h2>Bereiche (Aufrufe)</h2>" + tabelle(["Bereich", "Aufrufe"], [...bereiche].sort((a, b) => b[1] - a[1])) +
    "<h2>KI</h2>" + tabelle(["Modell", "Geräte", "Antworten", "Ø Token/s", "Ø Ladezeit s"], [...ki].sort((a, b) => b[1].geraete - a[1].geraete)
      .map(([s, e]) => [s, e.geraete, e.antworten, e.tokN ? runde(e.tok / e.tokN) : "–", e.ladenN ? runde(e.laden / e.ladenN) : "–"])) +
    "<h2>Arbeitsspeicher</h2>" + tabelle(["RAM", "Geräte"], zaehle(pakete.map(ram))) +
    "<h2>Prozessoren</h2>" + tabelle(["Prozessor", "Geräte"], zaehle(pakete.map(p => p.geraet && p.geraet.cpu)).slice(0, 20)) +
    "<h2>Grafik</h2>" + tabelle(["Grafik", "Geräte"], zaehle(pakete.flatMap(p => p.geraet ? p.geraet.grafik : [])).slice(0, 20)) +
    "<h2>Länder</h2>" + tabelle(["Land", "Geräte"], zaehle(pakete.map(p => p.land))) +
    "<h2>Wissenspakete</h2>" + tabelle(["Paket", "Geräte"], zaehle(pakete.flatMap(p => p.pakete || []))) +
    "<h2>Karten</h2>" + tabelle(["Karte", "Geräte"], zaehle(pakete.flatMap(p => p.karten || []))) +
    "<h2>Fehler</h2>" + tabelle(["Bereich", "Fehler", "Anzahl", "Meldungen", "Zuletzt", "Version", "Issue"],
      fehlertypen.map(f => [f.art, f.text, f.anzahl, f.meldungen, f.zuletzt, f.version, f.issue ? "#" + f.issue : ""]));
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}

// Vergleich in fester Zeit (über die Kurzwerte), damit der Schlüssel nicht erraten werden kann
async function gleich(a, b) {
  const [x, y] = await Promise.all([kurzwert(a), kurzwert(b)]);
  let u = 0;
  for (let i = 0; i < x.length; i++) u |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return u === 0;
}
function esc(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

// Unumkehrbarer Kurzwert (SHA-256, die ersten 16 Zeichen)
async function kurzwert(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

function str(v, max) { return typeof v === "string" ? v.slice(0, max) : ""; }
function kurz(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }
// Text als Zitat, damit Markdown aus der Rückmeldung nichts am Aufbau ändert; @ ohne Erwähnung
function zitat(s) { return s.replace(/@/g, "@​").split("\n").map(z => "> " + z).join("\n"); }
// Tabellenzelle: keine Zeilenumbrüche, kein |, keine @-Erwähnungen
function zelle(v, max = 300) {
  return String(v == null ? "" : v).slice(0, max).replace(/[\r\n]+/g, " ").replace(/\|/g, "/").replace(/@/g, "@​");
}
function antwort(status, daten) {
  return new Response(JSON.stringify(daten), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

// Fieldbook-Rückmeldungen: kleiner Dienst für Cloudflare Workers.
//
// Fieldbook schickt eine Rückmeldung (Text, freiwillige Kontaktadresse, auf Wunsch Logdateien)
// hierher. Der Dienst legt daraus einen Eintrag (Issue) in einem privaten GitHub-Repository an.
// Den GitHub-Schlüssel kennt nur dieser Dienst, in Fieldbook selbst steht kein Passwort.
//
// Einrichtung bei Cloudflare (Workers & Pages → Worker → Einstellungen):
//   Variablen:  GITHUB_TOKEN  (Geheimnis)  Fine-grained Token, nur für das Feedback-Repository, Recht "Issues: Read and write"
//               REPO          (Text)       wobix08/Fieldbook-Feedback
//   Bindungen:  ZAEHLER       KV-Namespace (Pflicht, Schutz gegen Missbrauch)
//
// Schutz gegen Missbrauch (die Adresse steht offen im Quellcode, jeder kann sie aufrufen):
//   - je Absender höchstens 1 Rückmeldung pro Minute und 5 pro Stunde,
//   - insgesamt höchstens 50 pro Tag, damit das Repository nie überflutet wird,
//   - Größengrenzen für Text und Logdateien.
// Absender werden nur als unumkehrbarer Kurzwert (Hash) gezählt, der nach spätestens einer Stunde
// von selbst verfällt. Die IP-Adresse selbst wird nirgends gespeichert.

const MAX_ANFRAGE = 400 * 1024;   // ganze Anfrage
const MAX_TEXT = 5000;            // Text der Rückmeldung
const MAX_KONTAKT = 200;
const MAX_LOGS = 8;               // Anzahl Logdateien
const MAX_LOG = 60000;            // Zeichen je Logdatei (ein GitHub-Kommentar fasst 65536)
const JE_MINUTE = 1, JE_STUNDE = 5, JE_TAG = 50;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return antwort(405, { fehler: "Nur POST" });
    if (!env.GITHUB_TOKEN || !env.REPO || !env.ZAEHLER) return antwort(500, { fehler: "Dienst nicht eingerichtet" });

    // Erst prüfen, ob die Anfrage überhaupt eine Rückmeldung ist (Unsinn verbraucht keine Zähler)
    const roh = await request.text();
    if (roh.length > MAX_ANFRAGE) return antwort(413, { fehler: "Zu groß" });
    let d;
    try { d = JSON.parse(roh); } catch { return antwort(400, { fehler: "Kein JSON" }); }
    if (!d || typeof d !== "object") return antwort(400, { fehler: "Kein JSON" });
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

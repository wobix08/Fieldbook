# Fieldbook

**Wissen, wo kein Netz ist**\
Wikipedia, KI-Assistent, Karten, Kochen und Erste Hilfe auf dem Laptop, komplett ohne Internet.

Fieldbook ist ein portables Windows-Programm für Stromausfall, Reisen ohne Netz oder einfach für unterwegs.\
Es braucht kein Linux, kein Docker und keine Installation: Ordner entpacken, Doppelklick, fertig.\
Inspiriert von [Project NOMAD](https://www.projectnomad.us/) und [Internet-in-a-Box](https://internet-in-a-box.org/).

## Warum Fieldbook?

Project NOMAD hat mich sehr beeindruckt: Wikipedia, Karten, Anleitungen und eine KI, alles auf einem Gerät und ohne Internet.\
Dafür braucht man aber ein eigenes Linux-System oder eine virtuelle Maschine, und darauf hatte ich keine Lust.\
Ich wollte dieselbe Idee auf einem ganz normalen Windows-Laptop haben: entpacken, doppelklicken, fertig.

Außerdem soll so eine Wissenssammlung nicht nur etwas für Technikbegeisterte sein.\
Jeder, der einen Laptop hat, soll sie nutzen können, ob im Stromausfall, auf Reisen oder in einer einsamen Hütte im Wald.

Fieldbook habe ich mit Hilfe der KI Claude entwickelt.\
Ideen, Auswahl der Inhalte und alle Entscheidungen stammen von mir.

## Was drin ist

| | Bereich | Was es kann |
|---|---|---|
| <img src=".github/icons/ask.svg" width="32" height="32" align="left" alt=""> | **Fragen** | Eine lokale KI beantwortet Fragen anhand der Offline-Bibliothek, mit Quellenangabe |
| <img src=".github/icons/library.svg" width="32" height="32" align="left" alt=""> | **Bibliothek** | Wikipedia, Medizin, iFixit-Reparaturanleitungen, Lehrbücher, Kinderlexikon, Reiseführer und mehr, mit Übersetzer Englisch → Deutsch |
| <img src=".github/icons/cooking.svg" width="32" height="32" align="left" alt=""> | **Kochen** | Rezepte zu dem, was du da hast, und Faustregeln zu Trinkwasser, Vorräten und Stromausfall |
| <img src=".github/icons/maps.svg" width="32" height="32" align="left" alt=""> | **Karten** | OpenStreetMap-Karten offline, Ortssuche, Routenplanung, Ärzte, Apotheken und Trinkwasser in der Nähe |
| <img src=".github/icons/first-aid.svg" width="32" height="32" align="left" alt=""> | **Erste&nbsp;Hilfe** | Ein Kurs zum Vorbereiten mit Lektionen, Quiz und Fallbeispielen, dazu Spickzettel für den Ernstfall |
| <img src=".github/icons/preparedness.svg" width="32" height="32" align="left" alt=""> | **Vorsorge** | Checklisten zum Abhaken: Vorräte für 10 Tage, Stromausfall, Dokumente, Notgepäck |

## Schnellstart

1. **[Fieldbook 0.5.0 herunterladen](https://github.com/wobix08/Fieldbook/releases/download/v0.5.0/Fieldbook-0.5.0.zip)** (ZIP-Datei, unter 1 MB) und entpacken, zum Beispiel nach `C:\Fieldbook` oder auf einen USB-Stick.\
   Frühere Versionen und was sich geändert hat, stehen unter [Releases](../../releases).
2. **`Fieldbook.exe`** doppelklicken.
3. Der Einrichtungs-Assistent öffnet sich im Browser.\
   Er erkennt die Hardware, schlägt eine passende KI vor und lädt die gewählten Inhalte herunter.
4. Ab dann funktioniert alles offline.

Eine ausführliche Schritt-für-Schritt-Anleitung steht in der [GUIDE.md](GUIDE.md).

> Windows zeigt beim ersten Start „Der Computer wurde durch Windows geschützt“, weil das Programm neu und nicht signiert ist.\
> Dann auf **Weitere Informationen → Trotzdem ausführen** klicken.\
> Das ist nur einmal nötig.\
> Warum das harmlos ist, steht unter [Ist das sicher?](#ist-das-sicher).

## Ist das sicher?

Ein unbekanntes Programm aus dem Internet zu starten, erfordert Vertrauen.\
Deshalb ist bei Fieldbook alles offen und überprüfbar:

- **Der komplette Quellcode liegt in diesem Repository**\
  Es gibt keine versteckten Teile.\
  Auch die Startdatei `Fieldbook.exe` wird aus [`tools/Starter.cs`](tools/Starter.cs) gebaut (rund 90 Zeilen).\
  Sie macht nur eines: `app\Start.bat` starten.
- **Ohne .exe starten**\
  Wer keine .exe starten möchte, kann stattdessen `app\Start.bat` doppelklicken.\
  Das ist eine lesbare Textdatei, genau wie der restliche Programmcode in `app\`.
- **Keine Installation, keine Administratorrechte**\
  Fieldbook verändert nichts an Windows und schreibt nur in seinen eigenen Ordner.\
  Zum Entfernen genügt es, den Ordner zu löschen.\
  Einzige Ausnahme: Die *optionale* automatische Aktualisierung legt zwei Aufgaben in der Windows-Aufgabenplanung an.\
  Ausschalten in den Einstellungen entfernt sie wieder.
- **Deine Daten bleiben bei dir**\
  Kein Konto, keine Werbung.\
  Alles läuft auf `localhost`, also nur auf deinem Gerät.\
  Fragen an die KI, Chats und alles, was du in Fieldbook einträgst, verlassen dein Gerät nicht.\
  Fehlerberichte oder Nutzungsstatistiken verschickt Fieldbook nur, wenn du ausdrücklich zustimmst, und du kannst das jederzeit wieder abschalten.\
  In der aktuellen Version ist so etwas noch gar nicht eingebaut.\
  Ganz ehrlich: Ich kann jeden verstehen, der das ausgeschaltet lässt, bei anderen Programmen mache ich es genauso.\
  Über jedes Ja würde ich mich trotzdem sehr freuen.\
  Fieldbook läuft auf ganz unterschiedlicher Hardware, und ohne solche Rückmeldungen bekomme ich kaum mit, wo es hakt oder zu langsam ist.\
  Zusammen mit den Nutzungsstatistiken kommt auch eine Feedback-Funktion.\
  Dort kannst du mir selbst schreiben, was gut läuft und was nicht, als Alternative zur Statistik.
- **Downloads nur aus offiziellen Quellen**\
  Alle stehen in [`app/config/programme.json`](app/config/programme.json) und den anderen Konfigurationsdateien:

  | Was | Woher |
  |---|---|
  | Wissenspakete, kiwix-serve | download.kiwix.org (Kiwix / Wikimedia) |
  | KI-Modelle | huggingface.co |
  | llama.cpp, BRouter, PMTiles, Java (Eclipse Temurin) | github.com (offizielle Releases der Projekte) |
  | Karten | build.protomaps.com (OpenStreetMap-Daten) |
  | Wegedaten | brouter.de |
  | Ortsnamen | download.geonames.org |
  | Übersetzer (Bergamot) | cdn.jsdelivr.net (npm-Paket `@browsermt/bergamot-translator`, feste Version) |
  | Übersetzungsmodell Englisch → Deutsch | storage.googleapis.com (Mozilla, Prüfsumme wird beim Laden kontrolliert) |

- **Prüfsumme**\
  Zu jedem Release gibt es eine Datei `.sha256`.\
  Damit lässt sich prüfen, dass die heruntergeladene ZIP nicht verändert wurde:

  ```powershell
  Get-FileHash .\Fieldbook-0.5.0.zip -Algorithm SHA256
  ```

  Der angezeigte Wert muss mit dem in der `.sha256`-Datei übereinstimmen.
- **Selbst prüfen lassen**\
  Wer möchte, lädt die ZIP bei [VirusTotal](https://www.virustotal.com) hoch.\
  Dort prüfen rund 70 Virenscanner gleichzeitig.

## Systemanforderungen

- Windows 10 oder 11 (64 Bit)
- Mindestens 4 GB Arbeitsspeicher, empfohlen 8 GB oder mehr
- Speicherplatz je nach Auswahl: ca. 6 GB (Reise-Set) bis über 100 GB (alles)
- Internet nur für die Einrichtung

## Downloads in Firmen- und Schulnetzen

Fieldbook braucht Internet nur zum Herunterladen.\
Sperren ein Werbeblocker (z. B. Pi-hole, AdGuard), eine Firewall oder ein Jugendschutzfilter einzelne Adressen, schlagen Downloads fehl.

- **Verbindung prüfen**\
  Unter *Einstellungen → Internetverbindung → Prüfen* testet Fieldbook alle Adressen und sagt, welche gesperrt ist.\
  Derselbe Knopf erscheint, wenn ein Download scheitert.
- **Proxy**\
  Fieldbook übernimmt den Proxy aus den Windows-Einstellungen automatisch.\
  Falls nötig, lässt sich unter *Einstellungen → Internetverbindung* ein eigener eintragen (z. B. `proxy.schule.de:8080`).
- **Ohne Internet**\
  Pakete, Karten und KI-Modelle lassen sich auch von einem USB-Stick oder einem anderen Ordner übernehmen (*Inhalte → Von USB-Stick oder Ordner übernehmen*).\
  So kann man zum Beispiel einen zweiten Laptop bestücken, ohne alles neu zu laden.

Diese Adressen müssen erreichbar sein (zum Freigeben in Firewall oder Werbeblocker):

| Wofür | Adressen |
|---|---|
| Wissenspakete | `library.kiwix.org`, `download.kiwix.org` und dessen Spiegelserver (z. B. `ftp.fau.de`, `mirror.download.kiwix.org`) |
| Karten | `build-metadata.protomaps.dev`, `build.protomaps.com` |
| KI-Modelle | `huggingface.co`, `*.hf.co` (Download-Server von Hugging Face) |
| Hilfsprogramme und Updates | `github.com`, `api.github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` |
| Übersetzer | `cdn.jsdelivr.net`, `storage.googleapis.com` |
| Ortsnamen | `download.geonames.org` |
| Wegedaten | `brouter.de` |

## Welche KI passt zu meinem Gerät?

Der Assistent misst Arbeitsspeicher und Grafikkarte und schlägt automatisch vor:

| Gerät | Vorschlag | Download |
|---|---|---|
| 4 GB RAM | Qwen 3.5 (2B) | 1,3 GB |
| 8 GB RAM, ohne Grafikkarte | Qwen 3.5 (4B) | 2,7 GB |
| 16 GB RAM | Qwen 3.5 (9B) | 5,7 GB |
| 32 GB RAM, ohne starke Grafikkarte | Qwen 3.5 (35B-A3B) | 22 GB |
| Grafikkarte ab 10 GB | Gemma 4 (12B) | 7,1 GB |
| Grafikkarte ab 20 GB | Qwen 3.5 (27B) | 16,7 GB |

Grafikkarten von NVIDIA, AMD und Intel Arc werden über Vulkan genutzt.\
Es ist keine Treiber-Zusatzinstallation wie CUDA nötig.\
Die Liste steht in [`app/config/modelle.json`](app/config/modelle.json) und lässt sich leicht erweitern.

## So funktioniert die Frage-Antwort-Funktion

```
Frage ──► KI erzeugt Suchbegriffe ──► Suche in allen Wissenspaketen (Kiwix)
                                            │
Antwort mit Quellen [1] [2] ◄── KI liest die besten Abschnitte
```

Die KI antwortet nur anhand der gefundenen Artikel und nennt die Quellen.\
Englische Quellen (z. B. medizinische Handbücher) übersetzt sie sinngemäß ins Deutsche.\
Im **Sparmodus** ist die KI aus.\
Dann zeigt der Bereich „Fragen“ die passenden Artikel direkt an.

## Aufbau

```
Fieldbook.exe           Startdatei (sucht app\Start.bat neben sich)
app\
  Start.bat, start.ps1        Starter (PowerShell, in Windows enthalten)
  Server.cs                   Kleiner lokaler Server, wird beim Start kompiliert
  config\                     Modelle, Wissenspakete, Karten, Kochen, Erste Hilfe (JSON)
  web\                        Dashboard (HTML, CSS, JavaScript, MapLibre)
programme\                    Wird vom Setup gefüllt: kiwix-serve, llama-server, pmtiles
daten\                        Wird vom Setup gefüllt: wissen\*.zim, modelle\*.gguf, karten\*.pmtiles
```

Alles läuft auf `localhost`.\
Deine Fragen, Chats und Einträge bleiben auf deinem Gerät.\
Nach der Einrichtung geht Fieldbook nur noch in drei Fällen ins Internet:
- **Beim Start** fragt es kurz bei GitHub nach, ob es eine neue Version gibt.\
  Heruntergeladen wird sie erst, wenn du dies bestätigst.\
  Auch diese Anfrage kannst du in den Einstellungen abschalten.
- **Neue Inhalte** lädt es, wenn du sie auf der Seite *Inhalte* auswählst.
- **Automatische Aktualisierung**, wenn du sie einschaltest (standardmäßig aus).\
  Dann prüft Fieldbook einmal pro Woche, ob es neue Inhalte oder eine neue Version gibt, und fragt vorher oder lädt sie selbst, je nach Einstellung.\
  Mehr dazu unter [Automatische Aktualisierung](#automatische-aktualisierung-optional).

Verwendete Bausteine:
- [Kiwix](https://kiwix.org) (`kiwix-serve`) für die ZIM-Wissenspakete
- [llama.cpp](https://github.com/ggml-org/llama.cpp) (`llama-server`) für die KI
- [Protomaps / PMTiles](https://protomaps.com) und [MapLibre](https://maplibre.org) für die Karten
- [GeoNames](https://www.geonames.org) für die Ortssuche

## Entwicklung

Der Code braucht keinen Build-Schritt.\
Zum Testen `app\Start.bat` starten.

- Startdatei mit Symbol neu bauen: `powershell -ExecutionPolicy Bypass -File tools\starter-bauen.ps1`
- Release-ZIP bauen: `powershell -ExecutionPolicy Bypass -File tools\release-bauen.ps1 -Version 0.1.0`
- Neue Wissenspakete: Eintrag in `app/config/pakete.json` mit `name` und `flavour` wie im [Kiwix-Katalog](https://library.kiwix.org)
- Eigene ZIM-Dateien kann man einfach in `daten\wissen` legen.\
  Sie werden automatisch eingebunden.

## Automatische Aktualisierung (optional)

Im Assistenten ganz am Anfang einschaltbar, standardmäßig aus.\
Es gibt keinen Autostart und kein Programm, das dauerhaft im Hintergrund läuft.\
Stattdessen legt Fieldbook zwei Aufgaben in der Windows-Aufgabenplanung an:

| Aufgabe | Wann | Was |
|---|---|---|
| *Fieldbook Daten pruefen* | einmal pro Woche (Sonntag 19 Uhr oder beim nächsten Einschalten) | ein paar kleine Anfragen, dauert unter einer Sekunde; im Modus „Vorher fragen“ danach ein Pop-up |
| *Fieldbook Daten herunterladen* | nur wenn der Computer 10 Minuten unbenutzt am Strom hängt | lädt freigegebene Daten mit niedrigster Priorität; bei Maus, Tastatur oder Akkubetrieb sofort Pause, beim nächsten Leerlauf geht es weiter |

Nicht über getaktete Verbindungen (z. B. Handy-Hotspot).\
Aktualisiert werden Wissenspakete (neue Ausgaben im Kiwix-Katalog), Wegedaten (höchstens monatlich) und Karten (etwa halbjährlich).\
Ausschalten in den Einstellungen entfernt beide Aufgaben wieder.\
Protokoll: `daten\logs\aktualisierung.log`.

## Programm-Updates (Fieldbook selbst)

**Du entscheidest über Updates**\
Fieldbook spielt nie eine neue Version ein, ohne dass du zugestimmt hast.\
Beim Start fragt es nur kurz bei GitHub nach, ob es eine neue Version gibt, und zeigt dann einen Hinweis (in den Einstellungen unter *Fieldbook-Version*).\
Heruntergeladen und eingespielt wird sie erst, wenn du dies bestätigst.\
Möchtest du auch diese kurze Anfrage nicht, schaltest du sie in den Einstellungen bei *Beim Start nach neuer Version fragen* aus.\
Dann sucht Fieldbook nur noch, wenn du selbst auf *Nach neuer Version suchen* klickst oder die automatische Aktualisierung eingeschaltet hast.

**Mit automatischer Aktualisierung**\
Hast du die automatische Aktualisierung eingeschaltet, sucht Fieldbook dabei auch nach neuen Versionen.\
Im Modus „Vorher fragen“ fragt es dich, im Modus „Automatisch herunterladen“ lädt es die neue Version selbst und spielt sie beim nächsten Start ein.\
Wer das nicht möchte, nimmt in den Einstellungen den Haken bei „Auch Fieldbook selbst aktualisieren“ heraus.\
Dann aktualisiert die automatische Aktualisierung nur noch Inhalte.

**So läuft ein Update ab**\
Fieldbook sucht in den GitHub-Releases nach den Dateien `Fieldbook-<version>.zip` und `Fieldbook-<version>.zip.sha256` (beide erzeugt `tools\release-bauen.ps1`).

1. Herunterladen und Prüfsumme kontrollieren, dann unter `daten\cache\update\bereit` ablegen.
2. Fieldbook startet neu.\
   `app\start.ps1` sichert den bisherigen Programmteil nach `daten\cache\update\sicherung` und spielt die neue Version ein, **bevor** der Server geladen wird.
3. Lässt sich die neue Version nicht laden, wird automatisch die Sicherung wiederhergestellt.

Der Ordner `daten` wird dabei nie verändert.\
Im Git-Entwicklungsordner sind Programm-Updates gesperrt.\
Das Repository steht in [`app/config/fieldbook.json`](app/config/fieldbook.json) (`"github": "wobix08/Fieldbook"`).

## Länder und Sprachen

Vorerst ist Fieldbook auf Deutsch und für Deutschland, Österreich und die Schweiz eingerichtet.\
Für andere Länder ist es vorbereitet:

- Das Land wird aus der Windows-Regionseinstellung erkannt und lässt sich im Assistenten und in den Einstellungen ändern.
- Notrufnummern und die vorgeschlagene Karte kommen aus [`app/config/laender.json`](app/config/laender.json).\
  Ein neues Land braucht nur einen Eintrag dort (`"aktiv": true`).\
  In den Erste-Hilfe-Texten steht `{notruf}`, das durch die Nummer des Landes ersetzt wird.
- Sprachen: Deutsch und Englisch.\
  Die Antwortsprache der KI folgt der Sprache des Landes.\
  Die Oberfläche selbst ist noch nicht übersetzt.

## Lizenz

Der Code dieses Projekts steht unter der [MIT-Lizenz](LICENSE).\
Die heruntergeladenen Programme und Inhalte haben eigene Lizenzen, siehe [THIRD-PARTY.md](THIRD-PARTY.md).

**Hinweis**\
Der Erste-Hilfe-Kurs folgt gängigen Erste-Hilfe-Regeln, ersetzt aber keinen echten Erste-Hilfe-Kurs und keine ärztliche Hilfe.\
KI-Antworten können Fehler enthalten.\
Bei wichtigen Entscheidungen immer die Quellen lesen.

# Anleitung: Fieldbook einrichten und benutzen

Diese Anleitung ist für alle gedacht, auch ohne Computer-Erfahrung.

---

## 1. Herunterladen und entpacken

1. Die Datei `Fieldbook-…zip` herunterladen.
2. Mit der rechten Maustaste auf die Datei klicken und **Alle extrahieren …** wählen.
3. Einen Ort auswählen, zum Beispiel `C:\Fieldbook` oder einen USB-Stick.\
   Auf dem Laufwerk sollte genug Platz frei sein, siehe Schritt 3.

Danach liegt im Ordner unter anderem die Datei **Fieldbook**.

## 2. Starten

Doppelklick auf **Fieldbook**.

### Beim allerersten Start: Windows-Warnung

Windows zeigt beim ersten Start sehr wahrscheinlich ein blaues Fenster:

> **Der Computer wurde durch Windows geschützt**\
> Von Microsoft Defender SmartScreen wurde der Start einer unbekannten App verhindert.

**Warum kommt die Warnung?**\
Windows warnt bei jedem Programm aus dem Internet, das noch nicht viele Menschen heruntergeladen haben oder das nicht mit einem kostenpflichtigen Zertifikat signiert ist.\
Die Meldung sagt nichts über einen Virus aus, sondern nur: „Microsoft kennt dieses Programm noch nicht.“\
Fieldbook ist ein kleines, freies Projekt.\
Woran du erkennst, dass es harmlos ist, steht in der README auf GitHub im Abschnitt **Ist das sicher?**.

So geht es weiter:

1. Auf **Weitere Informationen** klicken (kleiner Text unter der Meldung).
2. Unten erscheint der Knopf **Trotzdem ausführen**.\
   Darauf klicken.

Das musst du nur einmal machen.\
Danach startet Fieldbook ohne Nachfrage.

Wichtig: Fieldbook braucht **keine Administratorrechte**.\
Fragt Windows nach einem Administrator-Passwort, stimmt etwas nicht.\
Dann bitte abbrechen.

### Danach

- Es öffnet sich ein schwarzes Fenster.\
  **Lass es offen**, solange du das Programm benutzt.\
  Schließt du es, wird Fieldbook beendet.
- Der Browser öffnet sich automatisch mit dem Dashboard.

## 3. Einrichten (einmalig, mit Internet)

Der Assistent führt in fünf Schritten durch die Einrichtung:

1. **Dein Gerät**\
   Das Programm prüft Prozessor, Arbeitsspeicher, Grafikkarte und freien Platz.\
   Hier wählst du auch dein Land, ob ein **Symbol auf dem Desktop** angelegt werden soll und ob Fieldbook sich automatisch aktuell hält.
2. **KI-Assistent**\
   Die passende KI ist schon vorausgewählt („Empfohlen“).\
   Größere Modelle antworten besser, brauchen aber mehr Speicher und Strom.\
   „Keine KI“ geht auch.
3. **Wissen**\
   Wähle die Bibliotheken aus.\
   Die Schnellwahl hilft:
   - **Reise**\
     Klein, etwa 5 GB (Wikipedia kompakt, Medizin, Reiseführer)
   - **Zuhause**\
     Empfohlen, etwa 30 GB (vollständige Wikipedia, Medizin, Reparaturanleitungen, Lehrbücher, Kinderlexikon …)
   - **Alles**\
     Über 100 GB
4. **Karten**\
   Wähle eine oder mehrere Regionen.\
   Die Größe wird automatisch berechnet.
5. **Übersicht**\
   Prüfe deine Auswahl und klicke auf **Einrichtung abschließen und herunterladen**.

Danach öffnet sich die Seite **Inhalte** mit dem Fortschritt der Downloads.\
Bis zu drei Downloads laufen gleichzeitig, kleine zuerst.\
Fertige Pakete kannst du sofort benutzen, auch wenn der Rest noch lädt.\
Du kannst das Fenster jederzeit schließen: Beim nächsten Start geht es an derselben Stelle weiter.\
Läuft gerade ein Download, zeigt oben in der Kopfzeile „40 %“ mit einem Pfeil den Stand; ein Klick darauf führt zu den Downloads.

## 4. Benutzen (offline)

### Fragen
Schreib eine Frage, zum Beispiel „Wie versorge ich eine Schnittwunde?“.\
Die KI sucht passende Artikel und antwortet mit Quellennummern wie [1].\
Klick auf eine Nummer öffnet den Artikel.

- **Neuer Chat** (links) beginnt ein neues Thema.\
  Im selben Chat versteht die KI Rückfragen wie „Und wenn ich kein Feuerzeug habe?“.\
  Für ein ganz anderes Thema lieber einen neuen Chat starten.
- **Frühere Chats** stehen links in der Liste (auf dem Handy unter **Verlauf**).\
  Ein Klick öffnet den Chat wieder, dort kannst du weiterfragen.\
  Mit ✕ löschst du einen Chat.\
  Die Chats liegen im Ordner `daten\chats` und wandern mit, wenn du Fieldbook auf einen USB-Stick kopierst.
- Eine Modellnummer oder einen Namen kannst du auch als eigene Nachricht hinterherschicken, zum Beispiel erst „Wie repariere ich einen Kühlschrank von LG?“ und dann „LFX25973“.
- **Lage** (unter dem Fragefeld) sagt der KI, was dir zur Verfügung steht: *Zuhause*, *Stromausfall* (keine Steckdose), *Draußen / unterwegs* (nur was du dabei hast oder findest) oder *Krise* (keine Läden, keine Hilfe).\
  Die KI erklärt immer, wie du es selbst machst, nicht wen du beauftragen sollst.
- **Einfach erklären** macht die Antwort kindgerecht, gut für den Unterricht.
- Auf schwachen Laptops dauert eine Antwort etwa 20 bis 60 Sekunden.

### Bibliothek
Die Pakete sind nach Themen sortiert: Grundwissen, Gesundheit & Erste Hilfe, Reparieren & Technik, Draußen & Überleben, Selbstversorgung & Haushalt, Lernen & Schule, Für Kinder sowie Beschäftigung & Lesen.\
Ein Klick auf eine Kategorie zeigt ihre Pakete.\
Manche Pakete stehen in mehreren Kategorien.\
Oben rechts wechselst du zwischen **Kacheln** und **Liste** (mit Beschreibung).\
Über dem Regal kannst du in allen Paketen gleichzeitig suchen.

**Englische Artikel auf Deutsch lesen**\
Beim Lesen oben auf **Auf Deutsch** klicken.\
Der Artikel wird offline übersetzt, meist in wenigen Sekunden.\
Solange die Übersetzung an ist, werden auch weitere Artikel automatisch übersetzt, wenn du auf Links klickst.\
**Original** zeigt wieder den englischen Text.\
Die Übersetzung macht ein Programm, keine Person: Bei Fachbegriffen und Zahlen im Zweifel das Original prüfen.\
Den Übersetzer (27 MB) wählst du im Assistenten oder unter **Inhalte** aus.

### Karten
Zoomen mit dem Mausrad, verschieben mit gedrückter Maustaste.\
Oben links nach Orten suchen.\
Die Knöpfe wie „Arzt / Klinik“ oder „Apotheke“ zeigen Einrichtungen im sichtbaren Kartenausschnitt.\
Dafür vorher auf Stadt- oder Ortsebene hineinzoomen.

### Kochen
Unter **Was hast du da?** gibst du ein, was im Haus ist.\
Fieldbook sucht passende Rezepte im Koch-Wiki, zuerst die, für die du alles hast.\
Darunter stehen Faustregeln zu Trinkwasser, Vorräten und Kühlschrank im Stromausfall, auch ohne heruntergeladene Pakete.

### Erste Hilfe
Ganz oben stehen die Notrufnummern und Spickzettel für den Ernstfall mit je fünf Sofort-Schritten.\
Darunter folgt ein Kurs mit 12 Lektionen, Quiz und Fallbeispielen zum Üben.\
Er ersetzt keinen echten Erste-Hilfe-Kurs.

### Vorsorge
Checklisten zum Abhaken: Vorräte für 10 Tage (mit Vorratsrechner), Stromausfall, Aufbewahren, Dokumente und Notgepäck.\
Jedes Kapitel lässt sich ausdrucken.

## 5. Strom sparen

- Oben rechts siehst du den Akkustand.
- Strom braucht die KI vor allem, während sie antwortet: Dann rechnet der Laptop mit voller Kraft.\
  Wer Akku sparen will, stellt also lieber wenige, gezielte Fragen.
- Der **Sparmodus** schaltet die KI ganz ab und gibt den Arbeitsspeicher frei, den sie belegt.\
  Fragen an die KI gehen dann nicht, alles andere funktioniert wie gewohnt.\
  Einschalten: auf das Feld „KI bereit“ oben rechts klicken.\
  Bei wenig Akku schlägt das Programm den Sparmodus selbst vor.
- Oben rechts wechselt der Knopf mit Sonne bzw. Mond zwischen heller und dunkler Ansicht.\
  Standard ist dunkel; hell ist zum Lesen und Lernen oft angenehmer.
- Bildschirmhelligkeit herunterdrehen spart am meisten.

## 6. Inhalte aktuell halten

Im ersten Schritt des Assistenten (oder später in den Einstellungen im Kasten **Inhalte**) kannst du **Inhalte automatisch aktuell halten** einschalten.\
Dann sieht Windows einmal pro Woche nach, ob es neue Ausgaben deiner Wissenspakete, Karten oder Wegedaten gibt.\
Wähle dann:

- **Vorher fragen**\
  Ein Fenster zeigt, was es Neues gibt, und fragt, ob es geladen werden soll.
- **Automatisch herunterladen**\
  Ohne Nachfrage, aber nie über getaktete Verbindungen wie einen Handy-Hotspot.

Außerdem wählst du, ob sofort im Hintergrund geladen wird oder nur, wenn der Computer am Strom hängt und gerade nicht benutzt wird.\
Geladen wird immer mit niedrigster Priorität, damit du normal weiterarbeiten kannst.\
Ohne Automatik geht es jederzeit von Hand mit **Inhalte aktualisieren**.

## 7. Später erweitern oder ändern

- Einstellungen (Zahnrad oben rechts) → **Inhalte hinzufügen oder aktualisieren** öffnet die Seite **Inhalte**.\
  Dort hakst du an, was neu dazukommen soll (Pakete, Karten für eine Reise, ein anderes KI-Modell, Routenplanung), und klickst auf **Auswahl herunterladen**.\
  Dort kannst du Inhalte auch löschen.\
  Neue Versionen werden markiert.
- **Einrichtung neu starten** (ebenfalls in den Einstellungen) führt noch einmal durch den ganzen Assistenten, zum Beispiel um die KI oder grundlegende Einstellungen zu ändern.\
  Bereits Installiertes bleibt erhalten und ist vorausgewählt.
- **Fieldbook selbst aktualisieren**\
  In den Einstellungen im Kasten **Fieldbook-Programm** steht, ob es eine neue Programmversion gibt.\
  Ein Klick lädt sie, Fieldbook startet kurz neu.\
  Deine Inhalte und Einstellungen bleiben erhalten.\
  Fieldbook fragt beim Start kurz nach einer neuen Version; das lässt sich dort mit **Beim Start nach neuer Fieldbook-Version fragen** abschalten.\
  Ist die automatische Aktualisierung der Inhalte eingeschaltet, kann sie neue Fieldbook-Versionen mitladen (Schalter **Neue Fieldbook-Versionen bei der automatischen Aktualisierung mitladen**).

## 8. Häufige Fragen

**Die Bibliothek sagt „Paket beschädigt“**\
Eine Datei ist unvollständig oder defekt, zum Beispiel nach einem Absturz beim Download.\
Fieldbook lässt sie aus und startet die anderen Pakete trotzdem.\
Unter **Inhalte** das betroffene Paket löschen und neu herunterladen.

**Der Browser öffnet sich nicht**\
Öffne ihn selbst und gib `http://localhost:8090` ein.

**„KI-Fehler“ oben rechts**\
Meist reicht der Arbeitsspeicher nicht.\
In den Einstellungen ein kleineres Modell wählen oder andere Programme schließen.\
Details stehen in `daten\logs\ki.log`.

**Kann ich den Ordner auf einen anderen Computer kopieren?**\
Ja.\
Den ganzen Ordner kopieren und dort **Fieldbook** doppelklicken.

**Kann ich eigene Wissenspakete hinzufügen?**\
Ja.\
ZIM-Dateien von [library.kiwix.org](https://library.kiwix.org) in den Ordner `daten\wissen` legen und Fieldbook neu starten.

**Wird etwas ins Internet geschickt?**\
Deine Fragen, Chats und Einträge nicht, sie bleiben auf deinem Gerät.\
Internet braucht Fieldbook nur für Downloads und um nach einer neuen Version zu fragen.\
Fehlerberichte oder Nutzungsstatistiken verschickt Fieldbook nur, wenn du ausdrücklich zustimmst (in dieser Version gibt es das noch nicht).

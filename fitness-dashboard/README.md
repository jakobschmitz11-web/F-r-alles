# Fitness-Dashboard (Fitbit Air + Technogym → Obsidian)

Lokales Dashboard im Browser. Ohne Abhängigkeiten (nur Node ≥ 20), Daten **ausschließlich als Markdown in deinem Obsidian-Vault**.

```bash
cd fitness-dashboard
cp .env.example .env      # VAULT_PATH auf deinen Obsidian-Vault setzen
npm start                 # → http://localhost:8787
```

Beim ersten Start sieht man sofort 60 Tage **Demo-Daten** (Button „Demo-Daten löschen" im Dashboard entfernt sie wieder).

## Wie es funktioniert

```
Fitbit Air ──► Google Health API ──┐
Technogym  ──► Export-Inbox/manuell ┼──► Obsidian-Vault/Fitness/*.md ──► Dashboard (live per SSE)
                                    ┘          ▲
                                   Änderungen in Obsidian erscheinen sofort im Browser
```

* `Fitness/Daily/YYYY-MM-DD.md` – Tageswerte (Schritte, Ruhepuls, HRV, Schlafphasen, Gewicht …) als Frontmatter. Eigene Notizen unter dem Auto-Block bleiben erhalten.
* `Fitness/Workouts/*.md` – ein Workout pro Notiz (Quelle `fitbit` / `technogym`).
* `Fitness/Dashboard.md` – Dataview-Übersicht in Obsidian (Plugin *Dataview* installieren).
* Auto-Sync alle `SYNC_MINUTES` (15) + Button „Jetzt synchronisieren". Das Dashboard liest nur aus dem Vault zurück → ein einziger Speicherort.
* OAuth-Tokens liegen in `data/tokens.json` (nicht im Vault, `chmod 600`, git-ignoriert). Server hört nur auf `127.0.0.1`.

## Fitbit Air einrichten (Google Health API)

Wichtig: Die **Fitbit Web API wurde am 30.10.2026 abgeschaltet** und Google Fit ist eingestellt. Fitbit-Daten gibt es nur noch über die **Google Health API**.

1. Google Cloud Console → Projekt anlegen → *Google Health API* aktivieren.
2. OAuth-Zustimmungsbildschirm (extern, Status „Testing", dich als **Testnutzer** eintragen – so brauchst du kein Verifizierungsverfahren für den Eigengebrauch).
3. OAuth-Client „Webanwendung", Redirect-URI: `http://localhost:8787/auth/google/callback`.
4. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, neu starten, im Dashboard „Mit Google verbinden".

> ⚠️ **Nicht gegen die echte API getestet.** Die Entwicklungsumgebung hatte keinen Zugriff auf Googles Doku/API. Endpunkt-Pfade, Datentyp-Namen und Scopes sind Annahmen (siehe `connectors/googlehealth.js`, alle per Env überschreibbar: `GOOGLE_HEALTH_BASE`, `GOOGLE_HEALTH_SCOPES`, `GH_TYPE_STEPS` …). Bei HTTP-Fehlern erscheint die Meldung im Dashboard und die Roh-Antwort in `data/debug/<typ>.txt` – damit lässt sich der Connector in Minuten anpassen. Die Auswertung der Antworten ist per Unit-Test nur gegen eine *angenommene* Form geprüft.

## Technogym

Technogym/mywellness hat **keine öffentliche API für Privatkunden** (nur Enterprise/Partner-API für Studios, bzw. Aggregatoren wie Terra). Deshalb:

* **Inbox:** Exporte (`.tcx`, `.json`, `.csv`, auch deutsche Spaltennamen) in `Fitness/Inbox/` legen → automatisch importiert und nach `Verarbeitet/` verschoben.
* **Manuell:** Formular im Dashboard („Workout manuell eintragen").
* Läuft dein Technogym-Training über die Fitbit/Google-Health-Daten mit (Bluetooth/Health-Sync), erscheint es zusätzlich als Quelle `fitbit`.

## Tests

```bash
npm test     # 9 Tests: Vault-Roundtrip, Importer, Inbox, Server, Live-Events, Pfad-Sicherheit
```

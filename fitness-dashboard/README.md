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

Die **Fitbit Web API ist abgeschaltet** (laut Google-Doku: Support-Ende 30.09.2026, Abschaltung 02.11.2026) und Google Fit ist eingestellt. Fitbit-Daten – auch vom Fitbit Air – gibt es nur noch über die **Google Health API** (`health.googleapis.com/v4`).

1. Google Cloud Console → Projekt → *Google Health API* aktivieren.
2. OAuth-Zustimmungsbildschirm (extern, Status „Testing", dich als **Testnutzer** eintragen).
3. OAuth-Client „Webanwendung", Redirect-URI: `http://localhost:8787/auth/google/callback`.
4. `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, neu starten, im Dashboard „Mit Google verbinden" (Google-Konto muss mit dem Fitbit-/Google-Health-Konto verknüpft sein).

Der Connector wurde **anhand der offiziellen Doku** gebaut (Endpunkte, Filter-Syntax, `dailyRollUp`-Body, Datentyp-Namen, Scopes, Antwortformen) und gegen einen Mock-Server getestet, der genau dieses Protokoll erzwingt. Geholt werden: Schritte, Distanz, Kalorien, Aktivminuten (Tages-Rollups), Ruhepuls, HRV, Gewicht, Schlaf inkl. Phasen und Workouts. Gegen dein echtes Konto lief er mangels Zugangsdaten noch nicht – bei Fehlern erscheint die Meldung im Dashboard, die Roh-Antwort liegt in `data/debug/`.

## Technogym

* **Offizielle Enterprise-API** (`connectors/technogym.js`, laut openplatformdocs.mywellness.com): trage `TECHNOGYM_API_KEY`, `TECHNOGYM_AUTH_DOMAIN` und `TECHNOGYM_USER_ID` in `.env` ein → Workouts (Dauer, kcal, Distanz, Geräte, MOVEs) werden automatisch abgeholt. **Diese Zugangsdaten vergibt Technogym nur an Partner** (Studios/Firmen). Hast du keine, nimm einen der beiden Wege unten.
* **Inbox:** Exporte (`.tcx`, `.json`, `.csv`, auch deutsche Spaltennamen) in `Fitness/Inbox/` legen → automatisch importiert und nach `Verarbeitet/` verschoben.
* **Manuell:** Formular im Dashboard („Workout manuell eintragen").
* Läuft dein Training über Fitbit/Health-Sync mit, erscheint es zusätzlich als Quelle `fitbit`.

## Tests

```bash
npm test     # 12 Tests: Vault, Importer, Server/Live-Events, Google-Health- und Technogym-Connector gegen protokollstrenge Mocks
```

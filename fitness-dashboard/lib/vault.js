// Obsidian-Vault als einziger Datenspeicher.
//   Fitness/Daily/YYYY-MM-DD.md      -> Tageswerte als YAML-Frontmatter
//   Fitness/Workouts/<id>.md         -> ein Workout pro Notiz
//   Fitness/Dashboard.md             -> Dataview-Übersicht innerhalb von Obsidian
// Eigene Notizen unterhalb des Auto-Blocks bleiben beim Aktualisieren erhalten.
import fs from 'node:fs';
import path from 'node:path';

const MARK_START = '<!-- fitness:auto:start -->';
const MARK_END = '<!-- fitness:auto:end -->';

export const DAILY_FIELDS = [
  'steps', 'distance_km', 'calories', 'active_minutes', 'resting_hr',
  'hrv', 'sleep_min', 'sleep_deep_min', 'sleep_rem_min', 'sleep_light_min', 'weight_kg',
];
export const WORKOUT_FIELDS = [
  'date', 'start', 'source', 'type', 'duration_min', 'calories', 'distance_km', 'avg_hr', 'max_hr', 'note',
];

// ---------- Frontmatter (flaches YAML) ----------
function fmValue(v) {
  if (Array.isArray(v)) return `[${v.map((x) => JSON.stringify(String(x))).join(', ')}]`;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

export function stringifyFrontmatter(obj) {
  const lines = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v))) continue;
    lines.push(`${k}: ${fmValue(v)}`);
  }
  return `---\n${lines.join('\n')}\n---\n`;
}

function parseScalar(s) {
  s = s.trim();
  if (s === '') return '';
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('"')) { try { return JSON.parse(s); } catch { /* fallthrough */ } }
  if (s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

export function parseNote(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      fm[kv[1]] = inner ? (inner.match(/"(?:[^"\\]|\\.)*"|[^,]+/g) || []).map((x) => parseScalar(x)) : [];
    } else fm[kv[1]] = parseScalar(raw);
  }
  return { fm, body: m[2] };
}

export const safeId = (s) => String(s).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);

function atomicWrite(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file); // Obsidian sieht nie halbe Dateien
}

export class Vault {
  constructor(fitnessDir) {
    this.dir = fitnessDir;
    this.dailyDir = path.join(fitnessDir, 'Daily');
    this.workoutDir = path.join(fitnessDir, 'Workouts');
  }

  init() {
    fs.mkdirSync(this.dailyDir, { recursive: true });
    fs.mkdirSync(this.workoutDir, { recursive: true });
    const dash = path.join(this.dir, 'Dashboard.md');
    if (!fs.existsSync(dash)) atomicWrite(dash, DASHBOARD_NOTE);
    const readme = path.join(this.dir, 'Inbox', 'LIESMICH.md');
    if (!fs.existsSync(readme)) {
      atomicWrite(readme, '# Technogym-Inbox\n\nLege hier Technogym/mywellness-Exporte (`.tcx`, `.json`, `.csv`) ab. ' +
        'Das Dashboard liest sie automatisch ein und verschiebt sie nach `Verarbeitet/`.\n');
    }
  }

  dailyPath(date) { return path.join(this.dailyDir, `${date}.md`); }
  workoutPath(id) { return path.join(this.workoutDir, `${safeId(id)}.md`); }

  /** Tageswerte zusammenführen (nur übergebene Felder überschreiben). */
  upsertDaily(date, values, source) {
    if (!isDate(date)) throw new Error(`Ungültiges Datum: ${date}`);
    const file = this.dailyPath(date);
    const existing = fs.existsSync(file) ? parseNote(fs.readFileSync(file, 'utf8')) : { fm: {}, body: '' };
    const fm = { kind: 'fitness-daily', date, ...existing.fm };
    for (const k of DAILY_FIELDS) {
      const v = values[k];
      if (typeof v === 'number' && Number.isFinite(v)) fm[k] = Math.round(v * 100) / 100;
    }
    const sources = new Set(Array.isArray(fm.sources) ? fm.sources : []);
    if (source) sources.add(source);
    fm.sources = [...sources];
    const auto = `${MARK_START}\n# ${date}\n\n[[Dashboard|← Fitness-Dashboard]]\n\n\`\`\`dataview\nTABLE type AS Art, duration_min AS Min, calories AS kcal, source AS Quelle\nFROM "Fitness/Workouts"\nWHERE kind = "fitness-workout" AND date = this.date\n\`\`\`\n${MARK_END}`;
    let body = existing.body;
    if (body.includes(MARK_START) && body.includes(MARK_END)) {
      body = body.replace(new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`), auto);
    } else body = `${auto}\n${body}`;
    // Nur schreiben, wenn sich Inhalt ändert (sonst Endlosschleife mit dem Datei-Watcher)
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (before !== null && stringifyFrontmatter(fm) + body === before) return false;
    fm.updated = new Date().toISOString();
    atomicWrite(file, stringifyFrontmatter(fm) + body);
    return true;
  }

  upsertWorkout(w) {
    if (!isDate(w.date)) throw new Error(`Ungültiges Datum: ${w.date}`);
    const id = w.id || `${w.date}-${w.source || 'manual'}-${safeId(w.start || w.type || '')}`;
    const file = this.workoutPath(id);
    const fm = { kind: 'fitness-workout', id: safeId(id) };
    for (const k of WORKOUT_FIELDS) if (w[k] !== undefined && w[k] !== null && w[k] !== '') fm[k] = w[k];
    const prev = fs.existsSync(file) ? parseNote(fs.readFileSync(file, 'utf8')) : null;
    const body = prev ? prev.body : `\n# ${w.type || 'Workout'} · ${w.date}\n\n[[${w.date}]]\n`;
    const out = stringifyFrontmatter(fm) + body;
    if (prev && fs.readFileSync(file, 'utf8') === out) return false;
    atomicWrite(file, out);
    return true;
  }

  deleteBySource(source) {
    let n = 0;
    for (const dir of [this.dailyDir, this.workoutDir]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
        const full = path.join(dir, f);
        const { fm } = parseNote(fs.readFileSync(full, 'utf8'));
        const only = dir === this.dailyDir
          ? Array.isArray(fm.sources) && fm.sources.length === 1 && fm.sources[0] === source
          : fm.source === source;
        if (only) { fs.unlinkSync(full); n++; }
      }
    }
    return n;
  }

  /** Liest den gesamten Fitness-Ordner aus dem Vault (einzige Wahrheit). */
  readAll() {
    const days = new Map();
    const workouts = [];
    const read = (dir, fn) => {
      if (!fs.existsSync(dir)) return;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.md')) continue;
        try { fn(parseNote(fs.readFileSync(path.join(dir, f), 'utf8')).fm); } catch { /* defekte Notiz ignorieren */ }
      }
    };
    read(this.dailyDir, (fm) => { if (fm.kind === 'fitness-daily' && isDate(fm.date)) days.set(fm.date, fm); });
    read(this.workoutDir, (fm) => { if (fm.kind === 'fitness-workout' && isDate(fm.date)) workouts.push(fm); });
    workouts.sort((a, b) => String(b.start || b.date).localeCompare(String(a.start || a.date)));
    return { days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)), workouts };
  }
}

const DASHBOARD_NOTE = `---
kind: fitness-dashboard
---
# Fitness-Dashboard

Diese Notizen schreibt das lokale Fitness-Dashboard automatisch. Hier die Übersicht in Obsidian (Plugin **Dataview** nötig).

## Letzte 14 Tage
\`\`\`dataview
TABLE steps AS Schritte, resting_hr AS Ruhepuls, round(sleep_min/60, 1) AS Schlaf_h, active_minutes AS Aktiv_min, weight_kg AS Gewicht
FROM "Fitness/Daily"
WHERE kind = "fitness-daily"
SORT date DESC
LIMIT 14
\`\`\`

## Letzte Workouts
\`\`\`dataview
TABLE source AS Quelle, type AS Art, duration_min AS Min, calories AS kcal, avg_hr AS "Ø Puls"
FROM "Fitness/Workouts"
WHERE kind = "fitness-workout"
SORT date DESC
LIMIT 15
\`\`\`
`;

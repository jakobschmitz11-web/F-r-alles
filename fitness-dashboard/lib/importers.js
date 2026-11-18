// Technogym / mywellness: Es gibt keine öffentliche Privatkunden-API. Realistische Wege:
//  1) Export (.tcx/.json/.csv) in den Inbox-Ordner legen  -> wird automatisch eingelesen
//  2) manuell im Dashboard eintragen
import fs from 'node:fs';
import path from 'node:path';
import { isoDate } from './demo.js';

const num = (v) => {
  const n = typeof v === 'string' ? parseFloat(v.replace(',', '.')) : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

const SPORT = { Running: 'Laufband', Biking: 'Indoor Cycling', Other: 'Training', Walking: 'Gehen' };

export function parseTcx(xml, fileName = 'tcx') {
  const out = [];
  const acts = xml.match(/<Activity\b[\s\S]*?<\/Activity>/g) || [];
  acts.forEach((a, idx) => {
    const sport = (a.match(/<Activity[^>]*Sport="([^"]+)"/) || [])[1] || 'Other';
    const id = (a.match(/<Id>([^<]+)<\/Id>/) || [])[1];
    const laps = a.match(/<Lap\b[\s\S]*?<\/Lap>/g) || [];
    let secs = 0, dist = 0, cal = 0, maxHr = 0, hrW = 0, hrT = 0;
    for (const l of laps) {
      const t = num((l.match(/<TotalTimeSeconds>([^<]+)</) || [])[1]) || 0;
      secs += t; dist += num((l.match(/<DistanceMeters>([^<]+)</) || [])[1]) || 0;
      cal += num((l.match(/<Calories>([^<]+)</) || [])[1]) || 0;
      const avg = num((l.match(/<AverageHeartRateBpm[^>]*>\s*<Value>([^<]+)</) || [])[1]);
      const mx = num((l.match(/<MaximumHeartRateBpm[^>]*>\s*<Value>([^<]+)</) || [])[1]);
      if (avg) { hrW += avg * (t || 1); hrT += t || 1; }
      if (mx) maxHr = Math.max(maxHr, mx);
    }
    const start = id ? new Date(id) : new Date();
    if (Number.isNaN(start.getTime())) return;
    out.push({
      date: isoDate(start), start: start.toISOString().slice(0, 19), source: 'technogym',
      id: `technogym-${start.toISOString().replace(/\D/g, '').slice(0, 14)}-${idx}`,
      type: SPORT[sport] || sport, duration_min: Math.round(secs / 60), calories: Math.round(cal) || undefined,
      distance_km: dist ? +(dist / 1000).toFixed(2) : undefined,
      avg_hr: hrT ? Math.round(hrW / hrT) : undefined, max_hr: maxHr || undefined,
    });
  });
  return out;
}

// Toleranter Import für JSON/CSV mit deutschen/englischen Spaltennamen
const ALIASES = {
  date: ['date', 'datum', 'day', 'startdate', 'start'],
  type: ['type', 'art', 'activity', 'aktivität', 'sport', 'name', 'exercise'],
  duration_min: ['duration_min', 'duration', 'dauer', 'minutes', 'minuten', 'durationminutes'],
  calories: ['calories', 'kcal', 'kalorien', 'energy'],
  distance_km: ['distance_km', 'distance', 'distanz', 'km'],
  avg_hr: ['avg_hr', 'averagehr', 'avgheartrate', 'ø puls', 'puls', 'heartrate'],
  max_hr: ['max_hr', 'maxhr', 'maxheartrate', 'maxpuls'],
};

function normalizeRow(row) {
  const low = {};
  for (const [k, v] of Object.entries(row)) low[String(k).toLowerCase().trim()] = v;
  const pick = (names) => { for (const n of names) if (low[n] !== undefined && low[n] !== '') return low[n]; };
  const rawDate = pick(ALIASES.date);
  if (!rawDate) return null;
  let d = new Date(rawDate);
  const de = String(rawDate).match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (de) d = new Date(`${de[3]}-${de[2].padStart(2, '0')}-${de[1].padStart(2, '0')}T12:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  const date = isoDate(d);
  let dur = num(pick(ALIASES.duration_min));
  const durRaw = String(pick(ALIASES.duration_min) ?? '');
  const hms = durRaw.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (hms) dur = Number(hms[1]) * 60 + Number(hms[2]) + (hms[3] ? 0 : 0); // hh:mm
  return {
    date, start: d.toISOString().slice(0, 19), source: 'technogym', type: String(pick(ALIASES.type) || 'Training'),
    duration_min: dur !== undefined ? Math.round(dur) : undefined, calories: num(pick(ALIASES.calories)),
    distance_km: num(pick(ALIASES.distance_km)), avg_hr: num(pick(ALIASES.avg_hr)), max_hr: num(pick(ALIASES.max_hr)),
  };
}

export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ';' : ',';
  const split = (l) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
  const head = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l); const row = {};
    head.forEach((h, i) => { row[h] = cells[i]; });
    return normalizeRow(row);
  }).filter(Boolean);
}

export function parseJson(text) {
  const data = JSON.parse(text);
  const arr = Array.isArray(data) ? data : (data.workouts || data.activities || data.items || data.data || []);
  return arr.map(normalizeRow).filter(Boolean);
}

export function parseFile(name, text) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.tcx') return parseTcx(text, name);
  if (ext === '.json') return parseJson(text);
  if (ext === '.csv') return parseCsv(text);
  return [];
}

/** Liest alle Dateien im Inbox-Ordner, schreibt Workouts in den Vault und archiviert die Dateien. */
export function processInbox(inbox, vault) {
  if (!fs.existsSync(inbox)) return { files: 0, workouts: 0, errors: [] };
  const done = path.join(inbox, 'Verarbeitet');
  const res = { files: 0, workouts: 0, errors: [] };
  for (const f of fs.readdirSync(inbox)) {
    const full = path.join(inbox, f);
    if (!fs.statSync(full).isFile() || !/\.(tcx|json|csv)$/i.test(f)) continue;
    try {
      const ws = parseFile(f, fs.readFileSync(full, 'utf8'));
      ws.forEach((w, i) => {
        w.id = w.id || `technogym-${w.date}-${(w.start || '').replace(/\D/g, '').slice(8, 14) || i}-${i}`;
        vault.upsertWorkout(w);
      });
      res.workouts += ws.length; res.files++;
      fs.mkdirSync(done, { recursive: true });
      fs.renameSync(full, path.join(done, `${Date.now()}-${f}`));
    } catch (e) { res.errors.push(`${f}: ${e.message}`); }
  }
  return res;
}

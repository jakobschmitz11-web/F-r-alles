// Fitbit Air -> Google Health API (v4).
// Hintergrund: Die alte Fitbit Web API ist abgeschaltet, Google Fit ist eingestellt. Fitbit-Daten gibt es nur noch
// über die Google Health API (Google-OAuth). Alles hier folgt der offiziellen Doku (developers.google.com/health):
//   * Basis:   https://health.googleapis.com/v4/users/me/dataTypes/{kebab-case}/dataPoints
//   * Listen:  GET  ...dataPoints?filter=<snake_case>.<feld> >= "..." AND ... < "..."   (nur >=, <, AND)
//   * Tages-Aggregation: POST ...dataPoints:dailyRollUp  { range:{start,end:CivilDateTime}, windowSizeDays:1 }
//   * Scopes:  https://www.googleapis.com/auth/googlehealth.<bereich>.readonly
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE_BASE = 'https://www.googleapis.com/auth/googlehealth';
export const SCOPES = ['activity_and_fitness', 'sleep', 'health_metrics_and_measurements'].map((s) => `${SCOPE_BASE}.${s}.readonly`);

const b64u = (b) => Buffer.from(b).toString('base64url');
const pad2 = (n) => String(n).padStart(2, '0');
const int = (v) => { const n = typeof v === 'string' ? Number(v) : v; return Number.isFinite(n) ? n : undefined; };
const ymd = (d) => `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;

// ---------- Datumshilfen ----------
const isoLocalDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const civil = (s) => { const [year, month, day] = s.split('-').map(Number); return { date: { year, month, day }, time: { hours: 0, minutes: 0, seconds: 0, nanos: 0 } }; };
/** "2026-04-21T06:30:00Z" + "-14400s" -> lokales Datum/Zeit des Nutzers */
export function localParts(iso, offset) {
  const sec = typeof offset === 'string' ? parseInt(offset, 10) || 0 : 0;
  const d = new Date(Date.parse(iso) + sec * 1000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 19) };
}
const secs = (s) => (typeof s === 'string' ? parseFloat(s) : undefined);

// ---------- Welche Daten wie geholt werden ----------
// maxDays = maximale Spanne pro dailyRollUp-Anfrage laut Doku (14 Tage für total-calories/active-minutes, sonst 90)
export const ROLLUPS = [
  { type: 'steps', maxDays: 90, read: (p) => (p.steps?.countSum !== undefined ? { steps: int(p.steps.countSum) } : null) },
  { type: 'distance', maxDays: 90, read: (p) => (p.distance?.millimetersSum !== undefined ? { distance_km: int(p.distance.millimetersSum) / 1e6 } : null) },
  { type: 'total-calories', maxDays: 14, read: (p) => (p.totalCalories?.kcalSum !== undefined ? { calories: Math.round(p.totalCalories.kcalSum) } : null) },
  {
    type: 'active-minutes', maxDays: 14, // "aktiv" = moderat + intensiv (wie die frühere Fitbit-Definition)
    read: (p) => {
      const a = p.activeMinutes?.activeMinutesRollupByActivityLevel; if (!Array.isArray(a)) return null;
      return { active_minutes: a.filter((x) => x.activityLevel === 'MODERATE' || x.activityLevel === 'VIGOROUS').reduce((s, x) => s + (int(x.activeMinutesSum) || 0), 0) };
    },
  },
];

export function parseRollup(spec, json) {
  const out = {};
  for (const p of json.rollupDataPoints || []) {
    const start = p.civilStartTime?.date; if (!start) continue;
    const v = spec.read(p); if (v) out[ymd(start)] = { ...(out[ymd(start)] || {}), ...v };
  }
  return out;
}

export const LISTS = [
  { type: 'daily-resting-heart-rate', filter: (a, b) => `daily_resting_heart_rate.date >= "${a}" AND daily_resting_heart_rate.date < "${b}"` },
  { type: 'daily-heart-rate-variability', filter: (a, b) => `daily_heart_rate_variability.date >= "${a}" AND daily_heart_rate_variability.date < "${b}"` },
  { type: 'weight', filter: (a, b) => `weight.sample_time.civil_time >= "${a}" AND weight.sample_time.civil_time < "${b}"` },
  { type: 'sleep', filter: (a, b) => `sleep.interval.civil_end_time >= "${a}" AND sleep.interval.civil_end_time < "${b}"` },
  { type: 'exercise', filter: (a, b) => `exercise.interval.civil_start_time >= "${a}" AND exercise.interval.civil_start_time < "${b}"` },
];

/** Wertet Listen-Antworten aus -> { days: {datum:{feld}}, workouts: [] } */
export function parseList(type, points) {
  const days = {}; const workouts = []; const set = (d, o) => { days[d] = { ...(days[d] || {}), ...o }; };
  const sum = (d, k, v) => { if (v === undefined) return; days[d] = days[d] || {}; days[d][k] = (days[d][k] || 0) + v; };
  const weightLatest = {};
  for (const p of points) {
    switch (type) {
      case 'daily-resting-heart-rate': { const x = p.dailyRestingHeartRate; if (x?.date) set(ymd(x.date), { resting_hr: int(x.beatsPerMinute) }); break; }
      case 'daily-heart-rate-variability': { const x = p.dailyHeartRateVariability; if (x?.date && x.averageHeartRateVariabilityMilliseconds !== undefined) set(ymd(x.date), { hrv: x.averageHeartRateVariabilityMilliseconds }); break; }
      case 'weight': {
        const x = p.weight; const t = x?.sampleTime; if (!t || x.weightGrams === undefined) break;
        const d = t.civilTime?.date ? ymd(t.civilTime.date) : localParts(t.physicalTime, t.utcOffset).date;
        const stamp = t.physicalTime || d;
        if (!weightLatest[d] || stamp > weightLatest[d]) { weightLatest[d] = stamp; set(d, { weight_kg: Math.round(x.weightGrams) / 1000 }); }
        break;
      }
      case 'sleep': {
        const s = p.sleep; if (!s?.interval?.endTime) break;
        const d = localParts(s.interval.endTime, s.interval.endUtcOffset).date; // Schlaf zählt zum Aufwachtag
        const st = { LIGHT: 0, DEEP: 0, REM: 0 };
        for (const g of s.stages || []) if (g.type in st) st[g.type] += (Date.parse(g.endTime) - Date.parse(g.startTime)) / 60000;
        const stageTotal = st.LIGHT + st.DEEP + st.REM;
        const asleep = int(s.summary?.minutesAsleep) ?? (stageTotal || (Date.parse(s.interval.endTime) - Date.parse(s.interval.startTime)) / 60000);
        sum(d, 'sleep_min', Math.round(asleep));
        if (stageTotal) { sum(d, 'sleep_deep_min', Math.round(st.DEEP)); sum(d, 'sleep_rem_min', Math.round(st.REM)); sum(d, 'sleep_light_min', Math.round(st.LIGHT)); }
        break;
      }
      case 'exercise': {
        const e = p.exercise; if (!e?.interval?.startTime) break;
        const lp = localParts(e.interval.startTime, e.interval.startUtcOffset); const m = e.metricsSummary || {};
        const dur = secs(e.activeDuration) ?? (Date.parse(e.interval.endTime) - Date.parse(e.interval.startTime)) / 1000;
        workouts.push({
          id: `fitbit-${(p.name || '').split('/').pop() || e.interval.startTime.replace(/\D/g, '').slice(0, 14)}`,
          date: lp.date, start: `${lp.date}T${lp.time}`, source: 'fitbit', type: e.displayName || e.exerciseType || 'Workout',
          duration_min: Math.round(dur / 60), calories: m.caloriesKcal !== undefined ? Math.round(m.caloriesKcal) : undefined,
          distance_km: m.distanceMillimeters !== undefined ? +(m.distanceMillimeters / 1e6).toFixed(2) : undefined,
          avg_hr: int(m.averageHeartRateBeatsPerMinute),
        });
        break;
      }
      default:
    }
  }
  return { days, workouts };
}

export class GoogleHealth {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = cfg.google.base || process.env.GOOGLE_HEALTH_BASE || 'https://health.googleapis.com/v4';
    this.tokenUrl = cfg.google.tokenUrl || TOKEN_URL;
    this.tokenFile = path.join(cfg.dataDir, 'tokens.json');
    this.pending = new Map(); // state -> verifier
    this.status = { connected: false, lastSync: null, lastError: null, lastCounts: null, user: null };
    this.tokens = this.#load();
    this.status.connected = !!this.tokens?.refresh_token;
  }

  get configured() { return !!(this.cfg.google.clientId && this.cfg.google.clientSecret); }

  #load() { try { return JSON.parse(fs.readFileSync(this.tokenFile, 'utf8')); } catch { return null; } }
  #save(t) {
    fs.mkdirSync(this.cfg.dataDir, { recursive: true });
    fs.writeFileSync(this.tokenFile, JSON.stringify(t), { mode: 0o600 });
    this.tokens = t;
  }

  authUrl(redirectUri) {
    const verifier = b64u(crypto.randomBytes(32));
    const state = b64u(crypto.randomBytes(16));
    this.pending.set(state, verifier);
    setTimeout(() => this.pending.delete(state), 10 * 60_000).unref();
    const q = new URLSearchParams({
      client_id: this.cfg.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES.join(' '),
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state,
      code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    });
    return `${AUTH_URL}?${q}`;
  }

  async handleCallback(code, state, redirectUri) {
    const verifier = this.pending.get(state);
    if (!verifier) throw new Error('Ungültiger oder abgelaufener OAuth-State');
    this.pending.delete(state);
    const t = await this.#tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier });
    this.#save({ ...t, expires_at: Date.now() + t.expires_in * 1000 });
    this.status.connected = true; this.status.lastError = null;
    // Laut Doku direkt nach dem Token-Austausch: Identität abrufen und prüfen, ob das Google-Konto mit Fitbit/Google Health verknüpft ist.
    try { this.status.user = (await this.#get('/users/me/identity')).healthUserId || null; } catch (e) { this.status.lastError = e.message; }
  }

  async #tokenRequest(params) {
    const r = await fetch(this.tokenUrl, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.google.clientId, client_secret: this.cfg.google.clientSecret, ...params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google-Token: ${j.error_description || (typeof j.error === 'string' ? j.error : j.error?.message) || r.status}`);
    return j;
  }

  async #accessToken() {
    if (!this.tokens) throw new Error('Nicht verbunden');
    if (this.tokens.expires_at - 60_000 > Date.now()) return this.tokens.access_token;
    const t = await this.#tokenRequest({ grant_type: 'refresh_token', refresh_token: this.tokens.refresh_token });
    this.#save({ ...this.tokens, ...t, refresh_token: t.refresh_token || this.tokens.refresh_token, expires_at: Date.now() + t.expires_in * 1000 });
    return this.tokens.access_token;
  }

  disconnect() { try { fs.unlinkSync(this.tokenFile); } catch { /* */ } this.tokens = null; this.status.connected = false; }

  async #request(method, urlPath, body) {
    const token = await this.#accessToken();
    const url = `${this.base}${urlPath}`;
    const r = await fetch(url, {
      method, headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    if (!r.ok) {
      this.#debug(urlPath, r.status, text);
      let msg = ''; try { const e = JSON.parse(text).error; msg = e.details?.[0]?.reason || e.status || e.message; } catch { /* */ }
      const err = new Error(`${urlPath.split('?')[0].replace(/^\/users\/me\//, '')}: HTTP ${r.status}${msg ? ` ${msg}` : ''}`); err.status = r.status; throw err;
    }
    return text ? JSON.parse(text) : {};
  }
  #get(p) { return this.#request('GET', p); }

  async #list(type, filter) {
    const points = []; let pageToken;
    do {
      const q = new URLSearchParams({ page_size: '100', filter }); if (pageToken) q.set('page_token', pageToken);
      const j = await this.#get(`/users/me/dataTypes/${type}/dataPoints?${q}`);
      points.push(...(j.dataPoints || [])); pageToken = j.nextPageToken || undefined;
    } while (pageToken);
    return points;
  }

  async #rollup(spec, from, to) { // [from, to) in Chunks, die das Spannen-Limit der Doku einhalten
    const merged = {};
    for (let a = from; a < to;) {
      const b = addDays(a, spec.maxDays) < to ? addDays(a, spec.maxDays) : to;
      const j = await this.#request('POST', `/users/me/dataTypes/${spec.type}/dataPoints:dailyRollUp`, { range: { start: civil(a), end: civil(b) }, windowSizeDays: 1 });
      const part = parseRollup(spec, j);
      for (const [d, v] of Object.entries(part)) merged[d] = { ...(merged[d] || {}), ...v };
      a = b;
    }
    return merged;
  }

  #debug(urlPath, status, body) {
    try {
      const dir = path.join(this.cfg.dataDir, 'debug'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${urlPath.split('?')[0].replace(/\W+/g, '_')}.txt`), `${new Date().toISOString()}\n${urlPath}\nHTTP ${status}\n${body.slice(0, 4000)}\n`);
    } catch { /* */ }
  }

  /** Holt die letzten N Tage (inkl. heute) und schreibt sie in den Vault. */
  async sync(vault, days = 7, now = new Date()) {
    if (!this.status.connected) return null;
    const to = addDays(isoLocalDate(now), 1); const from = addDays(to, -(days + 1));
    const counts = { days: 0, workouts: 0 }; const errors = []; const merged = {};
    const take = (d) => { for (const [k, v] of Object.entries(d)) merged[k] = { ...(merged[k] || {}), ...v }; };
    const tasks = [
      ...ROLLUPS.map((s) => async () => take(await this.#rollup(s, from, to))),
      ...LISTS.map((s) => async () => {
        const r = parseList(s.type, await this.#list(s.type, s.filter(from, to)));
        take(r.days); for (const w of r.workouts) { vault.upsertWorkout(w); counts.workouts++; }
      }),
    ];
    for (const t of tasks) {
      try { await t(); } catch (e) {
        errors.push(e.message);
        if (e.status === 401) { this.status.connected = false; break; }
      }
    }
    for (const [date, vals] of Object.entries(merged)) { vault.upsertDaily(date, vals, 'fitbit'); counts.days++; }
    this.status.lastSync = new Date().toISOString(); this.status.lastCounts = counts;
    this.status.lastError = errors.length ? errors.join(' · ') : null;
    return { counts, errors };
  }
}

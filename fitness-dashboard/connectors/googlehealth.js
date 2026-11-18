// Fitbit Air -> Google Health API.
// Hintergrund: Die alte Fitbit Web API wurde am 30.10.2026 abgeschaltet, Google Fit ebenfalls eingestellt.
// Fitbit-Daten gibt es nur noch über die Google Health API (Google-OAuth, Scopes sind "restricted").
//
// ACHTUNG: Entwickelt ohne Zugriff auf die Live-API/Doku (Sandbox ohne Internet zu Google).
// Pfade/Feldnamen sind per Umgebungsvariable überschreibbar und die Roh-Antworten landen bei
// Fehlern in data/debug/, damit man sie schnell anpassen kann. Siehe README "Verbindung testen".
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isoDate } from '../lib/demo.js';

const BASE = process.env.GOOGLE_HEALTH_BASE || 'https://health.googleapis.com/v4';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE_BASE = 'https://www.googleapis.com/auth/googlehealth';
const SCOPES = (process.env.GOOGLE_HEALTH_SCOPES ||
  ['activity_and_fitness', 'sleep', 'health_metrics_and_measurements'].map((s) => `${SCOPE_BASE}.${s}.readonly`).join(' '));

// datentyp -> wie er in Tageswerte übersetzt wird
const TYPES = {
  steps: process.env.GH_TYPE_STEPS || 'steps',
  restingHr: process.env.GH_TYPE_RHR || 'daily-resting-heart-rate',
  hrv: process.env.GH_TYPE_HRV || 'daily-heart-rate-variability',
  sleep: process.env.GH_TYPE_SLEEP || 'sleep',
  weight: process.env.GH_TYPE_WEIGHT || 'weight',
  exercise: process.env.GH_TYPE_EXERCISE || 'exercise',
  activeMinutes: process.env.GH_TYPE_ACTIVE || 'active-minutes',
  calories: process.env.GH_TYPE_CALORIES || 'total-calories',
  distance: process.env.GH_TYPE_DISTANCE || 'distance',
};

const b64u = (b) => Buffer.from(b).toString('base64url');

// ---- generische Auswertung einer Antwort: dataPoints -> flache Zahlenwerte + Zeit ----
function flatten(obj, prefix = '', out = {}) {
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (obj !== undefined && obj !== null) out[prefix] = obj;
  return out;
}
const toNum = (v) => (typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v)) ? Number(v) : undefined));
const pickNum = (flat, re) => {
  for (const [k, v] of Object.entries(flat)) if (re.test(k)) { const n = toNum(v); if (n !== undefined) return n; }
};
const pickTime = (flat, re = /(start.?time|civil.?start|time|date)$/i) => {
  for (const [k, v] of Object.entries(flat)) if (re.test(k) && typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v;
};
const dayOf = (t) => (t.length === 10 ? t : isoDate(new Date(t)));

export function summarize(type, points) {
  // -> { 'YYYY-MM-DD': {field: value} } sowie workouts[]
  const days = {}; const workouts = []; const add = (d, k, v, mode = 'sum') => {
    if (v === undefined || !d) return; const o = (days[d] ||= {});
    o[k] = mode === 'sum' ? (o[k] || 0) + v : v;
  };
  for (const p of points) {
    const f = flatten(p); const t = pickTime(f); if (!t) continue; const d = dayOf(t);
    switch (type) {
      case 'steps': add(d, 'steps', pickNum(f, /(count|steps)$/i)); break;
      case 'restingHr': add(d, 'resting_hr', pickNum(f, /(beats.?per.?minute|bpm|value)$/i), 'last'); break;
      case 'hrv': add(d, 'hrv', pickNum(f, /(rmssd|milliseconds|value)$/i), 'last'); break;
      case 'weight': { const g = pickNum(f, /grams$/i); const kg = g !== undefined ? g / 1000 : pickNum(f, /(kilograms|kg|value)$/i); add(d, 'weight_kg', kg, 'last'); break; }
      case 'activeMinutes': add(d, 'active_minutes', pickNum(f, /(minutes|value|count)$/i)); break;
      case 'calories': add(d, 'calories', pickNum(f, /(kcal|calories|value)$/i)); break;
      case 'distance': { const m = pickNum(f, /(meters|distance)$/i); add(d, 'distance_km', m !== undefined ? m / 1000 : undefined); break; }
      case 'sleep': {
        const end = pickTime(f, /(end.?time|civil.?end)$/i);
        const mins = end ? (new Date(end) - new Date(t)) / 60000 : pickNum(f, /minutes.?asleep$/i);
        const dd = end ? dayOf(end) : d; // Schlaf zählt zum Aufwachtag
        add(dd, 'sleep_min', mins);
        add(dd, 'sleep_deep_min', pickNum(f, /deep.*(minutes|min)$/i));
        add(dd, 'sleep_rem_min', pickNum(f, /rem.*(minutes|min)$/i));
        add(dd, 'sleep_light_min', pickNum(f, /light.*(minutes|min)$/i));
        break;
      }
      case 'exercise': {
        const end = pickTime(f, /(end.?time|civil.?end)$/i);
        const dur = end ? (new Date(end) - new Date(t)) / 60000 : pickNum(f, /(duration|minutes)$/i);
        const name = Object.entries(f).find(([k]) => /(exercise.?type|activity.?type|display.?name|name)$/i.test(k));
        workouts.push({
          id: `fitbit-${t.replace(/\D/g, '').slice(0, 14)}`, date: d, start: t.slice(0, 19), source: 'fitbit',
          type: name ? String(name[1]) : 'Workout', duration_min: dur !== undefined ? Math.round(dur) : undefined,
          calories: pickNum(f, /(calories|kcal)$/i), distance_km: (() => { const m = pickNum(f, /(distance.*meters|meters)$/i); return m !== undefined ? +(m / 1000).toFixed(2) : undefined; })(),
          avg_hr: pickNum(f, /(avg|average).*(heart|hr|bpm)/i), max_hr: pickNum(f, /(max|maximum).*(heart|hr|bpm)/i),
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
    this.tokenFile = path.join(cfg.dataDir, 'tokens.json');
    this.pending = new Map(); // state -> verifier
    this.status = { connected: false, lastSync: null, lastError: null, lastCounts: null };
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
      client_id: this.cfg.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES,
      access_type: 'offline', prompt: 'consent', state,
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
  }

  async #tokenRequest(params) {
    const r = await fetch(TOKEN_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.cfg.google.clientId, client_secret: this.cfg.google.clientSecret, ...params }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Google-Token: ${j.error_description || j.error || r.status}`);
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

  async #getPoints(type, from, to) {
    const token = await this.#accessToken();
    const points = []; let pageToken;
    do {
      const q = new URLSearchParams({ pageSize: '1000' });
      q.set('filter', `interval.start_time >= "${from.toISOString()}" AND interval.start_time < "${to.toISOString()}"`);
      if (pageToken) q.set('pageToken', pageToken);
      const url = `${BASE}/users/me/dataTypes/${TYPES[type]}/dataPoints?${q}`;
      const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      const text = await r.text();
      if (!r.ok) {
        this.#debug(type, url, r.status, text);
        const e = new Error(`${TYPES[type]}: HTTP ${r.status}`); e.status = r.status; throw e;
      }
      const j = JSON.parse(text);
      points.push(...(j.dataPoints || j.points || []));
      pageToken = j.nextPageToken;
    } while (pageToken);
    return points;
  }

  #debug(type, url, status, body) {
    try {
      const dir = path.join(this.cfg.dataDir, 'debug'); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${type}.txt`), `${new Date().toISOString()}\n${url}\nHTTP ${status}\n${body.slice(0, 4000)}\n`);
    } catch { /* */ }
  }

  /** Holt die letzten N Tage und schreibt sie in den Vault. */
  async sync(vault, days = 7) {
    if (!this.status.connected) return null;
    const to = new Date(Date.now() + 86_400_000); const from = new Date(Date.now() - days * 86_400_000);
    const counts = { days: 0, workouts: 0 }; const errors = []; const merged = {};
    for (const type of Object.keys(TYPES)) {
      try {
        const { days: d, workouts } = summarize(type, await this.#getPoints(type, from, to));
        for (const [date, vals] of Object.entries(d)) Object.assign((merged[date] ||= {}), vals);
        for (const w of workouts) { vault.upsertWorkout(w); counts.workouts++; }
      } catch (e) { errors.push(e.message); if (e.status === 401) { this.status.connected = false; break; } }
    }
    for (const [date, vals] of Object.entries(merged)) { vault.upsertDaily(date, vals, 'fitbit'); counts.days++; }
    this.status.lastSync = new Date().toISOString(); this.status.lastCounts = counts;
    this.status.lastError = errors.length ? errors.join(' · ') : null;
    return { counts, errors };
  }
}

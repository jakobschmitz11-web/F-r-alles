// Technogym mywellness – offizielle "Enterprise API" (Server-to-Server), laut openplatformdocs.mywellness.com:
//   Basis:   https://enterprise.mywellness.com/api   (Testumgebung: https://enterprise-test.mywellness.com)
//   Header:  x-openplatform-apikey, x-openplatform-authdomain  (beides vergibt Technogym an Partner)
//   Liste:   GET /v1/backend/user/{userId}/workout-sessions?from=YYYYMMDD&to=YYYYMMDD
//   Detail:  GET /v1/backend/user/{userId}/workout-sessions/{sessionId}
// Zugangsdaten gibt es nur über Technogym/dein Studio – ohne sie bleibt der Datei-Import (Inbox).
import { isoDate } from '../lib/demo.js';

const compact = (d) => d.replaceAll('-', '');
const num = (v) => { const n = typeof v === 'string' ? parseFloat(v) : v; return Number.isFinite(n) ? n : undefined; };

export function parseSession(list, detail) {
  const start = new Date(list.startedOn);
  const date = list.partitionDate ? String(list.partitionDate).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3') : isoDate(start);
  const exs = detail?.exercises || [];
  const prop = (ex, name) => num((ex.doneProperties || []).find((p) => p.physicalProperty === name)?.rawValue);
  const meters = exs.reduce((s, ex) => s + (prop(ex, 'HDistance') || 0), 0);
  const hrs = exs.map((ex) => (ex.doneProperties || []).find((p) => /HeartRate/i.test(p.physicalProperty) && /avg|average|mean/i.test(p.physicalProperty + p.displayName))).filter(Boolean).map((p) => num(p.rawValue)).filter(Boolean);
  const equipment = [...new Set(exs.map((e) => e.equipmentName).filter(Boolean))];
  return {
    id: `technogym-${list.id}`, date, start: start.toISOString().slice(0, 19), source: 'technogym',
    type: equipment.length ? equipment.slice(0, 2).join(' + ') : (list.title || 'Training'),
    duration_min: num(list.duration) !== undefined ? Math.round(list.duration / 60) : undefined,
    calories: num(list.calories), distance_km: meters ? +(meters / 1000).toFixed(2) : undefined,
    avg_hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : undefined,
    note: num(list.move) !== undefined ? `${list.move} MOVEs` : undefined,
  };
}

export class Technogym {
  constructor(cfg) {
    this.t = cfg.technogym;
    this.status = { connected: false, lastSync: null, lastError: null, lastCount: null };
    this.status.connected = this.configured;
  }
  get configured() { return !!(this.t.apiKey && this.t.authDomain && this.t.userId); }

  async #get(path) {
    const r = await fetch(`${this.t.baseUrl}${path}`, {
      headers: { 'x-openplatform-apikey': this.t.apiKey, 'x-openplatform-authdomain': this.t.authDomain, accept: 'application/json', 'accept-language': 'de' },
    });
    if (!r.ok) throw new Error(`Technogym ${path.split('?')[0]}: HTTP ${r.status}`);
    return r.json();
  }

  async sync(vault, days = 30, now = new Date()) {
    if (!this.configured) return null;
    try {
      const to = new Date(now); const from = new Date(now); from.setDate(from.getDate() - days);
      const list = await this.#get(`/v1/backend/user/${encodeURIComponent(this.t.userId)}/workout-sessions?from=${compact(isoDate(from))}&to=${compact(isoDate(to))}`);
      let n = 0;
      for (const s of Array.isArray(list) ? list : []) {
        let detail = null;
        try { detail = await this.#get(`/v1/backend/user/${encodeURIComponent(this.t.userId)}/workout-sessions/${encodeURIComponent(s.id)}`); } catch { /* Liste reicht als Fallback */ }
        vault.upsertWorkout(parseSession(s, detail)); n++;
      }
      this.status.lastSync = new Date().toISOString(); this.status.lastCount = n; this.status.lastError = null;
      return { count: n };
    } catch (e) { this.status.lastError = e.message; return { count: 0, error: e.message }; }
  }
}

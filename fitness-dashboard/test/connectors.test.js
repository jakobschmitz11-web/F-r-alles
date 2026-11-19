// Prüft die Connectors gegen Mock-Server, die das in der Google-Health-/Technogym-Doku beschriebene Protokoll strikt erzwingen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Vault } from '../lib/vault.js';
import { GoogleHealth, parseList, parseRollup, ROLLUPS, localParts } from '../connectors/googlehealth.js';
import { Technogym, parseSession } from '../connectors/technogym.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fitc-'));
const listen = (handler) => new Promise((res) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res({ s, url: `http://127.0.0.1:${s.address().port}` })); });
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

// ---- Strenger Filter-Validator nach Doku ("Filter data") ----
function validateFilter(type, f) {
  const snake = type.replaceAll('-', '_');
  const parts = f.split(' AND ');
  const kinds = new Set();
  for (const p of parts) {
    const m = p.match(/^([a-z_]+(?:\.[a-z_]+)+) (>=|<) "([^"]+)"$/);
    if (!m) throw new Error(`INVALID_DATA_POINT_FILTER: ${p}`);
    if (!m[1].startsWith(`${snake}.`)) throw new Error('INVALID_DATA_POINT_FILTER_COLLECTION_MISMATCH');
    const physical = /Z$|[+-]\d\d:\d\d$/.test(m[3]);
    kinds.add(physical ? 'physical' : 'civil');
    if (!physical && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?$/.test(m[3])) throw new Error('bad civil literal');
  }
  if (kinds.size > 1) throw new Error('INVALID_DATA_POINT_FILTER_MIXED_TIME_RESTRICTIONS');
  return parts.map((p) => p.match(/"([^"]+)"/)[1]);
}

const D = (s) => { const [year, month, day] = s.split('-').map(Number); return { year, month, day }; };

async function mockGoogle() {
  const seen = [];
  const { s, url } = await listen(async (req, res) => {
    const u = new URL(req.url, 'http://x'); const body = await readBody(req);
    seen.push(`${req.method} ${u.pathname}`);
    if (u.pathname === '/token') {
      const f = new URLSearchParams(body); assert.equal(req.method, 'POST'); assert.equal(f.get('grant_type'), 'authorization_code'); assert.ok(f.get('code_verifier'));
      return send(res, 200, { access_token: 'ACCESS', refresh_token: 'REFRESH', expires_in: 3600 });
    }
    if (req.headers.authorization !== 'Bearer ACCESS') return send(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    if (u.pathname === '/v4/users/me/identity') return send(res, 200, { name: 'users/me/identity', legacyUserId: 'A1B2C3', healthUserId: '111111256096816351' });
    const m = u.pathname.match(/^\/v4\/users\/me\/dataTypes\/([a-z-]+)\/dataPoints(:dailyRollUp)?$/);
    if (!m) return send(res, 404, {});
    const [, type, roll] = m;
    try {
      if (roll) {
        assert.equal(req.method, 'POST');
        const b = JSON.parse(body); assert.equal(b.windowSizeDays, 1);
        const a = b.range.start, z = b.range.end; assert.deepEqual(a.time, { hours: 0, minutes: 0, seconds: 0, nanos: 0 });
        const d0 = Date.UTC(a.date.year, a.date.month - 1, a.date.day), d1 = Date.UTC(z.date.year, z.date.month - 1, z.date.day);
        const span = (d1 - d0) / 86400000; const max = ROLLUPS.find((r) => r.type === type).maxDays;
        assert.ok(span > 0 && span <= max, `Spanne ${span} > ${max} für ${type}`);
        const day = `${a.date.year}-${String(a.date.month).padStart(2, '0')}-${String(a.date.day).padStart(2, '0')}`;
        const val = { steps: { countSum: '3822' }, distance: { millimetersSum: '2800000' }, 'total-calories': { kcalSum: 2350.4 },
          'active-minutes': { activeMinutesRollupByActivityLevel: [{ activityLevel: 'LIGHT', activeMinutesSum: '90' }, { activityLevel: 'MODERATE', activeMinutesSum: '20' }, { activityLevel: 'VIGOROUS', activeMinutesSum: '10' }] } }[type];
        const k = { steps: 'steps', distance: 'distance', 'total-calories': 'totalCalories', 'active-minutes': 'activeMinutes' }[type];
        return send(res, 200, { rollupDataPoints: [{ civilStartTime: { date: D(day), time: {} }, civilEndTime: { date: D(day), time: {} }, [k]: val }] });
      }
      assert.equal(req.method, 'GET');
      assert.equal(u.searchParams.get('page_size'), '100');
      const [from] = validateFilter(type, u.searchParams.get('filter'));
      const date = from.slice(0, 10); const iso = `${date}T`; const nx = new Date(Date.parse(`${date}T12:00:00Z`) + 864e5).toISOString().slice(0, 10) + 'T';
      const pts = {
        'daily-resting-heart-rate': [{ dailyRestingHeartRate: { date: D(date), beatsPerMinute: '54' } }],
        'daily-heart-rate-variability': [{ dailyHeartRateVariability: { date: D(date), averageHeartRateVariabilityMilliseconds: 48.5 } }],
        weight: [{ weight: { sampleTime: { physicalTime: `${iso}07:00:00Z`, utcOffset: '0s', civilTime: { date: D(date) } }, weightGrams: 81400 } }],
        sleep: [{ name: 'users/1/dataTypes/sleep/dataPoints/9', sleep: { interval: { startTime: `${iso}22:30:00Z`, startUtcOffset: '3600s', endTime: `${nx}06:30:00Z`, endUtcOffset: '3600s' }, type: 'STAGES',
          stages: [{ startTime: `${iso}22:30:00Z`, endTime: `${iso}23:45:00Z`, type: 'LIGHT' }, { startTime: `${iso}23:45:00Z`, endTime: `${nx}01:15:00Z`, type: 'DEEP' }, { startTime: `${nx}01:15:00Z`, endTime: `${nx}02:15:00Z`, type: 'REM' }], summary: { minutesAsleep: '455' } } }],
        exercise: [{ name: 'users/1/dataTypes/exercise/dataPoints/777', exercise: { interval: { startTime: `${iso}08:00:00Z`, startUtcOffset: '3600s', endTime: `${iso}08:35:00Z`, endUtcOffset: '3600s' }, exerciseType: 'RUNNING', displayName: 'Run', activeDuration: '1800s', metricsSummary: { caloriesKcal: 380, distanceMillimeters: 5000000, averageHeartRateBeatsPerMinute: '148' } } }],
      }[type];
      assert.ok(pts, `unerwarteter Datentyp ${type}`);
      send(res, 200, { dataPoints: pts, nextPageToken: '' });
    } catch (e) { send(res, 400, { error: { code: 400, message: e.message, status: 'INVALID_ARGUMENT' } }); }
  });
  return { s, url, seen };
}

test('parseList/parseRollup mit den Beispielformen aus der Doku', () => {
  assert.deepEqual(localParts('2026-04-21T06:30:00Z', '-14400s'), { date: '2026-04-21', time: '02:30:00' });
  const r = parseRollup(ROLLUPS[0], { rollupDataPoints: [{ civilStartTime: { date: { year: 2026, month: 2, day: 26 }, time: {} }, steps: { countSum: '3822' } }] });
  assert.deepEqual(r, { '2026-02-26': { steps: 3822 } });
  const ex = parseList('exercise', [{ name: 'users/1/dataTypes/exercise/dataPoints/3054085373369111216', exercise: { interval: { startTime: '2026-04-20T08:00:00Z', startUtcOffset: '0s', endTime: '2026-04-20T08:35:00Z' }, exerciseType: 'RUNNING', displayName: 'Run', activeDuration: '1800s', metricsSummary: { caloriesKcal: 380, distanceMillimeters: 5000000, averageHeartRateBeatsPerMinute: '148' } } }]).workouts[0];
  assert.equal(ex.duration_min, 30); assert.equal(ex.distance_km, 5); assert.equal(ex.avg_hr, 148); assert.equal(ex.type, 'Run'); assert.equal(ex.id, 'fitbit-3054085373369111216');
  const sl = parseList('sleep', [{ sleep: { interval: { startTime: '2026-04-20T22:30:00Z', startUtcOffset: '-14400s', endTime: '2026-04-21T06:30:00Z', endUtcOffset: '-14400s' }, stages: [{ startTime: '2026-04-20T22:30:00Z', endTime: '2026-04-20T23:45:00Z', type: 'LIGHT' }, { startTime: '2026-04-20T23:45:00Z', endTime: '2026-04-21T01:15:00Z', type: 'DEEP' }], summary: { minutesAsleep: '455' } } }]).days;
  assert.deepEqual(sl['2026-04-21'], { sleep_min: 455, sleep_deep_min: 90, sleep_rem_min: 0, sleep_light_min: 75 });
});

test('Google Health: OAuth + kompletter Sync gegen protokollstrengen Mock', async () => {
  const g = await mockGoogle(); const root = tmp();
  const cfg = { dataDir: path.join(root, 'data'), google: { clientId: 'cid', clientSecret: 'sec', base: `${g.url}/v4`, tokenUrl: `${g.url}/token` } };
  const gh = new GoogleHealth(cfg);
  const u = new URL(gh.authUrl('http://localhost:8787/auth/google/callback'));
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  const scopes = u.searchParams.get('scope').split(' ');
  assert.ok(scopes.includes('https://www.googleapis.com/auth/googlehealth.sleep.readonly'));
  await gh.handleCallback('CODE', u.searchParams.get('state'), 'http://localhost:8787/auth/google/callback');
  assert.equal(gh.status.connected, true); assert.equal(gh.status.user, '111111256096816351');
  assert.equal((fs.statSync(path.join(cfg.dataDir, 'tokens.json')).mode & 0o777), 0o600);

  const v = new Vault(path.join(root, 'Fitness')); v.init();
  const r = await gh.sync(v, 40, new Date('2026-11-18T12:00:00'));
  assert.deepEqual(r.errors, [], r.errors.join('\n'));
  const all = v.readAll();
  assert.ok(all.days.length >= 1);
  const day = all.days.find((d) => d.steps === 3822 && d.resting_hr === 54);
  assert.ok(day, 'Tageswerte aus Rollups + Listen zusammengeführt');
  assert.equal(day.distance_km, 2.8); assert.equal(day.calories, 2350); assert.equal(day.active_minutes, 30); assert.equal(day.hrv, 48.5);
  assert.equal(day.weight_kg, 81.4); assert.deepEqual(day.sources, ['fitbit']);
  const sleepDay = all.days.find((d) => d.sleep_min === 455); assert.ok(sleepDay); assert.equal(sleepDay.sleep_deep_min, 90); assert.equal(sleepDay.sleep_rem_min, 60); assert.equal(sleepDay.sleep_light_min, 75);
  assert.equal(all.workouts[0].source, 'fitbit'); assert.equal(all.workouts[0].duration_min, 30);
  assert.ok(g.seen.filter((x) => x.includes('dailyRollUp')).length >= 5, 'Rollup-Chunks (14-Tage-Limit) wurden gesplittet');
  g.s.close();
});

test('Google Health: 401 trennt, Fehler werden gemeldet statt zu crashen', async () => {
  const { s, url } = await listen((req, res) => send(res, 401, { error: { code: 401, status: 'UNAUTHENTICATED' } }));
  const root = tmp(); fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data', 'tokens.json'), JSON.stringify({ access_token: 'x', refresh_token: 'r', expires_at: Date.now() + 1e7 }));
  const gh = new GoogleHealth({ dataDir: path.join(root, 'data'), google: { clientId: 'c', clientSecret: 's', base: `${url}/v4` } });
  const v = new Vault(path.join(root, 'F')); v.init();
  const r = await gh.sync(v, 3);
  assert.equal(gh.status.connected, false); assert.match(r.errors[0], /401/);
  s.close();
});

test('Technogym Enterprise-API: Header, Liste + Detail -> Workout-Notiz', async () => {
  const seen = [];
  const { s, url } = await listen((req, res) => {
    seen.push(req.url);
    if (req.headers['x-openplatform-apikey'] !== 'KEY' || req.headers['x-openplatform-authdomain'] !== 'com.dom') return send(res, 401, {});
    if (req.url.startsWith('/v1/backend/user/u-1/workout-sessions?')) { assert.match(req.url, /from=\d{8}&to=\d{8}/); return send(res, 200, [{ id: '1', title: 'Workout 1', startedOn: '2025-06-05T12:25:50.612+00:00', closedOn: '2025-06-05T12:26:03.317+00:00', partitionDate: 20250605, calories: 241, move: 420, duration: 1680, totalExeDone: 4 }]); }
    if (req.url === '/v1/backend/user/u-1/workout-sessions/1') return send(res, 200, { id: '1', exercises: [{ position: 1, equipmentName: 'Run', doneProperties: [{ physicalProperty: 'HDistance', rawValue: '1016.666667' }, { physicalProperty: 'Calories', rawValue: '90.85' }] }, { position: 2, equipmentName: 'Cross', doneProperties: [{ physicalProperty: 'HDistance', rawValue: '500' }] }] });
    send(res, 404, {});
  });
  const root = tmp(); const v = new Vault(path.join(root, 'F')); v.init();
  const t = new Technogym({ technogym: { apiKey: 'KEY', authDomain: 'com.dom', userId: 'u-1', baseUrl: url } });
  assert.equal(t.configured, true);
  const r = await t.sync(v, 30); assert.equal(r.count, 1);
  const w = v.readAll().workouts[0];
  assert.equal(w.source, 'technogym'); assert.equal(w.date, '2025-06-05'); assert.equal(w.duration_min, 28); assert.equal(w.calories, 241);
  assert.equal(w.distance_km, 1.52); assert.equal(w.type, 'Run + Cross'); assert.equal(w.note, '420 MOVEs');
  // falsche Zugangsdaten -> Fehler wird gemeldet
  const bad = new Technogym({ technogym: { apiKey: 'NOPE', authDomain: 'x', userId: 'u-1', baseUrl: url } });
  const rb = await bad.sync(v); assert.match(rb.error, /401/); assert.match(bad.status.lastError, /401/);
  assert.equal(new Technogym({ technogym: { apiKey: '', authDomain: '', userId: '', baseUrl: url } }).configured, false);
  assert.equal(parseSession({ id: '9', startedOn: '2025-06-05T12:00:00Z', duration: 600 }, null).type, 'Training');
  s.close();
});

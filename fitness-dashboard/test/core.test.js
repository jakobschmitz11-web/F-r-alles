import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vault, parseNote, stringifyFrontmatter } from '../lib/vault.js';
import { parseTcx, parseCsv, parseJson, processInbox } from '../lib/importers.js';
import { writeDemo } from '../lib/demo.js';
import { parseList, parseRollup, ROLLUPS } from '../connectors/googlehealth.js';
import http from 'node:http';
import { createApp } from '../server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fit-'));

test('Frontmatter Roundtrip', () => {
  const fm = { type: 'x', n: 12.5, s: 'a "b": c', list: ['a', 'b c'] };
  assert.deepEqual(parseNote(stringifyFrontmatter(fm) + 'body').fm, fm);
});

test('Daily-Upsert merged Quellen, behält eigene Notizen, ist idempotent', () => {
  const v = new Vault(path.join(tmp(), 'Fitness')); v.init();
  assert.equal(v.upsertDaily('2026-11-01', { steps: 1000 }, 'fitbit'), true);
  const f = v.dailyPath('2026-11-01');
  fs.appendFileSync(f, '\nMeine eigene Notiz\n');
  assert.equal(v.upsertDaily('2026-11-01', { weight_kg: 80 }, 'manual'), true);
  assert.equal(v.upsertDaily('2026-11-01', { weight_kg: 80 }, 'manual'), false, 'unverändert -> kein Schreiben');
  const txt = fs.readFileSync(f, 'utf8');
  assert.match(txt, /Meine eigene Notiz/);
  const day = v.readAll().days[0];
  assert.equal(day.steps, 1000); assert.equal(day.weight_kg, 80); assert.deepEqual(day.sources, ['fitbit', 'manual']);
  assert.throws(() => v.upsertDaily('../../evil', {}, 'x'));
});

test('Workout-IDs können nicht aus dem Ordner ausbrechen', () => {
  const v = new Vault(path.join(tmp(), 'Fitness')); v.init();
  v.upsertWorkout({ id: '../../../etc/passwd', date: '2026-11-01', source: 'technogym', type: 'x', duration_min: 5 });
  assert.equal(v.readAll().workouts.length, 1);
  assert.ok(v.workoutPath('../../x').startsWith(v.workoutDir));
});

test('TCX-Import', () => {
  const xml = `<TrainingCenterDatabase><Activities><Activity Sport="Running"><Id>2026-11-10T17:30:00Z</Id>
  <Lap StartTime="x"><TotalTimeSeconds>1800</TotalTimeSeconds><DistanceMeters>5000</DistanceMeters><Calories>320</Calories>
  <AverageHeartRateBpm><Value>140</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>172</Value></MaximumHeartRateBpm></Lap></Activity></Activities></TrainingCenterDatabase>`;
  const [w] = parseTcx(xml);
  assert.equal(w.type, 'Laufband'); assert.equal(w.duration_min, 30); assert.equal(w.distance_km, 5); assert.equal(w.avg_hr, 140); assert.equal(w.max_hr, 172);
});

test('CSV (deutsch, Semikolon) & JSON-Import', () => {
  const [a] = parseCsv('Datum;Aktivität;Dauer;Kalorien\n05.11.2026;Crosstrainer;45;410\n');
  assert.equal(a.date, '2026-11-05'); assert.equal(a.type, 'Crosstrainer'); assert.equal(a.duration_min, 45); assert.equal(a.calories, 410);
  const [b] = parseJson(JSON.stringify({ workouts: [{ date: '2026-11-06', type: 'Rudern', duration: 20 }] }));
  assert.equal(b.duration_min, 20);
});

test('Inbox verarbeitet Dateien und archiviert sie', () => {
  const root = tmp(); const v = new Vault(path.join(root, 'Fitness')); v.init();
  const inbox = path.join(root, 'in'); fs.mkdirSync(inbox);
  fs.writeFileSync(path.join(inbox, 'a.csv'), 'date,type,duration\n2026-11-02,Bike,30\n');
  fs.writeFileSync(path.join(inbox, 'kaputt.json'), '{nope');
  const r = processInbox(inbox, v);
  assert.equal(r.files, 1); assert.equal(r.workouts, 1); assert.equal(r.errors.length, 1);
  assert.ok(fs.existsSync(path.join(inbox, 'Verarbeitet')));
  assert.equal(v.readAll().workouts[0].source, 'technogym');
});

test('Demo-Daten schreiben & löschen', () => {
  const v = new Vault(path.join(tmp(), 'Fitness')); v.init();
  writeDemo(v, 20);
  assert.equal(v.readAll().days.length, 20);
  assert.ok(v.deleteBySource('demo') >= 20);
  assert.equal(v.readAll().days.length, 0);
});

test('Server: API, Host-Schutz, manuelles Workout, Live-Event', async () => {
  const root = tmp();
  const cfg = { port: 0, syncMinutes: 999, demo: true, vault: root, fitnessDir: path.join(root, 'Fitness'), inbox: path.join(root, 'Fitness', 'Inbox'), dataDir: path.join(root, 'data'), google: { clientId: '', clientSecret: '' }, technogym: { apiKey: '', authDomain: '', userId: '', baseUrl: '' } };
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const d = await (await fetch(`${base}/api/data`)).json();
  assert.equal(d.days.length, 60); assert.equal(d.status.hasDemo, true);
  const rawStatus = (port, hostHdr) => new Promise((res) => http.get({ host: '127.0.0.1', port, path: '/api/data', headers: { host: hostHdr } }, (r) => { r.resume(); res(r.statusCode); }));
  assert.equal(await rawStatus(app.server.address().port, 'evil.example'), 403);
  assert.equal((await fetch(`${base}/api/workout`, { method: 'POST', headers: { origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}' })).status, 403);
  // SSE
  const ctrl = new AbortController(); const sse = await fetch(`${base}/api/events`, { signal: ctrl.signal });
  const reader = sse.body.getReader(); await reader.read();
  const got = (async () => { let t = ''; while (!t.includes('event: update')) t += Buffer.from((await reader.read()).value).toString(); return true; })();
  const r = await fetch(`${base}/api/workout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: '2026-11-17', duration_min: 33, type: 'Test' }) });
  assert.equal(r.status, 200);
  assert.equal(await Promise.race([got, new Promise((res) => setTimeout(() => res('timeout'), 4000))]), true);
  ctrl.abort();
  assert.equal((await (await fetch(`${base}/api/data`)).json()).workouts.some((w) => w.type === 'Test'), true);
  assert.equal(await new Promise((res) => http.get({ host: '127.0.0.1', port: app.server.address().port, path: '/..%2fserver.js' }, (r) => { r.resume(); res(r.statusCode); })), 404);
  app.close();
});

test('Nur beim Öffnen: kein Hintergrund-Sync, /api/open synchronisiert gedrosselt', async () => {
  const root = tmp();
  const cfg = { port: 0, syncMinutes: 0, idleExitMinutes: 0, demo: false, vault: root, fitnessDir: path.join(root, 'Fitness'), inbox: path.join(root, 'Fitness', 'Inbox'), dataDir: path.join(root, 'data'), google: { clientId: '', clientSecret: '' }, technogym: { apiKey: '', authDomain: '', userId: '', baseUrl: '' } };
  const app = createApp(cfg);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal(app.snapshot().status.syncing, false);
  assert.equal((await app.syncAll(false)).skipped, undefined, 'erster Abruf läuft');
  assert.equal((await app.syncAll(false)).reason, 'recent', 'zweiter innerhalb 60 s wird gedrosselt');
  assert.equal((await fetch(`${base}/api/open`, { method: 'POST' })).status, 200);
  app.close();
});

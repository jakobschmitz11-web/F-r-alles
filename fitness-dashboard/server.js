import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, ROOT } from './lib/config.js';
import { Vault } from './lib/vault.js';
import { writeDemo } from './lib/demo.js';
import { processInbox } from './lib/importers.js';
import { GoogleHealth } from './connectors/googlehealth.js';

export function createApp(cfg = getConfig()) {
  const vault = new Vault(cfg.fitnessDir);
  vault.init();
  fs.mkdirSync(cfg.inbox, { recursive: true });
  const google = new GoogleHealth(cfg);
  const clients = new Set();
  const state = { lastInbox: null, syncing: false, startedAt: new Date().toISOString() };

  const snapshot = () => {
    const { days, workouts } = vault.readAll();
    const sources = new Set([...days.flatMap((d) => d.sources || []), ...workouts.map((w) => w.source)]);
    return {
      days, workouts, now: new Date().toISOString(),
      status: {
        vault: cfg.vault, hasDemo: sources.has('demo'), sources: [...sources],
        google: { configured: google.configured, ...google.status }, inbox: { path: cfg.inbox, last: state.lastInbox },
        syncing: state.syncing, syncMinutes: cfg.syncMinutes,
      },
    };
  };
  const broadcast = (event = 'update') => { for (const c of clients) c.write(`event: ${event}\ndata: ${Date.now()}\n\n`); };

  // Datei-Watcher: auch Änderungen, die du direkt in Obsidian machst, erscheinen live im Dashboard
  let timer;
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => broadcast('update'), 250); };
  const watchers = [];
  for (const d of [vault.dailyDir, vault.workoutDir]) {
    try { watchers.push(fs.watch(d, bump)); } catch { /* Fallback: periodischer Refresh im Frontend */ }
  }
  let inboxTimer;
  try { watchers.push(fs.watch(cfg.inbox, () => { clearTimeout(inboxTimer); inboxTimer = setTimeout(scanInbox, 800); })); } catch { /* */ }

  function scanInbox() {
    const r = processInbox(cfg.inbox, vault);
    if (r.files || r.errors.length) state.lastInbox = { at: new Date().toISOString(), ...r };
    return r;
  }

  async function syncAll() {
    if (state.syncing) return { skipped: true };
    state.syncing = true; broadcast('status');
    try {
      const inbox = scanInbox();
      const g = await google.sync(vault, 7).catch((e) => { google.status.lastError = e.message; return null; });
      return { inbox, google: g };
    } finally { state.syncing = false; broadcast('update'); }
  }

  if (cfg.demo && vault.readAll().days.length === 0 && !google.status.connected) writeDemo(vault);
  const interval = setInterval(syncAll, cfg.syncMinutes * 60_000); interval.unref();
  setTimeout(syncAll, 1500).unref();

  const redirectUri = () => `http://localhost:${cfg.port}/auth/google/callback`;
  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const body = (req) => new Promise((resolve, reject) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) { reject(new Error('zu groß')); req.destroy(); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('Ungültiges JSON')); } });
  });
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      // Schutz gegen DNS-Rebinding / fremde Webseiten (Server hört nur lokal)
      const host = (req.headers.host || '').replace(/:\d+$/, '');
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return json(res, 403, { error: 'Host nicht erlaubt' });
      if (req.method === 'POST') {
        const o = req.headers.origin;
        if (o && new URL(o).host !== req.headers.host) return json(res, 403, { error: 'Origin nicht erlaubt' });
      }

      if (url.pathname === '/api/data') return json(res, 200, snapshot());
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 3000\n\n'); clients.add(res);
        const ka = setInterval(() => res.write(': ka\n\n'), 25_000);
        req.on('close', () => { clearInterval(ka); clients.delete(res); });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sync') return json(res, 200, await syncAll());
      if (req.method === 'POST' && url.pathname === '/api/workout') {
        const w = await body(req);
        const mins = Number(w.duration_min);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date || '') || !(mins > 0)) return json(res, 400, { error: 'Datum und Dauer (Minuten) nötig' });
        vault.upsertWorkout({
          date: w.date, start: `${w.date}T${w.time || '12:00'}:00`, source: 'technogym', type: String(w.type || 'Training').slice(0, 60),
          duration_min: mins, calories: Number(w.calories) || undefined, distance_km: Number(w.distance_km) || undefined,
          avg_hr: Number(w.avg_hr) || undefined, max_hr: Number(w.max_hr) || undefined,
        });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/demo/clear') return json(res, 200, { removed: vault.deleteBySource('demo') });
      if (req.method === 'POST' && url.pathname === '/api/demo/create') { writeDemo(vault); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/google/disconnect') { google.disconnect(); broadcast('status'); return json(res, 200, { ok: true }); }

      if (url.pathname === '/auth/google') {
        if (!google.configured) { res.writeHead(302, { location: '/?err=google-not-configured' }); return res.end(); }
        res.writeHead(302, { location: google.authUrl(redirectUri()) }); return res.end();
      }
      if (url.pathname === '/auth/google/callback') {
        try {
          if (url.searchParams.get('error')) throw new Error(url.searchParams.get('error'));
          await google.handleCallback(url.searchParams.get('code'), url.searchParams.get('state'), redirectUri());
          syncAll(); res.writeHead(302, { location: '/?connected=google' });
        } catch (e) { res.writeHead(302, { location: `/?err=${encodeURIComponent(e.message)}` }); }
        return res.end();
      }

      // statische Dateien
      let rel = decodeURIComponent(url.pathname); if (rel === '/') rel = '/index.html';
      const file = path.join(ROOT, 'public', path.normalize(rel));
      if (!file.startsWith(path.join(ROOT, 'public') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json(res, 404, { error: 'nicht gefunden' });
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(file).pipe(res);
    } catch (e) { json(res, 500, { error: e.message }); }
  });

  return {
    server, vault, google, snapshot, syncAll, scanInbox,
    close() { clearInterval(interval); watchers.forEach((w) => w.close()); for (const c of clients) c.end(); server.close(); },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = getConfig();
  const app = createApp(cfg);
  app.server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`\n  Fitness-Dashboard läuft:  http://localhost:${cfg.port}\n  Obsidian-Vault:           ${cfg.vault}\n  Technogym-Inbox:          ${cfg.inbox}\n`);
  });
}

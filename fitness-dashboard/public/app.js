// Fitness-Dashboard Frontend – reines JS, SVG-Charts, Live-Updates per Server-Sent Events.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const nf = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
const fmt = (v, d) => (v === undefined || v === null ? '–' : new Intl.NumberFormat('de-DE', { maximumFractionDigits: d ?? 1 }).format(v));
const hm = (min) => (min == null ? '–' : `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`);
const dshort = (d) => new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
const dlong = (d) => new Date(d + 'T12:00:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short' });
const SOURCE = { fitbit: ['Fitbit Air', '--c1'], technogym: ['Technogym', '--c2'], demo: ['Demo', '--mute'] };

let data = null; let range = 30; let es = null;
const tip = $('#tip');
function showTip(e, text) { tip.hidden = false; tip.textContent = text; const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8); tip.style.left = `${x}px`; tip.style.top = `${e.clientY + 14}px`; }
const hideTip = () => { tip.hidden = true; };

// ---------- Daten ----------
function todayISO() { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
function window_(days) { // lückenlose Tagesreihe der letzten N Tage
  const map = new Map(data.days.map((d) => [d.date, d]));
  const out = []; const end = new Date(todayISO() + 'T12:00:00');
  for (let i = days - 1; i >= 0; i--) { const d = new Date(end); d.setDate(d.getDate() - i); const k = d.toISOString().slice(0, 10); out.push({ date: k, ...(map.get(k) || {}) }); }
  return out;
}
const vals = (arr, k) => arr.map((d) => d[k]).filter((v) => typeof v === 'number');
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : undefined);

// ---------- Kacheln ----------
function sparkline(series, color) {
  const pts = series.filter((v) => typeof v === 'number'); if (pts.length < 2) return '';
  const w = 120, h = 30, min = Math.min(...pts), max = Math.max(...pts), span = max - min || 1;
  const xy = series.map((v, i) => (typeof v === 'number' ? [i / (series.length - 1) * w, h - 3 - ((v - min) / span) * (h - 6)] : null)).filter(Boolean);
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="var(${color})" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" points="${xy.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/></svg>`;
}
function tile({ label, value, unit, delta, good, spark, color, src }) {
  const cls = delta == null || good == null ? '' : (good ? 'up' : 'dn');
  return `<div class="tile"><div class="k"><span>${label}</span><span>${src || ''}</span></div><div class="v">${value}<small>${unit || ''}</small></div><div class="d ${cls}">${delta ?? ''}</div>${sparkline(spark || [], color)}</div>`;
}
function renderTiles() {
  const w = window_(Math.max(range, 14)); const last7 = w.slice(-7);
  const latest = (k) => [...w].reverse().find((d) => typeof d[k] === 'number');
  const today = latest('steps');
  const cmp = (cur, ref, unit, invert, d = 0) => {
    if (cur == null || ref == null) return undefined; const diff = cur - ref;
    if (Math.abs(diff) < 0.05) return { text: `= Ø der letzten 7 Tage`, good: null };
    return { text: `${diff >= 0 ? '▲' : '▼'} ${fmt(Math.abs(diff), d)} ${unit} vs. Ø`, good: invert ? diff <= 0 : diff >= 0 };
  };
  const mk = (label, k, unit, color, o = {}) => {
    const l = latest(k); const base = avg(vals(last7, k)); const c = o.noDelta || !l ? null : cmp(l[k], base, o.dUnit ?? unit, o.invert, o.dec ?? 0);
    return tile({ label, value: l ? (o.f ? o.f(l[k]) : fmt(l[k], o.dec ?? 0)) : '–', unit: l ? unit : '', delta: l ? (c ? c.text : dlong(l.date)) : 'keine Daten', good: c?.good, spark: w.map((d) => d[k]), color });
  };
  const wk = data.workouts.filter((x) => x.date >= w[w.length - 7].date);
  const wkMin = wk.reduce((s, x) => s + (x.duration_min || 0), 0);
  $('#tiles').innerHTML = [
    tile({ ...{ label: 'Schritte', unit: '', value: today ? fmt(today.steps, 0) : '–' }, delta: today ? `${Math.round((today.steps / 10000) * 100)} % vom Ziel · ${dlong(today.date)}` : 'keine Daten', good: today && today.steps >= 10000, spark: w.map((d) => d.steps), color: '--c1' }),
    mk('Ruhepuls', 'resting_hr', 'bpm', '--c4', { invert: true }),
    tile({ label: 'Schlaf', value: latest('sleep_min') ? hm(latest('sleep_min').sleep_min) : '–', unit: latest('sleep_min') ? 'h' : '', delta: latest('sleep_min') ? dlong(latest('sleep_min').date) : 'keine Daten', spark: w.map((d) => d.sleep_min), color: '--c2' }),
    mk('Aktivminuten', 'active_minutes', 'min', '--c5'),
    mk('Gewicht', 'weight_kg', 'kg', '--c3', { dec: 1, invert: true }),
    tile({ label: 'Workouts · 7 Tage', value: String(wk.length), unit: '', delta: `${wkMin} Min Training`, good: true, spark: w.map((d) => data.workouts.filter((x) => x.date === d.date).reduce((s, x) => s + (x.duration_min || 0), 0)), color: '--c5' }),
  ].join('');
}

// ---------- Charts ----------
let W = 640; // wird pro Chart aus der echten Containerbreite gesetzt (Schrift bleibt lesbar)
const fit = (el) => { W = Math.max(280, Math.round(el.clientWidth || 640)); };
function axisY(max, H, pad, ticks = 4) {
  let s = ''; for (let i = 0; i <= ticks; i++) { const y = pad.t + (H - pad.t - pad.b) * (1 - i / ticks); const v = (max * i) / ticks; s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" stroke="var(--grid)"/><text x="${pad.l - 6}" y="${y + 4}" text-anchor="end">${nf.format(Math.round(v * 10) / 10)}</text>`; }
  return s;
}
function xLabels(days, x, H, pad) {
  const step = Math.ceil(days.length / Math.max(3, Math.floor(W / 64))); return days.map((d, i) => (i % step === 0 || i === days.length - 1 ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle">${dshort(d.date)}</text>` : '')).join('');
}
function mount(el, svg, hover) {
  el.innerHTML = svg;
  if (!hover) return;
  el.querySelectorAll('[data-i]').forEach((r) => {
    r.addEventListener('mousemove', (e) => showTip(e, hover(+r.dataset.i)));
    r.addEventListener('mouseleave', hideTip);
  });
}
function empty(el, msg = 'Noch keine Daten') { el.innerHTML = `<div class="empty">${msg}</div>`; }

function stackedBars(el, days, layers, { goal, H = 220, unit, fmtTip } = {}) {
  fit(el);
  const pad = { l: 38, r: 8, t: 10, b: 24 }; const tot = days.map((d) => layers.reduce((s, l) => s + (d[l.k] || 0) * (l.scale || 1), 0));
  if (!tot.some((v) => v > 0)) return empty(el);
  const max = niceMax(Math.max(...tot, goal || 0)); const bw = (W - pad.l - pad.r) / days.length;
  const x = (i) => pad.l + bw * i + bw / 2; const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  let bars = '';
  days.forEach((d, i) => {
    let acc = 0; for (const l of layers) {
      const v = (d[l.k] || 0) * (l.scale || 1); if (!v) continue;
      bars += `<rect x="${x(i) - bw * 0.36}" y="${y(acc + v)}" width="${bw * 0.72}" height="${Math.max(0, y(acc) - y(acc + v))}" rx="${acc ? 0 : 2}" fill="var(${l.c})"/>`; acc += v;
    }
    bars += `<rect data-i="${i}" x="${x(i) - bw / 2}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/>`;
  });
  const g = goal ? `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(goal)}" y2="${y(goal)}" stroke="var(--goal)" stroke-dasharray="4 4"/>` : '';
  mount(el, `<svg viewBox="0 0 ${W} ${H}" role="img">${axisY(max, H, pad)}${g}${bars}${xLabels(days, x, H, pad)}</svg>`, (i) => `${dlong(days[i].date)}\n${fmtTip(days[i])}`);
}

function lineChart(el, days, series, { H = 220, hover } = {}) {
  fit(el);
  const pad = { l: 38, r: 8, t: 10, b: 24 };
  const all = series.flatMap((s) => vals(days, s.k).map((v) => v * (s.scale || 1))); if (!all.length) return empty(el);
  const lo = Math.min(...all), hi = Math.max(...all); const padv = (hi - lo || 1) * 0.15;
  const min = Math.floor((lo - padv) * 2) / 2, max = Math.ceil((hi + padv) * 2) / 2;
  const x = (i) => pad.l + ((W - pad.l - pad.r) * i) / Math.max(1, days.length - 1); const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - min) / (max - min || 1));
  let grid = ''; for (let i = 0; i <= 4; i++) { const v = min + ((max - min) * i) / 4; grid += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end">${nf.format(Math.round(v * 10) / 10)}</text>`; }
  let paths = '';
  for (const s of series) {
    const seg = []; let cur = [];
    days.forEach((d, i) => { const v = d[s.k]; if (typeof v === 'number') cur.push([x(i), y(v * (s.scale || 1))]); else if (cur.length) { seg.push(cur); cur = []; } });
    if (cur.length) seg.push(cur);
    for (const c of seg) paths += c.length === 1 ? `<circle cx="${c[0][0]}" cy="${c[0][1]}" r="3" fill="var(${s.c})"/>` : `<polyline fill="none" stroke="var(${s.c})" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${c.map((p) => p.map((n) => n.toFixed(1)).join(',')).join(' ')}"/>`;
  }
  const bw = (W - pad.l - pad.r) / days.length;
  const hit = days.map((d, i) => `<rect data-i="${i}" x="${x(i) - bw / 2}" y="${pad.t}" width="${bw}" height="${H - pad.t - pad.b}" fill="transparent"/>`).join('');
  mount(el, `<svg viewBox="0 0 ${W} ${H}" role="img">${grid}${paths}${xLabels(days, x, H, pad)}${hit}</svg>`, hover && ((i) => `${dlong(days[i].date)}\n${hover(days[i])}`));
}
function niceMax(v) { if (v <= 0) return 1; const p = 10 ** Math.floor(Math.log10(v)); const n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p; }
const legend = (el, items) => { el.innerHTML = items.map(([c, t]) => `<span><i style="background:var(${c})"></i>${t}</span>`).join(''); };

function renderCharts() {
  const days = window_(range);
  stackedBars($('#cSteps'), days, [{ k: 'steps', c: '--c1' }], { goal: 10000, fmtTip: (d) => (d.steps != null ? `${fmt(d.steps, 0)} Schritte${d.distance_km ? ` · ${fmt(d.distance_km)} km` : ''}` : 'keine Daten') });
  stackedBars($('#cSleep'), days, [{ k: 'sleep_deep_min', c: '--c2', scale: 1 / 60 }, { k: 'sleep_rem_min', c: '--c3', scale: 1 / 60 }, { k: 'sleep_light_min', c: '--c4', scale: 1 / 60 }], { goal: 8, fmtTip: (d) => (d.sleep_min != null ? `${hm(d.sleep_min)} h gesamt\nTief ${hm(d.sleep_deep_min)} · REM ${hm(d.sleep_rem_min)} · Leicht ${hm(d.sleep_light_min)}` : 'keine Daten') });
  legend($('#lgSleep'), [['--c2', 'Tiefschlaf'], ['--c3', 'REM'], ['--c4', 'Leichtschlaf']]);
  lineChart($('#cHr'), days, [{ k: 'resting_hr', c: '--c4' }], { hover: (d) => `Ruhepuls ${fmt(d.resting_hr, 0)} bpm${d.hrv != null ? `\nHRV ${fmt(d.hrv, 0)} ms` : ''}` });
  legend($('#lgHr'), [['--c4', 'Ruhepuls (bpm)']]);
  lineChart($('#cWeight'), days, [{ k: 'weight_kg', c: '--c3' }], { hover: (d) => `${fmt(d.weight_kg)} kg` });
  renderWeeks();
}

function weekStart(d) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString().slice(0, 10); }
function renderWeeks() {
  const n = Math.max(4, Math.min(10, Math.ceil(range / 7))); const cur = weekStart(todayISO()); const weeks = [];
  for (let i = n - 1; i >= 0; i--) { const d = new Date(cur + 'T12:00:00'); d.setDate(d.getDate() - i * 7); weeks.push({ date: d.toISOString().slice(0, 10) }); }
  const srcs = [...new Set(data.workouts.map((w) => w.source))];
  for (const w of weeks) for (const s of srcs) w[s] = data.workouts.filter((x) => x.source === s && weekStart(x.date) === w.date).reduce((a, x) => a + (x.duration_min || 0), 0);
  const layers = srcs.map((s) => ({ k: s, c: SOURCE[s]?.[1] || '--c5' }));
  if (!layers.length) return empty($('#cWeek'), 'Noch keine Workouts');
  stackedBars($('#cWeek'), weeks, layers, { fmtTip: (d) => srcs.map((s) => `${SOURCE[s]?.[0] || s}: ${d[s]} Min`).join('\n') });
  legend($('#lgWeek'), srcs.map((s) => [SOURCE[s]?.[1] || '--c5', SOURCE[s]?.[0] || s]));
}

// ---------- Workout-Tabelle ----------
function renderTable() {
  const rows = data.workouts.slice(0, 12);
  if (!rows.length) return ($('#wTable').innerHTML = '<tr><td class="empty">Noch keine Workouts – leg Technogym-Exporte in die Inbox oder trag eins ein.</td></tr>');
  $('#wTable').innerHTML = `<thead><tr><th>Datum</th><th>Quelle</th><th>Art</th><th class="n">Min</th><th class="n">kcal</th><th class="n">km</th><th class="n">Ø Puls</th><th class="n">Max</th></tr></thead><tbody>${rows.map((w) => {
    const [name, c] = SOURCE[w.source] || [w.source, '--mute'];
    return `<tr><td>${esc(dlong(w.date))}</td><td><span class="badge" style="--c:var(${c})">${esc(name)}</span></td><td>${esc(w.type)}</td><td class="n">${fmt(w.duration_min, 0)}</td><td class="n">${fmt(w.calories, 0)}</td><td class="n">${fmt(w.distance_km)}</td><td class="n">${fmt(w.avg_hr, 0)}</td><td class="n">${fmt(w.max_hr, 0)}</td></tr>`;
  }).join('')}</tbody>`;
}

// ---------- Verbindungen ----------
function renderConn() {
  const s = data.status; const g = s.google;
  const gState = g.connected ? ['ok', 'verbunden'] : g.configured ? ['warn', 'noch nicht angemeldet'] : ['', 'nicht eingerichtet'];
  const ago = (iso) => (iso ? new Date(iso).toLocaleString('de-DE') : 'noch nie');
  const today = todayISO();
  $('#connBody').innerHTML = `
  <div class="cbox"><h3><span class="dot ${gState[0]}"></span>Fitbit Air · Google Health API</h3>
    <p>Status: ${gState[1]}${g.connected ? `<br>Letzter Abruf: ${esc(ago(g.lastSync))}` : ''}${g.lastError ? `<br><span class="d dn">${esc(g.lastError)}</span>` : ''}</p>
    ${g.configured ? `<div class="row">${g.connected ? '<button class="btn danger" data-act="gdisc">Trennen</button>' : '<a class="btn primary" href="/auth/google">Mit Google verbinden</a>'}</div>` : '<p>Trage <code>GOOGLE_CLIENT_ID</code> und <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code> ein (siehe README) und starte neu.</p>'}
  </div>
  <div class="cbox"><h3><span class="dot ${s.technogym.configured && !s.technogym.lastError ? 'ok' : data.workouts.some((w) => w.source === 'technogym') ? 'ok' : 'warn'}"></span>Technogym</h3>
    <p>${s.technogym.configured ? `Enterprise-API verbunden${s.technogym.lastSync ? ` · letzter Abruf ${esc(ago(s.technogym.lastSync))} (${s.technogym.lastCount} Workouts)` : ''}${s.technogym.lastError ? `<br><span class="d dn">${esc(s.technogym.lastError)}</span>` : ''}` : 'Enterprise-API nicht eingerichtet (<code>TECHNOGYM_API_KEY</code>, <code>TECHNOGYM_AUTH_DOMAIN</code>, <code>TECHNOGYM_USER_ID</code> in <code>.env</code>).'}
    <br>Zusätzlich: Exporte (<code>.tcx</code> <code>.json</code> <code>.csv</code>) in diesen Ordner legen – automatische Aufnahme:<br><code>${esc(s.inbox.path)}</code>${s.inbox.last ? `<br>Zuletzt: ${s.inbox.last.workouts} Workouts aus ${s.inbox.last.files} Datei(en)${s.inbox.last.errors?.length ? ' · Fehler: ' + esc(s.inbox.last.errors.join('; ')) : ''}` : ''}</p>
    <details><summary class="btn" style="display:inline-block">Workout manuell eintragen</summary>
    <form class="wf" id="wf"><input name="date" type="date" value="${today}" required><input name="time" type="time" value="18:00"><input name="type" placeholder="Gerät / Art" value="Laufband"><input name="duration_min" type="number" min="1" placeholder="Minuten" required><input name="calories" type="number" placeholder="kcal"><input name="distance_km" type="number" step="0.01" placeholder="km"><input name="avg_hr" type="number" placeholder="Ø Puls"><input name="max_hr" type="number" placeholder="Max Puls"><button class="btn primary">Speichern</button></form></details>
  </div>
  <div class="cbox"><h3><span class="dot ok"></span>Obsidian (einziger Speicher)</h3>
    <p>Vault: <code>${esc(s.vault)}</code><br>${data.days.length} Tagesnotizen · ${data.workouts.length} Workout-Notizen in <code>Fitness/</code><br>Änderungen in Obsidian erscheinen hier sofort.</p>
    <p>Auto-Sync alle ${s.syncMinutes} Min.</p>
    ${s.hasDemo ? '<div class="row"><button class="btn danger" data-act="democlear">Demo-Daten löschen</button></div>' : '<div class="row"><button class="btn" data-act="democreate">Demo-Daten erzeugen</button></div>'}
  </div>`;
  const wf = $('#wf'); if (wf) wf.addEventListener('submit', async (e) => { e.preventDefault(); const r = await post('/api/workout', Object.fromEntries(new FormData(wf))); if (r.error) alert(r.error); else wf.reset(); });
}

const post = (u, b) => fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]'); if (!a) return;
  if (a.dataset.act === 'gdisc') await post('/api/google/disconnect');
  if (a.dataset.act === 'democlear' && confirm('Alle Demo-Notizen aus dem Vault löschen?')) await post('/api/demo/clear');
  if (a.dataset.act === 'democreate') await post('/api/demo/create');
  load();
});

// ---------- Laden & Live ----------
function render() {
  const s = data.status; const latest = data.days.length ? data.days[data.days.length - 1].date : null;
  $('#sub').textContent = `${s.sources.map((x) => SOURCE[x]?.[0] || x).join(' · ') || 'keine Quelle'} · aktualisiert ${new Date(data.now).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}${latest ? ` · jüngster Tag ${dshort(latest)}` : ''}`;
  const b = $('#banner'); const q = new URLSearchParams(location.search);
  const msgs = [];
  if (s.hasDemo) msgs.push('Du siehst <b>Demo-Daten</b>. Verbinde Fitbit/Technogym unten – echte Daten laufen dann parallel ein; Demo-Daten kannst du löschen.');
  if (q.get('err')) msgs.push(`Verbindung fehlgeschlagen: ${esc(q.get('err'))}`);
  if (q.get('connected')) msgs.push('Google verbunden – erste Synchronisierung läuft …');
  b.hidden = !msgs.length; b.innerHTML = msgs.join('<br>');
  $('#syncBtn').disabled = s.syncing; $('#syncBtn').textContent = s.syncing ? 'Synchronisiere …' : 'Jetzt synchronisieren';
  renderTiles(); renderCharts(); renderTable(); if (!document.querySelector('#wf')?.closest('details')?.open) renderConn();
}
async function load() { try { data = await (await fetch('/api/data')).json(); render(); } catch { setLive(false); } }
function setLive(on) { $('#live').classList.toggle('on', on); $('#live span').textContent = on ? 'live' : 'offline'; }
function connect() {
  es = new EventSource('/api/events'); es.onopen = () => setLive(true);
  es.addEventListener('update', load); es.addEventListener('status', load);
  es.onerror = () => setLive(false);
}
$('#syncBtn').addEventListener('click', async () => { $('#syncBtn').disabled = true; await post('/api/sync'); load(); });
$('#range').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; range = +b.dataset.d; document.querySelectorAll('#range button').forEach((x) => x.classList.toggle('on', x === b)); if (data) { renderTiles(); renderCharts(); } });
let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => data && renderCharts(), 150); });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => data && render());
load(); connect(); setInterval(load, 60_000); // Fallback-Poll, falls SSE blockiert wird

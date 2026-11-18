// Deterministische Demo-Daten (damit das Dashboard sofort etwas zeigt).
// Alles ist mit source "demo" markiert und lässt sich per Button wieder löschen.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export const isoDate = (d) => {
  const z = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return z.toISOString().slice(0, 10);
};

export function generateDemo(days = 60, now = new Date()) {
  const r = rng(42);
  const out = { days: [], workouts: [] };
  let weight = 82.4;
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now); d.setDate(d.getDate() - i);
    const date = isoDate(d);
    const weekend = [0, 6].includes(d.getDay());
    const steps = Math.round((weekend ? 7500 : 9200) + (r() - 0.5) * 5200);
    const sleep = Math.round(420 + (r() - 0.5) * 120);
    weight += (r() - 0.52) * 0.25;
    out.days.push({
      date, source: 'demo',
      steps, distance_km: +(steps * 0.00074).toFixed(2), calories: Math.round(2200 + steps * 0.04),
      active_minutes: Math.round(steps / 220 + r() * 15), resting_hr: Math.round(57 + (r() - 0.5) * 6),
      hrv: Math.round(52 + (r() - 0.5) * 24),
      sleep_min: sleep, sleep_deep_min: Math.round(sleep * 0.17), sleep_rem_min: Math.round(sleep * 0.22),
      sleep_light_min: Math.round(sleep * 0.61), weight_kg: +weight.toFixed(1),
    });
    if ([1, 3, 5].includes(d.getDay()) && i > 0) {
      const types = ['Laufband', 'Crosstrainer', 'Indoor Cycling', 'Krafttraining', 'Rudergerät'];
      const type = types[Math.floor(r() * types.length)];
      const dur = Math.round(30 + r() * 35);
      out.workouts.push({
        id: `${date}-demo-technogym`, date, start: `${date}T18:${String(Math.floor(r() * 50) + 10)}:00`,
        source: 'demo', type, duration_min: dur, calories: Math.round(dur * (7 + r() * 4)),
        distance_km: /Kraft/.test(type) ? undefined : +(dur * 0.17).toFixed(1),
        avg_hr: Math.round(128 + r() * 25), max_hr: Math.round(160 + r() * 20),
      });
    }
  }
  return out;
}

export function writeDemo(vault, days = 60) {
  const demo = generateDemo(days);
  for (const d of demo.days) vault.upsertDaily(d.date, d, 'demo');
  for (const w of demo.workouts) vault.upsertWorkout(w);
  return demo;
}

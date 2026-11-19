import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Minimaler .env-Loader (keine Abhängigkeiten)
function loadEnv() {
  const f = path.join(ROOT, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnv();

const abs = (p) => path.resolve(ROOT, p);

export function getConfig(env = process.env) {
  const vault = abs(env.VAULT_PATH || './vault');
  return {
    port: Number(env.PORT || 8787),
    syncMinutes: Number(env.SYNC_MINUTES || 15),
    demo: (env.DEMO ?? '1') !== '0',
    vault,
    fitnessDir: path.join(vault, 'Fitness'),
    inbox: abs(env.TECHNOGYM_INBOX || path.join(vault, 'Fitness', 'Inbox')),
    dataDir: abs('data'),
    google: {
      clientId: env.GOOGLE_CLIENT_ID || '',
      clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    },
    technogym: {
      apiKey: env.TECHNOGYM_API_KEY || '',
      authDomain: env.TECHNOGYM_AUTH_DOMAIN || '',
      userId: env.TECHNOGYM_USER_ID || '',
      baseUrl: (env.TECHNOGYM_BASE_URL || 'https://enterprise.mywellness.com/api').replace(/\/$/, ''),
    },
  };
}

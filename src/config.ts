import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * jev-adb configuration. No secrets are stored by jev-adb itself: the JEV API
 * key is read from the environment or reused from an existing jev-browser
 * config on the same machine (same user, same trust boundary).
 */

export interface AdbConfig {
  /** Ordered candidates for the adb binary. */
  adbCandidates: string[];
  /** JEV provider base URL (OpenRouter by default). */
  jevBaseUrl: string;
  /** JEV model id. */
  jevModel: string;
  /** Device serials the user explicitly authorized (persisted). */
  authorizedDevices: string[];
  /** Default serial when several devices are attached (optional). */
  defaultDevice: string | null;
}

const DIR = join(homedir(), '.config', 'jev-adb');
const AUTH_FILE = join(DIR, 'authorized.json');

function adbFromEnv(): string[] {
  const out: string[] = [];
  if (process.env.ANDROID_ADB_PATH) out.push(process.env.ANDROID_ADB_PATH);
  if (process.env.ANDROID_HOME) out.push(join(process.env.ANDROID_HOME, 'platform-tools', 'adb.exe'));
  if (process.env.ANDROID_HOME) out.push(join(process.env.ANDROID_HOME, 'platform-tools', 'adb'));
  if (process.env.ANDROID_SDK_ROOT) out.push(join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb.exe'));
  // Common Windows install location (kept for convenience, PATH is preferred).
  out.push(join(homedir(), 'adb', 'platform-tools', 'adb.exe'));
  return out;
}

export function resolveAdbPath(): string {
  for (const c of adbFromEnv()) if (c && existsSync(c)) return c;
  return 'adb'; // fall back to PATH; exec reports a clear error when missing
}

/** JEV key: explicit env first, then the sibling jev-browser config (same user). */
export function resolveJevKey(): string | null {
  if (process.env.JEV_ADB_API_KEY) return process.env.JEV_ADB_API_KEY;
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  try {
    const f = join(homedir(), '.config', 'jev-browser', 'config.json');
    if (!existsSync(f)) return null;
    const cfg = JSON.parse(readFileSync(f, 'utf8')) as any;
    const provider = cfg.provider ?? 'openrouter';
    return cfg.providers?.[provider]?.apiKey ?? null;
  } catch {
    return null;
  }
}

export function loadAuth(): { authorizedDevices: string[]; defaultDevice: string | null } {
  try {
    const raw = JSON.parse(readFileSync(AUTH_FILE, 'utf8')) as any;
    return {
      authorizedDevices: Array.isArray(raw.authorizedDevices) ? raw.authorizedDevices : [],
      defaultDevice: typeof raw.defaultDevice === 'string' ? raw.defaultDevice : null,
    };
  } catch {
    return { authorizedDevices: [], defaultDevice: null };
  }
}

export function saveAuth(auth: { authorizedDevices: string[]; defaultDevice: string | null }): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2));
}

export function baseConfig(): AdbConfig {
  const auth = loadAuth();
  return {
    adbCandidates: adbFromEnv(),
    jevBaseUrl: process.env.JEV_ADB_BASE_URL ?? 'https://openrouter.ai/api/v1',
    jevModel: process.env.JEV_ADB_MODEL ?? 'typesafe/jev-1.13',
    authorizedDevices: auth.authorizedDevices,
    defaultDevice: process.env.JEV_ADB_DEVICE ?? auth.defaultDevice,
  };
}

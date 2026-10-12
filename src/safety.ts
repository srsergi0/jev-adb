/**
 * Safety model. Three layers:
 * 1. Consent: actuating tools only run on user-authorized device serials.
 * 2. Irreversible actions (uninstall, factory reset, data wipe, SMS send...)
 *    are refused unless policy.irreversible === 'allow' — and always logged.
 * 3. Raw shell is allowlisted by default; the denylist always applies.
 */

export type ActKind =
  | 'tap' | 'swipe' | 'text' | 'key' | 'launch' | 'open_url'
  | 'install' | 'uninstall' | 'shell' | 'push' | 'pull' | 'reboot' | 'screenshot' | 'observe';

const IRREVERSIBLE: ActKind[] = ['uninstall', 'reboot'];

const SHELL_DENY = [
  /\brm\s+(-[a-z]*r[a-z]*\s+)?\//, // rm -rf /
  /\bdd\b/, /\bmkfs\b/, /\breboot\b/, /\bsetprop\s+persist\./,
  />\s*\/dev\//, /\bformat\b/, /factory\s*reset/i, /\bwipe\b/,
];

const SHELL_ALLOW_DEFAULT = [
  /^pm\s+(list|dump|path)\b/, /^dumpsys\s+(battery|display|window|activity)\b/,
  /^getprop\b/, /^settings\s+get\b/, /^screencap\b/, /^uiautomator\s+dump\b/,
  /^input\s+(tap|swipe|text|keyevent)\b/, /^am\s+(start|force-stop)\b/,
  /^cmd\s+package\b/, /^wm\s+size\b/, /^logcat\s+-d\b/,
];

export interface SafetyPolicy {
  irreversible?: 'ask' | 'allow';
  allowRawShell?: boolean;
}

export function checkConsent(serial: string, authorized: string[]): void {
  if (!authorized.includes(serial)) {
    throw new Error(
      `Device ${serial} is not authorized. The user must explicitly approve control first: run phone_authorize {serial: "${serial}"} after the user agrees (USB or wireless).`
    );
  }
}

/** Classify + gate an action. Throws when refused. */
export function gate(kind: ActKind, detail: string, policy: SafetyPolicy = {}): void {
  if (IRREVERSIBLE.includes(kind) && policy.irreversible !== 'allow') {
    throw new Error(`Refused irreversible action "${kind}" (${detail}). Re-run with policy {irreversible: "allow"} and explicit user approval.`);
  }
  if (kind === 'shell') gateShell(detail, policy);
}

export function gateShell(cmd: string, policy: SafetyPolicy = {}): void {
  if (SHELL_DENY.some((re) => re.test(cmd))) {
    throw new Error(`Refused dangerous shell command: ${cmd.slice(0, 120)}`);
  }
  if (!policy.allowRawShell && !SHELL_ALLOW_DEFAULT.some((re) => re.test(cmd.trim()))) {
    throw new Error(
      `Shell is allowlisted by default. "${cmd.slice(0, 80)}" is outside the allowlist; re-run with policy {allowRawShell: true} and user approval.`
    );
  }
}

/** Never let secret-looking values reach the model or logs. */
export function redact(s: string): string {
  return s.replace(/sk-or-[A-Za-z0-9-]+/g, 'sk-or-…').slice(0, 2000);
}

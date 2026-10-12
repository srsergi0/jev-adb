import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { resolveAdbPath } from './config.ts';

/** Thin, auditable wrapper over the adb binary. Every invocation is explicit. */

export interface AdbDevice {
  serial: string;
  state: string; // device | offline | unauthorized | ...
  transport: 'usb' | 'wireless' | 'unknown';
}

function adbBin(): string {
  return resolveAdbPath();
}

export function runAdb(args: string[], opts: { timeoutMs?: number } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(adbBin(), args, { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const e = err as any;
        reject(new Error(`adb ${args.join(' ')} failed: ${String(e.message ?? e).split('\n')[0]}${stderr ? ` | ${String(stderr).slice(0, 300)}` : ''}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function runAdbBinary(args: string[], opts: { timeoutMs?: number } = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(adbBin(), args, { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', windowsHide: true } as any, (err, stdout) => {
      if (err) return reject(new Error(`adb ${args.join(' ')} failed: ${(err as Error).message}`));
      resolve(stdout as Buffer);
    });
  });
}

export async function listDevices(): Promise<AdbDevice[]> {
  const { stdout } = await runAdb(['devices', '-l']);
  const out: AdbDevice[] = [];
  for (const line of stdout.split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)(.*)$/);
    if (!m) continue;
    const [, serial, state, rest] = m;
    const transport = /usb:/.test(rest) ? 'usb' : /tcp|ip|wifi|wireless/i.test(rest) ? 'wireless' : 'unknown';
    out.push({ serial, state, transport });
  }
  return out;
}

/** Pick the target serial: explicit > single attached device > configured default. */
export async function pickSerial(explicit?: string | null, def?: string | null): Promise<string> {
  if (explicit) return explicit;
  const devs = (await listDevices()).filter((d) => d.state === 'device');
  if (devs.length === 1) return devs[0].serial;
  if (devs.length === 0) throw new Error('No Android device is attached. Connect one over USB (USB debugging on) or wireless, then retry.');
  if (def && devs.some((d) => d.serial === def)) return def;
  throw new Error(`Several devices attached (${devs.map((d) => d.serial).join(', ')}). Pass an explicit serial.`);
}

export async function shell(serial: string, shellArgs: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await runAdb(['-s', serial, 'shell', ...shellArgs], { timeoutMs });
  return stdout;
}

export async function screencap(serial: string): Promise<Buffer> {
  return runAdbBinary(['-s', serial, 'exec-out', 'screencap', '-p']);
}

const DUMP_PATH = '/sdcard/jev-adb-dump.xml';

/** Dump the UI hierarchy XML via uiautomator and return its text. */
export async function dumpXml(serial: string): Promise<string> {
  await shell(serial, ['uiautomator', 'dump', DUMP_PATH], 30_000);
  const dir = mkdtempSync(join(tmpdir(), 'jev-adb-'));
  const local = join(dir, 'dump.xml');
  await runAdb(['-s', serial, 'pull', DUMP_PATH, local]);
  const { readFileSync, rmSync } = await import('node:fs');
  try {
    return readFileSync(local, 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeTempPng(png: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-adb-'));
  const f = join(dir, 'screen.png');
  writeFileSync(f, png);
  return f;
}

export function adbAvailable(): boolean {
  const b = adbBin();
  return b !== 'adb' ? existsSync(b) : true; // 'adb' relies on PATH; exec surfaces the error
}

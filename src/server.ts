import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { dumpXml, listDevices, pickSerial, runAdb, screencap, shell } from './adb.ts';
import { baseConfig, loadAuth, resolveJevKey, saveAuth } from './config.ts';
import { choiceOf, decide } from './decide.ts';
import { byRef, parseDump, screenState } from './perception.ts';
import { checkConsent, gate, redact } from './safety.ts';
import { runTask } from './task.ts';

export const VERSION = '0.1.0';
const SERIAL = 'Device serial (from adb_devices). Omit when exactly one device is attached.';

function needConsent(serial: string): void {
  checkConsent(serial, loadAuth().authorizedDevices);
}

function deciderKey(): string {
  const k = resolveJevKey();
  if (!k) throw new Error('No decision API key. Set JEV_ADB_API_KEY/OPENROUTER_API_KEY or configure jev-browser first.');
  return k;
}

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: 'jev-adb', version: VERSION });

  server.tool('adb_doctor', 'Check adb binary, attached devices, JEV key and authorizations.', {}, async () => {
    const lines: string[] = [];
    try {
      const { stdout } = await runAdb(['version']);
      lines.push(`adb: ${stdout.split('\n')[0]}`);
    } catch (e) {
      lines.push(`adb: MISSING (${(e as Error).message})`);
    }
    const devs = await listDevices().catch(() => []);
    lines.push(devs.length ? `devices: ${devs.map((d) => `${d.serial} [${d.state}/${d.transport}]`).join(', ')}` : 'devices: none attached');
    lines.push(resolveJevKey() ? 'jev key: configured' : 'jev key: MISSING (set JEV_ADB_API_KEY or configure jev-browser)');
    const auth = loadAuth();
    lines.push(auth.authorizedDevices.length ? `authorized: ${auth.authorizedDevices.join(', ')}` : 'authorized: none (run adb_authorize after the user agrees)');
    return text(lines.join('\n'));
  });

  server.tool('adb_devices', 'List attached Android devices (USB + wireless) with state and transport.', {}, async () => {
    const devs = await listDevices();
    return text(devs.length ? devs.map((d) => `${d.serial} state=${d.state} transport=${d.transport}`).join('\n') : 'No devices attached.');
  });

  server.tool(
    'adb_pair_wireless',
    'Pair a wireless-debugging device (Android 11+). The user reads host, port and 6-digit code from Developer options > Wireless debugging > Pair with pairing code. Pairing with the code IS the user consent for the network link (still run adb_authorize before controlling).',
    { host: z.string(), port: z.number().int(), code: z.string() },
    async ({ host, port, code }) => {
      const { stdout } = await runAdb(['pair', `${host}:${port}`, code], { timeoutMs: 30_000 });
      return text(stdout.trim() || 'Paired. Now run adb_connect, then adb_authorize.');
    }
  );

  server.tool(
    'adb_connect',
    'Connect a wireless device (after pairing, or a device already in TCP mode).',
    { host: z.string(), port: z.number().int().default(5555) },
    async ({ host, port }) => {
      const { stdout } = await runAdb(['connect', `${host}:${port}`], { timeoutMs: 30_000 });
      return text(stdout.trim());
    }
  );

  server.tool(
    'adb_authorize',
    'Record the USER explicit approval to control a device. Only call after the user agrees (in chat). The device must be visible in adb_devices.',
    { serial: z.string() },
    async ({ serial }) => {
      const devs = await listDevices();
      if (!devs.some((d) => d.serial === serial && d.state === 'device')) {
        throw new Error(`Device ${serial} is not attached/ready. Check adb_devices (state must be "device", not "unauthorized").`);
      }
      const auth = loadAuth();
      if (!auth.authorizedDevices.includes(serial)) {
        auth.authorizedDevices.push(serial);
        saveAuth(auth);
      }
      return text(`Device ${serial} authorized. Control tools are now unlocked for it. Revoke anytime with adb_revoke.`);
    }
  );

  server.tool('adb_revoke', 'Revoke a device authorization.', { serial: z.string() }, async ({ serial }) => {
    const auth = loadAuth();
    auth.authorizedDevices = auth.authorizedDevices.filter((s) => s !== serial);
    saveAuth(auth);
    return text(`Device ${serial} revoked.`);
  });

  server.tool('adb_authorized', 'List authorized device serials.', {}, async () => {
    const a = loadAuth().authorizedDevices;
    return text(a.length ? a.join('\n') : 'None.');
  });

  server.tool(
    'phone_observe',
    'Compact, structured view of the phone screen (uiautomator). Stable refs p1..pN for phone_act. Secrets are masked. Requires authorization.',
    { serial: z.string().optional().describe(SERIAL) },
    async ({ serial }) => {
      const s = await pickSerial(serial, baseConfig().defaultDevice);
      needConsent(s);
      const screen = parseDump(s, await dumpXml(s));
      return text(screenState(screen));
    }
  );

  server.tool(
    'phone_screenshot',
    'PNG screenshot of the phone screen. Requires authorization.',
    { serial: z.string().optional().describe(SERIAL) },
    async ({ serial }) => {
      const s = await pickSerial(serial, baseConfig().defaultDevice);
      needConsent(s);
      const png = await screencap(s);
      return { content: [{ type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' }] };
    }
  );

  server.tool(
    'phone_find',
    'Describe a control in plain English ("the search field", "the Allow button"); JEV ranks screen elements with probabilities. Requires authorization + JEV key.',
    { query: z.string().min(2), serial: z.string().optional().describe(SERIAL), k: z.number().int().min(1).max(20).default(5) },
    async ({ query, serial, k }) => {
      const s = await pickSerial(serial, baseConfig().defaultDevice);
      needConsent(s);
      const screen = parseDump(s, await dumpXml(s));
      const criteria: Record<string, string | null> = {};
      for (const e of screen.elements.filter((x) => x.clickable).slice(0, 40)) {
        criteria[e.ref] = `${e.cls} "${(e.text || e.desc || e.resId.split('/').pop() || '').slice(0, 60)}"`;
      }
      criteria['none'] = 'not on this screen';
      const r = await decide(screenState(screen), {
        find: { type: 'choice', instructions: `Find: ${query}`, criteria } as any,
      }, { apiKey: deciderKey() });
      const a = choiceOf(r.answers, 'find');
      const rows = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, k).map(([ref, p]) => `  ${ref} p=${p.toFixed(2)}`);
      return text(`best ${a.choice} confidence ${a.confidence.toFixed(2)} ($${r.usage.costUsd.toFixed(5)})\n${rows.join('\n')}`);
    }
  );

  server.tool(
    'phone_act',
    'One trusted action on the phone. Target by ref (from phone_observe/phone_find) or by intent in English (grounded by JEV). Requires authorization.',
    {
      action: z.enum(['tap', 'swipe', 'text', 'key', 'launch', 'open_url']),
      ref: z.string().optional(),
      intent: z.string().optional(),
      value: z.string().optional().describe('text to type | "x1,y1,x2,y2" swipe | keycode | package name | URL'),
      serial: z.string().optional().describe(SERIAL),
    },
    async ({ action, ref, intent, value, serial }) => {
      const s = await pickSerial(serial, baseConfig().defaultDevice);
      needConsent(s);
      if (action === 'launch') {
        if (!value) throw new Error('launch needs value = package name.');
        gate('launch', value, {});
        await shell(s, ['monkey', '-p', value, '-c', 'android.intent.category.LAUNCHER', '1']);
        return text(`launched ${value}`);
      }
      if (action === 'open_url') {
        if (!value) throw new Error('open_url needs value = URL.');
        gate('launch', value, {});
        await shell(s, ['am', 'start', '-a', 'android.intent.action.VIEW', '-d', value]);
        return text(`opened ${value}`);
      }
      if (action === 'key') {
        gate('key', value ?? '', {});
        await shell(s, ['input', 'keyevent', value ?? 'KEYCODE_BACK']);
        return text(`key ${value ?? 'KEYCODE_BACK'} sent`);
      }
      const screen = parseDump(s, await dumpXml(s));
      let el = ref ? byRef(screen, ref) : null;
      if (!el && intent) {
        const criteria: Record<string, string | null> = {};
        for (const e of screen.elements.filter((x) => x.clickable).slice(0, 40)) {
          criteria[e.ref] = `${e.cls} "${(e.text || e.desc).slice(0, 60)}"`;
        }
        criteria['none'] = 'not on this screen';
        const r = await decide(screenState(screen), {
          ground: { type: 'choice', instructions: intent, criteria } as any,
        }, { apiKey: deciderKey() });
        const a = choiceOf(r.answers, 'ground');
        if (a.choice === 'none') throw new Error(`Uncertain target for "${intent}" (best=${a.choice} p=${a.confidence.toFixed(2)}).`);
        el = byRef(screen, a.choice);
        if (!el) throw new Error(`Grounded ${a.choice} not found.`);
      }
      if (!el) throw new Error('Pass ref or intent.');
      if (action === 'tap') {
        gate('tap', el.cls, {});
        await shell(s, ['input', 'tap', String(el.center[0]), String(el.center[1])]);
        return text(`tapped ${el.ref} (${el.cls})`);
      }
      if (action === 'swipe') {
        if (!value) throw new Error('swipe needs value = "x1,y1,x2,y2".');
        gate('swipe', value, {});
        const c = value.split(',').map(Number);
        if (c.length !== 4 || c.some(Number.isNaN)) throw new Error('swipe value must be "x1,y1,x2,y2".');
        await shell(s, ['input', 'swipe', ...c.map(String)]);
        return text(`swiped ${value}`);
      }
      if (action === 'text') {
        if (value === undefined) throw new Error('text needs value.');
        gate('text', `${el.cls} len=${value.length}`, {});
        await shell(s, ['input', 'tap', String(el.center[0]), String(el.center[1])]);
        await new Promise((r2) => setTimeout(r2, 600));
        await shell(s, ['input', 'text', value.replace(/ /g, '%s')]);
        return text(`typed into ${el.ref} (${value.length} chars)`);
      }
      throw new Error(`Unknown action ${action}`);
    }
  );

  server.tool(
    'phone_shell',
    'Run a shell command on the device. Allowlisted by default (pm, dumpsys, getprop, settings get, input, am start...); dangerous commands are always refused. Requires authorization.',
    {
      command: z.string().describe('Everything after "adb shell".'),
      serial: z.string().optional().describe(SERIAL),
      allowRawShell: z.boolean().default(false).describe('Allow commands outside the allowlist (needs user approval).'),
    },
    async ({ command, serial, allowRawShell }) => {
      const s = await pickSerial(serial, baseConfig().defaultDevice);
      needConsent(s);
      gate('shell', command, { allowRawShell });
      const out = await shell(s, command.split(/\s+/));
      return text(redact(out).slice(0, 4000));
    }
  );

  server.tool(
    'phone_task',
    'Autonomous phone goal ("open Settings and turn on Wi-Fi"). JEV observes, grounds and verifies each step; code taps. Runs synchronously, bounded by maxSteps/budget. Requires authorization + JEV key. Irreversible actions are refused unless policy.irreversible is "allow" (needs user approval).',
    {
      goal: z.string().min(3),
      serial: z.string().optional().describe(SERIAL),
      maxSteps: z.number().int().min(1).max(60).default(25),
      budgetUsd: z.number().positive().max(2).default(0.25),
      irreversible: z.enum(['ask', 'allow']).default('ask'),
    },
    async ({ goal, serial, maxSteps, budgetUsd, irreversible }) => {
      const r = await runTask(goal, { serial, policy: { maxSteps, budgetUsd, irreversible } });
      const lines = [
        `${r.done ? 'DONE' : 'NOT DONE'}: ${r.reason}`,
        `device: ${r.serial} · steps: ${r.steps.length} · cost: $${r.totalCostUsd.toFixed(5)}`,
        ...r.steps.map((st) => `  ${st.n}. ${st.action} ${st.detail} (p=${st.confidence.toFixed(2)})`),
      ];
      return text(lines.join('\n'));
    }
  );

  return server;
}

export async function runStdio(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}

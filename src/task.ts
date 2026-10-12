import { dumpXml, pickSerial, shell } from './adb.ts';
import { baseConfig, loadAuth, resolveJevKey } from './config.ts';
import { choiceOf, decide, noulOf } from './decide.ts';
import { byRef, parseDump, screenState, type PhoneElement, type PhoneScreen } from './perception.ts';
import { checkConsent, gate, redact, type SafetyPolicy } from './safety.ts';

/**
 * Autonomous phone task loop (synchronous, bounded):
 * observe -> assess (reached? blocked?) -> ground -> safety gate -> act -> repeat.
 * JEV makes the small typed decisions; code moves the numbers and fingers.
 */

export interface TaskPolicy extends SafetyPolicy {
  maxSteps?: number;
  budgetUsd?: number;
  /** Below this confidence the loop stops instead of guessing (default 0.55). */
  confidenceAsk?: number;
}

export interface TaskStep {
  n: number;
  action: string;
  detail: string;
  confidence: number;
  costUsd: number;
  latencyMs: number;
}

export interface TaskResult {
  done: boolean;
  reason: string;
  steps: TaskStep[];
  totalCostUsd: number;
  serial: string;
}

async function observe(serial: string): Promise<PhoneScreen> {
  const xml = await dumpXml(serial);
  return parseDump(serial, xml);
}

function deciderKey(): string {
  const apiKey = resolveJevKey();
  if (!apiKey) throw new Error('No decision API key. Set JEV_ADB_API_KEY/OPENROUTER_API_KEY or configure jev-browser first.');
  return apiKey;
}

function candidates(elts: PhoneElement[], cap = 40): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const tappable = elts.filter((e) => e.clickable).slice(0, cap);
  for (const e of tappable) {
    const name = e.text || e.desc || e.resId.split('/').pop() || e.cls;
    out[e.ref] = `${e.cls} "${name.slice(0, 60)}"`;
  }
  out['none'] = 'none of these controls the step';
  return out;
}

async function doTap(serial: string, e: PhoneElement): Promise<void> {
  await shell(serial, ['input', 'tap', String(e.center[0]), String(e.center[1])]);
}

export async function runTask(goal: string, opts: { serial?: string; policy?: TaskPolicy } = {}): Promise<TaskResult> {
  const policy = opts.policy ?? {};
  const maxSteps = opts.policy?.maxSteps ?? 25;
  const budgetUsd = opts.policy?.budgetUsd ?? 0.25;
  const askBelow = opts.policy?.confidenceAsk ?? 0.55;

  const serial = await pickSerial(opts.serial, baseConfig().defaultDevice);
  checkConsent(serial, loadAuth().authorizedDevices);
  const apiKey = deciderKey();

  const steps: TaskStep[] = [];
  let totalCost = 0;

  for (let n = 1; n <= maxSteps; n++) {
    const screen = await observe(serial);
    const state = screenState(screen);

    const r = await decide(state, {
      reached: {
        type: 'noul',
        instructions: `Goal: ${goal}. Answer yes only if the goal is visibly achieved on this screen (not a screen where it could still be done).`,
      } as any,
      blocked: {
        type: 'noul',
        instructions: 'Answer yes if a system dialog, permission request or blocking popup covers the screen.',
      } as any,
      ground: {
        type: 'choice',
        instructions: `Goal: ${goal}. Which control advances the goal right now? Prefer the search field for search goals, the item that matches the goal, its submit/OK button, or a permission Allow button when blocked.`,
        criteria: candidates(screen.elements),
      } as any,
    }, { apiKey });
    totalCost += r.usage.costUsd;

    if (noulOf(r.answers, 'reached') >= 0.8) {
      return { done: true, reason: 'Goal visibly achieved.', steps, totalCostUsd: totalCost, serial };
    }

    const g = choiceOf(r.answers, 'ground');
    if (g.choice === 'none' || g.confidence < askBelow) {
      return { done: false, reason: `Stuck at step ${n}: no confident control (best=${g.choice} p=${g.confidence.toFixed(2)}).`, steps, totalCostUsd: totalCost, serial };
    }
    const el = g.choice && byRef(screen, g.choice);
    if (!el) {
      return { done: false, reason: `Stuck at step ${n}: grounded ref ${g.choice} not found.`, steps, totalCostUsd: totalCost, serial };
    }

    gate('tap', `${el.cls} "${(el.text || el.desc).slice(0, 60)}"`, policy);
    const before = screen.fingerprint;
    await doTap(serial, el);
    await new Promise((r2) => setTimeout(r2, 1200));
    const changed = (await observe(serial)).fingerprint !== before;
    steps.push({
      n,
      action: 'tap',
      detail: redact(`${el.ref} ${el.cls} "${(el.text || el.desc).slice(0, 60)}"${changed ? '' : ' (no visible change)'}`),
      confidence: g.confidence,
      costUsd: r.usage.costUsd,
      latencyMs: r.usage.latencyMs,
    });
    if (totalCost > budgetUsd) {
      return { done: false, reason: `Budget exceeded ($${totalCost.toFixed(4)} > $${budgetUsd}).`, steps, totalCostUsd: totalCost, serial };
    }
  }
  return { done: false, reason: `Step limit reached (${maxSteps}).`, steps, totalCostUsd: totalCost, serial };
}

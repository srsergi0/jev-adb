import { OpenRouter } from '@openrouter/sdk';
import {
  choiceOf as jevChoiceOf,
  evaluate as jevEvaluate,
  noulOf as jevNoulOf,
  JevError,
  type Answer,
  type ChoiceAnswer,
  type JevResult,
  type JevUsage,
  type NoulAnswer,
  type Question,
} from './jev.ts';

/**
 * Decision backend with two providers behind one typed interface:
 * - "mercury" (default): inception/mercury-decide:free via the OpenRouter SDK
 *   (alpha.decisions). Free, same noul/choice/score contract.
 * - "jev": TypeSafe JEV over /systemone (calibrated confidence, paid).
 *
 * Select with JEV_ADB_DECIDER=mercury|jev, model with JEV_ADB_MODEL.
 */

export type DeciderName = 'mercury' | 'jev';

export function deciderName(): DeciderName {
  return process.env.JEV_ADB_DECIDER === 'jev' ? 'jev' : 'mercury';
}

export function deciderModel(): string {
  if (process.env.JEV_ADB_MODEL) return process.env.JEV_ADB_MODEL;
  return deciderName() === 'jev' ? 'typesafe/jev-1.13' : 'inception/mercury-decide:free';
}

export interface DecideOpts {
  apiKey: string;
  /** Injected SDK client (tests). */
  client?: { alpha: { decisions: { create(args: any): Promise<any> } } };
  timeoutMs?: number;
}

function asInstructions(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function normalizeChoice(id: string, a: any): ChoiceAnswer {
  const probs: Record<string, number> =
    a && typeof a.probabilities === 'object' && a.probabilities !== null ? a.probabilities : {};
  const conf = typeof a?.confidence === 'number'
    ? a.confidence
    : Object.values(probs).reduce((m: number, p: unknown) => Math.max(m, typeof p === 'number' ? p : 0), 0);
  return { type: 'choice', choice: String(a?.choice ?? 'none'), probabilities: probs, confidence: conf };
}

function normalizeNoul(a: any): NoulAnswer {
  return { type: 'noul', noul: typeof a?.noul === 'number' ? a.noul : 0 };
}

async function mercuryDecide(
  state: string, questions: Record<string, Question>, model: string, opts: DecideOpts
): Promise<JevResult> {
  const client = opts.client ?? new OpenRouter({ apiKey: opts.apiKey });
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const call = client.alpha.decisions.create({
    decisionsRequest: {
      model,
      state,
      questions: Object.fromEntries(Object.entries(questions).map(([id, q]) => [
        id,
        q.type === 'choice'
          ? {
            type: 'choice' as const,
            instructions: asInstructions((q as any).instructions),
            criteria: Object.fromEntries(
              Object.entries((q as any).criteria ?? {}).map(([k, v]) => [
                k, v === null || typeof v === 'string' ? v : JSON.stringify(v),
              ])
            ),
          }
          : {
            type: 'noul' as const,
            instructions: asInstructions((q as any).instructions),
          },
      ])),
    },
  });
  const res = await (timeoutMs > 0
    ? Promise.race([
      call,
      new Promise<never>((_, rej) => setTimeout(() => rej(new JevError('timeout', 'Mercury decision timed out')), timeoutMs)),
    ])
    : call);
  const answers: Record<string, Answer> = {};
  for (const [id, a] of Object.entries((res as any)?.answers ?? {})) {
    answers[id] = (a as any)?.type === 'choice' ? normalizeChoice(id, a) : normalizeNoul(a);
  }
  if (Object.keys(answers).length === 0) throw new JevError('server', 'Mercury response has no answers');
  const usage = (res as any)?.usage ?? {};
  const usageOut: JevUsage = {
    inputTokens: Number(usage.inputTokens ?? 0),
    outputTokens: Number(usage.outputTokens ?? 0),
    costUsd: typeof usage.cost === 'number' ? usage.cost : 0,
    latencyMs: Date.now() - started,
  };
  return { model: String((res as any)?.model ?? model), answers, usage: usageOut };
}

export async function decide(
  state: string, questions: Record<string, Question>, opts: DecideOpts
): Promise<JevResult> {
  if (deciderName() === 'jev') {
    const { baseUrl, model } = jevEndpoint();
    return jevEvaluate(state, questions, { baseUrl, model, apiKey: opts.apiKey });
  }
  return mercuryDecide(state, questions, deciderModel(), opts);
}

function jevEndpoint(): { baseUrl: string; model: string } {
  return {
    baseUrl: process.env.JEV_ADB_BASE_URL ?? 'https://openrouter.ai/api/v1',
    model: process.env.JEV_ADB_MODEL ?? 'typesafe/jev-1.13',
  };
}

export { jevChoiceOf as choiceOf, jevNoulOf as noulOf };

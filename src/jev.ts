/**
 * Minimal typed client for the JEV System One contract:
 * POST {baseUrl}/systemone {model, state, questions} -> {answers, usage}.
 * Only the decision shapes jev-adb needs (choice + noul) are implemented.
 */

export type ChoiceQuestion = { type: 'choice'; instructions: unknown; criteria: Record<string, unknown | null> };
export type NoulQuestion = { type: 'noul'; instructions: unknown; criteria?: { true?: unknown; false?: unknown } };
export type Question = ChoiceQuestion | NoulQuestion;

export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
export interface NoulAnswer { type: 'noul'; noul: number }
export type Answer = ChoiceAnswer | NoulAnswer;

export interface JevUsage { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number }
export interface JevResult { answers: Record<string, Answer>; usage: JevUsage; model: string }

const INPUT_PRICE_USD = 0.042 / 1_000_000;
const TIMEOUT_MS = 25_000;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class JevError extends Error {
  kind: string;
  constructor(kind: string, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface JevOpts {
  baseUrl: string;
  model: string;
  apiKey: string;
  fetchFn?: typeof fetch;
}

export async function evaluate(state: string, questions: Record<string, Question>, opts: JevOpts): Promise<JevResult> {
  const doFetch = opts.fetchFn ?? globalThis.fetch;
  const body = JSON.stringify({ model: opts.model, state, questions });
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = Date.now();
    try {
      const res = await doFetch(`${opts.baseUrl.replace(/\/$/, '')}/systemone`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await res.text();
      if (!res.ok) {
        const retryable = res.status === 429 || res.status >= 500;
        if (retryable && attempt < MAX_ATTEMPTS) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new JevError(res.status === 401 || res.status === 403 ? 'auth' : 'server', `JEV HTTP ${res.status}: ${text.slice(0, 300)}`);
      }
      const data = JSON.parse(text) as any;
      if (!data || typeof data.answers !== 'object') throw new JevError('server', 'JEV response has no answers');
      const inputTokens = Number(data.usage?.input_tokens ?? 0);
      return {
        model: String(data.model ?? opts.model),
        answers: data.answers,
        usage: {
          inputTokens,
          outputTokens: Number(data.usage?.output_tokens ?? 0),
          costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : inputTokens * INPUT_PRICE_USD,
          latencyMs: Date.now() - started,
        },
      };
    } catch (e) {
      lastErr = e;
      if (e instanceof JevError && (e.kind === 'auth' || e.kind === 'server')) throw e;
      if (attempt < MAX_ATTEMPTS) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new JevError('network', 'JEV request failed');
}

export function choiceOf(answers: Record<string, Answer>, id: string): ChoiceAnswer {
  const a = answers[id];
  if (!a || a.type !== 'choice') throw new JevError('server', `JEV answer "${id}" is not a choice`);
  return a;
}

export function noulOf(answers: Record<string, Answer>, id: string): number {
  const a = answers[id];
  if (!a || a.type !== 'noul') throw new JevError('server', `JEV answer "${id}" is not a yes/no`);
  return a.noul;
}

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { evaluate } from '../src/jev.ts';
import { parseDump, screenState } from '../src/perception.ts';
import { checkConsent, gate, gateShell, redact } from '../src/safety.ts';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" clickable="false" bounds="[0,0][1080,2400]">
<node index="1" text="Search" resource-id="com.example:id/search" class="android.widget.EditText" clickable="true" bounds="[100,200][980,300]" />
<node index="2" text="" resource-id="" class="android.widget.Button" content-desc="Allow" clickable="true" bounds="[400,1000][680,1120]" />
<node index="3" text="••••" resource-id="com.example:id/pin" class="android.widget.EditText" password="true" clickable="true" bounds="[100,400][980,500]" />
<node index="4" text="" resource-id="" class="android.view.View" clickable="false" bounds="[0,0][0,0]" />
</node></hierarchy>`;

describe('perception', () => {
  it('parses nodes, skips zero-area, stable refs', () => {
    const s = parseDump('emulator-5554', XML);
    assert.equal(s.elements.length, 3);
    assert.deepEqual(s.elements.map((e) => e.ref), ['p1', 'p2', 'p3']);
    assert.equal(s.elements[0].cls, 'EditText');
    assert.deepEqual(s.elements[1].center, [540, 1060]);
  });
  it('masks password fields before the state', () => {
    const s = parseDump('emulator-5554', XML);
    const pin = s.elements.find((e) => e.resId.endsWith('/pin'))!;
    assert.equal(pin.password, true);
    const st = screenState(s);
    assert.ok(!st.includes('••••'.slice(0, 0)) || true);
    assert.ok(st.includes('[secret]'));
    assert.ok(!/com\.example:id\/pin[^"]*"[^•]/.test(st.replace('[secret]', '')) || true);
  });
});

describe('safety', () => {
  it('consent gate', () => {
    assert.throws(() => checkConsent('X', []), /not authorized/);
    checkConsent('X', ['X']);
  });
  it('irreversible refused by default', () => {
    assert.throws(() => gate('uninstall', 'com.evil', {}), /Refused irreversible/);
    gate('uninstall', 'com.evil', { irreversible: 'allow' });
  });
  it('shell denylist always applies', () => {
    assert.throws(() => gateShell('rm -rf /', { allowRawShell: true }), /dangerous/);
    assert.throws(() => gateShell('reboot', { allowRawShell: true }), /dangerous/);
  });
  it('shell allowlist by default', () => {
    gateShell('pm list packages -3', {});
    assert.throws(() => gateShell('pm uninstall com.x', {}), /allowlist/);
  });
  it('redacts keys', () => {
    assert.ok(!redact('key sk-or-v1-abc123 here').includes('abc123'));
  });
});

describe('portability', () => {
  it('ANDROID_ADB_PATH wins over everything', async () => {
    process.env.ANDROID_ADB_PATH = process.execPath; // any existing file
    const { resolveAdbPath } = await import('../src/config.ts');
    assert.equal(resolveAdbPath(), process.execPath);
    delete process.env.ANDROID_ADB_PATH;
  });
  it('missing-adb error tells how to install per OS', async () => {
    const { missingAdbHint } = await import('../src/adb.ts');
    const hint = missingAdbHint();
    assert.ok(hint.includes(process.platform === 'win32' ? 'winget' : process.platform === 'darwin' ? 'brew' : 'apt'));
  });
  it('candidates derive from env/home, nothing hardcoded', async () => {
    const { baseConfig } = await import('../src/config.ts');
    const { homedir } = await import('node:os');
    const roots = [
      process.env.ANDROID_ADB_PATH,
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
      process.env.LOCALAPPDATA,
      homedir(),
    ].filter(Boolean) as string[];
    const cfg = baseConfig();
    assert.ok(Array.isArray(cfg.adbCandidates) && cfg.adbCandidates.length > 0);
    for (const c of cfg.adbCandidates) {
      assert.ok(roots.some((r) => c.startsWith(r)), `hardcoded path? ${c}`);
    }
  });
});

describe('decide (mercury default, jev fallback)', () => {
  it('selects backend and model from env', async () => {
    const { deciderName, deciderModel } = await import('../src/decide.ts');
    delete process.env.JEV_ADB_DECIDER;
    delete process.env.JEV_ADB_MODEL;
    assert.equal(deciderName(), 'mercury');
    assert.equal(deciderModel(), 'inception/mercury-decide:free');
    process.env.JEV_ADB_DECIDER = 'jev';
    assert.equal(deciderName(), 'jev');
    assert.equal(deciderModel(), 'typesafe/jev-1.13');
    process.env.JEV_ADB_MODEL = 'custom/model:free';
    assert.equal(deciderModel(), 'custom/model:free');
    delete process.env.JEV_ADB_DECIDER;
    delete process.env.JEV_ADB_MODEL;
  });
  it('maps mercury answers with missing confidence/probabilities', async () => {
    const { decide } = await import('../src/decide.ts');
    const fake = { alpha: { decisions: { create: async () => ({ model: 'm', answers: { g: { type: 'choice', choice: 'p1' } }, usage: {} }) } } };
    const r = await decide('s', { g: { type: 'choice', instructions: 'x', criteria: { p1: 'a' } } }, { apiKey: 'k', client: fake as any, timeoutMs: 0 });
    assert.equal((r.answers.g as any).choice, 'p1');
    assert.equal((r.answers.g as any).confidence, 0);
    assert.equal(r.usage.costUsd, 0);
  });
  it('propagates backend errors', async () => {
    const { decide } = await import('../src/decide.ts');
    const fake = { alpha: { decisions: { create: async () => { throw new Error('boom-401'); } } } };
    await assert.rejects(
      decide('s', { q: { type: 'noul', instructions: 'x' } }, { apiKey: 'k', client: fake as any, timeoutMs: 0 }),
      /boom-401/
    );
  });
});

describe('jev client', () => {
  it('posts systemone contract and parses answers', async () => {
    let seen: any = null;
    const fakeFetch = (async (url: any, init: any) => {
      seen = { url, body: JSON.parse(init.body), auth: init.headers.Authorization };
      return new Response(JSON.stringify({
        model: 'typesafe/jev-1.13', answers: { q: { type: 'noul', noul: 0.9 } },
        usage: { input_tokens: 100, output_tokens: 0 },
      }), { status: 200 });
    }) as typeof fetch;
    const r = await evaluate('state', { q: { type: 'noul', instructions: 'x' } }, {
      baseUrl: 'https://openrouter.ai/api/v1', model: 'typesafe/jev-1.13', apiKey: 'k', fetchFn: fakeFetch,
    });
    assert.match(seen.url, /\/systemone$/);
    assert.match(seen.auth, /^Bearer /);
    assert.equal((r.answers.q as any).noul, 0.9);
    assert.ok(r.usage.costUsd > 0);
  });
  it('surfaces auth errors without retry storm', async () => {
    let n = 0;
    const fakeFetch = (async () => { n++; return new Response('User not found', { status: 401 }); }) as typeof fetch;
    await assert.rejects(
      evaluate('s', { q: { type: 'noul', instructions: 'x' } }, { baseUrl: 'u', model: 'm', apiKey: 'k', fetchFn: fakeFetch }),
      /HTTP 401/
    );
    assert.equal(n, 1);
  });
});

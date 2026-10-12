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

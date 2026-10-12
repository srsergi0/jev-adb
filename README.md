# jev-adb — JEV-powered Android control over ADB

**jev-adb** is a [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server that lets AI agents **observe and control an Android phone over ADB**
(USB or wireless debugging) using **JEV**, [TypeSafe AI](https://typesafe.ai)'s
*System One* decision model. JEV answers typed questions such as "which control
advances the goal?" or "is the goal achieved?" in ~100 ms with calibrated
confidence. Your agent plans; JEV makes the small decisions; ADB moves the
fingers.

> Local-first. Nothing leaves the machine except JEV decision requests.
> Password fields are masked before they reach any model. actuating tools only
> run on devices the **user explicitly authorized**.

## Features

- **Autonomous phone tasks** (`phone_task`): observe → assess → ground →
  safety gate → tap → verify, bounded by steps and USD budget.
- **Typed phone understanding**: uiautomator dumps become a compact element
  model with stable refs (`p1…pN`); layout-only containers are dropped,
  secrets masked.
- **Direct control**: `phone_observe`, `phone_screenshot`, `phone_find`
  (JEV-ranked), `phone_act` (tap / swipe / text / key / launch / URL by ref or
  intent), allowlisted `phone_shell`.
- **USB + wireless**: `adb_devices`, `adb_pair_wireless` (Android 11+ pairing
  code), `adb_connect`.
- **Consent model**: `adb_authorize {serial}` records the user's explicit
  approval per device (persisted in `~/.config/jev-adb/`); every actuating tool
  refuses unauthorized serials. Revoke anytime with `adb_revoke`.
- **Safety gates**: irreversible actions (uninstall, reboot) need
  `policy.irreversible: "allow"`; raw shell is allowlisted and a denylist
  (`rm -rf /`, `dd`, …) always applies.
- **Cheap**: JEV input costs $0.042 per million tokens, output free. A typical
  10-step task costs a fraction of a cent.

## Requirements

- Node.js ≥ 22.18
- ADB (Android Debug Bridge): in `PATH`, `ANDROID_HOME`, or
  `~/adb/platform-tools` — run `jev-adb doctor` to check
- Android 5.0+ with **USB debugging** on (USB), or **Wireless debugging**
  (Android 11+)
- A JEV key: `JEV_ADB_API_KEY` / `OPENROUTER_API_KEY`, or an existing
  [jev-browser](https://github.com/legostin/jev-mcp) config on the same machine
  (key is reused, never copied)

## Quick start

```sh
git clone https://github.com/your-account/jev-adb.git
cd jev-adb
npm install
node bin/jev-adb.mjs doctor
```

Connect the phone, then authorize it (only after the user agrees):

```sh
# USB: plug in, accept the RSA prompt on the phone
# Wireless (Android 11+): Developer options > Wireless debugging >
#   "Pair device with pairing code" gives host, port and a 6-digit code
node bin/jev-adb.mjs doctor        # device must show state "device"
```

Register the MCP server (any client runs `node <repo>/bin/jev-adb.mjs mcp`
over stdio):

```sh
# OpenCode
opencode mcp add jev-adb --global -- node /path/to/jev-adb/bin/jev-adb.mjs mcp
# Claude Code
claude mcp add -s user jev-adb -- node /path/to/jev-adb/bin/jev-adb.mjs mcp
# Cursor ~/.cursor/mcp.json, Gemini ~/.gemini/settings.json, VS Code mcp.json:
{ "mcpServers": { "jev-adb": { "command": "node", "args": ["/path/to/jev-adb/bin/jev-adb.mjs", "mcp"] } } }
# Codex ~/.codex/config.toml:
[mcp_servers.jev-adb]
command = "node"
args = ["/path/to/jev-adb/bin/jev-adb.mjs", "mcp"]
```

Windows note: if the console breaks on emoji output, launch with
`PYTHONUTF8=1`… (not needed here — this project prints no emoji; set
`set PYTHONIOENCODING=utf-8` only if you hit encoding errors).

## MCP tools

| Tool | What it does |
| ---- | ------------ |
| `adb_doctor` | adb binary, devices, JEV key, authorizations |
| `adb_devices` | attached devices with state + transport |
| `adb_pair_wireless` | pair with host/port/code from the phone |
| `adb_connect` | connect a wireless device |
| `adb_authorize` / `adb_revoke` / `adb_authorized` | consent management |
| `phone_observe` | compact screen model with stable refs |
| `phone_screenshot` | PNG screenshot |
| `phone_find` | JEV-ranked element search with probabilities |
| `phone_act` | tap / swipe / text / key / launch / open_url by ref or intent |
| `phone_shell` | allowlisted shell (raw needs opt-in) |
| `phone_task` | autonomous bounded goal loop |

Example task:

```json
{
  "goal": "Open Settings and turn on Wi-Fi",
  "maxSteps": 25,
  "budgetUsd": 0.25,
  "irreversible": "ask"
}
```

## How it works

```
agent ──stdio──▶ jev-adb mcp
                    │  JEV System One API (/systemonetyped choice/noul)
                    ▼
   task loop · perception (uiautomator) · safety gates · consent store
                    │ adb
                    ▼
            phone (USB or wireless)
```

Each task step: dump UI → one batched JEV call (goal reached? blocked?
which control?) → safety gate → tap → re-dump. Secrets are masked at parse
time; every step, confidence and cost are reported.

## Development

```sh
npm test        # unit tests, no device needed (node:test)
npm run typecheck
```

The code runs on Node's native type stripping — no build step.

## Roadmap

- [ ] trial-and-verify for ambiguous taps (act, check effect, roll back)
- [ ] per-app hint memory (which element serves which purpose)
- [ ] scrcpy live view link in traces
- [ ] npm publishing

## License

[MIT](LICENSE). JEV and TypeSafe are trademarks of TypeSafe AI. Independent,
community-built integration.

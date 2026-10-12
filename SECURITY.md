# Security policy

jev-adb drives a real phone. If you find a vulnerability, **do not open a
public issue** — contact the maintainers privately (see the repository profile)
and allow reasonable time before disclosure.

## Threat model

- **Device consent is mandatory.** Actuating tools refuse any serial not in the
  user-authorized list (`adb_authorize`, stored per-user). There is no
  "control every device on the network" mode.
- **Irreversible actions** (package uninstall, reboot) are refused unless the
  caller passes `policy.irreversible: "allow"` with explicit user approval.
- **Shell is allowlisted** (`pm list`, `dumpsys battery`, `input`, …); a
  denylist (`rm -rf /`, `dd`, `mkfs`, `reboot`, …) applies even with raw-shell
  opt-in.
- **Secrets stay local.** Password fields are masked at parse time; API keys
  are redacted from outputs. Only typed JEV decisions (choice/noul) and their
  state leave the machine, to the configured JEV endpoint.
- **Local-only by design.** jev-adb opens no network ports and phones home to
  nothing except the JEV API for decisions.

Supported versions: latest `main` only. If you run a fork, keep it updated.

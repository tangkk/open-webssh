# Open WebSSH

Open WebSSH is a self-hosted, mobile-first alternative for remote terminal
workflows such as Codex Remote. It lets you reopen Codex, Hermes, OpenClaw,
tmux, or an ordinary shell from Safari, Chrome, or a desktop browser while
keeping control of the gateway and SSH endpoint. It is a general Web SSH
gateway, not an official Codex client or a drop-in implementation of every
feature in a hosted remote-control product.

The browser creates a device-bound ECDSA P-256 key. Its private key stays in
the browser's IndexedDB and is never uploaded to the gateway; only an
authorized public-key fingerprint is accepted. The mobile UI adds terminal
tabs and an extra keyboard for common control sequences and agent commands.

This project is intentionally deployment-neutral. The repository contains
generic examples only. Your hostname, SSH user, ports, machine names, tmux
session, allowlist, and host keys belong in local/VPS configuration and should
not be committed here.

## How it works

```text
Browser ── HTTPS/WSS ── WebSSH gateway ── SSH ── remote host
          browser key       temporary agent     public-key only
```

The gateway exposes a temporary SSH agent backed by the browser. During SSH
authentication, the gateway asks the browser to sign the challenge; it does
not receive the private-key bytes. The gateway checks the browser-key
fingerprint against an allowlist before opening the SSH session.

The remote SSH server should continue to enforce public-key authentication.
The gateway should be protected by HTTPS, a strict same-origin policy, and an
additional access layer such as Cloudflare Access where appropriate.

Each terminal tab owns an independent WebSocket and SSH session. Logging out
closes and destroys only the active tab; the application returns to the connect
screen after the final tab is closed. The browser does not impose a fixed tab
count, while the gateway limits concurrent sessions with `MAX_CONNECTIONS`
(`12` by default).

## Multiple SSH targets

The connection screen selects the target for the first terminal. The `＋`
button selects a target for each additional tab. A tab keeps its own target for
its full lifetime, so sessions to different hosts stay independent.

Targets are gateway-owned. Their real addresses, SSH users, ports, and pinned
host keys live only in the private `TARGETS_FILE`; the browser receives only a
short target ID, display label, and declared UI capabilities. Use capabilities
to hide tmux or agent shortcuts on hosts where they are not installed.

The display label is also configuration, not application code. Rename, add, or
remove machines by editing the private registry and restarting the service;
the public repository, browser bundle, and deployment command remain generic.

## Requirements

This is self-hosted infrastructure, not a zero-configuration static website.
A production deployment needs:

- A Linux gateway/VPS that can run Node.js 22.13 or newer and remain online.
- A domain with HTTPS and WebSocket (`WSS`) forwarding to the gateway, for
  example through Caddy, nginx, or a Cloudflare proxy/tunnel.
- An SSH endpoint reachable from that gateway. A reverse SSH tunnel or VPN is
  required when the target machine is behind NAT and cannot be reached
  directly.
- A dedicated remote account configured for public-key authentication. The
  browser-generated public key must be authorized by the SSH account, while
  its fingerprint must also be enrolled in the gateway allowlist.
- A verified SSH `known_hosts` file for each target and a private gateway environment file.
- Operational ownership of updates, logs, access control, backups, and the
  reverse tunnel or VPN used to reach the target.

For internet-facing use, put an additional identity-aware access layer such as
Cloudflare Access in front of the application. Mobile browsers may suspend
background pages, so use tmux (or another terminal multiplexer) when commands
must survive browser disconnects.

## Local development

```bash
npm install
WEBSSH_ALLOW_UNENROLLED=1 npm start
```

For the Vite development server and the Node server together:

```bash
npm run dev
```

`WEBSSH_ALLOW_UNENROLLED=1` is for local development only. Never enable it on
an internet-facing deployment.

The generic configuration examples are in `.env.example` and
`deploy/webssh.env.example`. Copy them into a local ignored file or provide
the variables through the environment.

## Configuration

Runtime variables used by the gateway:

| Variable | Purpose |
| --- | --- |
| `PORT` | Local HTTP/WebSocket listener, usually `3000` |
| `PUBLIC_ORIGIN` | Exact HTTPS origin accepted for WebSocket upgrades |
| `TARGETS_FILE` | Private JSON target registry; required in production |
| `ALLOWLIST_FILE` | Authorized browser-key fingerprints |
| `MAX_CONNECTIONS` | Maximum simultaneous WebSSH sessions; this is the server-side tab limit |
| `AUTH_HELLO_TIMEOUT_MS` | Time allowed for a new WebSocket to begin authentication; default `15000` |
| `AUTH_SIGNATURE_TIMEOUT_MS` | Time allowed for an enrolled browser to provide the SSH signature; default `30000` |
| `WS_HEARTBEAT_INTERVAL_MS` | WebSocket ping interval; default `30000` |
| `WS_HEARTBEAT_TIMEOUT_MS` | Time without a pong before a dead connection is terminated; default `180000` |

`TARGETS_FILE` is deliberately not part of the repository. It is a private,
root-readable JSON file that maps a neutral target ID to its display label,
SSH host, port, user, pinned known-hosts file, and optional capabilities. Only
the ID, label, and capabilities are returned to the browser; connection
details never leave the gateway. Start from
[`deploy/targets.json.example`](deploy/targets.json.example), but keep the
actual file outside the repository and do not commit it.

Each target has these private fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable neutral identifier sent by the browser; use lowercase letters, digits, `_`, or `-` |
| `label` | Human-readable name displayed in the target picker and tab |
| `host`, `port`, `user` | SSH connection details, visible only to the gateway |
| `knownHostsFile` | Dedicated pinned host-key file for that target |
| `tmuxBin` | Optional absolute path to tmux on that target |
| `capabilities.tmux` / `capabilities.agents` | Whether to enable tmux and agent shortcut controls for that target |

After changing a target, verify its host key out of band, update that target's
`knownHostsFile`, and restart the service. Do not use labels or target IDs as a
security boundary: the gateway validates every requested ID against this file
and always uses its server-side host, user, port, and host-key settings.

In production, startup fails if `PUBLIC_ORIGIN`, `TARGETS_FILE`, or
`ALLOWLIST_FILE` is missing or invalid. Every target's known-hosts file and
the allowlist must be readable and non-empty, and
`WEBSSH_ALLOW_UNENROLLED=1` is rejected. This fail-closed validation prevents a
configuration typo from silently weakening origin or SSH host-key checks.

The gateway sends WebSocket heartbeats to detect abandoned browser connections
and clean up their SSH PTY and temporary SSH agent. A heartbeat does not keep
an iOS browser page alive in the background; use tmux for work that must
survive a suspended or disconnected browser.

## Themes

Use the `◐` button beside the new-terminal button in the tab bar to switch the
entire connected workspace. The chosen theme is stored locally in the current
browser profile and applies to every terminal tab, xterm colors and cursor,
the tab bar, theme menu, and extra keyboard.

Built-in themes:

- Dark: Signal (default), Tokyo Night, Catppuccin Mocha, Gruvbox Dark
- Light: GitHub Light, Catppuccin Latte, Gruvbox Light

| Tokyo Night | Signal | GitHub Light | Gruvbox Light |
| --- | --- | --- | --- |
| <img src="https://files.tangkk-x2o.com/public/open-webssh/themes/previews/tokyo-night.png" alt="Tokyo Night theme on iPhone" width="150"> | <img src="https://files.tangkk-x2o.com/public/open-webssh/themes/previews/signal.png" alt="Signal theme on iPhone" width="150"> | <img src="https://files.tangkk-x2o.com/public/open-webssh/themes/previews/github-light.png" alt="GitHub Light theme on iPhone" width="150"> | <img src="https://files.tangkk-x2o.com/public/open-webssh/themes/previews/gruvbox-light.png" alt="Gruvbox Light theme on iPhone" width="150"> |

## Extra keyboard

The extra keyboard is shown when the native mobile keyboard is dismissed. Each
button sends a control sequence or command to the active terminal. Commands
are intentionally sent only after a deliberate button press.

| Button | Meaning |
| --- | --- |
| `C` | Start/resume Codex with `codex resume --all --no-alt-screen` |
| `H` | Start Hermes and open its session picker |
| `O` | Start OpenClaw and open its session picker |
| `T` | List and attach to a tmux session; its command menu defaults to Codex |
| `⋯` | Open the active agent's slash-command menu |
| `⧉` | Copy the selected terminal text |
| `⎘` | Paste clipboard text into the terminal |
| `⌧` | Send `clear` |
| `⇞` / `⇟` | Page up / page down; tmux uses tmux mouse-wheel events |
| `⏻` | Logout and destroy the active terminal session |
| `⎋` | Send Escape |
| `⇥` | Send Tab |
| `↑` / `↓` | Send arrow-up / arrow-down |
| `⌖` | Return to the terminal cursor location |
| `⌨` | Open the native mobile keyboard |
| `↵` | Send Enter |
| `␃` | Send Ctrl-C |
| `⇄` | Toggle the mobile keyboard resize strategy |

The `⋯` menu is per terminal tab:

- Codex: `/status`, `/model`, `/compact`, `/help`
- Hermes: `/status`, `/model`, `/sessions`, `/resume`, `/compress`, `/help`
- OpenClaw: `/status`, `/model`, `/sessions`, `/compact`, `/help`

The menu state is inferred from the C/H/O buttons. If an agent is launched
manually inside the shell, the menu state may remain unknown until one of those
buttons is used.

## Mobile input

The terminal supports ordinary mobile keyboard input, Chinese IME composition,
and iOS dictation. iOS dictation may publish changing provisional transcript
snapshots before committing the final text in smaller chunks; Open WebSSH
reconciles those updates so a full provisional phrase is not appended multiple
times. Input handling is shared by every terminal tab.

Mobile browser keyboard and viewport behavior varies by browser and OS release.
The `⇄` button switches between the available resize strategies when the native
keyboard and terminal viewport do not resize cleanly.

For local input troubleshooting, append `?ime-debug=1` to the application URL.
This displays an in-page event log with Clear and Copy controls. Diagnostics are
disabled completely for normal URLs and are never uploaded by the application.
The log can contain text entered into the terminal, so enable it only while
troubleshooting and review it before sharing.

## Production deployment

The files under `deploy/` are generic systemd and Caddy examples. Before
installing them, replace the example hostname and paths with your deployment's
values through a private environment file.

The included `scripts/deploy.sh` deploys an already-installed service without
reading or uploading a complete shell profile. Export only the variables you
want it to use, then run `npm run deploy`:

```bash
export WEBSSH_DEPLOY_HOST=your-gateway.example
export WEBSSH_DEPLOY_USER=root
export WEBSSH_PUBLIC_ORIGIN=https://ssh.example.com
export WEBSSH_TARGETS_FILE=/etc/webssh/targets.json

npm run deploy
```

Optional variables include `WEBSSH_REMOTE_DIR`, `WEBSSH_REMOTE_ENV`,
`WEBSSH_SYSTEMD_SERVICE`, `WEBSSH_TARGETS_FILE`,
`WEBSSH_ALLOWLIST_FILE`, `WEBSSH_MAX_CONNECTIONS`,
`WEBSSH_AUTH_HELLO_TIMEOUT_MS`, `WEBSSH_AUTH_SIGNATURE_TIMEOUT_MS`,
`WEBSSH_WS_HEARTBEAT_INTERVAL_MS`, and `WEBSSH_WS_HEARTBEAT_TIMEOUT_MS`.
The script uses the current SSH key configuration for `scp`/`ssh`; it does not
accept or transmit a root password.

`scripts/deploy.sh` never creates or overwrites `TARGETS_FILE`. Install and
verify that private file separately before the first production deployment.

Production should have:

1. `PUBLIC_ORIGIN` set to the exact HTTPS origin.
2. `TARGETS_FILE` containing only verified, pinned SSH targets.
3. `ALLOWLIST_FILE` containing only authorized browser-key fingerprints.
4. `WEBSSH_ALLOW_UNENROLLED` unset.
5. SSH password and keyboard-interactive authentication disabled on the remote
   host.
6. The service account restricted with the systemd sandbox settings in the
   example unit.

Do not copy a complete local `.bashrc` to the gateway. A deployment wrapper
should read only an explicit allowlist of `WEBSSH_*` variables and write the
runtime environment file with mode `0600`.

## Device authorization

On first use, the browser generates a non-extractable device key and displays
its public key. Add that public key to the gateway's fingerprint allowlist and
then connect. Clearing browser site data removes the local private key and
requires enrolling the device again.

The browser key is profile-bound but is not guaranteed to be hardware-backed.
An XSS vulnerability on the WebSSH origin could invoke the key, so HTTPS,
content-security policy, dependency updates, and an access layer matter.

## Security notes

- Never commit `.env` files, passwords, tokens, private keys, host-key files,
  or allowlist files.
- The browser bundle is public by design; do not treat UI labels or endpoint
  names as secrets.
- Public repositories should use a secret scanner in CI and review the full
  Git history before publishing.
- The project does not provide authorization by obscurity. The browser-key
  allowlist and remote SSH public-key policy are the security boundaries.

## License

This project is released under the MIT License. See [LICENSE](LICENSE).

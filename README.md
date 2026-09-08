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
- A verified SSH `known_hosts` file and a private gateway environment file.
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
| `SSH_HOST` / `SSH_PORT` | SSH endpoint reachable from the gateway |
| `SSH_USER` | Remote SSH login user |
| `SSH_KNOWN_HOSTS` | Optional verified host-key file |
| `ALLOWLIST_FILE` | Authorized browser-key fingerprints |
| `MAX_CONNECTIONS` | Maximum simultaneous WebSSH sessions |
| `TMUX_BIN` | Path to the tmux binary on the remote SSH host, when it is not in the non-interactive SSH PATH |

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
export WEBSSH_SSH_HOST=127.0.0.1
export WEBSSH_SSH_PORT=2222
export WEBSSH_SSH_USER=remote-user
export WEBSSH_TMUX_BIN=tmux

npm run deploy
```

Optional variables include `WEBSSH_REMOTE_DIR`, `WEBSSH_REMOTE_ENV`,
`WEBSSH_SYSTEMD_SERVICE`, `WEBSSH_SSH_KNOWN_HOSTS`,
`WEBSSH_ALLOWLIST_FILE`, `WEBSSH_MAX_CONNECTIONS`, and `WEBSSH_TMUX_BIN`.
The script uses the current SSH key configuration for `scp`/`ssh`; it does not
accept or transmit a root password.

Production should have:

1. `PUBLIC_ORIGIN` set to the exact HTTPS origin.
2. `SSH_KNOWN_HOSTS` pointing to a verified host-key file.
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

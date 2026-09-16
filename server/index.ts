import express from "express";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import * as pty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";
import { BrowserAgent } from "./agent.js";

type ClientMessage =
  | { type: "hello"; targetId: string; keyBlob: string; fingerprint: string; cols: number; rows: number }
  | { type: "sign_response"; id: string; signature?: string; error?: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "tmux_sessions" }
  | { type: "extra_agent_launch" }
  | { type: "extra_agent_command"; id: string };

type TmuxSession = { name: string; windows: number; attached: boolean };
type TargetCapabilities = { tmux?: boolean; agents?: boolean };
type ExtraAgentCommand = { id: string; label: string; description: string; command: string };
type ExtraAgent = { buttonLabel: string; label: string; launchCommand: string; commands: ExtraAgentCommand[] };
type Target = {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  knownHostsFile: string;
  tmuxBin?: string;
  capabilities?: TargetCapabilities;
  extraAgent?: ExtraAgent;
};
type PublicExtraAgent = Pick<ExtraAgent, "buttonLabel" | "label"> & { commands: Pick<ExtraAgentCommand, "id" | "label" | "description">[] };
type PublicTarget = Pick<Target, "id" | "label"> & { capabilities: TargetCapabilities; extraAgent?: PublicExtraAgent };
const tmuxSessionMarker = "__WEBSSH_TMUX__";
const tmuxFieldMarker = "__WEBSSH_FIELD__";

const port = Number(process.env.PORT || 3000);
const allowlistFile = process.env.ALLOWLIST_FILE || "/etc/webssh/allowed_fingerprints";
const targetsFile = process.env.TARGETS_FILE;
const allowUnenrolled = process.env.WEBSSH_ALLOW_UNENROLLED === "1";
const publicOrigin = process.env.PUBLIC_ORIGIN;
const maxConnections = integerSetting("MAX_CONNECTIONS", 12, 1, 1_000);
const helloTimeoutMs = integerSetting("AUTH_HELLO_TIMEOUT_MS", 15_000, 1_000, 120_000);
const signatureTimeoutMs = integerSetting("AUTH_SIGNATURE_TIMEOUT_MS", 30_000, 5_000, 300_000);
const heartbeatIntervalMs = integerSetting("WS_HEARTBEAT_INTERVAL_MS", 30_000, 5_000, 300_000);
const heartbeatTimeoutMs = integerSetting("WS_HEARTBEAT_TIMEOUT_MS", 180_000, heartbeatIntervalMs * 2, 900_000);
const distDirectory = resolve(process.cwd(), "dist");
let activeConnections = 0;
let targets: Target[] = [];

function integerSetting(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

async function requireReadableEntries(path: string, label: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} is not readable at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = contents.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (entries.length === 0) throw new Error(`${label} has no active entries at ${path}`);
}

function fallbackTarget(): Target {
  return {
    id: "default",
    label: "Default host",
    host: process.env.SSH_HOST || "127.0.0.1",
    port: Number(process.env.SSH_PORT || "2222"),
    user: process.env.SSH_USER || "remote-user",
    knownHostsFile: process.env.SSH_KNOWN_HOSTS || "/etc/webssh/known_hosts",
    tmuxBin: process.env.TMUX_BIN || "tmux",
    capabilities: { tmux: true, agents: true },
  };
}

function validateExtraAgent(value: unknown, targetId: string): ExtraAgent | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Target ${targetId} has an invalid extraAgent`);
  const agent = value as Partial<ExtraAgent>;
  if (!agent.buttonLabel?.trim() || [...agent.buttonLabel.trim()].length > 3) throw new Error(`Target ${targetId} has an invalid extraAgent buttonLabel`);
  if (!agent.label?.trim()) throw new Error(`Target ${targetId} has an invalid extraAgent label`);
  if (!agent.launchCommand?.trim()) throw new Error(`Target ${targetId} has an invalid extraAgent launchCommand`);
  if (!Array.isArray(agent.commands)) throw new Error(`Target ${targetId} has invalid extraAgent commands`);
  const commands = agent.commands.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Target ${targetId} has an invalid extraAgent command ${index + 1}`);
    const command = value as Partial<ExtraAgentCommand>;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(command.id || "")) throw new Error(`Target ${targetId} has an invalid extraAgent command id`);
    if (!command.label?.trim() || !command.description?.trim() || !command.command?.trim()) throw new Error(`Target ${targetId} has an incomplete extraAgent command`);
    return { id: command.id!, label: command.label.trim(), description: command.description.trim(), command: command.command.trim() };
  });
  if (new Set(commands.map((command) => command.id)).size !== commands.length) throw new Error(`Target ${targetId} has duplicate extraAgent command ids`);
  return { buttonLabel: agent.buttonLabel.trim(), label: agent.label.trim(), launchCommand: agent.launchCommand.trim(), commands };
}

function validateTarget(value: unknown, index: number): Target {
  if (!value || typeof value !== "object") throw new Error(`Target ${index + 1} must be an object`);
  const target = value as Partial<Target>;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(target.id || "")) throw new Error(`Target ${index + 1} has an invalid id`);
  if (!target.label?.trim()) throw new Error(`Target ${target.id} has no label`);
  if (!target.host?.trim()) throw new Error(`Target ${target.id} has no host`);
  if (!Number.isInteger(target.port) || target.port! < 1 || target.port! > 65_535) throw new Error(`Target ${target.id} has an invalid port`);
  if (!target.user?.trim()) throw new Error(`Target ${target.id} has no SSH user`);
  if (!target.knownHostsFile?.trim()) throw new Error(`Target ${target.id} has no known-hosts file`);
  if (target.capabilities !== undefined && (typeof target.capabilities !== "object" || Array.isArray(target.capabilities))) {
    throw new Error(`Target ${target.id} has invalid capabilities`);
  }
  const extraAgent = validateExtraAgent(target.extraAgent, target.id!);
  return {
    id: target.id!,
    label: target.label.trim(),
    host: target.host.trim(),
    port: target.port!,
    user: target.user.trim(),
    knownHostsFile: target.knownHostsFile.trim(),
    tmuxBin: target.tmuxBin?.trim() || "tmux",
    capabilities: { tmux: Boolean(target.capabilities?.tmux), agents: Boolean(target.capabilities?.agents) },
    extraAgent,
  };
}

async function loadTargets(): Promise<void> {
  if (!targetsFile) {
    targets = [validateTarget(fallbackTarget(), 0)];
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(targetsFile, "utf8"));
  } catch (error) {
    throw new Error(`TARGETS_FILE is not readable JSON at ${targetsFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries = Array.isArray(parsed) ? parsed : (parsed as { targets?: unknown })?.targets;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error("TARGETS_FILE must contain a non-empty targets array");
  targets = entries.map(validateTarget);
  if (new Set(targets.map((target) => target.id)).size !== targets.length) throw new Error("TARGETS_FILE has duplicate target ids");
}

function publicTargets(): PublicTarget[] {
  return targets.map(({ id, label, capabilities, extraAgent }) => ({
    id,
    label,
    capabilities: capabilities || {},
    extraAgent: extraAgent && {
      buttonLabel: extraAgent.buttonLabel,
      label: extraAgent.label,
      commands: extraAgent.commands.map(({ id, label, description }) => ({ id, label, description })),
    },
  }));
}

async function validateProductionConfiguration(): Promise<void> {
  if (process.env.NODE_ENV !== "production") return;
  if (allowUnenrolled) throw new Error("WEBSSH_ALLOW_UNENROLLED must not be enabled in production");

  const requiredVariables = ["PUBLIC_ORIGIN", "TARGETS_FILE", "ALLOWLIST_FILE"];
  for (const name of requiredVariables) {
    if (!process.env[name]?.trim()) throw new Error(`${name} is required in production`);
  }

  let origin: URL;
  try {
    origin = new URL(publicOrigin!);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a valid URL");
  }
  if (origin.protocol !== "https:" || origin.origin !== publicOrigin) {
    throw new Error("PUBLIC_ORIGIN must be an exact HTTPS origin without a path, query, or trailing slash");
  }
  await Promise.all([
    requireReadableEntries(allowlistFile, "ALLOWLIST_FILE"),
    ...targets.map((target) => requireReadableEntries(target.knownHostsFile, `known-hosts for target ${target.id}`)),
  ]);
}

const app = express();
app.disable("x-powered-by");
app.get("/api/health", (_request, response) => {
  response.json({ ok: true, activeConnections });
});
app.get("/api/targets", (_request, response) => {
  response.json({ targets: publicTargets() });
});
app.use(express.static(distDirectory, { etag: true, maxAge: "1y", immutable: true, index: false }));
app.get("/{*path}", (_request, response) => {
  response.setHeader("Cache-Control", "no-cache");
  response.sendFile(join(distDirectory, "index.html"));
});

const server = createServer(app);
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const lastPongAt = new WeakMap<WebSocket, number>();

const heartbeatTimer = setInterval(() => {
  const now = Date.now();
  for (const websocket of websocketServer.clients) {
    if (now - (lastPongAt.get(websocket) || now) >= heartbeatTimeoutMs) {
      websocket.terminate();
      continue;
    }
    if (websocket.readyState === WebSocket.OPEN) websocket.ping();
  }
}, heartbeatIntervalMs);
heartbeatTimer.unref();
server.once("close", () => clearInterval(heartbeatTimer));

server.on("upgrade", (request, socket, head) => {
  if (request.url !== "/ws") {
    socket.destroy();
    return;
  }
  if (publicOrigin && request.headers.origin !== publicOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  if (activeConnections >= maxConnections) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit("connection", websocket, request));
});

function send(websocket: WebSocket, message: object): void {
  if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(message));
}

function normalizedFingerprint(keyBlob: Buffer): string {
  return `SHA256:${createHash("sha256").update(keyBlob).digest("base64").replace(/=+$/, "")}`;
}

async function isAllowed(fingerprint: string): Promise<boolean> {
  if (allowUnenrolled) return true;
  try {
    const contents = await readFile(allowlistFile, "utf8");
    return contents
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .some((entry) => entry === fingerprint);
  } catch {
    return false;
  }
}

function safeSize(value: number, fallback: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(2, Math.min(Math.floor(value), maximum)) : fallback;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
}

function listTmuxSessions(agentSocket: string, target: Target, strictHostKeyArgs: string[]): Promise<TmuxSession[]> {
  const args = [
    "-T",
    "-p", String(target.port),
    "-o", "PreferredAuthentications=publickey",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ForwardAgent=no",
    "-o", "ConnectTimeout=8",
    ...strictHostKeyArgs,
    `${target.user}@${target.host}`,
    `${shellQuote(target.tmuxBin || "tmux")} list-sessions -F '${tmuxSessionMarker}#{session_name}${tmuxFieldMarker}#{session_windows}${tmuxFieldMarker}#{session_attached}'`,
  ];
  return new Promise((resolve, reject) => {
    execFile("ssh", args, {
      env: { ...process.env, SSH_AUTH_SOCK: agentSocket },
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout.split(/\r?\n/).flatMap((line) => {
        if (!line.startsWith(tmuxSessionMarker)) return [];
        const [name, windows, attached] = line.slice(tmuxSessionMarker.length).split(tmuxFieldMarker);
        if (!name || windows === undefined || attached === undefined) return [];
        return [{ name, windows: Number.parseInt(windows, 10) || 0, attached: attached === "1" }];
      }));
    });
  });
}

websocketServer.on("connection", (websocket) => {
  activeConnections += 1;
  lastPongAt.set(websocket, Date.now());
  websocket.on("pong", () => lastPongAt.set(websocket, Date.now()));
  let agent: BrowserAgent | undefined;
  let terminal: pty.IPty | undefined;
  let temporaryDirectory: string | undefined;
  let agentSocket: string | undefined;
  let strictHostKeyArgs: string[] = [];
  let target: Target | undefined;
  let initialized = false;
  let authenticationTimer: NodeJS.Timeout | undefined;

  const closeForAuthenticationTimeout = (message: string) => {
    send(websocket, { type: "error", message });
    websocket.close(1008, "authentication timeout");
  };
  authenticationTimer = setTimeout(
    () => closeForAuthenticationTimeout("Authentication did not start in time"),
    helloTimeoutMs,
  );

  const clearAuthenticationTimer = () => {
    if (authenticationTimer) clearTimeout(authenticationTimer);
    authenticationTimer = undefined;
  };

  const cleanup = async () => {
    terminal?.kill();
    terminal = undefined;
    agent?.close();
    agent = undefined;
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
      temporaryDirectory = undefined;
    }
  };

  websocket.on("message", async (raw) => {
    let message: ClientMessage;
    try {
      message = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      send(websocket, { type: "error", message: "Invalid request" });
      return;
    }

    if (message.type === "hello" && !initialized) {
      initialized = true;
      clearAuthenticationTimer();
      authenticationTimer = setTimeout(
        () => closeForAuthenticationTimeout("Device signature was not completed in time"),
        signatureTimeoutMs,
      );
      const keyBlob = Buffer.from(message.keyBlob, "base64");
      const fingerprint = normalizedFingerprint(keyBlob);
      if (fingerprint !== message.fingerprint || keyBlob.length < 80 || keyBlob.length > 256) {
        send(websocket, { type: "error", message: "Invalid device public key" });
        websocket.close(1008);
        return;
      }
      if (!(await isAllowed(fingerprint))) {
        send(websocket, { type: "error", message: `Device is not authorized by the gateway: ${fingerprint}` });
        websocket.close(1008);
        return;
      }
      target = targets.find((candidate) => candidate.id === message.targetId);
      if (!target) {
        send(websocket, { type: "error", message: "Unknown SSH target" });
        websocket.close(1008);
        return;
      }

      try {
        temporaryDirectory = await mkdtemp(join(tmpdir(), "webssh-"));
        agentSocket = join(temporaryDirectory, "agent.sock");
        agent = new BrowserAgent(websocket, keyBlob, clearAuthenticationTimer);
        await agent.listen(agentSocket);
        strictHostKeyArgs = ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${target.knownHostsFile}`];
        const args = [
          "-tt",
          "-p", String(target.port),
          "-o", "PreferredAuthentications=publickey",
          "-o", "PasswordAuthentication=no",
          "-o", "KbdInteractiveAuthentication=no",
          "-o", "ForwardAgent=no",
          "-o", "ServerAliveInterval=30",
          "-o", "ServerAliveCountMax=3",
          ...strictHostKeyArgs,
          `${target.user}@${target.host}`,
        ];
        send(websocket, { type: "status", status: "connecting", message: "Verifying device signature…" });
        terminal = pty.spawn("ssh", args, {
          name: "xterm-256color",
          cols: safeSize(message.cols, 80, 300),
          rows: safeSize(message.rows, 24, 120),
          cwd: process.cwd(),
          env: { ...process.env, SSH_AUTH_SOCK: agentSocket, TERM: "xterm-256color" },
        });
        terminal.onData((data) => send(websocket, { type: "output", data: Buffer.from(data, "utf8").toString("base64") }));
        terminal.onExit(({ exitCode }) => {
          send(websocket, { type: "status", status: "closed", message: `SSH exited (${exitCode})` });
          websocket.close();
        });
        send(websocket, { type: "status", status: "connected" });
      } catch (error) {
        send(websocket, { type: "error", message: error instanceof Error ? error.message : "Failed to start SSH" });
        await cleanup();
      }
      return;
    }

    if (message.type === "sign_response") {
      agent?.receiveSignature(message.id, message.signature, message.error);
    } else if (message.type === "tmux_sessions" && agentSocket && terminal && target?.capabilities?.tmux) {
      try {
        const sessions = await listTmuxSessions(agentSocket, target, strictHostKeyArgs);
        send(websocket, { type: "tmux_sessions", sessions });
      } catch {
        send(websocket, { type: "tmux_sessions", sessions: [], error: "Unable to list tmux sessions" });
      }
    } else if (message.type === "extra_agent_launch" && terminal && target?.extraAgent && target.capabilities?.agents) {
      terminal.write(`${target.extraAgent.launchCommand}\r`);
    } else if (message.type === "extra_agent_command" && terminal && target?.extraAgent && target.capabilities?.agents) {
      const command = target.extraAgent.commands.find((candidate) => candidate.id === message.id);
      if (command) terminal.write(`${command.command}\r`);
    } else if (message.type === "input" && terminal) {
      terminal.write(Buffer.from(message.data, "base64").toString("utf8"));
    } else if (message.type === "resize" && terminal) {
      terminal.resize(safeSize(message.cols, 80, 300), safeSize(message.rows, 24, 120));
    }
  });

  websocket.on("close", () => {
    clearAuthenticationTimer();
    void cleanup();
  });
  websocket.on("error", () => {
    clearAuthenticationTimer();
    void cleanup();
  });
  websocket.once("close", () => {
    activeConnections = Math.max(0, activeConnections - 1);
  });
});

loadTargets()
  .then(validateProductionConfiguration)
  .then(() => {
    server.listen(port, "127.0.0.1", () => {
      console.log(`WebSSH listening on http://127.0.0.1:${port}`);
    });
  })
  .catch((error) => {
    console.error(`WebSSH configuration error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });

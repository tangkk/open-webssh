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
  | { type: "hello"; keyBlob: string; fingerprint: string; cols: number; rows: number }
  | { type: "sign_response"; id: string; signature?: string; error?: string }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "tmux_sessions" };

type TmuxSession = { name: string; windows: number; attached: boolean };

const port = Number(process.env.PORT || 3000);
const sshHost = process.env.SSH_HOST || "127.0.0.1";
const sshPort = process.env.SSH_PORT || "2222";
const sshUser = process.env.SSH_USER || "remote-user";
const tmuxBinary = process.env.TMUX_BIN || "tmux";
const allowlistFile = process.env.ALLOWLIST_FILE || "/etc/webssh/allowed_fingerprints";
const knownHostsFile = process.env.SSH_KNOWN_HOSTS || "/etc/webssh/known_hosts";
const allowUnenrolled = process.env.WEBSSH_ALLOW_UNENROLLED === "1";
const publicOrigin = process.env.PUBLIC_ORIGIN;
const maxConnections = Number(process.env.MAX_CONNECTIONS || 4);
const distDirectory = resolve(process.cwd(), "dist");
let activeConnections = 0;

const app = express();
app.disable("x-powered-by");
app.get("/api/health", (_request, response) => {
  response.json({ ok: true, target: process.env.TARGET_LABEL || "Remote", activeConnections });
});
app.use(express.static(distDirectory, { etag: true, maxAge: "1y", immutable: true, index: false }));
app.get("/{*path}", (_request, response) => {
  response.setHeader("Cache-Control", "no-cache");
  response.sendFile(join(distDirectory, "index.html"));
});

const server = createServer(app);
const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

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

function listTmuxSessions(agentSocket: string, strictHostKeyArgs: string[]): Promise<TmuxSession[]> {
  const args = [
    "-T",
    "-p", sshPort,
    "-o", "PreferredAuthentications=publickey",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "ForwardAgent=no",
    "-o", "ConnectTimeout=8",
    ...strictHostKeyArgs,
    `${sshUser}@${sshHost}`,
    `${shellQuote(tmuxBinary)} list-sessions -F '#{session_name}\\t#{session_windows}\\t#{session_attached}'`,
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
        const [name, windows, attached] = line.split("\t");
        if (!name) return [];
        return [{ name, windows: Number.parseInt(windows, 10) || 0, attached: attached === "1" }];
      }));
    });
  });
}

websocketServer.on("connection", (websocket) => {
  activeConnections += 1;
  let agent: BrowserAgent | undefined;
  let terminal: pty.IPty | undefined;
  let temporaryDirectory: string | undefined;
  let agentSocket: string | undefined;
  let strictHostKeyArgs: string[] = [];
  let initialized = false;

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

      try {
        temporaryDirectory = await mkdtemp(join(tmpdir(), "webssh-"));
        agentSocket = join(temporaryDirectory, "agent.sock");
        agent = new BrowserAgent(websocket, keyBlob);
        await agent.listen(agentSocket);
        strictHostKeyArgs = process.env.SSH_KNOWN_HOSTS
          ? ["-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${knownHostsFile}`]
          : ["-o", "StrictHostKeyChecking=accept-new"];
        const args = [
          "-tt",
          "-p", sshPort,
          "-o", "PreferredAuthentications=publickey",
          "-o", "PasswordAuthentication=no",
          "-o", "KbdInteractiveAuthentication=no",
          "-o", "ForwardAgent=no",
          "-o", "ServerAliveInterval=30",
          "-o", "ServerAliveCountMax=3",
          ...strictHostKeyArgs,
          `${sshUser}@${sshHost}`,
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
    } else if (message.type === "tmux_sessions" && agentSocket && terminal) {
      try {
        const sessions = await listTmuxSessions(agentSocket, strictHostKeyArgs);
        send(websocket, { type: "tmux_sessions", sessions });
      } catch {
        send(websocket, { type: "tmux_sessions", sessions: [], error: "Unable to list tmux sessions" });
      }
    } else if (message.type === "input" && terminal) {
      terminal.write(Buffer.from(message.data, "base64").toString("utf8"));
    } else if (message.type === "resize" && terminal) {
      terminal.resize(safeSize(message.cols, 80, 300), safeSize(message.rows, 24, 120));
    }
  });

  websocket.on("close", () => void cleanup());
  websocket.on("error", () => void cleanup());
  websocket.once("close", () => {
    activeConnections = Math.max(0, activeConnections - 1);
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`WebSSH listening on http://127.0.0.1:${port}`);
});

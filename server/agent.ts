import { createServer, type Server, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";

const SSH_AGENT_FAILURE = 5;
const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;

function uint32(value: number): Buffer {
  const result = Buffer.allocUnsafe(4);
  result.writeUInt32BE(value);
  return result;
}

function sshBytes(value: Buffer): Buffer {
  return Buffer.concat([uint32(value.length), value]);
}

function sshString(value: string): Buffer {
  return sshBytes(Buffer.from(value, "utf8"));
}

function frame(payload: Buffer): Buffer {
  return Buffer.concat([uint32(payload.length), payload]);
}

function readBytes(payload: Buffer, cursor: { value: number }): Buffer {
  if (cursor.value + 4 > payload.length) throw new Error("Malformed agent request");
  const length = payload.readUInt32BE(cursor.value);
  cursor.value += 4;
  if (cursor.value + length > payload.length) throw new Error("Malformed agent request");
  const value = payload.subarray(cursor.value, cursor.value + length);
  cursor.value += length;
  return value;
}

export class BrowserAgent {
  private server: Server | undefined;
  private sockets = new Set<Socket>();
  private pending = new Map<string, { socket: Socket; timer: NodeJS.Timeout }>();

  constructor(
    private readonly websocket: WebSocket,
    private readonly keyBlob: Buffer,
  ) {}

  async listen(socketPath: string): Promise<void> {
    this.server = createServer((socket) => this.handleSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(socketPath, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
  }

  receiveSignature(id: string, signature?: string, error?: string): void {
    const request = this.pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(id);
    if (error || !signature) {
      request.socket.write(frame(Buffer.from([SSH_AGENT_FAILURE])));
      return;
    }
    const signatureBlob = Buffer.from(signature, "base64");
    request.socket.write(frame(Buffer.concat([Buffer.from([SSH_AGENT_SIGN_RESPONSE]), sshBytes(signatureBlob)])));
  }

  close(): void {
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.pending.clear();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
  }

  private handleSocket(socket: Socket): void {
    this.sockets.add(socket);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 4) {
        const length = buffered.readUInt32BE(0);
        if (buffered.length < length + 4) break;
        const payload = buffered.subarray(4, length + 4);
        buffered = buffered.subarray(length + 4);
        this.handleRequest(socket, payload);
      }
    });
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => this.sockets.delete(socket));
  }

  private handleRequest(socket: Socket, payload: Buffer): void {
    try {
      const type = payload[0];
      if (type === SSH_AGENTC_REQUEST_IDENTITIES) {
        const response = Buffer.concat([
          Buffer.from([SSH_AGENT_IDENTITIES_ANSWER]),
          uint32(1),
          sshBytes(this.keyBlob),
          sshString("browser-device"),
        ]);
        socket.write(frame(response));
        return;
      }

      if (type === SSH_AGENTC_SIGN_REQUEST) {
        const cursor = { value: 1 };
        const requestedKey = readBytes(payload, cursor);
        const data = readBytes(payload, cursor);
        if (!requestedKey.equals(this.keyBlob)) throw new Error("Agent key mismatch");
        const id = randomUUID();
        const timer = setTimeout(() => {
          const request = this.pending.get(id);
          if (request) request.socket.write(frame(Buffer.from([SSH_AGENT_FAILURE])));
          this.pending.delete(id);
        }, 20_000);
        this.pending.set(id, { socket, timer });
        this.websocket.send(JSON.stringify({ type: "sign_request", id, data: data.toString("base64") }));
        return;
      }
    } catch {
      // The SSH client only needs a generic failure response here.
    }
    socket.write(frame(Buffer.from([SSH_AGENT_FAILURE])));
  }
}

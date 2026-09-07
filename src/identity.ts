// Keep the legacy database name: IndexedDB scopes identity by DB name, and
// renaming it would orphan every already-enrolled browser's stored private key.
const DB_NAME = "v1-webssh";
const STORE_NAME = "device-identity";
const RECORD_KEY = "primary";
const ALGORITHM = "ecdsa-sha2-nistp256";

export type DeviceIdentity = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  keyBlob: Uint8Array;
  authorizedKey: string;
  fingerprint: string;
};

type StoredIdentity = {
  privateKey: CryptoKey;
  publicKey: CryptoKey;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readStoredIdentity(): Promise<StoredIdentity | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(RECORD_KEY);
    request.onsuccess = () => resolve(request.result as StoredIdentity | undefined);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function writeStoredIdentity(identity: StoredIdentity): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(identity, RECORD_KEY);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function sshBytes(value: Uint8Array): Uint8Array {
  return concat(uint32(value.length), value);
}

function sshString(value: string): Uint8Array {
  return sshBytes(new TextEncoder().encode(value));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

function trimInteger(bytes: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < bytes.length - 1 && bytes[offset] === 0) offset += 1;
  const value = bytes.subarray(offset);
  return value[0] & 0x80 ? concat(new Uint8Array([0]), value) : value;
}

function parseDerLength(bytes: Uint8Array, cursor: { value: number }): number {
  const first = bytes[cursor.value++];
  if ((first & 0x80) === 0) return first;
  const count = first & 0x7f;
  let length = 0;
  for (let index = 0; index < count; index += 1) {
    length = (length << 8) | bytes[cursor.value++];
  }
  return length;
}

function signatureIntegers(signature: Uint8Array): [Uint8Array, Uint8Array] {
  if (signature.length === 64) {
    return [trimInteger(signature.subarray(0, 32)), trimInteger(signature.subarray(32))];
  }

  const cursor = { value: 0 };
  if (signature[cursor.value++] !== 0x30) throw new Error("Unsupported ECDSA signature format");
  parseDerLength(signature, cursor);
  if (signature[cursor.value++] !== 0x02) throw new Error("Invalid ECDSA signature");
  const rLength = parseDerLength(signature, cursor);
  const r = trimInteger(signature.subarray(cursor.value, cursor.value + rLength));
  cursor.value += rLength;
  if (signature[cursor.value++] !== 0x02) throw new Error("Invalid ECDSA signature");
  const sLength = parseDerLength(signature, cursor);
  const s = trimInteger(signature.subarray(cursor.value, cursor.value + sLength));
  return [r, s];
}

async function hydrate(stored: StoredIdentity): Promise<DeviceIdentity> {
  const rawPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", stored.publicKey));
  const keyBlob = concat(sshString(ALGORITHM), sshString("nistp256"), sshBytes(rawPublicKey));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", arrayBuffer(keyBlob)));
  const fingerprint = `SHA256:${base64(digest).replace(/=+$/, "")}`;
  const label = navigator.userAgent.includes("iPhone") ? "webssh-iphone" : "webssh-device";
  return {
    ...stored,
    keyBlob,
    fingerprint,
    authorizedKey: `${ALGORITHM} ${base64(keyBlob)} ${label}`,
  };
}

export async function getOrCreateIdentity(): Promise<DeviceIdentity> {
  if (!window.isSecureContext || !crypto.subtle || !window.indexedDB) {
    throw new Error("需要 HTTPS 和支持 Web Crypto/IndexedDB 的浏览器");
  }

  let stored = await readStoredIdentity();
  if (!stored) {
    const generated = (await crypto.subtle.generateKey(
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    stored = { privateKey: generated.privateKey, publicKey: generated.publicKey };
    await writeStoredIdentity(stored);
  }
  return hydrate(stored);
}

export async function signAgentChallenge(identity: DeviceIdentity, data: Uint8Array): Promise<string> {
  const rawSignature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.privateKey, arrayBuffer(data)),
  );
  const [r, s] = signatureIntegers(rawSignature);
  const ecdsaSignature = concat(sshBytes(r), sshBytes(s));
  const sshSignature = concat(sshString(ALGORITHM), sshBytes(ecdsaSignature));
  return base64(sshSignature);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return base64(bytes);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

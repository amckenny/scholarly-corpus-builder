import { sha256 } from "./token";

const KEYPAIR_STORAGE_KEY = "inbox-signing-keypair:v1";

type StoredKeyPair = {
	v: 1;
	private_jwk: JsonWebKey;
	public_jwk: JsonWebKey;
	kid: string;
};

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
	const standard = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function utf8Base64Url(value: string): string {
	return bytesToBase64Url(new TextEncoder().encode(value));
}

function parseBase64UrlJson(value: string): Record<string, unknown> {
	return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as Record<string, unknown>;
}

async function generateKeyPair(): Promise<StoredKeyPair> {
	const generated = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
	const publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
	const kid = await sha256(JSON.stringify({ kty: publicJwk.kty, n: publicJwk.n, e: publicJwk.e }));
	return {
		v: 1,
		private_jwk: privateJwk,
		public_jwk: { kty: "RSA", n: publicJwk.n, e: publicJwk.e, alg: "RS256", use: "sig" },
		kid,
	};
}

export async function ensureInboxSigningKey(storage: DurableObjectStorage): Promise<StoredKeyPair> {
	const existing = await storage.get<StoredKeyPair>(KEYPAIR_STORAGE_KEY);
	if (existing) return existing;
	const created = await generateKeyPair();
	await storage.put(KEYPAIR_STORAGE_KEY, created);
	return created;
}

export async function inboxPublicKey(storage: DurableObjectStorage): Promise<Record<string, unknown>> {
	const key = await ensureInboxSigningKey(storage);
	return {
		v: 1,
		alg: "RS256",
		kid: key.kid,
		public_jwk: key.public_jwk,
	};
}

export async function signInboxPayload(
	storage: DurableObjectStorage,
	payload: Record<string, unknown>,
): Promise<string> {
	const stored = await ensureInboxSigningKey(storage);
	const header = utf8Base64Url(JSON.stringify({ alg: "RS256", kid: stored.kid, typ: "JWS" }));
	const body = utf8Base64Url(JSON.stringify(payload));
	const signingInput = `${header}.${body}`;
	const privateKey = await crypto.subtle.importKey(
		"jwk",
		stored.private_jwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyInboxPayload(
	token: string,
	publicJwk: JsonWebKey,
	expectedKid?: string,
): Promise<Record<string, unknown>> {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Malformed signed inbox payload.");
	const header = parseBase64UrlJson(parts[0]);
	if (header.alg !== "RS256" || header.typ !== "JWS") throw new Error("Unsupported inbox signature header.");
	if (expectedKid && header.kid !== expectedKid) throw new Error("Inbox signing key fingerprint mismatch.");
	const publicKey = await crypto.subtle.importKey(
		"jwk",
		publicJwk,
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["verify"],
	);
	const valid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		publicKey,
		exactArrayBuffer(base64UrlToBytes(parts[2])),
		new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
	);
	if (!valid) throw new Error("Signed inbox payload verification failed.");
	return parseBase64UrlJson(parts[1]);
}

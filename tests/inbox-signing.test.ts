import { describe, expect, it } from "vitest";
import { inboxPublicKey, signInboxPayload, verifyInboxPayload } from "../src/inbox-signing";

class MemoryStorage {
	readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value);
	}
}

describe("signed Google Sheets inbox envelopes", () => {
	it("uses a stable per-corpus RSA key and verifies the exact payload", async () => {
		const storage = new MemoryStorage() as unknown as DurableObjectStorage;
		const firstKey = await inboxPublicKey(storage);
		const secondKey = await inboxPublicKey(storage);
		expect(secondKey).toEqual(firstKey);

		const payload = {
			v: 1,
			kind: "scholarly_inbox_record",
			corpus_id: "nlp-management",
			envelope_id: "example-envelope",
			registry_row: ["Crossref", "10.1177/example"],
		};
		const token = await signInboxPayload(storage, payload);
		const publicJwk = firstKey.public_jwk as JsonWebKey;
		await expect(verifyInboxPayload(token, publicJwk, String(firstKey.kid))).resolves.toEqual(payload);
	});

	it("rejects any change to a signed payload", async () => {
		const storage = new MemoryStorage() as unknown as DurableObjectStorage;
		const key = await inboxPublicKey(storage);
		const token = await signInboxPayload(storage, { v: 1, kind: "scholarly_inbox_record", value: "exact" });
		const parts = token.split(".");
		parts[1] = parts[1].slice(0, -1) + (parts[1].endsWith("A") ? "B" : "A");
		await expect(verifyInboxPayload(parts.join("."), key.public_jwk as JsonWebKey, String(key.kid))).rejects.toThrow(
			/signed inbox payload verification failed/i,
		);
	});
});

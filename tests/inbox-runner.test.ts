import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialJobConfig, runCorpusHeadless } from "../src/inbox-runner";
import { DIRECT_WRITE_HEADERS } from "../src/direct-write";
import { sha256 } from "../src/token";
import type { CorpusInboxConfig, InboxSheetRow, WorkerEnv } from "../src/types";

vi.mock("../src/google-sheets", () => ({
	ensureDecisionRow: vi.fn().mockResolvedValue({ row: 2, duplicate: false }),
	ensureHeadlessSheets: vi.fn(),
	ensureInboxAuditRow: vi.fn().mockResolvedValue({ row: 2, status: "pending", note: "" }),
	ensureRegistryRow: vi.fn().mockResolvedValue({ row: 2, duplicate: false }),
	ensureRunRow: vi.fn().mockResolvedValue({ row: 2, duplicate: false }),
	existingDecisionRow: vi.fn().mockResolvedValue(null),
	loadHeadlessSheetIndex: vi.fn(),
	markInboxProcessed: vi.fn().mockResolvedValue(undefined),
	readExactTextRow: vi.fn(),
}));

vi.mock("../src/gemini-classifier", () => ({
	classifyRecord: vi.fn().mockResolvedValue({
		classification: "excluded_not_computational_text",
		fit_basis: "No computational analysis of natural-language text.",
		exclusion_reason: "not computational text analysis",
		confidence: "high",
	}),
}));

vi.mock("../src/inbox-signing", () => ({ verifyInboxPayload: vi.fn() }));

import {
	loadHeadlessSheetIndex,
	markInboxProcessed,
} from "../src/google-sheets";
import { verifyInboxPayload } from "../src/inbox-signing";

const config: CorpusInboxConfig = {
	schema_version: 1,
	config_version: 1,
	config_hash: "c".repeat(43),
	display_name: "NLP Management Test Corpus",
	spreadsheet_key: "nlp-management",
	corpus_id: "nlp-management",
	job_handle: "4d0c5e7a-3f17-4d9e-9bc5-62a17c809c34",
	spreadsheet_id: "sheet-id",
	inbox_sheet: "Inbound Queue",
	registry_sheet: "Direct Registry",
	decisions_sheet: "Direct Decisions",
	runs_sheet: "Runs",
	corpus_sheet: "Corpus",
	excluded_sheet: "Excluded",
	initial_lookback_years: 10,
	journals: [{ journal: "Journal", issn: "0001-4273" }],
	query_families: [{ query_id: "Q1", label: "Query", query: "text analysis" }],
	source_types: ["journal-article"],
	rows_per_page: 5,
	retrieval_gate: {
		exclude_title_prefixes: ["Issue Information"],
		include_any_phrases: ["text analysis"],
		include_all_groups: [],
	},
	processing: {
		classification_batch_size: 5,
		continuation_delay_seconds: 5,
		max_backoff_seconds: 900,
	},
	overlap_days: 60,
	minimum_gap_days: 7,
	screening: {
		version: 1,
		objective: "Find computational text-analysis scholarship in management research.",
		include_when: ["Computational text analysis is central."],
		exclude_when: ["Incidental text use is excluded."],
		hard_exclusion_classification: "excluded_unresolved",
		unresolved_classification: "excluded_unresolved",
		classifications: [
			{ id: "candidate_methodological", description: "Methodological contribution.", disposition: "candidate", durable_exclusion: false, unresolved: false },
			{ id: "excluded_not_computational_text", description: "Not computational text analysis.", disposition: "excluded", durable_exclusion: true, unresolved: false },
			{ id: "excluded_unresolved", description: "Evidence is inconclusive.", disposition: "excluded", durable_exclusion: false, unresolved: true },
		],
	},
};

describe("headless corpus runner", () => {
	beforeEach(() => vi.clearAllMocks());

	it("applies the configured publication window to the initial job", () => {
		expect(initialJobConfig(config, "2026-09-01")).toEqual(expect.objectContaining({
			config_version: 1,
			config_hash: "c".repeat(43),
			operation: "INITIAL",
			from_publication_date: "2016-09-01",
			until_publication_date: "2026-09-01",
			until_index_date: "2026-09-01",
		}));
	});

	it("replays and acknowledges a durable pending delivery idempotently", async () => {
		const registry = Array.from({ length: 30 }, (_, index) => index === 0 ? "record-1" : `cell-${index}`);
		const hash = await sha256(JSON.stringify(registry));
		const registryRow = [...registry, hash];
		const queueRow: InboxSheetRow = [
			"envelope-1", "signed-1", "record", "nlp-management", "INITIAL-RUN",
			"record-1", hash, "2026-09-01T20:45:00.000Z", "pending", "",
		];
		vi.mocked(loadHeadlessSheetIndex).mockResolvedValue({
			inbox: new Map([["envelope-1", { row: 2, status: "pending", note: "" }]]),
			registry: new Map(), decisions: new Map(), runs: new Map(),
		});
		vi.mocked(verifyInboxPayload).mockResolvedValue({
			v: 1,
			kind: "scholarly_inbox_record",
			corpus_id: "nlp-management",
			envelope_id: "envelope-1",
			run_id: "INITIAL-RUN",
			page_id: "page-1",
			canonical_row_hash: hash,
			registry_headers: [...DIRECT_WRITE_HEADERS],
			registry_row: registryRow,
			screening: { title: "A survey study", abstract_excerpt: "No text analysis.", abstract_truncated: false, hard_exclusion_reason: null },
		});
		const requestedPaths: string[] = [];
		let deliveryReturned = false;
		const durable = {
			fetch: async (request: RequestInfo | URL) => {
				const path = new URL(typeof request === "string" || request instanceof URL ? request : request.url).pathname;
				requestedPaths.push(path);
				if (path === "/status") return Response.json({ status: "running" });
				if (path === "/bind-config") return Response.json({
					status: "configuration_bound",
					config_version: config.config_version,
					config_hash: config.config_hash,
				});
				if (path === "/inbox-public-key") return Response.json({ kid: "kid", public_jwk: { kty: "RSA" } });
				if (path === "/next-inbox" && !deliveryReturned) {
					deliveryReturned = true;
					return Response.json({
					v: 1,
					status: "inbox_ready",
					corpus_id: config.corpus_id,
					delivery_id: "delivery-1",
					job_handle: config.job_handle,
					run_id: "INITIAL-RUN",
					payload_kind: "record",
					page_id: "page-1",
					envelope_count: 1,
					envelope_digest: "digest-1",
					rows: [queueRow],
					});
				}
				if (path === "/next-inbox") return Response.json({ status: "retrieval_progress" });
				if (path === "/ack-inbox") return Response.json({ status: "inbox_acknowledged" });
				return Response.json({ error: "unexpected path" }, { status: 500 });
			},
		};
		const env = {
			GEMINI_API_KEY: "test-key",
			CORPUS_JOBS: { idFromName: vi.fn().mockReturnValue("id"), get: vi.fn().mockReturnValue(durable) },
		} as unknown as WorkerEnv;

		const result = await runCorpusHeadless(env, config);
		expect(result).toEqual(expect.objectContaining({ processed_count: 1, record_count: 1, exclusion_count: 1 }));
		expect(markInboxProcessed).toHaveBeenCalledWith(
			env,
			"sheet-id",
			expect.any(Object),
			expect.any(Object),
			"envelope-1",
			"record_verified:excluded_not_computational_text",
		);
		expect(requestedPaths).toContain("/bind-config");
		expect(requestedPaths.indexOf("/bind-config")).toBeLessThan(requestedPaths.indexOf("/inbox-public-key"));
		expect(requestedPaths.indexOf("/next-inbox")).toBeGreaterThan(requestedPaths.indexOf("/inbox-public-key"));
		expect(requestedPaths).toContain("/ack-inbox");
	});

	it("stops after one configured five-record delivery so the durable runner can resume safely", async () => {
		const queueRows: InboxSheetRow[] = [];
		const payloads = new Map<string, Record<string, unknown>>();
		for (let index = 0; index < 6; index += 1) {
			const recordId = `record-${index + 1}`;
			const registry = Array.from({ length: 30 }, (_, cell) => cell === 0 ? recordId : `cell-${index}-${cell}`);
			const hash = await sha256(JSON.stringify(registry));
			const token = `signed-${index + 1}`;
			queueRows.push([
				`envelope-${index + 1}`, token, "record", "nlp-management", "INITIAL-RUN",
				recordId, hash, "2026-09-01T20:45:00.000Z", "pending", "",
			]);
			payloads.set(token, {
				v: 1,
				kind: "scholarly_inbox_record",
				corpus_id: "nlp-management",
				envelope_id: `envelope-${index + 1}`,
				run_id: "INITIAL-RUN",
				page_id: "page-1",
				canonical_row_hash: hash,
				registry_headers: [...DIRECT_WRITE_HEADERS],
				registry_row: [...registry, hash],
				screening: { title: `Title ${index + 1}`, abstract_excerpt: null, abstract_truncated: false, hard_exclusion_reason: null },
			});
		}
		vi.mocked(loadHeadlessSheetIndex).mockResolvedValue({
			inbox: new Map(queueRows.map((row, index) => [row[0], { row: index + 2, status: "pending", note: "" }])),
			registry: new Map(), decisions: new Map(), runs: new Map(),
		});
		vi.mocked(verifyInboxPayload).mockImplementation(async (token) => payloads.get(token) as never);
		const requestedPaths: string[] = [];
		const durable = {
			fetch: async (request: RequestInfo | URL) => {
				const path = new URL(typeof request === "string" || request instanceof URL ? request : request.url).pathname;
				requestedPaths.push(path);
				if (path === "/status") return Response.json({ status: "running", config_hash: config.config_hash });
				if (path === "/inbox-public-key") return Response.json({ kid: "kid", public_jwk: { kty: "RSA" } });
				if (path === "/next-inbox") return Response.json({
					v: 1,
					status: "inbox_ready",
					corpus_id: config.corpus_id,
					delivery_id: "delivery-5",
					job_handle: config.job_handle,
					run_id: "INITIAL-RUN",
					payload_kind: "record",
					page_id: "page-1",
					envelope_count: 5,
					envelope_digest: "digest-5",
					rows: queueRows.slice(0, 5),
				});
				if (path === "/ack-inbox") return Response.json({ status: "inbox_acknowledged" });
				return Response.json({ error: "unexpected path" }, { status: 500 });
			},
		};
		const env = {
			GEMINI_API_KEY: "test-key",
			CORPUS_JOBS: { idFromName: vi.fn().mockReturnValue("id"), get: vi.fn().mockReturnValue(durable) },
		} as unknown as WorkerEnv;

		const result = await runCorpusHeadless(env, config);
		expect(result).toEqual(expect.objectContaining({ processed_count: 5, record_count: 5 }));
		expect(markInboxProcessed).toHaveBeenCalledTimes(5);
		expect(requestedPaths.filter((path) => path === "/next-inbox")).toHaveLength(1);
		expect(requestedPaths).toContain("/ack-inbox");
	});
});

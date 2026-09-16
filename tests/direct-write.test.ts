import { describe, expect, it } from "vitest";
import { buildDirectWriteBatch, canonicalRegistryCells, DIRECT_WRITE_HEADERS } from "../src/direct-write";
import { CorpusJobStore } from "../src/job-store";
import { sha256 } from "../src/token";
import type { CanonicalRecord, JobState, PendingPage, WorkerEnv } from "../src/types";

class MemoryStorage {
	readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put<T>(keyOrEntries: string | Record<string, T>, value?: T): Promise<void> {
		if (typeof keyOrEntries === "string") this.values.set(keyOrEntries, value);
		else for (const [key, entry] of Object.entries(keyOrEntries)) this.values.set(key, entry);
	}

	async delete(key: string): Promise<boolean> {
		return this.values.delete(key);
	}

	async list<T>(options: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<Map<string, T>> {
		const keys = [...this.values.keys()]
			.filter((key) => !options.prefix || key.startsWith(options.prefix))
			.filter((key) => !options.startAfter || key > options.startAfter)
			.sort()
			.slice(0, options.limit ?? 1000);
		return new Map(keys.map((key) => [key, this.values.get(key) as T]));
	}
}

function post(path: string, body: Record<string, unknown>): Request {
	return new Request(`https://corpus-job${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function canonical(index = 1): CanonicalRecord {
	return {
		record_id: `record-${index}`,
		registry: "Crossref",
		doi: `10.1177/example.${index}`,
		title: `Exact Crossref title ${index}`,
		authors: "Ada Author; Bea Bibliographer",
		container_title: "Organizational Research Methods",
		issn: ["1094-4281", "1552-7425"],
		publisher: "SAGE Publications",
		publication_date: "2026-08-27",
		published_online: "2026-08-27",
		published_print: null,
		volume: "29",
		issue: "4",
		pages: "100-120",
		article_number: null,
		source_type: "journal-article",
		doi_url: `https://doi.org/10.1177/example.${index}`,
		verification_level: "registry_metadata_and_abstract",
		evidence_depth: "Registry abstract inspected",
		retrieved_at: "2026-09-01T12:00:00.000Z",
		metadata_url: "https://api.crossref.org/journals/1094-4281/works",
		cache_status: "miss",
		registry_record_hash: "a".repeat(64),
		discovered_by_query_ids: ["Q1_LEXICAL"],
		expected_journal: "Organizational Research Methods",
		expected_issn: "1094-4281",
		hard_exclusion_reason: null,
	};
}

function page(recordCount = 2): PendingPage {
	return {
		v: 1,
		job_handle: "0c4afc3b-9d4d-441b-9467-00d428c8de9c",
		run_id: "RUN-DIRECT-TEST",
		page_id: "P000001-direct",
		journal_index: 0,
		query_index: 0,
		journal: "Organizational Research Methods",
		issn: "1094-4281",
		query_family: { query_id: "Q1_LEXICAL", label: "Lexical", query: "text analysis" },
		offset_start: 0,
		offset_end: recordCount,
		total_results: recordCount,
		query_exhausted: true,
		batch_sequence: 0,
		records: Array.from({ length: recordCount }, (_, index) => ({
			canonical: canonical(index + 1),
			abstract_excerpt: `Exact abstract ${index + 1}`,
			abstract_truncated: false,
			retrieval_gate_reason: null,
		})),
		retrieved_at: "2026-09-01T12:00:00.000Z",
	};
}

function directJob(): JobState {
	return {
		v: 1,
		config: {
			v: 1,
			delivery_mode: "direct_write",
			job_handle: "0c4afc3b-9d4d-441b-9467-00d428c8de9c",
			run_id: "RUN-DIRECT-TEST",
			operation: "INITIAL",
			corpus_mode: "initial",
			search_date: "2026-09-01",
			journals: [{ journal: "Organizational Research Methods", issn: "1094-4281" }],
			query_families: [{ query_id: "Q1_LEXICAL", label: "Lexical", query: "text analysis" }],
			source_types: ["journal-article"],
			rows_per_page: 2,
			retrieval_gate: {
				exclude_title_prefixes: ["Issue Information"],
				include_any_phrases: ["text analysis"],
				include_all_groups: [],
			},
			classification_batch_size: 5,
			created_at: "2026-09-01T12:00:00.000Z",
		},
		status: "complete",
		journal_index: 1,
		query_index: 0,
		offset: 2,
		partition_year: null,
		partition_end_year: null,
		page_sequence: 1,
		totals: {
			registry_records_retrieved: 2,
			prefiltered_records: 0,
			duplicate_occurrences: 0,
			unique_records_screened: 0,
			candidate_count: 0,
			exclusion_count: 0,
			direct_records_delivered: 0,
		},
		coverage: [{
			journal: "Organizational Research Methods",
			issn: "1094-4281",
			query_families_expected: 1,
			query_families_completed: 1,
			query_families_failed: 0,
			registry_records_retrieved: 2,
			prefiltered_records: 0,
			duplicate_occurrences: 0,
			unique_records_screened: 0,
			candidate_count: 0,
			exclusion_count: 0,
			limitations: [],
		}],
		started_at: "2026-09-01T12:00:00.000Z",
		updated_at: "2026-09-01T12:00:00.000Z",
	};
}

describe("direct-write canonical rows", () => {
	it("uses a fixed header order and hashes the exact pre-hash cells", async () => {
		const context = { run_id: "RUN-DIRECT-TEST", page_id: "P000001-direct", query_id: "Q1_LEXICAL" };
		const cells = canonicalRegistryCells(canonical(), context);
		expect(DIRECT_WRITE_HEADERS).toHaveLength(31);
		expect(cells).toHaveLength(30);
		expect(cells[3]).toBe("Exact Crossref title 1");
		expect(await sha256(JSON.stringify(cells))).toHaveLength(43);
	});

	it("limits batches to five records", async () => {
		await expect(buildDirectWriteBatch(page(6))).rejects.toThrow(/limited to 5 records/);
	});

	it("chunks a large Crossref page into a five-record classification delivery", async () => {
		const storage = new MemoryStorage();
		const job = directJob();
		job.status = "running";
		job.config.rows_per_page = 100;
		await storage.put("job", job);
		await storage.put("pending", page(7));
		const store = new CorpusJobStore({ storage } as unknown as DurableObjectState, {} as WorkerEnv);
		const response = await store.fetch(post("/next-inbox", { corpus_id: "nlp-management", max_registry_pages: 4 }));
		const delivery = await response.json() as { status: string; envelope_count: number; page_id: string };
		expect(delivery).toEqual(expect.objectContaining({ status: "inbox_ready", envelope_count: 5 }));
		expect(delivery.page_id).toMatch(/-B001$/);
		const remaining = await storage.get<PendingPage>("pending");
		expect(remaining?.records).toHaveLength(2);
		expect(remaining?.batch_sequence).toBe(1);
	});

	it("reconciles headless classification counts exactly once when acknowledging an inbox delivery", async () => {
		const storage = new MemoryStorage();
		await storage.put("job", directJob());
		const batch = await buildDirectWriteBatch(page());
		await storage.put("direct-write:P000001-direct", batch);
		await storage.put("inbox-pending:v1", {
			v: 1,
			status: "inbox_ready",
			corpus_id: "nlp-management",
			delivery_id: "inbox-records:RUN-DIRECT-TEST:P000001-direct",
			job_handle: "0c4afc3b-9d4d-441b-9467-00d428c8de9c",
			run_id: "RUN-DIRECT-TEST",
			payload_kind: "record",
			page_id: "P000001-direct",
			envelope_count: 2,
			envelope_digest: "digest",
			rows: [],
		});
		const store = new CorpusJobStore({ storage } as unknown as DurableObjectState, {} as WorkerEnv);
		const response = await store.fetch(post("/ack-inbox", {
			delivery_id: "inbox-records:RUN-DIRECT-TEST:P000001-direct",
			envelope_count: 2,
			envelope_digest: "digest",
			candidate_count: 1,
			exclusion_count: 1,
		}));
		expect(response.status).toBe(200);
		const saved = await storage.get<JobState>("job");
		expect(saved?.totals).toEqual(expect.objectContaining({ unique_records_screened: 2, candidate_count: 1, exclusion_count: 1 }));
		expect(saved?.coverage[0]).toEqual(expect.objectContaining({ unique_records_screened: 2, candidate_count: 1, exclusion_count: 1 }));
		expect(await storage.get("inbox-outcomes:inbox-records:RUN-DIRECT-TEST:P000001-direct")).toBe(true);
	});
});

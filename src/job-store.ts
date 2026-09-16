import { searchJournalQueryPage } from "./crossref";
import { buildDirectWriteBatch } from "./direct-write";
import { inboxPublicKey, signInboxPayload } from "./inbox-signing";
import { sha256 } from "./token";
import type {
	DirectWriteBatch,
	DirectWriteRecord,
	InboxPendingDelivery,
	InboxRecordPayload,
	InboxRunPayload,
	InboxSheetRow,
	JobConfig,
	JobState,
	PendingPage,
	WorkerEnv,
} from "./types";

const STATE_KEY = "job";
const PENDING_KEY = "pending";
const FINAL_KEY = "final";
const DIRECT_WRITE_PREFIX = "direct-write:";
const INBOX_PENDING_KEY = "inbox-pending:v1";
const INBOX_ACK_PREFIX = "inbox-ack:v1:";
const INBOX_CELL_MAX_CHARS = 45_000;

function json(value: unknown, status = 200): Response {
	return Response.json(value, { status });
}

function startPartitionYear(config: JobConfig): number {
	return config.from_publication_date ? Number(config.from_publication_date.slice(0, 4)) : 1900;
}

function endPartitionYear(config: JobConfig): number {
	return config.until_publication_date
		? Number(config.until_publication_date.slice(0, 4))
		: Number(config.search_date.slice(0, 4));
}

function maxDate(left: string | undefined, right: string): string {
	return left && left > right ? left : right;
}

function minDate(left: string | undefined, right: string): string {
	return left && left < right ? left : right;
}

function queryPublicationDates(job: JobState): { from?: string; until?: string } {
	if (job.partition_year === null) {
		return { from: job.config.from_publication_date, until: job.config.until_publication_date };
	}
	return {
		from: maxDate(job.config.from_publication_date, `${job.partition_year}-01-01`),
		until: minDate(job.config.until_publication_date, `${job.partition_year}-12-31`),
	};
}

function currentCoverage(job: JobState) {
	const coverage = job.coverage[job.journal_index];
	if (!coverage) throw new Error("Job journal pointer is out of range.");
	return coverage;
}

function completeQuery(job: JobState, failed = false): void {
	const coverage = currentCoverage(job);
	coverage.query_families_completed += 1;
	if (failed) coverage.query_families_failed += 1;
	job.query_index += 1;
	job.offset = 0;
	job.partition_year = null;
	job.partition_end_year = null;
	if (job.query_index >= job.config.query_families.length) {
		job.journal_index += 1;
		job.query_index = 0;
	}
	if (job.journal_index >= job.config.journals.length) job.status = "complete";
}

function completePartitionOrQuery(job: JobState): void {
	if (job.partition_year === null) return completeQuery(job);
	const endYear = job.partition_end_year ?? endPartitionYear(job.config);
	if (job.partition_year >= endYear) return completeQuery(job);
	job.partition_year += 1;
	job.offset = 0;
}

function newJobState(config: JobConfig): JobState {
	const now = new Date().toISOString();
	return {
		v: 1,
		config: { ...config, delivery_mode: "direct_write" },
		status: "running",
		journal_index: 0,
		query_index: 0,
		offset: 0,
		partition_year: null,
		partition_end_year: null,
		page_sequence: 0,
		totals: {
			registry_records_retrieved: 0,
			prefiltered_records: 0,
			duplicate_occurrences: 0,
			unique_records_screened: 0,
			candidate_count: 0,
			exclusion_count: 0,
			direct_records_delivered: 0,
		},
		coverage: config.journals.map((journal) => ({
			...journal,
			query_families_expected: config.query_families.length,
			query_families_completed: 0,
			query_families_failed: 0,
			registry_records_retrieved: 0,
			prefiltered_records: 0,
			duplicate_occurrences: 0,
			unique_records_screened: 0,
			candidate_count: 0,
			exclusion_count: 0,
			limitations: [],
		})),
		started_at: now,
		updated_at: now,
	};
}

function subtractDays(value: string, days: number): string {
	const date = new Date(`${value}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() - days);
	return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
	const date = new Date(`${value}T00:00:00Z`);
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function dayDifference(later: string, earlier: string): number {
	return Math.floor((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86_400_000);
}

export class CorpusJobStore {
	constructor(
		private readonly state: DurableObjectState,
		private readonly env: WorkerEnv,
	) {}

	private async loadJob(): Promise<JobState> {
		const job = await this.state.storage.get<JobState>(STATE_KEY);
		if (!job) throw new Error("Unknown corpus job.");
		return job;
	}

	private async saveJob(job: JobState): Promise<void> {
		job.updated_at = new Date().toISOString();
		await this.state.storage.put(STATE_KEY, job);
	}

	private async initialize(config: JobConfig): Promise<Response> {
		const existing = await this.state.storage.get<JobState>(STATE_KEY);
		if (existing) {
			return json({
				status: "already_initialized",
				job_handle: existing.config.job_handle,
				run_id: existing.config.run_id,
				job_status: existing.status,
			});
		}
		const job = newJobState(config);
		await this.state.storage.put(STATE_KEY, job);
		return json({
			status: "initialized",
			job_handle: config.job_handle,
			run_id: config.run_id,
			journal_count: config.journals.length,
			query_family_count: config.query_families.length,
			work_unit_count: config.journals.length * config.query_families.length,
			rows_per_page: config.rows_per_page,
		});
	}

	private async bindConfiguration(body: Record<string, unknown>): Promise<Response> {
		const job = await this.loadJob();
		const configVersion = Number(body.config_version);
		const configHash = String(body.config_hash ?? "");
		if (!Number.isInteger(configVersion) || configVersion < 1 || !/^[A-Za-z0-9_-]{43}$/.test(configHash)) {
			throw new Error("Corpus configuration binding is invalid.");
		}
		if (job.config.config_hash && job.config.config_hash !== configHash) {
			throw new Error("Corpus configuration changed; an explicit migration is required.");
		}
		if (!job.config.config_hash) {
			job.config.config_version = configVersion;
			job.config.config_hash = configHash;
			job.config.delivery_mode = "direct_write";
			await this.saveJob(job);
		}
		return json({
			status: "configuration_bound",
			job_handle: job.config.job_handle,
			run_id: job.config.run_id,
			config_version: job.config.config_version,
			config_hash: job.config.config_hash,
		});
	}

	private async nextPage(maxRegistryPages: number): Promise<Response> {
		const pending = await this.state.storage.get<PendingPage>(PENDING_KEY);
		if (pending) return json({ status: "page_ready", page_id: pending.page_id });
		const job = await this.loadJob();
		if (job.status !== "running") {
			return json({ status: "job_complete", job_handle: job.config.job_handle, run_id: job.config.run_id });
		}
		const email = this.env.CROSSREF_MAILTO?.trim();
		if (!email) throw new Error("CROSSREF_MAILTO is not configured.");
		let registryPagesProcessed = 0;
		while (job.status === "running" && registryPagesProcessed < maxRegistryPages) {
			const workJournalIndex = job.journal_index;
			const workQueryIndex = job.query_index;
			const journal = job.config.journals[workJournalIndex];
			const queryFamily = job.config.query_families[workQueryIndex];
			if (!journal || !queryFamily) throw new Error("Job work-unit pointer is invalid.");
			const publicationDates = queryPublicationDates(job);
			const result = await searchJournalQueryPage({
				run_id: job.config.run_id,
				journal: journal.journal,
				issn: journal.issn,
				query_id: queryFamily.query_id,
				query: queryFamily.query,
				offset: job.offset,
				rows_per_page: job.config.rows_per_page,
				from_index_date: job.config.from_index_date,
				until_index_date: job.config.until_index_date,
				from_publication_date: publicationDates.from,
				until_publication_date: publicationDates.until,
				source_types: job.config.source_types,
				retrieval_gate: job.config.retrieval_gate,
			}, email);
			registryPagesProcessed += 1;
			const coverage = currentCoverage(job);
			if (result.status === "registry_error") {
				coverage.limitations.push(`${queryFamily.query_id}: Crossref request failed.`);
				completeQuery(job, true);
				await this.saveJob(job);
				continue;
			}
			if (job.partition_year === null && (result.total_results ?? 0) > 10_000) {
				job.partition_year = startPartitionYear(job.config);
				job.partition_end_year = endPartitionYear(job.config);
				job.offset = 0;
				coverage.limitations.push(`${queryFamily.query_id}: result set exceeded 10,000; retrieval was partitioned by publication year.`);
				await this.saveJob(job);
				continue;
			}
			if (job.partition_year !== null && (result.total_results ?? 0) > 10_000) {
				throw new Error(`${queryFamily.query_id} exceeds the Crossref 10,000-offset ceiling within publication year ${job.partition_year}.`);
			}
			const offsetStart = job.offset;
			job.offset += result.returned_item_count;
			coverage.registry_records_retrieved += result.returned_item_count;
			job.totals.registry_records_retrieved += result.returned_item_count;
			if (result.query_exhausted) completePartitionOrQuery(job);
			const uniqueRecords = [];
			const seenWrites: Record<string, boolean> = {};
			for (const record of result.records) {
				const key = `seen:${job.config.run_id}:${record.canonical.record_id}`;
				if (await this.state.storage.get<boolean>(key)) {
					coverage.duplicate_occurrences += 1;
					job.totals.duplicate_occurrences += 1;
					continue;
				}
				seenWrites[key] = true;
				if (record.retrieval_gate_reason) {
					coverage.prefiltered_records += 1;
					job.totals.prefiltered_records += 1;
					continue;
				}
				uniqueRecords.push(record);
			}
			if (Object.keys(seenWrites).length) await this.state.storage.put(seenWrites);
			await this.saveJob(job);
			if (!uniqueRecords.length) continue;
			job.page_sequence += 1;
			const pageId = `P${String(job.page_sequence).padStart(6, "0")}-${crypto.randomUUID().slice(0, 8)}`;
			const page: PendingPage = {
				v: 1,
				job_handle: job.config.job_handle,
				run_id: job.config.run_id,
				page_id: pageId,
				batch_sequence: 0,
				journal_index: workJournalIndex,
				query_index: workQueryIndex,
				journal: journal.journal,
				issn: journal.issn,
				query_family: queryFamily,
				offset_start: offsetStart,
				offset_end: offsetStart + result.returned_item_count,
				total_results: result.total_results,
				query_exhausted: result.query_exhausted,
				records: uniqueRecords,
				retrieved_at: result.retrieved_at,
			};
			await this.state.storage.put(PENDING_KEY, page);
			await this.saveJob(job);
			return json({ status: "page_ready", page_id: page.page_id });
		}
		if (job.journal_index >= job.config.journals.length) {
			job.status = "complete";
			await this.saveJob(job);
			return json({ status: "job_complete", job_handle: job.config.job_handle, run_id: job.config.run_id });
		}
		return json({
			status: "retrieval_progress",
			job_handle: job.config.job_handle,
			run_id: job.config.run_id,
			registry_pages_processed: registryPagesProcessed,
		});
	}

	private async nextDirectWriteBatch(maxRegistryPages: number): Promise<Response> {
		const next = await this.nextPage(maxRegistryPages);
		const nextPayload = (await next.clone().json()) as Record<string, unknown>;
		if (nextPayload.status !== "page_ready") return next;
		const page = await this.state.storage.get<PendingPage>(PENDING_KEY);
		if (!page || page.page_id !== nextPayload.page_id) throw new Error("Direct-write page state is unavailable.");
		const job = await this.loadJob();
		const batchSequence = page.batch_sequence + 1;
		const batchRecords = page.records.slice(0, job.config.classification_batch_size);
		const remainingRecords = page.records.slice(batchRecords.length);
		const batchPage: PendingPage = {
			...page,
			page_id: `${page.page_id}-B${String(batchSequence).padStart(3, "0")}`,
			batch_sequence: batchSequence,
			records: batchRecords,
			query_exhausted: page.query_exhausted && remainingRecords.length === 0,
		};
		const output = await buildDirectWriteBatch(batchPage);
		await this.state.storage.put(`${DIRECT_WRITE_PREFIX}${batchPage.page_id}`, output);
		if (remainingRecords.length) {
			await this.state.storage.put(PENDING_KEY, { ...page, batch_sequence: batchSequence, records: remainingRecords });
		} else {
			await this.state.storage.delete(PENDING_KEY);
		}
		job.totals.direct_records_delivered = (job.totals.direct_records_delivered ?? 0) + output.record_count;
		await this.saveJob(job);
		return json(output);
	}

	private async signedInboxRecord(
		corpusId: string,
		batch: DirectWriteBatch,
		record: DirectWriteRecord,
		stagedAt: string,
	): Promise<InboxSheetRow> {
		const envelopeId = (await sha256(`${corpusId}|${batch.run_id}|${batch.page_id}|${record.record_id}|${record.canonical_row_hash}`)).slice(0, 32);
		const payload: InboxRecordPayload = {
			v: 1,
			kind: "scholarly_inbox_record",
			corpus_id: corpusId,
			envelope_id: envelopeId,
			staged_at: stagedAt,
			job_handle: batch.job_handle,
			run_id: batch.run_id,
			page_id: batch.page_id,
			registry_headers: batch.registry_headers,
			registry_row: record.registry_row,
			canonical_row_hash: record.canonical_row_hash,
			screening: record.screening,
		};
		const signed = await signInboxPayload(this.state.storage, payload as unknown as Record<string, unknown>);
		if (signed.length > INBOX_CELL_MAX_CHARS) throw new Error(`Signed inbox record exceeds ${INBOX_CELL_MAX_CHARS} characters.`);
		return [envelopeId, signed, "record", corpusId, batch.run_id, record.record_id, record.canonical_row_hash, stagedAt, "pending", ""];
	}

	private async createInboxRecordDelivery(corpusId: string, batch: DirectWriteBatch): Promise<InboxPendingDelivery> {
		const stagedAt = new Date().toISOString();
		const rows: InboxSheetRow[] = [];
		for (const record of batch.records) rows.push(await this.signedInboxRecord(corpusId, batch, record, stagedAt));
		const pending: InboxPendingDelivery = {
			v: 1,
			status: "inbox_ready",
			corpus_id: corpusId,
			delivery_id: `inbox-records:${batch.run_id}:${batch.page_id}`,
			job_handle: batch.job_handle,
			run_id: batch.run_id,
			payload_kind: "record",
			page_id: batch.page_id,
			envelope_count: rows.length,
			envelope_digest: await sha256(rows.map((row) => row[1]).join("\n")),
			rows,
		};
		await this.state.storage.put(INBOX_PENDING_KEY, pending);
		return pending;
	}

	private async finalizeDirectWrite(): Promise<Record<string, unknown>> {
		const existing = await this.state.storage.get<Record<string, unknown>>(FINAL_KEY);
		if (existing?.status === "direct_write_finalized") return existing;
		const job = await this.loadJob();
		if (await this.state.storage.get(PENDING_KEY)) throw new Error("Cannot finalize while a direct-write page is pending.");
		if (job.status !== "complete") throw new Error("Cannot finalize before retrieval finishes.");
		const journalsFailed = job.coverage.filter((coverage) => coverage.query_families_failed > 0).length;
		const output = {
			status: "direct_write_finalized",
			job_handle: job.config.job_handle,
			run_id: job.config.run_id,
			retrieval_exhausted: journalsFailed === 0,
			journals_completed: job.coverage.length - journalsFailed,
			journals_failed: journalsFailed,
			registry_records_retrieved: job.totals.registry_records_retrieved,
			prefiltered_records: job.totals.prefiltered_records,
			duplicate_occurrences: job.totals.duplicate_occurrences,
			direct_records_delivered: job.totals.direct_records_delivered ?? 0,
			candidate_count: job.totals.candidate_count,
			exclusion_count: job.totals.exclusion_count,
		};
		job.status = "finalized";
		await this.state.storage.put(FINAL_KEY, output);
		await this.saveJob(job);
		return output;
	}

	private async createInboxRunDelivery(corpusId: string): Promise<Response> {
		const pending = await this.state.storage.get<InboxPendingDelivery>(INBOX_PENDING_KEY);
		if (pending) return json(pending);
		let job = await this.loadJob();
		const deliveryId = `inbox-run:${job.config.run_id}`;
		if (await this.state.storage.get(`${INBOX_ACK_PREFIX}${deliveryId}`)) {
			return json({ status: "inbox_cycle_complete", corpus_id: corpusId, job_handle: job.config.job_handle, run_id: job.config.run_id, search_date: job.config.search_date });
		}
		if (job.status === "running") throw new Error("Cannot stage a run manifest before retrieval completes.");
		const finalized = await this.finalizeDirectWrite();
		job = await this.loadJob();
		const stagedAt = new Date().toISOString();
		const envelopeId = (await sha256(`${corpusId}|${job.config.run_id}|run-manifest`)).slice(0, 32);
		const payload: InboxRunPayload = {
			v: 1,
			kind: "scholarly_inbox_run",
			corpus_id: corpusId,
			envelope_id: envelopeId,
			staged_at: stagedAt,
			job_handle: job.config.job_handle,
			run_id: job.config.run_id,
			operation: job.config.operation,
			search_date: job.config.search_date,
			config_version: job.config.config_version,
			config_hash: job.config.config_hash,
			retrieval_exhausted: Boolean(finalized.retrieval_exhausted),
			journals_completed: Number(finalized.journals_completed ?? 0),
			journals_failed: Number(finalized.journals_failed ?? 0),
			registry_records_retrieved: Number(finalized.registry_records_retrieved ?? 0),
			prefiltered_records: Number(finalized.prefiltered_records ?? 0),
			duplicate_occurrences: Number(finalized.duplicate_occurrences ?? 0),
			direct_records_delivered: Number(finalized.direct_records_delivered ?? 0),
			candidate_count: Number(finalized.candidate_count ?? 0),
			exclusion_count: Number(finalized.exclusion_count ?? 0),
			coverage: job.coverage,
		};
		const signed = await signInboxPayload(this.state.storage, payload as unknown as Record<string, unknown>);
		if (signed.length > INBOX_CELL_MAX_CHARS) throw new Error("Signed inbox run manifest exceeds the Google Sheets cell limit.");
		const row: InboxSheetRow = [envelopeId, signed, "run_manifest", corpusId, job.config.run_id, "", "", stagedAt, "pending", ""];
		const delivery: InboxPendingDelivery = {
			v: 1,
			status: "inbox_ready",
			corpus_id: corpusId,
			delivery_id: deliveryId,
			job_handle: job.config.job_handle,
			run_id: job.config.run_id,
			payload_kind: "run_manifest",
			envelope_count: 1,
			envelope_digest: await sha256(signed),
			rows: [row],
		};
		await this.state.storage.put(INBOX_PENDING_KEY, delivery);
		return json(delivery);
	}

	private async nextInbox(corpusId: string, maxRegistryPages: number): Promise<Response> {
		if (!corpusId.trim()) throw new Error("corpus_id is required.");
		const pending = await this.state.storage.get<InboxPendingDelivery>(INBOX_PENDING_KEY);
		if (pending) {
			if (pending.corpus_id !== corpusId) throw new Error("Pending inbox delivery belongs to another corpus.");
			return json(pending);
		}
		const job = await this.loadJob();
		if (job.status !== "running") return this.createInboxRunDelivery(corpusId);
		const response = await this.nextDirectWriteBatch(Math.max(1, Math.min(5, maxRegistryPages)));
		const payload = (await response.clone().json()) as Record<string, unknown>;
		if (payload.status === "batch_ready") return json(await this.createInboxRecordDelivery(corpusId, payload as unknown as DirectWriteBatch));
		if (payload.status === "job_complete") return this.createInboxRunDelivery(corpusId);
		return response;
	}

	private async acknowledgeInbox(body: Record<string, unknown>): Promise<Response> {
		const pending = await this.state.storage.get<InboxPendingDelivery>(INBOX_PENDING_KEY);
		if (!pending) throw new Error("No inbox delivery is pending acknowledgement.");
		if (body.delivery_id !== pending.delivery_id || body.envelope_digest !== pending.envelope_digest || Number(body.envelope_count) !== pending.envelope_count) {
			throw new Error("Inbox delivery acknowledgement reconciliation failed.");
		}
		if (pending.payload_kind === "record") {
			const candidateCount = Number(body.candidate_count);
			const exclusionCount = Number(body.exclusion_count);
			if (!Number.isInteger(candidateCount) || candidateCount < 0 || !Number.isInteger(exclusionCount) || exclusionCount < 0 || candidateCount + exclusionCount !== pending.envelope_count || !pending.page_id) {
				throw new Error("Inbox classification-count reconciliation failed.");
			}
			const outcomeKey = `inbox-outcomes:${pending.delivery_id}`;
			if (!(await this.state.storage.get(outcomeKey))) {
				const batch = await this.state.storage.get<DirectWriteBatch>(`${DIRECT_WRITE_PREFIX}${pending.page_id}`);
				if (!batch || batch.record_count !== pending.envelope_count) throw new Error("Inbox direct-write batch is unavailable.");
				const job = await this.loadJob();
				const coverage = job.coverage.find((entry) => entry.issn === batch.issn && entry.journal === batch.journal);
				if (!coverage) throw new Error("Inbox coverage row is unavailable.");
				coverage.unique_records_screened += pending.envelope_count;
				coverage.candidate_count += candidateCount;
				coverage.exclusion_count += exclusionCount;
				job.totals.unique_records_screened += pending.envelope_count;
				job.totals.candidate_count += candidateCount;
				job.totals.exclusion_count += exclusionCount;
				await this.saveJob(job);
				await this.state.storage.put(outcomeKey, true);
			}
		}
		const acknowledgement = {
			status: "inbox_acknowledged",
			corpus_id: pending.corpus_id,
			delivery_id: pending.delivery_id,
			job_handle: pending.job_handle,
			run_id: pending.run_id,
			payload_kind: pending.payload_kind,
			envelope_count: pending.envelope_count,
			envelope_digest: pending.envelope_digest,
			acknowledged_at: new Date().toISOString(),
		};
		await this.state.storage.put(`${INBOX_ACK_PREFIX}${pending.delivery_id}`, acknowledgement);
		await this.state.storage.delete(INBOX_PENDING_KEY);
		return json(acknowledgement);
	}

	private async startIncrementalCycle(searchDate: string, overlapDays: number, minimumGapDays: number): Promise<Response> {
		const previous = await this.loadJob();
		if (previous.status !== "finalized") throw new Error("The current corpus cycle must be finalized before starting an incremental cycle.");
		if (dayDifference(searchDate, previous.config.search_date) < minimumGapDays) {
			return json({
				status: "incremental_cycle_not_due",
				job_handle: previous.config.job_handle,
				run_id: previous.config.run_id,
				previous_search_date: previous.config.search_date,
				next_eligible_date: addDays(previous.config.search_date, minimumGapDays),
				minimum_gap_days: minimumGapDays,
			});
		}
		const config: JobConfig = {
			...previous.config,
			delivery_mode: "direct_write",
			run_id: `RUN-${searchDate.replace(/-/g, "")}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`,
			operation: "INCREMENTAL",
			corpus_mode: "incremental",
			search_date: searchDate,
			from_index_date: subtractDays(searchDate, overlapDays),
			until_index_date: searchDate,
			until_publication_date: undefined,
			created_at: new Date().toISOString(),
		};
		const next = newJobState(config);
		await this.state.storage.delete(FINAL_KEY);
		await this.state.storage.put(STATE_KEY, next);
		return json({
			status: "incremental_cycle_started",
			job_handle: config.job_handle,
			run_id: config.run_id,
			search_date: config.search_date,
			from_index_date: config.from_index_date,
			until_index_date: config.until_index_date,
			overlap_days: overlapDays,
		});
	}

	private async status(): Promise<Response> {
		const job = await this.loadJob();
		const pending = await this.state.storage.get<PendingPage>(PENDING_KEY);
		return json({
			status: job.status,
			job_handle: job.config.job_handle,
			run_id: job.config.run_id,
			config_version: job.config.config_version,
			config_hash: job.config.config_hash,
			operation: job.config.operation,
			delivery_mode: "direct_write",
			search_date: job.config.search_date,
			current_journal_index: job.journal_index,
			current_query_index: job.query_index,
			current_offset: job.offset,
			pending_page_id: pending?.page_id ?? null,
			delivery_pending_count: (await this.state.storage.get(INBOX_PENDING_KEY)) ? 1 : 0,
			totals: job.totals,
			coverage: job.coverage,
		});
	}

	async fetch(request: Request): Promise<Response> {
		try {
			if (request.method !== "POST") return json({ error: "POST required." }, 405);
			const path = new URL(request.url).pathname;
			const body = (await request.json()) as Record<string, unknown>;
			switch (path) {
				case "/initialize": return await this.initialize(body.config as JobConfig);
				case "/bind-config": return await this.bindConfiguration(body);
				case "/next-inbox": return await this.nextInbox(String(body.corpus_id ?? ""), Number(body.max_registry_pages ?? 3));
				case "/ack-inbox": return await this.acknowledgeInbox(body);
				case "/inbox-public-key": return json(await inboxPublicKey(this.state.storage));
				case "/start-incremental": return await this.startIncrementalCycle(String(body.search_date), Number(body.overlap_days ?? 60), Number(body.minimum_gap_days ?? 7));
				case "/status": return await this.status();
				default: return json({ error: "Unknown job-store route." }, 404);
			}
		} catch (error) {
			return json({ error: error instanceof Error ? error.message : "Unknown corpus-job error." }, 400);
		}
	}
}

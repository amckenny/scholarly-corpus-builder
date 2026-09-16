import { corpusById } from "./corpora";
import { DIRECT_WRITE_HEADERS } from "./direct-write";
import { classifyRecord } from "./gemini-classifier";
import {
	ensureDecisionRow,
	ensureHeadlessSheets,
	ensureInboxAuditRow,
	ensureRegistryRow,
	ensureRunRow,
	existingDecisionRow,
	loadHeadlessSheetIndex,
	markInboxProcessed,
	type HeadlessSheetIndex,
	type SheetNames,
} from "./google-sheets";
import { verifyInboxPayload } from "./inbox-signing";
import { sha256 } from "./token";
import type {
	CorpusInboxConfig,
	DirectWriteRecord,
	HeadlessClassification,
	InboxPendingDelivery,
	InboxRecordPayload,
	InboxRunPayload,
	InboxSheetRow,
	JobConfig,
	WorkerEnv,
} from "./types";

const MAX_DISCOVERY_STEPS_PER_RUN = 24;

type ProcessingTotals = {
	processed: number;
	records: number;
	run_manifests: number;
	duplicates: number;
	candidates: number;
	exclusions: number;
};

type PublicKey = { kid: string; public_jwk: JsonWebKey };

function sheetNames(config: CorpusInboxConfig): SheetNames {
	return {
		inbox: config.inbox_sheet,
		registry: config.registry_sheet,
		decisions: config.decisions_sheet,
		runs: config.runs_sheet,
		corpus: config.corpus_sheet,
		excluded: config.excluded_sheet,
	};
}

async function corpusStoreRequest(
	env: WorkerEnv,
	config: CorpusInboxConfig,
	path: string,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const id = env.CORPUS_JOBS.idFromName(config.job_handle);
	const response = await env.CORPUS_JOBS.get(id).fetch(`https://corpus-job${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const value = (await response.json()) as Record<string, unknown>;
	if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Corpus headless operation failed.");
	return value;
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

function subtractYears(value: string, years: number): string {
	const [year, month, day] = value.split("-").map(Number);
	const targetYear = year - years;
	const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
	return `${String(targetYear).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}

export function initialJobConfig(config: CorpusInboxConfig, searchDate = today()): JobConfig {
	return {
		v: 1,
		config_version: config.config_version,
		config_hash: config.config_hash,
		delivery_mode: "direct_write",
		job_handle: config.job_handle,
		run_id: `${config.corpus_id.toUpperCase()}-INITIAL-${searchDate.replace(/-/g, "")}`,
		operation: "INITIAL",
		corpus_mode: "initial",
		search_date: searchDate,
		journals: config.journals,
		query_families: config.query_families,
		until_index_date: searchDate,
		from_publication_date: subtractYears(searchDate, config.initial_lookback_years),
		until_publication_date: searchDate,
		source_types: config.source_types,
		rows_per_page: config.rows_per_page,
		retrieval_gate: config.retrieval_gate,
		classification_batch_size: config.processing.classification_batch_size,
		created_at: new Date().toISOString(),
	};
}

async function ensureJob(env: WorkerEnv, config: CorpusInboxConfig): Promise<void> {
	try {
		const status = await corpusStoreRequest(env, config, "/status", {});
		if (typeof status.config_hash === "string" && status.config_hash !== config.config_hash) {
			throw new Error(`Corpus configuration changed for ${config.corpus_id}; start an explicit migration or use a new corpus job handle.`);
		}
		if (status.config_hash == null) {
			await corpusStoreRequest(env, config, "/bind-config", {
				config_version: config.config_version,
				config_hash: config.config_hash,
			});
		}
		return;
	} catch (error) {
		if (!(error instanceof Error) || !/Unknown corpus job/.test(error.message)) throw error;
	}
	await corpusStoreRequest(env, config, "/initialize", { config: initialJobConfig(config) });
}

function exactStringArray(value: unknown, length: number, label: string): string[] {
	if (!Array.isArray(value) || value.length !== length || value.some((cell) => typeof cell !== "string")) {
		throw new Error(`${label} must contain exactly ${length} strings.`);
	}
	return value;
}

function exactObject(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`);
	return value as Record<string, unknown>;
}

async function verifiedRecordPayload(
	token: string,
	queueRow: InboxSheetRow,
	config: CorpusInboxConfig,
	key: PublicKey,
): Promise<{ payload: InboxRecordPayload; record: DirectWriteRecord }> {
	const decoded = await verifyInboxPayload(token, key.public_jwk, key.kid);
	if (decoded.v !== 1 || decoded.kind !== "scholarly_inbox_record" || decoded.corpus_id !== config.corpus_id) {
		throw new Error("Signed inbox record identity is invalid.");
	}
	for (const [field, expected] of [
		["envelope_id", queueRow[0]],
		["run_id", queueRow[4]],
		["canonical_row_hash", queueRow[6]],
	] as const) if (decoded[field] !== expected) throw new Error(`Signed inbox record ${field} does not match its queue row.`);
	const headers = exactStringArray(decoded.registry_headers, DIRECT_WRITE_HEADERS.length, "Signed registry_headers");
	if (headers.some((header, index) => header !== DIRECT_WRITE_HEADERS[index])) throw new Error("Signed registry headers do not match Direct Registry.");
	const registryRow = exactStringArray(decoded.registry_row, DIRECT_WRITE_HEADERS.length, "Signed registry_row");
	if (registryRow[0] !== queueRow[5]) throw new Error("Signed Record ID does not match its queue row.");
	const canonicalRowHash = await sha256(JSON.stringify(registryRow.slice(0, 30)));
	if (canonicalRowHash !== registryRow[30] || canonicalRowHash !== queueRow[6]) {
		throw new Error("Signed canonical Registry row hash is invalid.");
	}
	const screening = exactObject(decoded.screening, "Signed screening object");
	if (
		!(screening.title === null || typeof screening.title === "string") ||
		!(screening.abstract_excerpt === null || typeof screening.abstract_excerpt === "string") ||
		typeof screening.abstract_truncated !== "boolean" ||
		!(screening.hard_exclusion_reason === null || typeof screening.hard_exclusion_reason === "string")
	) throw new Error("Signed screening object has invalid fields.");
	return {
		payload: decoded as unknown as InboxRecordPayload,
		record: {
			record_id: registryRow[0],
			registry_row: registryRow,
			canonical_row_hash: canonicalRowHash,
			screening: screening as DirectWriteRecord["screening"],
		},
	};
}

async function verifiedRunPayload(
	token: string,
	queueRow: InboxSheetRow,
	config: CorpusInboxConfig,
	key: PublicKey,
): Promise<InboxRunPayload> {
	const decoded = await verifyInboxPayload(token, key.public_jwk, key.kid);
	if (
		decoded.v !== 1 || decoded.kind !== "scholarly_inbox_run" || decoded.corpus_id !== config.corpus_id ||
		decoded.envelope_id !== queueRow[0] || decoded.run_id !== queueRow[4]
	) throw new Error("Signed inbox run manifest identity is invalid.");
	if (decoded.retrieval_exhausted !== true) throw new Error("Run manifest does not certify exhaustive retrieval.");
	if (decoded.config_hash && decoded.config_hash !== config.config_hash) {
		throw new Error("Signed run manifest configuration hash does not match the active corpus configuration.");
	}
	return decoded as unknown as InboxRunPayload;
}

function classificationFromDecisionRow(row: string[], config: CorpusInboxConfig): HeadlessClassification {
	const classification = row[2];
	if (!config.screening.classifications.some((candidate) => candidate.id === classification)) {
		throw new Error("Existing Direct Decisions row has an invalid classification.");
	}
	const confidence = row[5];
	if (confidence !== "high" && confidence !== "medium" && confidence !== "low") {
		throw new Error("Existing Direct Decisions row has an invalid confidence.");
	}
	return { classification, fit_basis: row[3], exclusion_reason: row[4], confidence };
}

function addClassificationTotal(totals: ProcessingTotals, classification: string, config: CorpusInboxConfig): void {
	const specification = config.screening.classifications.find((candidate) => candidate.id === classification);
	if (!specification) throw new Error("Classification is not defined by the active corpus configuration.");
	if (specification.disposition === "candidate") totals.candidates += 1;
	else totals.exclusions += 1;
}

async function processRecord(
	env: WorkerEnv,
	config: CorpusInboxConfig,
	names: SheetNames,
	index: HeadlessSheetIndex,
	queueRow: InboxSheetRow,
	key: PublicKey,
	totals: ProcessingTotals,
): Promise<void> {
	const queueState = await ensureInboxAuditRow(env, config.spreadsheet_id, names, index, queueRow);
	const { payload, record } = await verifiedRecordPayload(queueRow[1], queueRow, config, key);
	const registry = await ensureRegistryRow(env, config.spreadsheet_id, names, index, record.registry_row);
	let decision = await existingDecisionRow(env, config.spreadsheet_id, names, index, record.record_id, record.canonical_row_hash);
	let classification: HeadlessClassification;
	if (decision) {
		classification = classificationFromDecisionRow(decision, config);
		totals.duplicates += 1;
	} else {
		classification = await classifyRecord(record, env, config.screening);
		decision = [
			record.record_id,
			record.canonical_row_hash,
			classification.classification,
			classification.fit_basis,
			classification.exclusion_reason,
			classification.confidence,
			payload.run_id,
			payload.page_id,
			new Date().toISOString(),
			"verified",
		];
		await ensureDecisionRow(env, config.spreadsheet_id, names, index, decision);
	}
	if (queueState.status !== "processed") {
		const note = registry.duplicate ? `duplicate_verified:${classification.classification}` : `record_verified:${classification.classification}`;
		await markInboxProcessed(env, config.spreadsheet_id, names, index, queueRow[0], note);
	}
	totals.processed += 1;
	totals.records += 1;
	addClassificationTotal(totals, classification.classification, config);
}

function runRow(payload: InboxRunPayload, index: HeadlessSheetIndex, config: CorpusInboxConfig): string[] {
	const registryAdded = [...index.registry.values()].filter((entry) => entry.run_id === payload.run_id).length;
	const decisions = [...index.decisions.values()].filter((entry) => entry.run_id === payload.run_id && entry.status === "verified");
	const durableIds = new Set(config.screening.classifications.filter((entry) => entry.durable_exclusion).map((entry) => entry.id));
	const unresolvedIds = new Set(config.screening.classifications.filter((entry) => entry.unresolved).map((entry) => entry.id));
	const durableExclusions = decisions.filter((entry) => durableIds.has(entry.classification)).length;
	const unresolved = decisions.filter((entry) => unresolvedIds.has(entry.classification)).length;
	const failedScope = payload.coverage.filter((entry) => entry.query_families_failed > 0).map((entry) => entry.journal);
	const limitations = payload.coverage.flatMap((entry) => entry.limitations).filter(Boolean);
	if (payload.prefiltered_records > 0) {
		limitations.push(`Deterministic retrieval gate filtered ${payload.prefiltered_records} Crossref records before classification.`);
	}
	limitations.push(`Corpus configuration v${config.config_version}: ${config.config_hash}`);
	return [
		payload.run_id,
		payload.operation,
		payload.operation.toLowerCase(),
		"manifest",
		failedScope.length ? "registry_metadata_verified_partial" : "registry_metadata_verified",
		String(registryAdded),
		"0",
		String(durableExclusions),
		String(unresolved),
		failedScope.join("; "),
		payload.search_date,
		limitations.join("; "),
		payload.operation === "INITIAL" ? "Continue with scheduled incremental updates." : "Await the next scheduled incremental window.",
	];
}

async function processRunManifest(
	env: WorkerEnv,
	config: CorpusInboxConfig,
	names: SheetNames,
	index: HeadlessSheetIndex,
	queueRow: InboxSheetRow,
	key: PublicKey,
	totals: ProcessingTotals,
): Promise<void> {
	const queueState = await ensureInboxAuditRow(env, config.spreadsheet_id, names, index, queueRow);
	const payload = await verifiedRunPayload(queueRow[1], queueRow, config, key);
	await ensureRunRow(env, config.spreadsheet_id, names, index, runRow(payload, index, config));
	if (queueState.status !== "processed") {
		await markInboxProcessed(env, config.spreadsheet_id, names, index, queueRow[0], "run_manifest_verified");
	}
	totals.processed += 1;
	totals.run_manifests += 1;
}

async function processQueueRow(
	env: WorkerEnv,
	config: CorpusInboxConfig,
	names: SheetNames,
	index: HeadlessSheetIndex,
	queueRow: InboxSheetRow,
	key: PublicKey,
	totals: ProcessingTotals,
): Promise<void> {
	if (queueRow.length !== 10 || queueRow.some((value) => typeof value !== "string")) throw new Error("Inbound Queue row is malformed.");
	if (queueRow[2] === "record") return processRecord(env, config, names, index, queueRow, key, totals);
	if (queueRow[2] === "run_manifest") return processRunManifest(env, config, names, index, queueRow, key, totals);
	throw new Error("Inbound Queue payload kind is unsupported.");
}

async function publicKey(env: WorkerEnv, config: CorpusInboxConfig): Promise<PublicKey> {
	const value = await corpusStoreRequest(env, config, "/inbox-public-key", {});
	if (typeof value.kid !== "string" || !value.public_jwk || typeof value.public_jwk !== "object") {
		throw new Error("Inbox public key is unavailable.");
	}
	return { kid: value.kid, public_jwk: value.public_jwk as JsonWebKey };
}

async function acknowledge(
	env: WorkerEnv,
	config: CorpusInboxConfig,
	delivery: InboxPendingDelivery,
	totals: ProcessingTotals,
): Promise<void> {
	await corpusStoreRequest(env, config, "/ack-inbox", {
		delivery_id: delivery.delivery_id,
		envelope_count: delivery.envelope_count,
		envelope_digest: delivery.envelope_digest,
		candidate_count: totals.candidates,
		exclusion_count: totals.exclusions,
	});
}

export async function runCorpusHeadless(env: WorkerEnv, config: CorpusInboxConfig): Promise<Record<string, unknown>> {
	const names = sheetNames(config);
	await ensureHeadlessSheets(env, config.spreadsheet_id, names, DIRECT_WRITE_HEADERS);
	await ensureJob(env, config);
	const key = await publicKey(env, config);
	const index = await loadHeadlessSheetIndex(env, config.spreadsheet_id, names);
	const totals: ProcessingTotals = { processed: 0, records: 0, run_manifests: 0, duplicates: 0, candidates: 0, exclusions: 0 };
	const processingLimit = config.processing.classification_batch_size;
	let lastStatus = "initialized";
	for (let step = 0; step < MAX_DISCOVERY_STEPS_PER_RUN && totals.processed < processingLimit; step += 1) {
		const next = await corpusStoreRequest(env, config, "/next-inbox", { corpus_id: config.corpus_id, max_registry_pages: 4 });
		lastStatus = String(next.status ?? "unknown");
		if (next.status === "inbox_ready") {
			const delivery = next as unknown as InboxPendingDelivery;
			if (totals.processed + delivery.envelope_count > processingLimit) break;
			const deliveryTotals: ProcessingTotals = { processed: 0, records: 0, run_manifests: 0, duplicates: 0, candidates: 0, exclusions: 0 };
			for (const row of delivery.rows) await processQueueRow(env, config, names, index, row, key, deliveryTotals);
			await acknowledge(env, config, delivery, deliveryTotals);
			for (const field of Object.keys(totals) as Array<keyof ProcessingTotals>) totals[field] += deliveryTotals[field];
			continue;
		}
		if (next.status === "retrieval_progress") continue;
		if (next.status === "inbox_cycle_complete") {
			const searchDate = new Date().toISOString().slice(0, 10);
			const incremental = await corpusStoreRequest(env, config, "/start-incremental", {
				search_date: searchDate,
				overlap_days: config.overlap_days,
				minimum_gap_days: config.minimum_gap_days,
			});
			lastStatus = String(incremental.status ?? "unknown");
			if (incremental.status === "incremental_cycle_started") continue;
		}
		break;
	}
	const pendingRows = [...index.inbox.values()].filter((entry) => entry.status === "pending").length;
	return {
		corpus_id: config.corpus_id,
		status: lastStatus,
		processed_count: totals.processed,
		record_count: totals.records,
		run_manifest_count: totals.run_manifests,
		duplicate_count: totals.duplicates,
		candidate_count: totals.candidates,
		exclusion_count: totals.exclusions,
		pending_queue_count: pendingRows,
	};
}

export async function runConfiguredCorpus(env: WorkerEnv, corpusId: string): Promise<Record<string, unknown>> {
	const config = corpusById(env, corpusId);
	if (!config) throw new Error(`Unknown corpus_id: ${corpusId}.`);
	return runCorpusHeadless(env, config);
}

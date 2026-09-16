export type WorkerEnv = {
	CROSSREF_MAILTO?: string;
	GEMINI_API_KEY?: string;
	GEMINI_MODEL?: string;
	SCHOLARLY_RUN_SECRET?: string;
	GOOGLE_SERVICE_ACCOUNT_EMAIL?: string;
	GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?: string;
	SCHOLARLY_CORPUS_SPREADSHEETS?: string;
	CORPUS_JOBS: DurableObjectNamespace;
	CORPUS_RUNNERS: DurableObjectNamespace;
};

export type CorpusRetrievalGateConfig = {
	exclude_title_prefixes: string[];
	include_any_phrases: string[];
	include_all_groups: string[][];
};

export type CorpusProcessingConfig = {
	classification_batch_size: number;
	continuation_delay_seconds: number;
	max_backoff_seconds: number;
};

export type CorpusClassificationSpec = {
	id: string;
	description: string;
	disposition: "candidate" | "excluded";
	durable_exclusion: boolean;
	unresolved: boolean;
};

export type CorpusScreeningConfig = {
	version: number;
	objective: string;
	include_when: string[];
	exclude_when: string[];
	hard_exclusion_classification: string;
	unresolved_classification: string;
	classifications: CorpusClassificationSpec[];
};

export type CorpusInboxConfig = {
	schema_version: number;
	config_version: number;
	config_hash: string;
	display_name: string;
	spreadsheet_key: string;
	corpus_id: string;
	job_handle: string;
	spreadsheet_id: string;
	inbox_sheet: string;
	registry_sheet: string;
	decisions_sheet: string;
	runs_sheet: string;
	corpus_sheet: string;
	excluded_sheet: string;
	initial_lookback_years: number;
	journals: JournalSpec[];
	query_families: QueryFamily[];
	source_types: string[];
	rows_per_page: number;
	retrieval_gate: CorpusRetrievalGateConfig;
	processing: CorpusProcessingConfig;
	overlap_days: number;
	minimum_gap_days: number;
	screening: CorpusScreeningConfig;
};

export type CanonicalRecord = {
	record_id: string;
	registry: "Crossref";
	doi: string | null;
	title: string | null;
	authors: string;
	container_title: string | null;
	issn: string[];
	publisher: string | null;
	publication_date: string | null;
	published_online: string | null;
	published_print: string | null;
	volume: string | null;
	issue: string | null;
	pages: string | null;
	article_number: string | null;
	source_type: string | null;
	doi_url: string | null;
	verification_level: "registry_metadata_and_abstract" | "registry_metadata_only";
	evidence_depth: "Registry abstract inspected" | "Registry abstract excerpt inspected" | "Registry metadata only";
	retrieved_at: string;
	metadata_url: string;
	cache_status: "hit" | "miss" | "bypass";
	registry_record_hash: string;
	discovered_by_query_ids: string[];
	expected_journal: string;
	expected_issn: string;
	hard_exclusion_reason: string | null;
};

export type ClassificationConfidence = "high" | "medium" | "low";

export type HeadlessClassification = {
	classification: string;
	fit_basis: string;
	exclusion_reason: string;
	confidence: ClassificationConfidence;
};

export type JournalSpec = { journal: string; issn: string };
export type QueryFamily = { query_id: string; label: string; query: string };

export type JobConfig = {
	v: 1;
	config_version?: number;
	config_hash?: string;
	delivery_mode?: "direct_write";
	job_handle: string;
	run_id: string;
	operation: "INITIAL" | "INCREMENTAL";
	corpus_mode: "initial" | "incremental";
	search_date: string;
	journals: JournalSpec[];
	query_families: QueryFamily[];
	from_index_date?: string;
	until_index_date?: string;
	from_publication_date?: string;
	until_publication_date?: string;
	source_types: string[];
	rows_per_page: number;
	retrieval_gate: CorpusRetrievalGateConfig;
	classification_batch_size: number;
	created_at: string;
};

export type DirectWriteRecord = {
	record_id: string;
	registry_row: string[];
	canonical_row_hash: string;
	screening: {
		title: string | null;
		abstract_excerpt: string | null;
		abstract_truncated: boolean;
		hard_exclusion_reason: string | null;
	};
};

export type DirectWriteBatch = {
	status: "batch_ready";
	job_handle: string;
	run_id: string;
	page_id: string;
	journal: string;
	issn: string;
	query_id: string;
	record_count: number;
	registry_headers: string[];
	records: DirectWriteRecord[];
	batch_hash: string;
	query_exhausted: boolean;
};

export type InboxRecordPayload = {
	v: 1;
	kind: "scholarly_inbox_record";
	corpus_id: string;
	envelope_id: string;
	staged_at: string;
	job_handle: string;
	run_id: string;
	page_id: string;
	registry_headers: string[];
	registry_row: string[];
	canonical_row_hash: string;
	screening: DirectWriteRecord["screening"];
};

export type JournalCoverage = {
	journal: string;
	issn: string;
	query_families_expected: number;
	query_families_completed: number;
	query_families_failed: number;
	registry_records_retrieved: number;
	prefiltered_records: number;
	duplicate_occurrences: number;
	unique_records_screened: number;
	candidate_count: number;
	exclusion_count: number;
	limitations: string[];
};

export type InboxRunPayload = {
	v: 1;
	kind: "scholarly_inbox_run";
	corpus_id: string;
	envelope_id: string;
	staged_at: string;
	job_handle: string;
	run_id: string;
	operation: JobConfig["operation"];
	search_date: string;
	config_version?: number;
	config_hash?: string;
	retrieval_exhausted: boolean;
	journals_completed: number;
	journals_failed: number;
	registry_records_retrieved: number;
	prefiltered_records: number;
	duplicate_occurrences: number;
	direct_records_delivered: number;
	candidate_count: number;
	exclusion_count: number;
	coverage: JournalCoverage[];
};

export type InboxSheetRow = [
	envelope_id: string,
	signed_payload: string,
	payload_kind: "record" | "run_manifest",
	corpus_id: string,
	run_id: string,
	record_id: string,
	canonical_row_hash: string,
	staged_at: string,
	processing_status: "pending",
	processing_note: string,
];

export type InboxPendingDelivery = {
	v: 1;
	status: "inbox_ready";
	corpus_id: string;
	delivery_id: string;
	job_handle: string;
	run_id: string;
	payload_kind: "record" | "run_manifest";
	page_id?: string;
	envelope_count: number;
	envelope_digest: string;
	rows: InboxSheetRow[];
};

export type JobState = {
	v: 1;
	config: JobConfig;
	status: "running" | "complete" | "finalized";
	journal_index: number;
	query_index: number;
	offset: number;
	partition_year: number | null;
	partition_end_year: number | null;
	page_sequence: number;
	totals: {
		registry_records_retrieved: number;
		prefiltered_records: number;
		duplicate_occurrences: number;
		unique_records_screened: number;
		candidate_count: number;
		exclusion_count: number;
		direct_records_delivered?: number;
	};
	coverage: JournalCoverage[];
	started_at: string;
	updated_at: string;
};

export type PendingPage = {
	v: 1;
	job_handle: string;
	run_id: string;
	page_id: string;
	batch_sequence: number;
	journal_index: number;
	query_index: number;
	journal: string;
	issn: string;
	query_family: QueryFamily;
	offset_start: number;
	offset_end: number;
	total_results: number | null;
	query_exhausted: boolean;
	records: Array<{
		canonical: CanonicalRecord;
		abstract_excerpt: string | null;
		abstract_truncated: boolean;
		retrieval_gate_reason: string | null;
	}>;
	retrieved_at: string;
};

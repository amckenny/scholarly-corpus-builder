import { GENERATED_CORPUS_CONFIGS } from "./generated-corpus-configs";
import type {
	CorpusInboxConfig,
	CorpusProcessingConfig,
	CorpusRetrievalGateConfig,
	CorpusScreeningConfig,
	JournalSpec,
	QueryFamily,
	WorkerEnv,
} from "./types";

type GeneratedCorpusConfig = {
	schema_version: number;
	config_version: number;
	config_hash: string;
	enabled: boolean;
	corpus_id: string;
	display_name: string;
	spreadsheet_key: string;
	job_handle: string;
	initial_load: { lookback_years: number };
	discovery: {
		source_types: readonly string[];
		rows_per_page: number;
		journals: readonly JournalSpec[];
		query_families: readonly QueryFamily[];
		retrieval_gate: CorpusRetrievalGateConfig;
	};
	processing: CorpusProcessingConfig;
	screening: CorpusScreeningConfig;
	incremental_updates: { overlap_days: number; minimum_gap_days: number };
};

const DEFINITIONS = GENERATED_CORPUS_CONFIGS as unknown as readonly GeneratedCorpusConfig[];

function spreadsheetMappings(env: WorkerEnv): Record<string, string> {
	const raw = env.SCHOLARLY_CORPUS_SPREADSHEETS?.trim();
	if (!raw) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("SCHOLARLY_CORPUS_SPREADSHEETS must be a valid JSON object.");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("SCHOLARLY_CORPUS_SPREADSHEETS must be a valid JSON object.");
	}
	const mappings: Record<string, string> = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key) || typeof value !== "string" || !value.trim()) {
			throw new Error("SCHOLARLY_CORPUS_SPREADSHEETS contains an invalid spreadsheet mapping.");
		}
		mappings[key] = value.trim();
	}
	return mappings;
}

function spreadsheetId(env: WorkerEnv, definition: GeneratedCorpusConfig): string {
	const mapped = spreadsheetMappings(env)[definition.spreadsheet_key];
	if (mapped) return mapped;
	throw new Error(`No spreadsheet mapping is configured for corpus ${definition.corpus_id}.`);
}

function materialize(env: WorkerEnv, definition: GeneratedCorpusConfig): CorpusInboxConfig {
	return {
		schema_version: definition.schema_version,
		config_version: definition.config_version,
		config_hash: definition.config_hash,
		display_name: definition.display_name,
		spreadsheet_key: definition.spreadsheet_key,
		corpus_id: definition.corpus_id,
		job_handle: definition.job_handle,
		spreadsheet_id: spreadsheetId(env, definition),
		inbox_sheet: "Inbound Queue",
		registry_sheet: "Direct Registry",
		decisions_sheet: "Direct Decisions",
		runs_sheet: "Runs",
		corpus_sheet: "Corpus",
		excluded_sheet: "Excluded",
		initial_lookback_years: definition.initial_load.lookback_years,
		journals: definition.discovery.journals.map((journal) => ({ ...journal })),
		query_families: definition.discovery.query_families.map((query) => ({ ...query })),
		source_types: [...definition.discovery.source_types],
		rows_per_page: definition.discovery.rows_per_page,
		retrieval_gate: {
			exclude_title_prefixes: [...definition.discovery.retrieval_gate.exclude_title_prefixes],
			include_any_phrases: [...definition.discovery.retrieval_gate.include_any_phrases],
			include_all_groups: definition.discovery.retrieval_gate.include_all_groups.map((group) => [...group]),
		},
		processing: { ...definition.processing },
		overlap_days: definition.incremental_updates.overlap_days,
		minimum_gap_days: definition.incremental_updates.minimum_gap_days,
		screening: {
			...definition.screening,
			include_when: [...definition.screening.include_when],
			exclude_when: [...definition.screening.exclude_when],
			classifications: definition.screening.classifications.map((classification) => ({ ...classification })),
		},
	};
}

export function configuredCorpusIds(): string[] {
	return DEFINITIONS.filter((definition) => definition.enabled).map((definition) => definition.corpus_id);
}

export function corpusById(env: WorkerEnv, corpusId: string): CorpusInboxConfig | undefined {
	const definition = DEFINITIONS.find((candidate) => candidate.enabled && candidate.corpus_id === corpusId);
	return definition ? materialize(env, definition) : undefined;
}

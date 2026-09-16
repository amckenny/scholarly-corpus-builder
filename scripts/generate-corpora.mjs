import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDirectory = join(root, "corpora");
const outputPath = join(root, "src", "generated-corpus-configs.ts");

function fail(file, message) {
	throw new Error(`${relative(root, file)}: ${message}`);
}

function object(value, file, label) {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(file, `${label} must be an object`);
	return value;
}

function string(value, file, label, minimum = 1, maximum = 1_000) {
	if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
		fail(file, `${label} must be a string between ${minimum} and ${maximum} characters`);
	}
	return value;
}

function integer(value, file, label, minimum, maximum) {
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		fail(file, `${label} must be an integer from ${minimum} through ${maximum}`);
	}
	return value;
}

function array(value, file, label, minimum, maximum) {
	if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
		fail(file, `${label} must contain ${minimum} through ${maximum} entries`);
	}
	return value;
}

function exactKeys(value, file, label, allowed) {
	const extra = Object.keys(value).filter((key) => !allowed.includes(key));
	if (extra.length) fail(file, `${label} contains unsupported keys: ${extra.join(", ")}`);
}

function unique(values, file, label) {
	if (new Set(values).size !== values.length) fail(file, `${label} values must be unique`);
}

function validateCorpus(value, file) {
	const config = object(value, file, "configuration");
	exactKeys(config, file, "configuration", [
		"$schema", "schema_version", "config_version", "enabled", "corpus_id", "display_name",
		"spreadsheet_key", "job_handle", "initial_load", "discovery", "processing", "screening", "incremental_updates",
	]);
	if (config.schema_version !== 1) fail(file, "schema_version must equal 1");
	integer(config.config_version, file, "config_version", 1, 1_000_000);
	if (typeof config.enabled !== "boolean") fail(file, "enabled must be a boolean");
	const corpusId = string(config.corpus_id, file, "corpus_id", 1, 80);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(corpusId)) fail(file, "corpus_id must be lowercase kebab-case");
	string(config.display_name, file, "display_name", 3, 120);
	const spreadsheetKey = string(config.spreadsheet_key, file, "spreadsheet_key", 1, 80);
	if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(spreadsheetKey)) fail(file, "spreadsheet_key must be lowercase kebab-case");
	const jobHandle = string(config.job_handle, file, "job_handle", 36, 36);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobHandle)) {
		fail(file, "job_handle must be a version-4 UUID");
	}

	const initial = object(config.initial_load, file, "initial_load");
	exactKeys(initial, file, "initial_load", ["lookback_years"]);
	integer(initial.lookback_years, file, "initial_load.lookback_years", 1, 50);

	const discovery = object(config.discovery, file, "discovery");
	exactKeys(discovery, file, "discovery", ["source_types", "rows_per_page", "journals", "query_families", "retrieval_gate"]);
	array(discovery.source_types, file, "discovery.source_types", 1, 10)
		.forEach((entry, index) => string(entry, file, `discovery.source_types[${index}]`, 2, 80));
	integer(discovery.rows_per_page, file, "discovery.rows_per_page", 1, 1_000);
	const journals = array(discovery.journals, file, "discovery.journals", 1, 50);
	const issns = journals.map((entry, index) => {
		const journal = object(entry, file, `discovery.journals[${index}]`);
		exactKeys(journal, file, `discovery.journals[${index}]`, ["journal", "issn"]);
		string(journal.journal, file, `discovery.journals[${index}].journal`, 3, 300);
		const issn = string(journal.issn, file, `discovery.journals[${index}].issn`, 9, 9).toUpperCase();
		if (!/^\d{4}-\d{3}[\dX]$/.test(issn)) fail(file, `discovery.journals[${index}].issn is invalid`);
		journal.issn = issn;
		return issn;
	});
	unique(issns, file, "journal ISSN");
	const queries = array(discovery.query_families, file, "discovery.query_families", 1, 8);
	const queryIds = queries.map((entry, index) => {
		const query = object(entry, file, `discovery.query_families[${index}]`);
		exactKeys(query, file, `discovery.query_families[${index}]`, ["query_id", "label", "query"]);
		const queryId = string(query.query_id, file, `discovery.query_families[${index}].query_id`, 2, 40);
		if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(queryId)) fail(file, `${queryId} is not a valid query_id`);
		string(query.label, file, `discovery.query_families[${index}].label`, 3, 120);
		string(query.query, file, `discovery.query_families[${index}].query`, 3, 300);
		return queryId;
	});
	unique(queryIds, file, "query_id");
	const gate = object(discovery.retrieval_gate, file, "discovery.retrieval_gate");
	exactKeys(gate, file, "discovery.retrieval_gate", ["exclude_title_prefixes", "include_any_phrases", "include_all_groups"]);
	array(gate.exclude_title_prefixes, file, "discovery.retrieval_gate.exclude_title_prefixes", 0, 50)
		.forEach((entry, index) => string(entry, file, `discovery.retrieval_gate.exclude_title_prefixes[${index}]`, 2, 200));
	array(gate.include_any_phrases, file, "discovery.retrieval_gate.include_any_phrases", 0, 100)
		.forEach((entry, index) => string(entry, file, `discovery.retrieval_gate.include_any_phrases[${index}]`, 2, 200));
	array(gate.include_all_groups, file, "discovery.retrieval_gate.include_all_groups", 0, 50)
		.forEach((group, groupIndex) => array(group, file, `discovery.retrieval_gate.include_all_groups[${groupIndex}]`, 2, 10)
			.forEach((entry, entryIndex) => string(entry, file, `discovery.retrieval_gate.include_all_groups[${groupIndex}][${entryIndex}]`, 2, 200)));
	if (!gate.include_any_phrases.length && !gate.include_all_groups.length) {
		fail(file, "discovery.retrieval_gate must contain at least one inclusion rule");
	}

	const processing = object(config.processing, file, "processing");
	exactKeys(processing, file, "processing", ["classification_batch_size", "continuation_delay_seconds", "max_backoff_seconds"]);
	integer(processing.classification_batch_size, file, "processing.classification_batch_size", 1, 5);
	integer(processing.continuation_delay_seconds, file, "processing.continuation_delay_seconds", 1, 300);
	integer(processing.max_backoff_seconds, file, "processing.max_backoff_seconds", 30, 86_400);

	const screening = object(config.screening, file, "screening");
	exactKeys(screening, file, "screening", [
		"version", "objective", "include_when", "exclude_when", "hard_exclusion_classification",
		"unresolved_classification", "classifications",
	]);
	integer(screening.version, file, "screening.version", 1, 1_000_000);
	string(screening.objective, file, "screening.objective", 20, 1_000);
	array(screening.include_when, file, "screening.include_when", 1, 20)
		.forEach((entry, index) => string(entry, file, `screening.include_when[${index}]`, 3, 500));
	array(screening.exclude_when, file, "screening.exclude_when", 1, 20)
		.forEach((entry, index) => string(entry, file, `screening.exclude_when[${index}]`, 3, 500));
	const classifications = array(screening.classifications, file, "screening.classifications", 2, 20);
	const classificationIds = classifications.map((entry, index) => {
		const classification = object(entry, file, `screening.classifications[${index}]`);
		exactKeys(classification, file, `screening.classifications[${index}]`, [
			"id", "description", "disposition", "durable_exclusion", "unresolved",
		]);
		const id = string(classification.id, file, `screening.classifications[${index}].id`, 3, 80);
		if (!/^(candidate|excluded)_[a-z0-9_]+$/.test(id)) fail(file, `${id} is not a valid classification ID`);
		if (classification.disposition !== "candidate" && classification.disposition !== "excluded") {
			fail(file, `${id} has an invalid disposition`);
		}
		if (!id.startsWith(`${classification.disposition}_`)) fail(file, `${id} does not match its disposition`);
		if (typeof classification.durable_exclusion !== "boolean" || typeof classification.unresolved !== "boolean") {
			fail(file, `${id} flags must be booleans`);
		}
		if (classification.disposition === "candidate" && (classification.durable_exclusion || classification.unresolved)) {
			fail(file, `${id} cannot be a candidate and an exclusion reporting category`);
		}
		if (classification.durable_exclusion && classification.unresolved) fail(file, `${id} cannot be both durable and unresolved`);
		string(classification.description, file, `${id}.description`, 3, 500);
		return id;
	});
	unique(classificationIds, file, "classification ID");
	const hardId = string(screening.hard_exclusion_classification, file, "screening.hard_exclusion_classification", 3, 80);
	const unresolvedId = string(screening.unresolved_classification, file, "screening.unresolved_classification", 3, 80);
	const byId = new Map(classifications.map((entry) => [entry.id, entry]));
	if (byId.get(hardId)?.disposition !== "excluded") fail(file, "hard_exclusion_classification must name an excluded classification");
	if (byId.get(unresolvedId)?.unresolved !== true) fail(file, "unresolved_classification must name the unresolved classification");
	if (![...byId.values()].some((entry) => entry.disposition === "candidate")) fail(file, "at least one candidate classification is required");

	const incremental = object(config.incremental_updates, file, "incremental_updates");
	exactKeys(incremental, file, "incremental_updates", ["overlap_days", "minimum_gap_days"]);
	integer(incremental.overlap_days, file, "incremental_updates.overlap_days", 1, 365);
	integer(incremental.minimum_gap_days, file, "incremental_updates.minimum_gap_days", 1, 365);
	return config;
}

function stable(value) {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
	}
	return value;
}

const files = readdirSync(corpusDirectory)
	.filter((name) => name.endsWith(".json") && name !== "corpus.schema.json")
	.sort()
	.map((name) => join(corpusDirectory, name));
if (!files.length) throw new Error("At least one corpus configuration is required.");
const configs = files.map((file) => validateCorpus(JSON.parse(readFileSync(file, "utf8")), file));
unique(configs.map((config) => config.corpus_id), files[0], "corpus_id");
unique(configs.map((config) => config.job_handle), files[0], "job_handle");
for (const config of configs) {
	const semantic = { ...config };
	delete semantic.$schema;
	delete semantic.enabled;
	config.config_hash = createHash("sha256").update(JSON.stringify(stable(semantic))).digest("base64url");
}

if (process.argv.includes("--list")) {
	for (const config of configs.filter((entry) => entry.enabled)) console.log(config.corpus_id);
} else {
	const output = `// Generated by scripts/generate-corpora.mjs. Do not edit by hand.\n` +
		`export const GENERATED_CORPUS_CONFIGS = ${JSON.stringify(configs, null, "\t")} as const;\n`;
	writeFileSync(outputPath, output);
	console.log(`Generated ${relative(root, outputPath)} from ${configs.length} corpus configuration(s).`);
}

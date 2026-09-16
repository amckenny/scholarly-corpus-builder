import type { CanonicalRecord } from "./types";
import type { CorpusRetrievalGateConfig } from "./types";
import { evaluateRetrievalGate } from "./retrieval-gate";
import { sha256 } from "./token";

type FetchReceipt = {
	response: Response;
	cache_status: "hit" | "miss" | "bypass";
};

export type SearchQueryPageInput = {
	run_id: string;
	journal: string;
	issn: string;
	query_id: string;
	query: string;
	offset: number;
	rows_per_page: number;
	from_index_date?: string;
	until_index_date?: string;
	from_publication_date?: string;
	until_publication_date?: string;
	source_types?: string[];
	retrieval_gate: CorpusRetrievalGateConfig;
};

export type SearchQueryPageRecord = {
	canonical: CanonicalRecord;
	abstract_excerpt: string | null;
	abstract_truncated: boolean;
	retrieval_gate_reason: string | null;
};

export type SearchQueryPageResult = {
	status: "search_complete" | "registry_error";
	records: SearchQueryPageRecord[];
	returned_item_count: number;
	total_results: number | null;
	query_exhausted: boolean;
	receipt: Record<string, unknown>;
	retrieved_at: string;
};

const USER_AGENT_NAME = "ScholarlyCorpusBuilder/1.0";
const MIN_REQUEST_INTERVAL_MS = 1_100;
const CACHE_SECONDS = 86_400;
const MAX_RETRIES = 2;
const REQUEST_TIMEOUT_MS = 20_000;
const ABSTRACT_LIMIT = 900;

let registryQueue: Promise<unknown> = Promise.resolve();
let nextRegistryRequestAt = 0;

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function normalizeDoi(value: string): string | null {
	let doi = value.trim().replace(/^doi:\s*/i, "").replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
	try {
		doi = decodeURIComponent(doi);
	} catch {
		return null;
	}
	if (doi.length > 255 || !/^10\.\d{4,9}\/\S+$/i.test(doi)) return null;
	return doi.toLowerCase().replace(/\/$/, "");
}

export function normalizeIssn(value: string): string | null {
	const compact = value.trim().toUpperCase().replace(/-/g, "");
	if (!/^\d{7}[\dX]$/.test(compact)) return null;
	return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function normalizeOutlet(value: string): string {
	return value
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function publicRegistryUrl(url: URL): string {
	const copy = new URL(url);
	copy.searchParams.delete("mailto");
	return copy.toString();
}

function stripMarkup(value: unknown): string | null {
	if (typeof value !== "string" || !value.trim()) return null;
	return value
		.replace(/<[^>]*>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function crossrefDate(value: unknown): string | null {
	const parts = (value as { "date-parts"?: number[][] } | undefined)?.["date-parts"]?.[0];
	if (!parts?.length) return null;
	const [year, month, day] = parts;
	if (!year) return null;
	return [String(year), month ? String(month).padStart(2, "0") : null, day ? String(day).padStart(2, "0") : null]
		.filter(Boolean)
		.join("-");
}

function authorDisplay(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((raw) => {
			const author = raw as Record<string, unknown>;
			if (typeof author.name === "string" && author.name.trim()) return author.name.trim();
			const given = typeof author.given === "string" ? author.given.trim() : "";
			const family = typeof author.family === "string" ? author.family.trim() : "";
			return [given, family].filter(Boolean).join(" ");
		})
		.filter(Boolean)
		.join("; ");
}

function retryDelay(response: Response, attempt: number): number {
	const retryAfter = response.headers.get("retry-after");
	if (retryAfter) {
		const seconds = Number(retryAfter);
		if (Number.isFinite(seconds)) return Math.min(seconds * 1_000, 10_000);
	}
	return Math.min(1_000 * 2 ** attempt, 5_000);
}

async function fetchWithRetries(url: URL, email: string): Promise<Response> {
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
		try {
			const response = await fetch(url.toString(), {
				headers: {
					Accept: "application/json",
					"User-Agent": `${USER_AGENT_NAME} (mailto:${email})`,
				},
				signal: controller.signal,
			});
			if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
				await sleep(retryDelay(response, attempt));
				continue;
			}
			return response;
		} finally {
			clearTimeout(timeout);
		}
	}
	throw new Error("Registry request failed after bounded retries.");
}

async function politeFetch(url: URL, email: string): Promise<Response> {
	const operation = registryQueue.then(async () => {
		const wait = Math.max(0, nextRegistryRequestAt - Date.now());
		if (wait > 0) await sleep(wait);
		nextRegistryRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
		return fetchWithRetries(url, email);
	});
	registryQueue = operation.then(
		() => undefined,
		() => undefined,
	);
	return operation as Promise<Response>;
}

async function registryFetch(url: URL, email: string): Promise<FetchReceipt> {
	const workerCaches = caches as CacheStorage & { readonly default: Cache };
	const cacheUrl = new URL(url);
	cacheUrl.searchParams.delete("mailto");
	const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
	const cached = await workerCaches.default.match(cacheKey);
	if (cached) return { response: cached, cache_status: "hit" };
	const response = await politeFetch(url, email);
	if (!response.ok) return { response, cache_status: "bypass" };
	const body = await response.text();
	const stored = new Response(body, {
		status: response.status,
		headers: {
			"content-type": response.headers.get("content-type") ?? "application/json",
			"cache-control": `public, max-age=${CACHE_SECONDS}`,
		},
	});
	await workerCaches.default.put(cacheKey, stored.clone());
	return { response: stored, cache_status: "miss" };
}

function validIsoDate(value: string | undefined): boolean {
	if (value === undefined) return true;
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

async function normalizeWork(
	item: Record<string, unknown>,
	input: SearchQueryPageInput,
	retrievedAt: string,
	metadataUrl: string,
	cacheStatus: FetchReceipt["cache_status"],
): Promise<SearchQueryPageRecord> {
	const rawDoi = typeof item.DOI === "string" ? item.DOI : "";
	const doi = normalizeDoi(rawDoi);
	const title = Array.isArray(item.title) && typeof item.title[0] === "string" ? item.title[0] : null;
	const containerTitle =
		Array.isArray(item["container-title"]) && typeof item["container-title"][0] === "string"
			? item["container-title"][0]
			: null;
	const issn = Array.isArray(item.ISSN)
		? item.ISSN.map((value) => (typeof value === "string" ? normalizeIssn(value) : null)).filter((value): value is string => Boolean(value))
		: [];
	const abstract = stripMarkup(item.abstract);
	const abstractTruncated = Boolean(abstract && abstract.length > ABSTRACT_LIMIT);
	const abstractExcerpt = abstract?.slice(0, ABSTRACT_LIMIT) ?? null;
	const sourceType = typeof item.type === "string" ? item.type : null;
	let hardExclusionReason: string | null = null;
	if (!doi) hardExclusionReason = "missing_doi";
	else if (!title) hardExclusionReason = "missing_title";
	else if (containerTitle && normalizeOutlet(containerTitle) === normalizeOutlet("Academy of Management Proceedings")) {
		hardExclusionReason = "unsupported_source_type";
	} else if (input.source_types?.length && (!sourceType || !input.source_types.includes(sourceType))) {
		hardExclusionReason = "unsupported_source_type";
	} else if (!issn.includes(input.issn) && (!containerTitle || normalizeOutlet(containerTitle) !== normalizeOutlet(input.journal))) {
		hardExclusionReason = "outlet_mismatch";
	}
	const publicationDate = crossrefDate(item.published) ?? crossrefDate(item["published-online"]) ?? crossrefDate(item.issued);
	const registryFields = {
		doi,
		title,
		authors: authorDisplay(item.author),
		container_title: containerTitle,
		issn,
		publisher: typeof item.publisher === "string" ? item.publisher : null,
		publication_date: publicationDate,
		published_online: crossrefDate(item["published-online"]),
		published_print: crossrefDate(item["published-print"]),
		volume: typeof item.volume === "string" ? item.volume : null,
		issue: typeof item.issue === "string" ? item.issue : null,
		pages: typeof item.page === "string" ? item.page : null,
		article_number: typeof item["article-number"] === "string" ? item["article-number"] : null,
		source_type: sourceType,
		doi_url: doi ? `https://doi.org/${doi}` : null,
	};
	const identity = doi ? `doi:${doi}` : `title:${normalizeOutlet(title ?? "")}|${normalizeOutlet(containerTitle ?? input.journal)}`;
	const recordId = (await sha256(identity)).slice(0, 22);
	const gate = evaluateRetrievalGate(title, abstract, input.retrieval_gate);
	return {
		canonical: {
			record_id: recordId,
			registry: "Crossref",
			...registryFields,
			verification_level: abstract ? "registry_metadata_and_abstract" : "registry_metadata_only",
			evidence_depth: abstract
				? abstractTruncated
					? "Registry abstract excerpt inspected"
					: "Registry abstract inspected"
				: "Registry metadata only",
			retrieved_at: retrievedAt,
			metadata_url: metadataUrl,
			cache_status: cacheStatus,
			registry_record_hash: await sha256(JSON.stringify(registryFields)),
			discovered_by_query_ids: [input.query_id],
			expected_journal: input.journal,
			expected_issn: input.issn,
			hard_exclusion_reason: hardExclusionReason,
		},
		abstract_excerpt: abstractExcerpt,
		abstract_truncated: abstractTruncated,
		retrieval_gate_reason: hardExclusionReason || gate.passed ? null : gate.reason,
	};
}

export async function searchJournalQueryPage(input: SearchQueryPageInput, email: string): Promise<SearchQueryPageResult> {
	if (![input.from_index_date, input.until_index_date, input.from_publication_date, input.until_publication_date].every(validIsoDate)) {
		throw new Error("Date filters must use YYYY-MM-DD.");
	}
	const normalizedIssn = normalizeIssn(input.issn);
	if (!normalizedIssn) throw new Error("Invalid ISSN.");
	if (input.offset < 0 || input.offset > 10_000) throw new Error("Crossref offset must be between 0 and 10,000.");
	const url = new URL(`https://api.crossref.org/journals/${encodeURIComponent(normalizedIssn)}/works`);
	url.searchParams.set("query.bibliographic", input.query.trim());
	const filters: string[] = [];
	if (input.from_index_date) filters.push(`from-index-date:${input.from_index_date}`);
	if (input.until_index_date) filters.push(`until-index-date:${input.until_index_date}`);
	if (input.from_publication_date) filters.push(`from-pub-date:${input.from_publication_date}`);
	if (input.until_publication_date) filters.push(`until-pub-date:${input.until_publication_date}`);
	if (input.source_types?.length === 1) filters.push(`type:${input.source_types[0]}`);
	if (filters.length) url.searchParams.set("filter", filters.join(","));
	url.searchParams.set("rows", String(input.rows_per_page));
	url.searchParams.set("offset", String(input.offset));
	url.searchParams.set("sort", "indexed");
	url.searchParams.set("order", "asc");
	url.searchParams.set("mailto", email);
	const receipt = await registryFetch(url, email);
	const retrievedAt = new Date().toISOString();
	if (!receipt.response.ok) {
		return {
			status: "registry_error",
			records: [],
			returned_item_count: 0,
			total_results: null,
			query_exhausted: false,
			retrieved_at: retrievedAt,
			receipt: {
				query_id: input.query_id,
				status: "registry_error",
				http_status: receipt.response.status,
				offset: input.offset,
				retrieved_at: retrievedAt,
			},
		};
	}
	const payload = (await receipt.response.json()) as {
		message?: { items?: Array<Record<string, unknown>>; "total-results"?: number };
	};
	const items = payload.message?.items ?? [];
	const totalResults = typeof payload.message?.["total-results"] === "number" ? payload.message["total-results"] : null;
	const records = await Promise.all(
		items.map((item) =>
			normalizeWork(
				item,
				{ ...input, issn: normalizedIssn },
				retrievedAt,
				publicRegistryUrl(url),
				receipt.cache_status,
			),
		),
	);
	const queryExhausted = items.length < input.rows_per_page || (totalResults !== null && input.offset + items.length >= totalResults);
	return {
		status: "search_complete",
		records,
		returned_item_count: items.length,
		total_results: totalResults,
		query_exhausted: queryExhausted,
		retrieved_at: retrievedAt,
		receipt: {
			query_id: input.query_id,
			status: "search_complete",
			returned_item_count: items.length,
			crossref_total_results_unreviewed: totalResults,
			offset: input.offset,
			rows_per_page: input.rows_per_page,
			query_exhausted: queryExhausted,
			metadata_url: publicRegistryUrl(url),
			cache_status: receipt.cache_status,
			retrieved_at: retrievedAt,
		},
	};
}

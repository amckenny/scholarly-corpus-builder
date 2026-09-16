import { sha256 } from "./token";
import type { CanonicalRecord, DirectWriteRecord, PendingPage } from "./types";

export const DIRECT_WRITE_HEADERS = [
	"Record ID",
	"Registry",
	"DOI",
	"Title",
	"Authors",
	"Journal",
	"ISSNs",
	"Publisher",
	"Publication Date",
	"Published Online",
	"Published Print",
	"Volume",
	"Issue",
	"Pages",
	"Article Number",
	"Source Type",
	"DOI URL",
	"Verification Level",
	"Evidence Depth",
	"Retrieved At",
	"Metadata URL",
	"Cache Status",
	"Registry Record Hash",
	"Discovered By Query IDs",
	"Expected Journal",
	"Expected ISSN",
	"Hard Exclusion Reason",
	"Run ID",
	"Page ID",
	"Query ID",
	"Canonical Row Hash",
] as const;

export const DIRECT_WRITE_MAX_RECORDS = 5;
export const DIRECT_WRITE_MAX_SERIALIZED_CHARS = 40_000;

function cell(value: string | null | undefined): string {
	return value ?? "";
}

export function canonicalRegistryCells(
	canonical: CanonicalRecord,
	context: { run_id: string; page_id: string; query_id: string },
): string[] {
	return [
		canonical.record_id,
		canonical.registry,
		cell(canonical.doi),
		cell(canonical.title),
		canonical.authors,
		cell(canonical.container_title),
		canonical.issn.join("; "),
		cell(canonical.publisher),
		cell(canonical.publication_date),
		cell(canonical.published_online),
		cell(canonical.published_print),
		cell(canonical.volume),
		cell(canonical.issue),
		cell(canonical.pages),
		cell(canonical.article_number),
		cell(canonical.source_type),
		cell(canonical.doi_url),
		canonical.verification_level,
		canonical.evidence_depth,
		canonical.retrieved_at,
		canonical.metadata_url,
		canonical.cache_status,
		canonical.registry_record_hash,
		canonical.discovered_by_query_ids.join("; "),
		canonical.expected_journal,
		canonical.expected_issn,
		cell(canonical.hard_exclusion_reason),
		context.run_id,
		context.page_id,
		context.query_id,
	];
}

export async function directWriteRecord(
	canonical: CanonicalRecord,
	screening: { abstract_excerpt: string | null; abstract_truncated: boolean },
	context: { run_id: string; page_id: string; query_id: string },
): Promise<DirectWriteRecord> {
	const canonicalCells = canonicalRegistryCells(canonical, context);
	const canonicalRowHash = await sha256(JSON.stringify(canonicalCells));
	return {
		record_id: canonical.record_id,
		registry_row: [...canonicalCells, canonicalRowHash],
		canonical_row_hash: canonicalRowHash,
		screening: {
			title: canonical.title,
			abstract_excerpt: screening.abstract_excerpt,
			abstract_truncated: screening.abstract_truncated,
			hard_exclusion_reason: canonical.hard_exclusion_reason,
		},
	};
}

export async function buildDirectWriteBatch(page: PendingPage) {
	if (page.records.length > DIRECT_WRITE_MAX_RECORDS) {
		throw new Error(
			`Direct-write classification batches are limited to ${DIRECT_WRITE_MAX_RECORDS} records.`,
		);
	}
	const records = await Promise.all(
		page.records.map((record) =>
			directWriteRecord(record.canonical, record, {
				run_id: page.run_id,
				page_id: page.page_id,
				query_id: page.query_family.query_id,
			}),
		),
	);
	const batchHash = await sha256(records.map((record) => record.canonical_row_hash).join("\n"));
	const output = {
		status: "batch_ready" as const,
		job_handle: page.job_handle,
		run_id: page.run_id,
		page_id: page.page_id,
		journal: page.journal,
		issn: page.issn,
		query_id: page.query_family.query_id,
		record_count: records.length,
		registry_headers: [...DIRECT_WRITE_HEADERS],
		records,
		batch_hash: batchHash,
		query_exhausted: page.query_exhausted,
	};
	if (JSON.stringify(output).length > DIRECT_WRITE_MAX_SERIALIZED_CHARS) {
		throw new Error(
			`Direct-write batch exceeds ${DIRECT_WRITE_MAX_SERIALIZED_CHARS} serialized characters; reduce processing.classification_batch_size.`,
		);
	}
	return output;
}

import { describe, expect, it } from "vitest";
import { configuredCorpusIds, corpusById } from "../src/corpora";
import type { WorkerEnv } from "../src/types";

describe("corpus configuration materialization", () => {
	it("lists enabled configurations and applies the per-corpus spreadsheet map", () => {
		expect(configuredCorpusIds()).toContain("nlp-management");
		const corpus = corpusById({
			SCHOLARLY_CORPUS_SPREADSHEETS: JSON.stringify({ "nlp-management": "mapped-sheet" }),
		} as WorkerEnv, "nlp-management");
		expect(corpus).toMatchObject({
			corpus_id: "nlp-management",
			spreadsheet_id: "mapped-sheet",
			initial_lookback_years: 10,
			rows_per_page: 100,
			processing: { classification_batch_size: 5, continuation_delay_seconds: 5 },
		});
		expect(corpus?.config_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("fails closed on malformed or missing mappings and ignores unknown corpus IDs", () => {
		expect(() => corpusById({ SCHOLARLY_CORPUS_SPREADSHEETS: "not-json" } as WorkerEnv, "nlp-management"))
			.toThrow(/valid JSON object/);
		expect(() => corpusById({} as WorkerEnv, "nlp-management")).toThrow(/No spreadsheet mapping/);
		expect(corpusById({} as WorkerEnv, "not-configured")).toBeUndefined();
	});
});

import { describe, expect, it } from "vitest";
import { evaluateRetrievalGate } from "../src/retrieval-gate";
import type { CorpusRetrievalGateConfig } from "../src/types";

const gate: CorpusRetrievalGateConfig = {
	exclude_title_prefixes: ["Issue Information", "Editorial Board"],
	include_any_phrases: ["CATA", "natural language processing", "topic modeling"],
	include_all_groups: [
		["machine learning", "text"],
		["artificial intelligence", "qualitative coding"],
	],
};

describe("deterministic retrieval gate", () => {
	it("rejects issue-only content before classification", () => {
		expect(evaluateRetrievalGate("Issue Information", null, gate)).toEqual({
			passed: false,
			reason: "excluded_title_prefix",
		});
	});

	it("accepts configured methods in either title or abstract", () => {
		expect(evaluateRetrievalGate("Using CATA in organizational research", null, gate).passed).toBe(true);
		expect(evaluateRetrievalGate("A measurement study", "We apply machine learning to text from employee reviews.", gate).passed).toBe(true);
	});

	it("does not treat substrings as short acronym matches", () => {
		expect(evaluateRetrievalGate("Training and retention", "A conventional survey study.", gate)).toEqual({
			passed: false,
			reason: "no_configured_retrieval_signal",
		});
	});
});

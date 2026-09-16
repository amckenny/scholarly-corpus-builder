import { afterEach, describe, expect, it, vi } from "vitest";
import { classifierInternals, classifyRecord } from "../src/gemini-classifier";
import type { CorpusScreeningConfig, DirectWriteRecord, WorkerEnv } from "../src/types";

const screening: CorpusScreeningConfig = {
	version: 1,
	objective: "Find scholarship in which computational text analysis is a material method or contribution.",
	include_when: ["Computational text analysis is central to the method or result."],
	exclude_when: ["A passing reference to text analysis is not enough."],
	hard_exclusion_classification: "excluded_unresolved",
	unresolved_classification: "excluded_unresolved",
	classifications: [
		{
			id: "candidate_methodological",
			description: "Develops or validates a computational text-analysis method.",
			disposition: "candidate",
			durable_exclusion: false,
			unresolved: false,
		},
		{
			id: "candidate_substantive",
			description: "Uses computational text analysis centrally in a substantive contribution.",
			disposition: "candidate",
			durable_exclusion: false,
			unresolved: false,
		},
		{
			id: "excluded_unresolved",
			description: "The available evidence cannot establish topical fit.",
			disposition: "excluded",
			durable_exclusion: false,
			unresolved: true,
		},
	],
};

function record(overrides: Partial<DirectWriteRecord["screening"]> = {}): DirectWriteRecord {
	return {
		record_id: "record-1",
		registry_row: Array.from({ length: 31 }, () => "value"),
		canonical_row_hash: "hash",
		screening: {
			title: "Organizational adaptation after a crisis",
			abstract_excerpt: null,
			abstract_truncated: false,
			hard_exclusion_reason: null,
			...overrides,
		},
	};
}

describe("Gemini one-record classifier", () => {
	afterEach(() => vi.restoreAllMocks());

	it("sends a title-only record to Gemini instead of auto-excluding it", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
			candidates: [{ content: { parts: [{ text: JSON.stringify({
				classification: "excluded_unresolved",
				fit_basis: "The title alone does not establish a computational text-analysis method.",
				exclusion_reason: "insufficient title-only evidence",
				confidence: "low",
			}) }] } }],
		}));
		await expect(classifyRecord(record(), { GEMINI_API_KEY: "secret" } as WorkerEnv, screening)).resolves.toMatchObject({
			classification: "excluded_unresolved",
			confidence: "low",
		});
		expect(fetchSpy).toHaveBeenCalledOnce();
		expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("models/gemini-3.8-flash:generateContent");
	});

	it("enforces hard exclusions deterministically", async () => {
		await expect(classifyRecord(record({ hard_exclusion_reason: "outlet_mismatch" }), {} as WorkerEnv, screening)).resolves.toMatchObject({
			classification: "excluded_unresolved",
			exclusion_reason: "outlet_mismatch",
		});
	});

	it("sends only one screening object and accepts schema-constrained JSON", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
			candidates: [{ content: { parts: [{ text: JSON.stringify({
				classification: "candidate_methodological",
				fit_basis: "Develops and validates a topic-modeling procedure.",
				exclusion_reason: "",
				confidence: "high",
			}) }] } }],
		}));
		const inputRecord = record({
			title: "Validating Topic Models for Organizational Research",
			abstract_excerpt: "We develop and validate a topic-modeling workflow.",
		});
		await expect(classifyRecord(inputRecord, { GEMINI_API_KEY: "secret" } as WorkerEnv, screening)).resolves.toMatchObject({
			classification: "candidate_methodological",
		});
		expect(fetchSpy).toHaveBeenCalledOnce();
		const request = fetchSpy.mock.calls[0]?.[1] as RequestInit;
		const body = JSON.parse(String(request.body));
		expect(body.contents).toHaveLength(1);
		expect(body.contents[0].parts).toHaveLength(1);
		expect(String(request.body)).not.toContain("record-1");
		expect(body.generationConfig.responseMimeType).toBe("application/json");
		expect(body.generationConfig.responseJsonSchema.required).toEqual([
			"classification", "fit_basis", "exclusion_reason", "confidence",
		]);
		expect(body.generationConfig.responseFormat).toBeUndefined();
	});

	it("logs sanitized upstream diagnostics and does not retry an invalid request", async () => {
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
			error: { status: "INVALID_ARGUMENT", message: "Invalid JSON payload received." },
		}, { status: 400 }));
		await expect(classifyRecord(record(), { GEMINI_API_KEY: "secret" } as WorkerEnv, screening)).rejects.toThrow(/HTTP 400/);
		expect(fetchSpy).toHaveBeenCalledOnce();
		const logged = JSON.parse(String(errorLog.mock.calls[0]?.[0]));
		expect(logged).toMatchObject({
			event: "gemini_api_error",
			http_status: 400,
			upstream_status: "INVALID_ARGUMENT",
		});
		expect(JSON.stringify(logged)).not.toContain("secret");
	});

	it("defers a rate-limited record without immediate retries", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
			error: { status: "RESOURCE_EXHAUSTED", message: "Quota exceeded." },
		}, { status: 429 }));
		await expect(classifyRecord(record(), { GEMINI_API_KEY: "secret" } as WorkerEnv, screening)).rejects.toThrow(/HTTP 429/);
		expect(fetchSpy).toHaveBeenCalledOnce();
	});

	it("ignores thinking parts and combines final structured-output parts", () => {
		const text = classifierInternals.responseText({
			candidates: [{
				content: { parts: [
					{ thought: true, text: "internal reasoning" },
					{ text: '{"classification":"candidate_' },
					{ text: 'substantive"}' },
				] },
			}],
		});
		expect(text).toBe('{"classification":"candidate_substantive"}');
	});

	it("accepts a fenced JSON wrapper and labels malformed JSON as Gemini output", () => {
		expect(classifierInternals.structuredJson("```json\n{\"confidence\":\"low\"}\n```")).toEqual({ confidence: "low" });
		expect(() => classifierInternals.structuredJson("not json")).toThrow(/Gemini returned malformed structured JSON/);
	});

	it("rejects semantically inconsistent structured output", () => {
		expect(() => classifierInternals.parseClassification({
			classification: "candidate_substantive",
			fit_basis: "Uses NLP centrally.",
			exclusion_reason: "not relevant",
			confidence: "high",
		}, screening)).toThrow(/candidate classification cannot contain/i);
	});

	it("builds the prompt and output enum from a different corpus configuration", () => {
		const crowdfunding: CorpusScreeningConfig = {
			...screening,
			objective: "Find crowdfunding research about campaign narratives and backer decisions.",
			classifications: [
				{ id: "candidate_crowdfunding", description: "Directly studies crowdfunding.", disposition: "candidate", durable_exclusion: false, unresolved: false },
				{ id: "excluded_off_topic", description: "Does not study crowdfunding.", disposition: "excluded", durable_exclusion: true, unresolved: false },
				{ id: "excluded_unclear", description: "Evidence is inconclusive.", disposition: "excluded", durable_exclusion: false, unresolved: true },
			],
			hard_exclusion_classification: "excluded_off_topic",
			unresolved_classification: "excluded_unclear",
		};
		const instruction = classifierInternals.systemInstruction(crowdfunding);
		expect(instruction).toContain("campaign narratives and backer decisions");
		expect(instruction).toContain("candidate_crowdfunding");
		expect(instruction).not.toContain("candidate_methodological");
	});
});

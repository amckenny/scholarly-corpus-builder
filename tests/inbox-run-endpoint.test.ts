import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { WorkerEnv } from "../src/types";

const RUN_SECRET = "r".repeat(48);

describe("authenticated inbox run endpoint", () => {
	afterEach(() => vi.restoreAllMocks());

	it("rejects non-POST and unauthenticated requests before staging", async () => {
		const env = { SCHOLARLY_RUN_SECRET: RUN_SECRET } as WorkerEnv;
		const getResponse = await worker.fetch(
			new Request("https://worker.example/inbox/run/nlp-management"),
			env,
		);
		expect(getResponse.status).toBe(405);

		const postResponse = await worker.fetch(
			new Request("https://worker.example/inbox/run/nlp-management", { method: "POST" }),
			env,
		);
		expect(postResponse.status).toBe(401);
		expect(await postResponse.json()).toEqual({ status: "run_failed", error: "Run authentication failed." });
	});

	it("accepts the exact secret and returns a sanitized staging failure", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const response = await worker.fetch(
			new Request("https://worker.example/inbox/run/nlp-management", {
				method: "POST",
				headers: { authorization: `Bearer ${RUN_SECRET}` },
			}),
			{ SCHOLARLY_RUN_SECRET: RUN_SECRET } as WorkerEnv,
		);
		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			status: "run_failed",
			error_code: "missing_spreadsheet_mapping",
			error: "The corpus does not have a valid Google Sheets mapping.",
		});
	});

	it("starts the durable corpus runner and returns immediately", async () => {
		const runner = {
			fetch: vi.fn().mockResolvedValue(Response.json({
				status: "runner_started",
				corpus_id: "nlp-management",
				next_alarm_at: "2026-09-15T12:00:01.000Z",
			}, { status: 202 })),
		};
		const response = await worker.fetch(
			new Request("https://worker.example/inbox/run/nlp-management", {
				method: "POST",
				headers: { authorization: `Bearer ${RUN_SECRET}` },
			}),
			{
				SCHOLARLY_RUN_SECRET: RUN_SECRET,
				SCHOLARLY_CORPUS_SPREADSHEETS: JSON.stringify({ "nlp-management": "sheet-id" }),
				CORPUS_RUNNERS: { idFromName: vi.fn().mockReturnValue("id"), get: vi.fn().mockReturnValue(runner) },
			} as unknown as WorkerEnv,
		);
		expect(response.status).toBe(202);
		expect(await response.json()).toEqual(expect.objectContaining({ status: "runner_started", corpus_id: "nlp-management" }));
		expect(runner.fetch).toHaveBeenCalledOnce();
	});

	it("rejects an unknown corpus without exposing internal details", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const response = await worker.fetch(
			new Request("https://worker.example/inbox/run/not-configured", {
				method: "POST",
				headers: { authorization: `Bearer ${RUN_SECRET}` },
			}),
			{ SCHOLARLY_RUN_SECRET: RUN_SECRET } as WorkerEnv,
		);
		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({
			status: "run_failed",
			error: "Unknown corpus_id.",
		});
	});
});

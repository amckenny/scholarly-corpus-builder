import { afterEach, describe, expect, it, vi } from "vitest";
import { safeDiagnosticError } from "../src/diagnostic-errors";
import { diagnoseInboxSheetAccess } from "../src/google-sheets";
import { executeInboxRun } from "../src/inbox-diagnostics";
import type { WorkerEnv } from "../src/types";

describe("scheduled inbox diagnostics", () => {
	afterEach(() => vi.restoreAllMocks());

	it("classifies failures without returning raw upstream details", () => {
		expect(safeDiagnosticError(new Error("CROSSREF_MAILTO is not set: secret-value"))).toEqual({
			code: "missing_crossref_mailto",
			message: "CROSSREF_MAILTO is not configured.",
		});
		expect(safeDiagnosticError(new Error("Google Sheets API request failed with HTTP 403: private response"))).toEqual({
			code: "google_sheets_forbidden",
			message: "Google Sheets denied access. Enable the Sheets API and share the workbook with the service account as Editor.",
		});
		expect(safeDiagnosticError(new Error("Google OAuth token exchange failed with HTTP 400: Invalid JWT Signature."))).toEqual({
			code: "google_oauth_failed",
			message: "Google rejected service-account authentication.",
		});
		expect(safeDiagnosticError(new Error("Google Sheets API request failed with HTTP 429: quota detail"))).toEqual({
			code: "google_sheets_rate_limited",
			message: "Google Sheets temporarily rate-limited the service account; verified rows remain safe for the next scheduled run.",
		});
		expect(safeDiagnosticError(new Error("Gemini API request failed with HTTP 400."))).toEqual({
			code: "gemini_request_invalid",
			message: "Gemini rejected the classification request; the queue row remains pending.",
		});
		expect(safeDiagnosticError(new Error("Too many subrequests."))).toEqual({
			code: "cloudflare_subrequest_limit",
			message: "The Cloudflare per-request subrequest limit was reached; verified rows remain safe for the next scheduled run.",
		});
	});

	it("reports missing Google credentials without attempting a network request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const result = await diagnoseInboxSheetAccess({} as WorkerEnv, "sheet-id", "Inbound Queue");
		expect(result).toMatchObject({
			status: "error",
			failure_stage: "configuration",
			error_code: "missing_google_credentials",
			checks: { credentials_configured: false },
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("identifies an invalid private key before attempting Google OAuth", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const result = await diagnoseInboxSheetAccess({
			GOOGLE_SERVICE_ACCOUNT_EMAIL: "worker@example.invalid",
			GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\ninvalid\n-----END PRIVATE KEY-----",
		} as WorkerEnv, "sheet-id", "Inbound Queue");
		expect(result).toMatchObject({
			status: "error",
			failure_stage: "private_key",
			error_code: "invalid_google_private_key",
			checks: { credentials_configured: true, private_key_valid: false },
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("logs a structured completion receipt", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const run = vi.fn().mockResolvedValue({ corpus_id: "nlp-management", status: "batch_ready", processed_count: 5 });
		const result = await executeInboxRun(
			{ source: "github_actions", trigger: "POST /inbox/run/nlp-management", scheduledTime: Date.parse("2026-09-01T19:15:00.000Z"), corpus_id: "nlp-management" },
			{} as WorkerEnv,
			run,
		);
		expect(result[0]?.processed_count).toBe(5);
		expect(log).toHaveBeenCalledTimes(2);
		expect(log.mock.calls.map(([entry]) => JSON.parse(String(entry)).event)).toEqual([
			"scholarly_headless_run_started",
			"scholarly_headless_run_completed",
		]);
		expect(JSON.parse(String(log.mock.calls[0]?.[0])).source).toBe("github_actions");
	});

	it("logs a sanitized failure and preserves the failed promise", async () => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
		const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const failure = new Error("Google Sheets API request failed with HTTP 403: sensitive upstream detail");
		await expect(executeInboxRun(
			{ source: "github_actions", trigger: "POST /inbox/run/nlp-management", scheduledTime: Date.parse("2026-09-01T19:15:00.000Z"), corpus_id: "nlp-management" },
			{} as WorkerEnv,
			vi.fn().mockRejectedValue(failure),
		)).rejects.toBe(failure);
		const logged = JSON.parse(String(errorLog.mock.calls[0]?.[0]));
		expect(logged.error_code).toBe("google_sheets_forbidden");
		expect(logged.event).toBe("scholarly_headless_run_failed");
		expect(JSON.stringify(logged)).not.toContain("sensitive upstream detail");
	});
});

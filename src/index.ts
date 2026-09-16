import { configuredCorpusIds, corpusById } from "./corpora";
import { safeDiagnosticError } from "./diagnostic-errors";
import { diagnoseInboxSheetAccess } from "./google-sheets";
import type { WorkerEnv } from "./types";

export { CorpusJobStore } from "./job-store";
export { CorpusRunnerStore } from "./corpus-runner";

function bearerAuthorized(request: Request, secret: string | undefined): boolean {
	const expected = secret?.trim() ?? "";
	if (expected.length < 32) return false;
	const authorization = request.headers.get("authorization") ?? "";
	if (!authorization.startsWith("Bearer ")) return false;
	const supplied = authorization.slice(7);
	if (supplied.length !== expected.length) return false;
	let difference = 0;
	for (let index = 0; index < expected.length; index += 1) {
		difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
	}
	return difference === 0;
}

async function callJobStore(env: WorkerEnv, jobHandle: string, path: string, body: Record<string, unknown>) {
	const id = env.CORPUS_JOBS.idFromName(jobHandle);
	const response = await env.CORPUS_JOBS.get(id).fetch(`https://corpus-job${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const value = (await response.json()) as Record<string, unknown>;
	if (!response.ok) throw new Error(typeof value.error === "string" ? value.error : "Corpus job operation failed.");
	return value;
}

async function runCorpus(request: Request, env: WorkerEnv, corpusId: string): Promise<Response> {
	if (!bearerAuthorized(request, env.SCHOLARLY_RUN_SECRET)) {
		return Response.json({ status: "run_failed", error: "Run authentication failed." }, { status: 401 });
	}
	try {
		if (!corpusById(env, corpusId)) {
			return Response.json({ status: "run_failed", error: "Unknown corpus_id." }, { status: 404 });
		}
		const id = env.CORPUS_RUNNERS.idFromName(corpusId);
		const response = await env.CORPUS_RUNNERS.get(id).fetch("https://corpus-runner/start", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ corpus_id: corpusId }),
		});
		const value = await response.json();
		return Response.json(value, { status: response.status });
	} catch (error) {
		const safe = safeDiagnosticError(error);
		return Response.json({ status: "run_failed", error_code: safe.code, error: safe.message }, { status: 500 });
	}
}

async function runnerStatus(env: WorkerEnv, corpusId: string): Promise<Record<string, unknown>> {
	try {
		const id = env.CORPUS_RUNNERS.idFromName(corpusId);
		const response = await env.CORPUS_RUNNERS.get(id).fetch("https://corpus-runner/status", { method: "POST" });
		return await response.json() as Record<string, unknown>;
	} catch (error) {
		const safe = safeDiagnosticError(error);
		return { status: "unreachable", error_code: safe.code, error: safe.message };
	}
}

async function corpusStatus(env: WorkerEnv, corpusId: string): Promise<Response> {
	const missing = [
		!env.CROSSREF_MAILTO?.trim() ? "CROSSREF_MAILTO" : null,
		!env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() ? "GOOGLE_SERVICE_ACCOUNT_EMAIL" : null,
		!env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim() ? "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY" : null,
		!env.GEMINI_API_KEY?.trim() ? "GEMINI_API_KEY" : null,
		!env.SCHOLARLY_RUN_SECRET?.trim() ? "SCHOLARLY_RUN_SECRET" : null,
		!env.SCHOLARLY_CORPUS_SPREADSHEETS?.trim() ? "SCHOLARLY_CORPUS_SPREADSHEETS" : null,
	].filter((value): value is string => value !== null);
	if (missing.length) {
		return Response.json({ status: "error", checked_at: new Date().toISOString(), corpus_id: corpusId, configuration: { ready: false, missing } }, { status: 503 });
	}
	let corpus;
	try {
		corpus = corpusById(env, corpusId);
	} catch (error) {
		const safe = safeDiagnosticError(error);
		return Response.json({ status: "error", corpus_id: corpusId, error_code: safe.code, error: safe.message }, { status: 503 });
	}
	if (!corpus) return Response.json({ status: "not_found", error: "Unknown corpus_id." }, { status: 404 });
	const googleSheets = await diagnoseInboxSheetAccess(env, corpus.spreadsheet_id, corpus.inbox_sheet);
	let job: Record<string, unknown> = { reachable: true, status: "not_initialized" };
	let configurationMatches = true;
	try {
		const value = await callJobStore(env, corpus.job_handle, "/status", {});
		configurationMatches = value.config_hash == null || value.config_hash === corpus.config_hash;
		job = {
			reachable: true,
			status: value.status,
			run_id: value.run_id,
			operation: value.operation,
			current_journal_index: value.current_journal_index,
			current_query_index: value.current_query_index,
			current_offset: value.current_offset,
			delivery_pending_count: value.delivery_pending_count,
			configuration_matches: configurationMatches,
		};
	} catch (error) {
		const safe = safeDiagnosticError(error);
		if (safe.code !== "job_not_initialized") job = { reachable: false, status: "error", error_code: safe.code, error: safe.message };
	}
	const ready = googleSheets.status === "ready" && configurationMatches && job.reachable === true;
	const runner = await runnerStatus(env, corpusId);
	return Response.json({
		status: ready ? "ready" : "error",
		checked_at: new Date().toISOString(),
		corpus_id: corpus.corpus_id,
		configuration: {
			ready: configurationMatches,
			missing: [],
			config_version: corpus.config_version,
			config_hash: corpus.config_hash,
			display_name: corpus.display_name,
		},
		google_sheets: googleSheets,
		gemini: { status: "configured", model: env.GEMINI_MODEL?.trim() || "gemini-3.8-flash" },
		job,
		runner,
	}, { status: ready ? 200 : 503 });
}

export default {
	async fetch(request: Request, env: WorkerEnv) {
		const url = new URL(request.url);
		const run = url.pathname.match(/^\/inbox\/run\/([a-z0-9]+(?:-[a-z0-9]+)*)$/);
		if (run) {
			if (request.method !== "POST") return Response.json({ status: "run_failed", error: "POST required." }, { status: 405 });
			return runCorpus(request, env, run[1]);
		}
		if (request.method === "GET" && url.pathname === "/inbox/status") {
			const corpusId = url.searchParams.get("corpus_id") ?? "";
			if (!corpusId) return Response.json({ status: "error", error: "corpus_id is required." }, { status: 400 });
			return corpusStatus(env, corpusId);
		}
		if (request.method === "GET" && url.pathname === "/") {
			return Response.json({
				name: "Scholarly Corpus Worker",
				version: "1.0.0",
				status: "ok",
				headless_driver: "github_actions_watchdog_cloudflare_alarm_gemini_api",
				configured_corpora: configuredCorpusIds(),
				run_endpoint: "/inbox/run/<corpus_id>",
				status_endpoint: "/inbox/status?corpus_id=<corpus_id>",
			});
		}
		return Response.json({ status: "not_found" }, { status: 404 });
	},
} satisfies ExportedHandler<WorkerEnv>;

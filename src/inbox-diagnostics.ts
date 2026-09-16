import { safeDiagnosticError } from "./diagnostic-errors";
import { runConfiguredCorpus } from "./inbox-runner";
import type { WorkerEnv } from "./types";

type RunCorpus = (env: WorkerEnv, corpusId: string) => Promise<Record<string, unknown>>;

type InboxRunContext = {
	source: "github_actions" | "durable_object_alarm";
	trigger: string;
	scheduledTime: number;
	corpus_id: string;
};

export async function executeInboxRun(
	context: InboxRunContext,
	env: WorkerEnv,
	run: RunCorpus = runConfiguredCorpus,
): Promise<Array<Record<string, unknown>>> {
	const startedAt = new Date().toISOString();
	console.log(JSON.stringify({
		event: "scholarly_headless_run_started",
		source: context.source,
		trigger: context.trigger,
		scheduled_time: new Date(context.scheduledTime).toISOString(),
		started_at: startedAt,
		corpus_id: context.corpus_id,
	}));
	try {
		const results = [await run(env, context.corpus_id)];
		console.log(JSON.stringify({
			event: "scholarly_headless_run_completed",
			source: context.source,
			trigger: context.trigger,
			started_at: startedAt,
			completed_at: new Date().toISOString(),
			corpus_id: context.corpus_id,
			results,
		}));
		return results;
	} catch (error) {
		const safe = safeDiagnosticError(error);
		console.error(JSON.stringify({
			event: "scholarly_headless_run_failed",
			source: context.source,
			trigger: context.trigger,
			started_at: startedAt,
			failed_at: new Date().toISOString(),
			corpus_id: context.corpus_id,
			error_code: safe.code,
			error: safe.message,
		}));
		throw error;
	}
}

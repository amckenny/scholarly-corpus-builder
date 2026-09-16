import { corpusById } from "./corpora";
import { safeDiagnosticError } from "./diagnostic-errors";
import { executeInboxRun } from "./inbox-diagnostics";
import type { WorkerEnv } from "./types";

const RUNNER_STATE_KEY = "runner:v1";

type RunnerState = {
	corpus_id: string;
	active: boolean;
	failure_count: number;
	last_started_at: string | null;
	last_completed_at: string | null;
	last_result: Record<string, unknown> | null;
	last_error_code: string | null;
	last_error: string | null;
	next_alarm_at: string | null;
};

function initialState(corpusId: string): RunnerState {
	return {
		corpus_id: corpusId,
		active: true,
		failure_count: 0,
		last_started_at: null,
		last_completed_at: null,
		last_result: null,
		last_error_code: null,
		last_error: null,
		next_alarm_at: null,
	};
}

function terminalStatus(result: Record<string, unknown>): boolean {
	return result.status === "incremental_cycle_not_due";
}

export class CorpusRunnerStore {
	constructor(private readonly state: DurableObjectState, private readonly env: WorkerEnv) {}

	private async schedule(runner: RunnerState, delaySeconds: number): Promise<void> {
		const alarmAt = Date.now() + Math.max(1, delaySeconds) * 1_000;
		runner.next_alarm_at = new Date(alarmAt).toISOString();
		await this.state.storage.put(RUNNER_STATE_KEY, runner);
		await this.state.storage.setAlarm(alarmAt);
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/start") {
			const body = await request.json() as { corpus_id?: unknown };
			if (typeof body.corpus_id !== "string" || !corpusById(this.env, body.corpus_id)) {
				return Response.json({ status: "runner_failed", error: "Unknown corpus_id." }, { status: 404 });
			}
			const existing = await this.state.storage.get<RunnerState>(RUNNER_STATE_KEY);
			const existingAlarm = existing?.active ? await this.state.storage.getAlarm() : null;
			if (existing?.active && existingAlarm !== null) {
				existing.next_alarm_at = new Date(existingAlarm).toISOString();
				await this.state.storage.put(RUNNER_STATE_KEY, existing);
				return Response.json({
					status: "runner_already_active",
					corpus_id: body.corpus_id,
					next_alarm_at: existing.next_alarm_at,
				}, { status: 202 });
			}
			const runner = existing?.corpus_id === body.corpus_id ? existing : initialState(body.corpus_id);
			runner.active = true;
			runner.last_error_code = null;
			runner.last_error = null;
			await this.schedule(runner, 1);
			return Response.json({
				status: existing?.active ? "runner_revived" : "runner_started",
				corpus_id: body.corpus_id,
				next_alarm_at: runner.next_alarm_at,
			}, { status: 202 });
		}
		if (request.method === "POST" && url.pathname === "/status") {
			const runner = await this.state.storage.get<RunnerState>(RUNNER_STATE_KEY);
			return Response.json(runner ?? { status: "not_started" });
		}
		return Response.json({ status: "not_found" }, { status: 404 });
	}

	async alarm(): Promise<void> {
		const runner = await this.state.storage.get<RunnerState>(RUNNER_STATE_KEY);
		if (!runner?.active) return;
		const config = corpusById(this.env, runner.corpus_id);
		if (!config) {
			runner.active = false;
			runner.next_alarm_at = null;
			runner.last_error_code = "unknown_corpus";
			runner.last_error = "The configured corpus no longer exists.";
			await this.state.storage.put(RUNNER_STATE_KEY, runner);
			return;
		}

		runner.last_started_at = new Date().toISOString();
		runner.next_alarm_at = null;
		await this.state.storage.put(RUNNER_STATE_KEY, runner);
		try {
			const [result] = await executeInboxRun({
				source: "durable_object_alarm",
				trigger: "CorpusRunnerStore.alarm",
				scheduledTime: Date.now(),
				corpus_id: runner.corpus_id,
			}, this.env);
			runner.failure_count = 0;
			runner.last_completed_at = new Date().toISOString();
			runner.last_result = result;
			runner.last_error_code = null;
			runner.last_error = null;
			if (terminalStatus(result)) {
				runner.active = false;
				runner.next_alarm_at = null;
				await this.state.storage.put(RUNNER_STATE_KEY, runner);
				return;
			}
			await this.schedule(runner, config.processing.continuation_delay_seconds);
		} catch (error) {
			const safe = safeDiagnosticError(error);
			runner.failure_count += 1;
			runner.last_error_code = safe.code;
			runner.last_error = safe.message;
			const delay = Math.min(
				config.processing.max_backoff_seconds,
				30 * (2 ** Math.min(runner.failure_count - 1, 10)),
			);
			await this.schedule(runner, delay);
			console.error(JSON.stringify({
				event: "scholarly_runner_retry_scheduled",
				corpus_id: runner.corpus_id,
				error_code: safe.code,
				error: safe.message,
				failure_count: runner.failure_count,
				retry_in_seconds: delay,
			}));
		}
	}
}

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	corpusById: vi.fn(),
	executeInboxRun: vi.fn(),
}));

vi.mock("../src/corpora", () => ({ corpusById: mocks.corpusById }));
vi.mock("../src/inbox-diagnostics", () => ({ executeInboxRun: mocks.executeInboxRun }));

import { CorpusRunnerStore } from "../src/corpus-runner";
import type { WorkerEnv } from "../src/types";

class AlarmStorage {
	readonly values = new Map<string, unknown>();
	alarmAt: number | null = null;

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value);
	}

	async setAlarm(value: number): Promise<void> {
		this.alarmAt = value;
	}

	async getAlarm(): Promise<number | null> {
		return this.alarmAt;
	}
}

function startRequest(): Request {
	return new Request("https://corpus-runner/start", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ corpus_id: "nlp-management" }),
	});
}

describe("durable corpus runner", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.corpusById.mockReturnValue({
			processing: { classification_batch_size: 5, continuation_delay_seconds: 5, max_backoff_seconds: 900 },
		});
	});

	it("starts asynchronously and schedules another alarm while work remains", async () => {
		const storage = new AlarmStorage();
		const runner = new CorpusRunnerStore({ storage } as unknown as DurableObjectState, {} as WorkerEnv);
		const started = await runner.fetch(startRequest());
		expect(started.status).toBe(202);
		expect(storage.alarmAt).not.toBeNull();

		mocks.executeInboxRun.mockResolvedValue([{ status: "inbox_ready", processed_count: 5 }]);
		await runner.alarm();
		const state = await storage.get<{ active: boolean; failure_count: number; last_result: Record<string, unknown>; next_alarm_at: string }>("runner:v1");
		expect(state).toEqual(expect.objectContaining({ active: true, failure_count: 0 }));
		expect(state?.last_result).toEqual(expect.objectContaining({ processed_count: 5 }));
		expect(state?.next_alarm_at).toBeTruthy();
	});

	it("stops only when the next incremental cycle is not due", async () => {
		const storage = new AlarmStorage();
		const runner = new CorpusRunnerStore({ storage } as unknown as DurableObjectState, {} as WorkerEnv);
		await runner.fetch(startRequest());
		mocks.executeInboxRun.mockResolvedValue([{ status: "incremental_cycle_not_due" }]);
		await runner.alarm();
		const state = await storage.get<{ active: boolean; next_alarm_at: string | null }>("runner:v1");
		expect(state).toEqual(expect.objectContaining({ active: false, next_alarm_at: null }));
	});

	it("retains state and backs off after a transient failure", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const storage = new AlarmStorage();
		const runner = new CorpusRunnerStore({ storage } as unknown as DurableObjectState, {} as WorkerEnv);
		await runner.fetch(startRequest());
		mocks.executeInboxRun.mockRejectedValue(new Error("temporary upstream failure"));
		await runner.alarm();
		const state = await storage.get<{ active: boolean; failure_count: number; last_error: string; next_alarm_at: string }>("runner:v1");
		expect(state).toEqual(expect.objectContaining({ active: true, failure_count: 1 }));
		expect(state?.last_error).toBeTruthy();
		expect(state?.next_alarm_at).toBeTruthy();
	});
});

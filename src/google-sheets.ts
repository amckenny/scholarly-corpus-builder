import type { InboxSheetRow, WorkerEnv } from "./types";
import { safeDiagnosticError } from "./diagnostic-errors";

export const INBOX_HEADERS = [
	"Envelope ID",
	"Signed Payload",
	"Payload Kind",
	"Corpus ID",
	"Run ID",
	"Record ID",
	"Canonical Row Hash",
	"Staged At",
	"Processing Status",
	"Processing Note",
] as const;

export const DECISION_HEADERS = [
	"Record ID",
	"Canonical Row Hash",
	"Decision",
	"Fit Basis",
	"Exclusion Reason",
	"Confidence",
	"Run ID",
	"Page ID",
	"Screened At",
	"Write Status",
] as const;

export const RUN_HEADERS = [
	"Run ID",
	"Maintenance Mode",
	"Discovery Mode",
	"Coverage Type",
	"Discovery Status",
	"Records Added",
	"Records Updated",
	"Durable Exclusions",
	"Unresolved Records",
	"Partial or Failed Scope",
	"Run Date",
	"Limitations",
	"Next Action",
] as const;

export const CORPUS_HEADERS = [
	"Record ID", "DOI", "Title", "Authors", "Journal", "Publication Date", "Published Online",
	"Published Print", "Volume", "Issue", "Pages", "Article Number", "Source Type", "Publisher",
	"Decision", "Fit Basis", "Confidence", "Evidence Depth", "Verification Level", "DOI URL",
	"Retrieved At", "Discovered By Query IDs", "Run ID", "Page ID", "Canonical Row Hash",
] as const;

export const EXCLUDED_HEADERS = [
	...CORPUS_HEADERS.slice(0, 16),
	"Exclusion Reason",
	...CORPUS_HEADERS.slice(16),
] as const;

export type SheetNames = {
	inbox: string;
	registry: string;
	decisions: string;
	runs: string;
	corpus: string;
	excluded: string;
};

export type HeadlessSheetIndex = {
	inbox: Map<string, { row: number; status: string; note: string }>;
	registry: Map<string, { row: number; run_id: string }>;
	decisions: Map<string, { row: number; status: string; classification: string; run_id: string }>;
	runs: Map<string, number>;
};

let cachedAccessToken: { token: string; expires_at: number } | null = null;

function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function utf8Base64Url(value: string): string {
	return bytesToBase64Url(new TextEncoder().encode(value));
}

function pemToPkcs8(value: string): ArrayBuffer {
	const normalized = value.replace(/\\n/g, "\n");
	const body = normalized
		.replace(/-----BEGIN PRIVATE KEY-----/g, "")
		.replace(/-----END PRIVATE KEY-----/g, "")
		.replace(/\s+/g, "");
	if (!body) throw new Error("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is empty or malformed.");
	const binary = atob(body);
	return Uint8Array.from(binary, (character) => character.charCodeAt(0)).buffer;
}

async function validatePrivateKey(privateKeyPem: string): Promise<void> {
	await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(privateKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
}

async function serviceAccountAssertion(email: string, privateKeyPem: string): Promise<string> {
	const now = Math.floor(Date.now() / 1_000);
	const header = utf8Base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = utf8Base64Url(
		JSON.stringify({
			iss: email,
			scope: "https://www.googleapis.com/auth/spreadsheets",
			aud: "https://oauth2.googleapis.com/token",
			iat: now,
			exp: now + 3_600,
		}),
	);
	const input = `${header}.${claims}`;
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToPkcs8(privateKeyPem),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
	return `${input}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function googleAccessToken(env: WorkerEnv): Promise<string> {
	if (cachedAccessToken && cachedAccessToken.expires_at > Date.now() + 60_000) return cachedAccessToken.token;
	const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
	const privateKey = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
	if (!email || !privateKey) throw new Error("Google service-account credentials are not configured.");
	const assertion = await serviceAccountAssertion(email, privateKey);
	const response = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion,
		}),
	});
	const payload = (await response.json()) as { access_token?: string; expires_in?: number; error_description?: string };
	if (!response.ok || !payload.access_token) {
		throw new Error(
			`Google OAuth token exchange failed with HTTP ${response.status}: ${payload.error_description ?? "No access token returned."}`,
		);
	}
	cachedAccessToken = {
		token: payload.access_token,
		expires_at: Date.now() + (payload.expires_in ?? 3_600) * 1_000,
	};
	return payload.access_token;
}

async function googleRequest(env: WorkerEnv, url: string, init: RequestInit = {}): Promise<Response> {
	const token = await googleAccessToken(env);
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${token}`);
	if (init.body) headers.set("content-type", "application/json");
	const response = await fetch(url, { ...init, headers });
	if (!response.ok) {
		const detail = await response.text();
		let upstreamStatus = "";
		let upstreamMessage = "";
		try {
			const parsed = JSON.parse(detail) as { error?: { status?: unknown; message?: unknown } };
			upstreamStatus = typeof parsed.error?.status === "string" ? parsed.error.status : "";
			upstreamMessage = typeof parsed.error?.message === "string"
				? parsed.error.message.replace(/[\r\n\t]+/g, " ").slice(0, 240)
				: "";
		} catch {
			// Non-JSON upstream failures still retain their HTTP status.
		}
		const operation = url.includes(":append") ? "values_append"
			: url.includes("values:batchGet") ? "values_batch_get"
			: url.includes(":batchUpdate") ? "spreadsheet_batch_update"
			: url.includes("/values/") ? (init.method === "PUT" ? "values_update" : "values_get")
			: "spreadsheet_metadata";
		console.error(JSON.stringify({
			event: "google_sheets_api_error",
			operation,
			http_status: response.status,
			upstream_status: upstreamStatus,
			upstream_message: upstreamMessage,
		}));
		throw new Error(`Google Sheets API request failed with HTTP ${response.status}: ${detail.slice(0, 500)}`);
	}
	return response;
}

function sheetsBase(spreadsheetId: string): string {
	return `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}`;
}

function a1Sheet(value: string): string {
	return `'${value.replace(/'/g, "''")}'`;
}

function columnName(columnCount: number): string {
	let value = columnCount;
	let output = "";
	while (value > 0) {
		value -= 1;
		output = String.fromCharCode(65 + (value % 26)) + output;
		value = Math.floor(value / 26);
	}
	return output;
}

export type InboxSheetAccessDiagnostic = {
	status: "ready" | "error";
	workbook_initialized?: boolean;
	checks: {
		credentials_configured: boolean;
		private_key_valid: boolean;
		oauth_token_obtained: boolean;
		spreadsheet_accessible: boolean;
		inbox_sheet_exists: boolean;
	};
	spreadsheet_title?: string;
	failure_stage?: "configuration" | "private_key" | "oauth" | "spreadsheet" | "inbox_sheet";
	error_code?: string;
	error?: string;
};

export async function diagnoseInboxSheetAccess(
	env: WorkerEnv,
	spreadsheetId: string,
	sheetTitle: string,
): Promise<InboxSheetAccessDiagnostic> {
	const checks = {
		credentials_configured: false,
		private_key_valid: false,
		oauth_token_obtained: false,
		spreadsheet_accessible: false,
		inbox_sheet_exists: false,
	};
	const fail = (
		failureStage: NonNullable<InboxSheetAccessDiagnostic["failure_stage"]>,
		error: unknown,
	): InboxSheetAccessDiagnostic => {
		const safe = safeDiagnosticError(error);
		return { status: "error", checks, failure_stage: failureStage, error_code: safe.code, error: safe.message };
	};
	const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim();
	const privateKey = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY?.trim();
	if (!email || !privateKey) return fail("configuration", new Error("Google service-account credentials are not configured."));
	checks.credentials_configured = true;
	try {
		await validatePrivateKey(privateKey);
		checks.private_key_valid = true;
	} catch {
		return {
			status: "error",
			checks,
			failure_stage: "private_key",
			error_code: "invalid_google_private_key",
			error: "The Google service-account private key could not be parsed.",
		};
	}
	try {
		await googleAccessToken(env);
		checks.oauth_token_obtained = true;
	} catch (error) {
		return fail("oauth", error);
	}
	let metadata: { properties?: { title?: string }; sheets?: Array<{ properties?: { title?: string } }> };
	try {
		metadata = (await (
			await googleRequest(env, `${sheetsBase(spreadsheetId)}?fields=properties.title,sheets.properties.title`)
		).json()) as typeof metadata;
		checks.spreadsheet_accessible = true;
	} catch (error) {
		return fail("spreadsheet", error);
	}
	checks.inbox_sheet_exists = Boolean(metadata.sheets?.some((sheet) => sheet.properties?.title === sheetTitle));
	return {
		status: "ready",
		workbook_initialized: checks.inbox_sheet_exists,
		checks,
		spreadsheet_title: metadata.properties?.title,
	};
}

export function candidateViewFormula(names: SheetNames): string {
	const decisions = a1Sheet(names.decisions);
	const registry = a1Sheet(names.registry);
	return `=ARRAYFORMULA(IFERROR(LET(decision_keys,FILTER(${decisions}!A2:A&"|"&${decisions}!B2:B,${decisions}!J2:J="verified"),matching_registry,ISNUMBER(MATCH(${registry}!A2:A&"|"&${registry}!AE2:AE,decision_keys,0)),eligible_registry,FILTER(${registry}!A2:AE,matching_registry),eligible_rows,FILTER(ROW(${registry}!A2:A),matching_registry),latest_registry,FILTER(eligible_registry,eligible_rows=XLOOKUP(CHOOSECOLS(eligible_registry,1),CHOOSECOLS(eligible_registry,1),eligible_rows,"",0,-1)),registry_keys,CHOOSECOLS(latest_registry,1)&"|"&CHOOSECOLS(latest_registry,31),decision_codes,XLOOKUP(registry_keys,decision_keys,FILTER(${decisions}!C2:C,${decisions}!J2:J="verified")),output_rows,HSTACK(CHOOSECOLS(latest_registry,1,3,4,5,6,9,10,11,12,13,14,15,16,8),decision_codes,XLOOKUP(registry_keys,decision_keys,FILTER(${decisions}!D2:D,${decisions}!J2:J="verified")),XLOOKUP(registry_keys,decision_keys,FILTER(${decisions}!F2:F,${decisions}!J2:J="verified")),CHOOSECOLS(latest_registry,19,18,17,20,24,28,29,31)),FILTER(output_rows,LEFT(decision_codes,10)="candidate_")),""))`;
}

export function excludedViewFormula(names: SheetNames): string {
	const decisions = a1Sheet(names.decisions);
	const registry = a1Sheet(names.registry);
	return `=ARRAYFORMULA(IFERROR(LET(decision_keys,FILTER(${decisions}!A2:A&"|"&${decisions}!B2:B,${decisions}!J2:J="verified"),matching_registry,ISNUMBER(MATCH(${registry}!A2:A&"|"&${registry}!AE2:AE,decision_keys,0)),eligible_registry,FILTER(${registry}!A2:AE,matching_registry),eligible_rows,FILTER(ROW(${registry}!A2:A),matching_registry),latest_registry,FILTER(eligible_registry,eligible_rows=XLOOKUP(CHOOSECOLS(eligible_registry,1),CHOOSECOLS(eligible_registry,1),eligible_rows,"",0,-1)),registry_keys,CHOOSECOLS(latest_registry,1)&"|"&CHOOSECOLS(latest_registry,31),decision_codes,XLOOKUP(registry_keys,decision_keys,FILTER(${decisions}!C2:C,${decisions}!J2:J="verified")),output_rows,HSTACK(CHOOSECOLS(latest_registry,1,3,4,5,6,9,10,11,12,13,14,15,16,8),decision_codes,XLOOKUP(registry_keys,decision_keys,FILTER(${decisions}!D2:D,${decisions}!J2:J="verified")),XLOOKUP(registry_keys,decision_keys,FILTER(${decisions}!E2:E,${decisions}!J2:J="verified")),XLOOKUP(registry_keys,decision_keys,FILTER(${decisions}!F2:F,${decisions}!J2:J="verified")),CHOOSECOLS(latest_registry,19,18,17,20,24,28,29,31)),FILTER(output_rows,LEFT(decision_codes,9)="excluded_")),""))`;
}

export async function ensureHeadlessSheets(
	env: WorkerEnv,
	spreadsheetId: string,
	names: SheetNames,
	registryHeaders: readonly string[],
): Promise<void> {
	const expected = [
		{ title: names.inbox, headers: INBOX_HEADERS, writable: true },
		{ title: names.registry, headers: registryHeaders, writable: true },
		{ title: names.decisions, headers: DECISION_HEADERS, writable: true },
		{ title: names.runs, headers: RUN_HEADERS, writable: true },
		{ title: names.corpus, headers: CORPUS_HEADERS, writable: false, formula: candidateViewFormula(names) },
		{ title: names.excluded, headers: EXCLUDED_HEADERS, writable: false, formula: excludedViewFormula(names) },
	] as const;
	const metadata = (await (
		await googleRequest(env, `${sheetsBase(spreadsheetId)}?fields=sheets.properties`)
	).json()) as { sheets?: Array<{ properties?: { sheetId?: number; title?: string } }> };
	const titles = new Set(
		metadata.sheets?.map((sheet) => sheet.properties?.title).filter((title): title is string => Boolean(title)),
	);
	const missing = expected.filter((sheet) => !titles.has(sheet.title));
	if (missing.length) {
		await googleRequest(env, `${sheetsBase(spreadsheetId)}:batchUpdate`, {
			method: "POST",
			body: JSON.stringify({
				requests: missing.map((sheet) => ({
					addSheet: {
						properties: {
							title: sheet.title,
							gridProperties: { rowCount: 10_000, columnCount: sheet.headers.length, frozenRowCount: 1 },
						},
					},
				})),
			}),
		});
		const refreshed = (await (
			await googleRequest(env, `${sheetsBase(spreadsheetId)}?fields=sheets.properties`)
		).json()) as typeof metadata;
		metadata.sheets = refreshed.sheets;
	}
	const sheetIds = new Map(
		metadata.sheets?.flatMap((sheet) => {
			const title = sheet.properties?.title;
			const sheetId = sheet.properties?.sheetId;
			return title && sheetId !== undefined ? [[title, sheetId] as const] : [];
		}),
	);
	if (missing.length) {
		const requests: Record<string, unknown>[] = [];
		for (const sheet of missing) {
			const sheetId = sheetIds.get(sheet.title);
			if (sheetId === undefined) throw new Error(`${sheet.title} sheet ID could not be resolved.`);
			requests.push({
				updateCells: {
					range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: sheet.headers.length },
					rows: [{ values: sheet.headers.map((header) => ({ userEnteredValue: { stringValue: header } })) }],
					fields: "userEnteredValue",
				},
			});
			if (sheet.writable) {
				requests.push({
					repeatCell: {
						range: { sheetId, startColumnIndex: 0, endColumnIndex: sheet.headers.length },
						cell: { userEnteredFormat: { numberFormat: { type: "TEXT" } } },
						fields: "userEnteredFormat.numberFormat",
					},
				});
			} else {
				requests.push({
					updateCells: {
						range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 1 },
						rows: [{ values: [{ userEnteredValue: { formulaValue: sheet.formula } }] }],
						fields: "userEnteredValue",
					},
				});
			}
		}
		await googleRequest(env, `${sheetsBase(spreadsheetId)}:batchUpdate`, {
			method: "POST",
			body: JSON.stringify({ requests }),
		});
	}
	const writable = expected.filter((sheet) => sheet.writable);
	const headerRanges = await batchGetValues(
		env,
		spreadsheetId,
		writable.map((sheet) => `${a1Sheet(sheet.title)}!A1:${columnName(sheet.headers.length)}1`),
	);
	for (let index = 0; index < writable.length; index += 1) {
		const actual = rectangularValues(headerRanges[index], writable[index].headers.length)[0] ?? [];
		if (
			actual.length !== writable[index].headers.length ||
			actual.some((header, column) => header !== writable[index].headers[column])
		) throw new Error(`${writable[index].title} headers do not match the approved schema.`);
	}
	const views = expected.filter((sheet) => !sheet.writable);
	const existingFormulas = await batchGetValues(
		env,
		spreadsheetId,
		views.map((sheet) => `${a1Sheet(sheet.title)}!A2`),
		"FORMULA",
	);
	const formulaRepairs: Record<string, unknown>[] = [];
	for (let index = 0; index < views.length; index += 1) {
		const sheetId = sheetIds.get(views[index].title);
		if (sheetId === undefined) throw new Error(`${views[index].title} sheet ID could not be resolved.`);
		const current = rectangularValues(existingFormulas[index], 1)[0]?.[0] ?? "";
		if (current === views[index].formula) continue;
		formulaRepairs.push({
			updateCells: {
				range: { sheetId, startRowIndex: 1, endRowIndex: 2, startColumnIndex: 0, endColumnIndex: 1 },
				rows: [{ values: [{ userEnteredValue: { formulaValue: views[index].formula } }] }],
				fields: "userEnteredValue",
			},
		});
	}
	if (formulaRepairs.length) {
		await googleRequest(env, `${sheetsBase(spreadsheetId)}:batchUpdate`, {
			method: "POST",
			body: JSON.stringify({ requests: formulaRepairs }),
		});
	}
}

type ValueRange = { range?: string; values?: unknown[][] };

async function batchGetValues(
	env: WorkerEnv,
	spreadsheetId: string,
	ranges: string[],
	valueRenderOption?: "FORMULA",
): Promise<ValueRange[]> {
	const url = new URL(`${sheetsBase(spreadsheetId)}/values:batchGet`);
	for (const range of ranges) url.searchParams.append("ranges", range);
	url.searchParams.set("majorDimension", "ROWS");
	if (valueRenderOption) url.searchParams.set("valueRenderOption", valueRenderOption);
	const payload = (await (await googleRequest(env, url.toString())).json()) as { valueRanges?: ValueRange[] };
	return payload.valueRanges ?? [];
}

function columnValues(range: ValueRange | undefined): string[] {
	return (range?.values ?? []).map((row) => {
		const value = row[0];
		return typeof value === "string" ? value : value == null ? "" : String(value);
	});
}

function rectangularValues(range: ValueRange | undefined, width: number): string[][] {
	return (range?.values ?? []).map((row) => Array.from({ length: width }, (_, index) => {
		const value = row[index];
		return typeof value === "string" ? value : value == null ? "" : String(value);
	}));
}

export async function loadHeadlessSheetIndex(
	env: WorkerEnv,
	spreadsheetId: string,
	names: SheetNames,
): Promise<HeadlessSheetIndex> {
	const ranges = await batchGetValues(env, spreadsheetId, [
		`${a1Sheet(names.inbox)}!A2:A`,
		`${a1Sheet(names.inbox)}!I2:J`,
		`${a1Sheet(names.registry)}!A2:A`,
		`${a1Sheet(names.registry)}!AE2:AE`,
		`${a1Sheet(names.registry)}!AB2:AB`,
		`${a1Sheet(names.decisions)}!A2:B`,
		`${a1Sheet(names.decisions)}!C2:C`,
		`${a1Sheet(names.decisions)}!G2:G`,
		`${a1Sheet(names.decisions)}!J2:J`,
		`${a1Sheet(names.runs)}!A2:A`,
	]);
	const inboxIds = columnValues(ranges[0]);
	const inboxState = rectangularValues(ranges[1], 2);
	const registryIds = columnValues(ranges[2]);
	const registryHashes = columnValues(ranges[3]);
	const registryRunIds = columnValues(ranges[4]);
	const decisionKeys = rectangularValues(ranges[5], 2);
	const decisionClassifications = columnValues(ranges[6]);
	const decisionRunIds = columnValues(ranges[7]);
	const decisionStatus = columnValues(ranges[8]);
	const runIds = columnValues(ranges[9]);
	const inbox = new Map<string, { row: number; status: string; note: string }>();
	for (let index = 0; index < inboxIds.length; index += 1) {
		if (!inboxIds[index]) continue;
		if (inbox.has(inboxIds[index])) throw new Error(`Duplicate Inbound Queue envelope ID: ${inboxIds[index]}`);
		inbox.set(inboxIds[index], { row: index + 2, status: inboxState[index]?.[0] ?? "", note: inboxState[index]?.[1] ?? "" });
	}
	const registry = new Map<string, { row: number; run_id: string }>();
	for (let index = 0; index < registryIds.length; index += 1) {
		if (!registryIds[index] && !registryHashes[index]) continue;
		const key = `${registryIds[index]}|${registryHashes[index] ?? ""}`;
		if (registry.has(key)) throw new Error(`Duplicate Direct Registry key: ${key}`);
		registry.set(key, { row: index + 2, run_id: registryRunIds[index] ?? "" });
	}
	const decisions = new Map<string, { row: number; status: string; classification: string; run_id: string }>();
	for (let index = 0; index < decisionKeys.length; index += 1) {
		const [recordId, hash] = decisionKeys[index] ?? ["", ""];
		if (!recordId && !hash) continue;
		const key = `${recordId}|${hash}`;
		if (decisions.has(key)) throw new Error(`Duplicate Direct Decisions key: ${key}`);
		decisions.set(key, {
			row: index + 2,
			status: decisionStatus[index] ?? "",
			classification: decisionClassifications[index] ?? "",
			run_id: decisionRunIds[index] ?? "",
		});
	}
	const runs = new Map<string, number>();
	for (let index = 0; index < runIds.length; index += 1) if (runIds[index]) runs.set(runIds[index], index + 2);
	return { inbox, registry, decisions, runs };
}

async function appendRawRow(
	env: WorkerEnv,
	spreadsheetId: string,
	sheetTitle: string,
	row: string[],
): Promise<number> {
	if (!row.length || row.some((value) => typeof value !== "string")) throw new Error(`${sheetTitle} append requires string cells.`);
	const endColumn = columnName(row.length);
	const range = encodeURIComponent(`${a1Sheet(sheetTitle)}!A:${endColumn}`);
	const payload = (await (
		await googleRequest(
			env,
			`${sheetsBase(spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
			{ method: "POST", body: JSON.stringify({ majorDimension: "ROWS", values: [row] }) },
		)
	).json()) as { updates?: { updatedRange?: string } };
	const match = payload.updates?.updatedRange?.match(/![A-Z]+(\d+):/);
	if (!match) throw new Error(`${sheetTitle} append did not report its row number.`);
	return Number(match[1]);
}

export async function readExactTextRow(
	env: WorkerEnv,
	spreadsheetId: string,
	sheetTitle: string,
	rowNumber: number,
	width: number,
): Promise<string[]> {
	const endColumn = columnName(width);
	const range = encodeURIComponent(`${a1Sheet(sheetTitle)}!A${rowNumber}:${endColumn}${rowNumber}`);
	const payload = (await (
		await googleRequest(env, `${sheetsBase(spreadsheetId)}/values/${range}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE`)
	).json()) as { values?: unknown[][] };
	const raw = payload.values?.[0] ?? [];
	return Array.from({ length: width }, (_, index) => {
		const value = raw[index];
		if (value == null) return "";
		if (typeof value !== "string") throw new Error(`${sheetTitle} row ${rowNumber} contains a non-text cell.`);
		return value;
	});
}

function requireExactRow(actual: string[], expected: string[], label: string): void {
	if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
		throw new Error(`${label} read-back reconciliation failed.`);
	}
}

export async function ensureInboxAuditRow(
	env: WorkerEnv,
	spreadsheetId: string,
	names: SheetNames,
	index: HeadlessSheetIndex,
	row: InboxSheetRow,
): Promise<{ row: number; status: string; note: string }> {
	const existing = index.inbox.get(row[0]);
	if (existing) {
		const actual = await readExactTextRow(env, spreadsheetId, names.inbox, existing.row, INBOX_HEADERS.length);
		requireExactRow(actual.slice(0, 8), row.slice(0, 8), "Inbound Queue envelope");
		return existing;
	}
	const rowNumber = await appendRawRow(env, spreadsheetId, names.inbox, row);
	const actual = await readExactTextRow(env, spreadsheetId, names.inbox, rowNumber, INBOX_HEADERS.length);
	requireExactRow(actual, row, "Inbound Queue envelope");
	const state = { row: rowNumber, status: row[8], note: row[9] };
	index.inbox.set(row[0], state);
	return state;
}

export async function ensureRegistryRow(
	env: WorkerEnv,
	spreadsheetId: string,
	names: SheetNames,
	index: HeadlessSheetIndex,
	row: string[],
): Promise<{ row: number; duplicate: boolean }> {
	if (row.length !== 31) throw new Error("Direct Registry requires exactly 31 cells.");
	const key = `${row[0]}|${row[30]}`;
	const existing = index.registry.get(key);
	if (existing) {
		requireExactRow(await readExactTextRow(env, spreadsheetId, names.registry, existing.row, row.length), row, "Direct Registry row");
		return { row: existing.row, duplicate: true };
	}
	const rowNumber = await appendRawRow(env, spreadsheetId, names.registry, row);
	requireExactRow(await readExactTextRow(env, spreadsheetId, names.registry, rowNumber, row.length), row, "Direct Registry row");
	index.registry.set(key, { row: rowNumber, run_id: row[27] });
	return { row: rowNumber, duplicate: false };
}

export async function existingDecisionRow(
	env: WorkerEnv,
	spreadsheetId: string,
	names: SheetNames,
	index: HeadlessSheetIndex,
	recordId: string,
	hash: string,
): Promise<string[] | null> {
	const existing = index.decisions.get(`${recordId}|${hash}`);
	if (!existing) return null;
	const row = await readExactTextRow(env, spreadsheetId, names.decisions, existing.row, DECISION_HEADERS.length);
	if (row[0] !== recordId || row[1] !== hash || row[9] !== "verified") throw new Error("Existing Direct Decisions row is not verified.");
	return row;
}

export async function ensureDecisionRow(
	env: WorkerEnv,
	spreadsheetId: string,
	names: SheetNames,
	index: HeadlessSheetIndex,
	row: string[],
): Promise<{ row: number; duplicate: boolean }> {
	if (row.length !== DECISION_HEADERS.length || row[9] !== "verified") throw new Error("Direct Decisions row is invalid.");
	const key = `${row[0]}|${row[1]}`;
	const existing = index.decisions.get(key);
	if (existing) {
		requireExactRow(await readExactTextRow(env, spreadsheetId, names.decisions, existing.row, row.length), row, "Direct Decisions row");
		return { row: existing.row, duplicate: true };
	}
	const rowNumber = await appendRawRow(env, spreadsheetId, names.decisions, row);
	requireExactRow(await readExactTextRow(env, spreadsheetId, names.decisions, rowNumber, row.length), row, "Direct Decisions row");
	index.decisions.set(key, { row: rowNumber, status: "verified", classification: row[2], run_id: row[6] });
	return { row: rowNumber, duplicate: false };
}

export async function markInboxProcessed(
	env: WorkerEnv,
	spreadsheetId: string,
	names: SheetNames,
	index: HeadlessSheetIndex,
	envelopeId: string,
	note: string,
): Promise<void> {
	const existing = index.inbox.get(envelopeId);
	if (!existing) throw new Error("Inbound Queue envelope is missing before acknowledgement.");
	const range = encodeURIComponent(`${a1Sheet(names.inbox)}!I${existing.row}:J${existing.row}`);
	await googleRequest(
		env,
		`${sheetsBase(spreadsheetId)}/values/${range}?valueInputOption=RAW`,
		{ method: "PUT", body: JSON.stringify({ majorDimension: "ROWS", values: [["processed", note]] }) },
	);
	const actual = await readExactTextRow(env, spreadsheetId, names.inbox, existing.row, INBOX_HEADERS.length);
	if (actual[8] !== "processed" || actual[9] !== note) throw new Error("Inbound Queue acknowledgement read-back failed.");
	index.inbox.set(envelopeId, { row: existing.row, status: "processed", note });
}

export async function ensureRunRow(
	env: WorkerEnv,
	spreadsheetId: string,
	names: SheetNames,
	index: HeadlessSheetIndex,
	row: string[],
): Promise<{ row: number; duplicate: boolean }> {
	if (row.length !== RUN_HEADERS.length || !row[0]) throw new Error("Runs row is invalid.");
	const existingRow = index.runs.get(row[0]);
	if (existingRow) {
		requireExactRow(await readExactTextRow(env, spreadsheetId, names.runs, existingRow, row.length), row, "Runs row");
		return { row: existingRow, duplicate: true };
	}
	const rowNumber = await appendRawRow(env, spreadsheetId, names.runs, row);
	requireExactRow(await readExactTextRow(env, spreadsheetId, names.runs, rowNumber, row.length), row, "Runs row");
	index.runs.set(row[0], rowNumber);
	return { row: rowNumber, duplicate: false };
}

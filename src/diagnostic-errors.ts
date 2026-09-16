export type SafeDiagnosticError = {
	code: string;
	message: string;
};

export function safeDiagnosticError(error: unknown): SafeDiagnosticError {
	const message = error instanceof Error ? error.message : String(error);
	if (/CROSSREF_MAILTO/i.test(message)) {
		return { code: "missing_crossref_mailto", message: "CROSSREF_MAILTO is not configured." };
	}
	if (/SCHOLARLY_CORPUS_SPREADSHEETS|No spreadsheet mapping is configured/i.test(message)) {
		return { code: "missing_spreadsheet_mapping", message: "The corpus does not have a valid Google Sheets mapping." };
	}
	if (/Corpus configuration changed|configuration hash does not match/i.test(message)) {
		return {
			code: "corpus_configuration_changed",
			message: "The active corpus configuration differs from the initialized job; an explicit migration or new job handle is required.",
		};
	}
	if (/Unknown corpus_id/i.test(message)) {
		return { code: "unknown_corpus", message: "The requested corpus_id is not configured." };
	}
	if (/GEMINI_API_KEY/i.test(message)) {
		return { code: "missing_gemini_api_key", message: "GEMINI_API_KEY is not configured." };
	}
	if (/Gemini API request failed with HTTP 429/i.test(message)) {
		return { code: "gemini_rate_limited", message: "The Gemini API rate limit was reached; the queue remains safe for retry." };
	}
	if (/Gemini API request failed with HTTP 400/i.test(message)) {
		return { code: "gemini_request_invalid", message: "Gemini rejected the classification request; the queue row remains pending." };
	}
	if (/Gemini API request failed with HTTP 401|Gemini API request failed with HTTP 403/i.test(message)) {
		return { code: "gemini_auth_failed", message: "Gemini rejected the configured API key or project access; the queue row remains pending." };
	}
	if (/Gemini API request failed with HTTP 404/i.test(message)) {
		return { code: "gemini_model_not_found", message: "The configured Gemini model was not available to this API project; the queue row remains pending." };
	}
	if (/Gemini|classification/i.test(message)) {
		return { code: "gemini_classification_failed", message: "Gemini classification failed; the queue row remains pending." };
	}
	if (/Too many subrequests|subrequest limit/i.test(message)) {
		return {
			code: "cloudflare_subrequest_limit",
			message: "The Cloudflare per-request subrequest limit was reached; verified rows remain safe for the next scheduled run.",
		};
	}
	if (/service-account credentials are not configured/i.test(message)) {
		return { code: "missing_google_credentials", message: "Google service-account credentials are not configured." };
	}
	if (/private key|pkcs8|key data|malformed/i.test(message)) {
		return { code: "invalid_google_private_key", message: "The Google service-account private key could not be parsed." };
	}
	if (/OAuth token exchange failed|invalid_grant|invalid_client|unauthorized_client/i.test(message)) {
		return { code: "google_oauth_failed", message: "Google rejected service-account authentication." };
	}
	if (/Google Sheets API request failed with HTTP 403/i.test(message)) {
		return {
			code: "google_sheets_forbidden",
			message: "Google Sheets denied access. Enable the Sheets API and share the workbook with the service account as Editor.",
		};
	}
	if (/Google Sheets API request failed with HTTP 404/i.test(message)) {
		return { code: "spreadsheet_not_found", message: "The configured Google spreadsheet was not found." };
	}
	if (/Google Sheets API request failed with HTTP 429/i.test(message)) {
		return {
			code: "google_sheets_rate_limited",
			message: "Google Sheets temporarily rate-limited the service account; verified rows remain safe for the next scheduled run.",
		};
	}
	if (/Google Sheets API request failed/i.test(message)) {
		return { code: "google_sheets_request_failed", message: "The Google Sheets API request failed." };
	}
	if (/configured inbox sheet was not found/i.test(message)) {
		return { code: "inbox_sheet_not_found", message: "The configured Inbound Queue sheet was not found." };
	}
	if (/Unknown corpus job/i.test(message)) {
		return { code: "job_not_initialized", message: "The corpus job has not been initialized." };
	}
	return { code: "scheduled_inbox_failed", message: "The scheduled inbox run failed." };
}

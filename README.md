# Scholarly Corpus Builder

This project builds and maintains scholarly literature corpora in Google Sheets. A scheduled GitHub Action calls a Cloudflare Worker, which queries Crossref by exact journal ISSN, asks Gemini to classify one title/abstract at a time, and writes verified rows through the Google Sheets API.

The search universe is **the configured query matches within the configured exact-ISSN journals and date window**. 

## Runtime flow

1. A periodic GitHub Actions watchdog calls `POST /inbox/run/<corpus_id>` with a shared bearer secret. The endpoint starts or revives that corpus's Cloudflare runner and returns immediately.
2. A Durable Object alarm retrieves Crossref pages by exact journal ISSN and query family. Query matches that fail the configured deterministic retrieval gate are counted but not sent to Gemini.
3. Duplicate record IDs within the run are discarded. The retained records are split into signed deliveries of at most five, independent of the Crossref page size.
4. For each envelope, the Worker verifies the signature and row hash, writes the immutable Registry row, and verifies the exact read-back.
5. Gemini classifies the separate title/abstract object. The Worker validates the response against the corpus's allowed classifications and writes a separate Decision row.
6. The envelope is marked processed only after both writes verify.
7. Unless the corpus is caught up, the runner schedules its next alarm after `continuation_delay_seconds`. When the initial search is exhausted, it records a run manifest and later starts overlapping incremental searches when the configured minimum interval has elapsed.

## Repository map

| Path | Purpose | Usually edited by a new user? |
|---|---|---|
| `corpora/*.json` | Journals, queries, retrieval gate, screening rubric, batch settings, initial lookback, and incremental cadence | Yes |
| `corpora/corpus.schema.json` | Configuration reference schema | No |
| `corpora/crowdfunding.json.example` | Copyable second-corpus example | Yes, after copying |
| `.github/workflows/stage-scholarly-inbox.yml` | Schedule and authenticated Worker calls | Only to change the schedule |
| `wrangler.jsonc` | Worker name, Durable Object binding, deployment settings | Only to rename the Worker |
| `src/` | Headless runtime | No |
| `scripts/generate-corpora.mjs` | Validates configurations and generates their hashes | No |

## End-to-end setup

No local Node installation is required if Cloudflare Builds performs the deployment.

### 1. Prepare the GitHub repository

1. Fork or copy this repository into the GitHub account Cloudflare will use.
2. Open `corpora/nlp-management.json`, or copy `corpora/crowdfunding.json.example` to a new filename ending in `.json`.
3. Edit the corpus-specific fields described below. Do not edit `src/generated-corpus-configs.ts`; Cloudflare regenerates it during the build.
4. Commit the changes to the default branch.

For a new corpus, edit:

| Field | What to enter |
|---|---|
| `corpus_id` | Unique lowercase kebab-case ID, such as `crowdfunding` |
| `display_name` | Human-readable corpus name |
| `spreadsheet_key` | Key used in the Cloudflare spreadsheet mapping; usually the same as `corpus_id` |
| `job_handle` | A new version-4 UUID; never reuse one from another corpus |
| `initial_load.lookback_years` | Publication window for the first load |
| `discovery.journals` | Authoritative journal names and ISSNs |
| `discovery.query_families` | Crossref search queries; up to eight |
| `discovery.retrieval_gate` | Deterministic title/abstract phrases required before Gemini, plus title prefixes to reject |
| `discovery.rows_per_page` | Crossref transport page size; 100 is a practical default and is not a total-result limit |
| `processing.classification_batch_size` | Records classified per transaction; keep at five |
| `processing.continuation_delay_seconds` | Delay before the next transaction while work remains; five seconds is the default |
| `processing.max_backoff_seconds` | Maximum retry delay after temporary API failures |
| `screening.*` | Topic definition, inclusion/exclusion rules, and allowed classifications |
| `incremental_updates.overlap_days` | Overlap used to catch late Crossref indexing |
| `incremental_updates.minimum_gap_days` | Minimum days between completed incremental cycles |

Generate a UUID without installing software:

- PowerShell: `[guid]::NewGuid().ToString()`
- Python, if available: `python -c "import uuid; print(uuid.uuid4())"`

Query families are deliberately corpus-specific. Prefer distinctive phrases and method names over generic single words. For example, `natural language processing`, `topic modeling`, and `word embeddings` are useful signals; `information` by itself is not. The Crossref search is a broad discovery layer, so use `retrieval_gate.include_any_phrases` for distinctive phrases and `include_all_groups` for combinations such as `["machine learning", "text"]`. The gate is evaluated against the exact Crossref title and abstract and never rewrites them. A gate that is too narrow can reduce recall, so validate it against a small set of known relevant articles before starting a fresh corpus job.

**Test this step:** Cloudflare will run the configuration validator during deployment. If Node is available locally, run `npm clean-install && npm run type-check && npm test`.

### 2. Create the Google Cloud credentials

1. Create or select a Google Cloud project.
2. In **APIs & Services → Library**, enable the **Google Sheets API**. Google's [Sheets quickstart](https://developers.google.com/workspace/sheets/api/quickstart/nodejs) links directly to the enablement step.
3. In **IAM & Admin → Service Accounts**, create a service account:
   - Name: `Scholarly Corpus Writer`
   - ID: accept the generated `scholarly-corpus-writer`, or another unique ID
   - Description: `Writes verified Crossref corpus rows to configured Google Sheets`
   - Project role: none is required for this workflow; spreadsheet access is granted by sharing the file directly.
4. Open the service account, choose **Keys → Add key → Create new key → JSON**, and download the key. Google documents the process in [Create and delete service-account keys](https://docs.cloud.google.com/iam/docs/keys-create-delete).
5. Record the JSON file's `client_email` and `private_key`. Store them in Cloudflare in step 5, then securely delete the downloaded key file. Review Google's [service-account key practices](https://docs.cloud.google.com/iam/docs/best-practices-for-managing-service-account-keys).

An OAuth consent screen and domain-wide delegation are not needed; the Worker authenticates as the service account.

**Test this step:** On the Google Cloud API page, **Google Sheets API** should show **Enabled**. Under the service account's **Keys** tab, the downloaded key ID should be listed as active.

### 3. Create the Gemini API key

1. Open [Google AI Studio](https://aistudio.google.com/apikey).
2. Select the intended Google Cloud project and create an API key.
3. Ensure the project has billing/quota appropriate for unattended classification. An exhausted Gemini quota pauses the queue safely but prevents progress.
4. The default model is `gemini-3.8-flash`. Set `GEMINI_MODEL` in Cloudflare if the model available to your project differs. Google maintains current setup guidance in the [Gemini API documentation](https://ai.google.dev/gemini-api/docs/api-key).

**Test this step:** AI Studio should show the key as active. The Worker status test in step 6 confirms only that a key and model are configured; the first workflow run confirms the key can classify.

### 4. Create one Google Sheet per corpus

1. Create a blank Google Sheet.
2. Share it directly with the service account's `client_email` as **Editor**.
3. Copy the spreadsheet ID: it is the text between `/d/` and `/edit` in the Sheet URL.
4. Repeat for every enabled corpus.

Do not create tabs or install Apps Script. On the first run, the Worker creates:

- `Inbound Queue` — signed processing audit
- `Direct Registry` — immutable Crossref rows and hashes
- `Direct Decisions` — Gemini classification only
- `Runs` — completed retrieval manifests
- `Corpus` — current candidate view, one latest verified version per record ID
- `Excluded` — current exclusion view, one latest verified version per record ID

If any writable tab already exists, its header row must match the approved schema; the Worker fails closed instead of overwriting it. Existing `Corpus` and `Excluded` views are preserved.

**Test this step:** Confirm that the service-account email appears in the Sheet's share dialog as Editor. Tab creation is tested by the first GitHub workflow run.

### 5. Deploy with Cloudflare Workers Builds

Cloudflare's [Workers Builds guide](https://developers.cloudflare.com/workers/ci-cd/builds/) explains how to import a GitHub repository. For an existing Worker, connect the repository under **Settings → Builds**.

1. In Cloudflare, choose **Workers & Pages → Create application → Import a repository** and select this repository.
2. Configure the default branch and these commands:
   - Build command: `npm run type-check && npm test`
   - Deploy command: `npm run deploy`
3. Deploy. `wrangler.jsonc` provisions both Durable Objects: `CORPUS_JOBS` stores retrieval state and `CORPUS_RUNNERS` owns continuation alarms and retry backoff.
4. Under the Worker's **Settings → Variables and Secrets**, add the values below. Cloudflare recommends storing sensitive values as encrypted [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

| Name | Type | Value |
|---|---|---|
| `CROSSREF_MAILTO` | Variable | A real contact email used for polite Crossref requests |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Variable | The JSON key's complete `client_email` |
| `SCHOLARLY_CORPUS_SPREADSHEETS` | Variable | One complete JSON object mapping spreadsheet keys to IDs, for example `{"nlp-management":"1abc...","crowdfunding":"1xyz..."}` |
| `GEMINI_MODEL` | Variable, optional | Model name; omit to use `gemini-3.8-flash` |
| `GEMINI_API_KEY` | Secret | Google AI Studio API key |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | Secret | The complete JSON key `private_key`, including BEGIN/END lines; pasted multiline or with literal `\n` sequences |
| `SCHOLARLY_RUN_SECRET` | Secret | At least 32 random characters; the exact same value is added to GitHub |

To generate the run secret in PowerShell:

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(48))
```

The spreadsheet mapping value is the **full JSON object**, not a lone worksheet ID. Do not add the obsolete `SCHOLARLY_HMAC_SECRET`, `SCHOLARLY_DELIVERY_SECRET`, or `SCHOLARLY_INBOX_SPREADSHEET_ID` variables.

**Test this step:** Open the deployed Worker URL. `/` should return `status: "ok"`, version `1.0.0`, and the expected `configured_corpora` list.

### 6. Test Worker-to-Google configuration

Open this URL in a browser, replacing the host and corpus ID:

```text
https://YOUR-WORKER.workers.dev/inbox/status?corpus_id=YOUR-CORPUS-ID
```

Before the first run, a correct setup returns:

- top-level `status: "ready"`
- `configuration.ready: true`
- `google_sheets.status: "ready"`
- `google_sheets.workbook_initialized: false` for a blank Sheet
- `job.status: "not_initialized"`

After the first run, `workbook_initialized` becomes `true` and the job becomes `running`, `complete`, or `finalized`.
The `runner` object reports whether automatic continuation is active, its next alarm, its last result, and any safe retry error.

### 7. Configure GitHub Actions

1. In GitHub, open **Settings → Secrets and variables → Actions**.
2. Add a repository **secret** named `SCHOLARLY_RUN_SECRET` with exactly the same value stored in Cloudflare.
3. Add a repository **variable** named `WORKER_RUN_BASE_URL` with:

   ```text
   https://YOUR-WORKER.workers.dev/inbox/run
   ```

   Do not append a corpus ID and do not add a trailing slash.
4. Enable Actions for the repository.
5. Review `.github/workflows/stage-scholarly-inbox.yml`. Its default daily schedule is a watchdog, not the batch cadence. After one authenticated start, Cloudflare alarms continue five-record transactions until the corpus is caught up. The Worker itself enforces each corpus's `minimum_gap_days`. GitHub documents scheduled syntax in [Workflow syntax](https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions#onschedule).
6. In **Actions → Update scholarly corpus**, choose **Run workflow**. GitHub documents this in [Manually running a workflow](https://docs.github.com/actions/managing-workflow-runs/manually-running-a-workflow).

The workflow uses `actions/checkout@v5` with explicit read-only repository permission, so it works for private repositories when Actions is enabled.

**Test this step:** A successful run prints `runner_started`, `runner_revived`, or `runner_already_active` for each enabled corpus and finishes quickly. Within roughly `continuation_delay_seconds`, the Sheet should contain the six tabs listed above and processed `Inbound Queue` rows.

## Verifying an initial load

The initial load retrieves all pages in every configured journal-query-date intersection. It classifies at most five records per alarm, then normally schedules the next alarm seconds later—there is no 15-minute pause between batches. Check progress at `/inbox/status?corpus_id=...`:

- `current_journal_index`, `current_query_index`, and `current_offset` should advance.
- `delivery_pending_count` is 0 or 1; a pending item is retried safely.
- `totals.prefiltered_records` counts query matches rejected by the deterministic gate before Gemini.
- `runner.active: true` and a future `runner.next_alarm_at` mean automatic continuation is scheduled.
- `Runs` receives an `INITIAL` row only after every configured journal-query family is exhausted or explicitly recorded as failed.
- `Corpus` and `Excluded` should contain only rows whose exact Registry hash has a verified Decision.

After the `INITIAL` row appears, the runner stops when an incremental cycle is not due. The daily GitHub watchdog restarts it; `minimum_gap_days` remains the authoritative per-corpus eligibility rule.

## Incremental loads

After the initial run manifest is acknowledged, the next eligible invocation starts an `INCREMENTAL` cycle. It searches records indexed during an overlapping window ending on the current date. The overlap catches late updates; deduplication prevents identical record versions from being written twice. If Crossref changes registry metadata, the immutable old version remains in `Direct Registry`, while the formula views show only the latest verified version for that record ID.

## Adding another corpus

1. Create and share a new blank Google Sheet with the same service account.
2. Copy `corpora/crowdfunding.json.example` to `corpora/<corpus-id>.json`.
3. Set a unique `corpus_id`, `spreadsheet_key`, and version-4 `job_handle`; then replace the journals, queries, date rules, and screening rubric.
4. Add the new mapping to `SCHOLARLY_CORPUS_SPREADSHEETS`. Keep all existing mappings in the same JSON object.
5. Commit the configuration. Cloudflare redeploys and GitHub Actions automatically discovers every enabled `.json` corpus.
6. Test the new status URL, then manually run the workflow once.

Once a job is initialized, its configuration hash is deliberately immutable. To make a substantive change to journals, queries, date scope, or screening rules, create a new job handle and preferably a new Sheet/corpus ID so decisions made under different rubrics cannot be silently mixed. To pause a corpus without deleting its state, set `enabled` to `false` and commit.

## Troubleshooting

| Symptom | Likely cause or action |
|---|---|
| `missing_spreadsheet_mapping` | `SCHOLARLY_CORPUS_SPREADSHEETS` is missing, invalid JSON, or lacks the `spreadsheet_key` |
| `google_sheets_forbidden` | Enable Sheets API and share the Sheet with the service account as Editor |
| `invalid_google_private_key` | Store the complete PKCS#8 private key, preserving newlines |
| `gemini_auth_failed` / `gemini_model_not_found` | Check the AI Studio key, project, billing, and `GEMINI_MODEL` |
| `gemini_rate_limited` | The runner retains the signed delivery and retries with exponential backoff; increase quota if this repeats |
| `google_sheets_rate_limited` | The runner retries automatically with exponential backoff; Google documents per-minute quotas in [Sheets API usage limits](https://developers.google.com/workspace/sheets/api/limits) |
| `corpus_configuration_changed` | The initialized job handle is bound to an older configuration hash; use a new handle and migration plan |
| GitHub checkout says repository not found | Ensure Actions is enabled and the workflow has `contents: read`; reconnect Cloudflare's GitHub installation if deployment checkout fails |

Cloudflare structured logs use `scholarly_headless_run_started`, `scholarly_headless_run_completed`, `scholarly_headless_run_failed`, and `scholarly_runner_retry_scheduled` events. GitHub Actions retains only the runner-start receipt; secrets and raw upstream error bodies are not returned.

## Local development (optional)

```bash
cp .dev.vars.example .dev.vars
npm clean-install
npm run type-check
npm test
npm run dev
```

Never commit `.dev.vars` or a downloaded Google service-account key.

## License

[MIT](LICENSE)

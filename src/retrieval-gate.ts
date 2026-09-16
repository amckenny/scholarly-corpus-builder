import type { CorpusRetrievalGateConfig } from "./types";

function normalized(value: string | null): string {
	return (value ?? "")
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim()
		.replace(/\s+/g, " ");
}

function containsPhrase(text: string, phrase: string): boolean {
	const needle = normalized(phrase);
	return Boolean(needle && ` ${text} `.includes(` ${needle} `));
}

export type RetrievalGateResult = {
	passed: boolean;
	reason: "excluded_title_prefix" | "no_configured_retrieval_signal" | null;
};

export function evaluateRetrievalGate(
	title: string | null,
	abstract: string | null,
	config: CorpusRetrievalGateConfig,
): RetrievalGateResult {
	const normalizedTitle = normalized(title);
	for (const prefix of config.exclude_title_prefixes) {
		const normalizedPrefix = normalized(prefix);
		if (normalizedPrefix && normalizedTitle.startsWith(normalizedPrefix)) {
			return { passed: false, reason: "excluded_title_prefix" };
		}
	}

	const evidence = normalized(`${title ?? ""} ${abstract ?? ""}`);
	if (config.include_any_phrases.some((phrase) => containsPhrase(evidence, phrase))) {
		return { passed: true, reason: null };
	}
	if (config.include_all_groups.some((group) => group.every((phrase) => containsPhrase(evidence, phrase)))) {
		return { passed: true, reason: null };
	}
	return { passed: false, reason: "no_configured_retrieval_signal" };
}

export const retrievalGateInternals = { containsPhrase, normalized };

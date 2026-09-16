import { describe, expect, it } from "vitest";
import { normalizeDoi, normalizeIssn } from "../src/crossref";

describe("registry identifiers", () => {
	it("normalizes DOI URLs without changing the DOI", () => {
		expect(normalizeDoi("https://doi.org/10.1177/10944281241234567")).toBe("10.1177/10944281241234567");
	});

	it("normalizes ISSNs", () => {
		expect(normalizeIssn("10944281")).toBe("1094-4281");
		expect(normalizeIssn("1082-989X")).toBe("1082-989X");
	});
});

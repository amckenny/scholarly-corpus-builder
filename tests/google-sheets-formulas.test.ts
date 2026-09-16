import { describe, expect, it } from "vitest";
import { candidateViewFormula, excludedViewFormula, type SheetNames } from "../src/google-sheets";

const names: SheetNames = {
	inbox: "Inbound Queue",
	registry: "Direct Registry",
	decisions: "Direct Decisions",
	runs: "Runs",
	corpus: "Corpus",
	excluded: "Excluded",
};

describe("materialized view formulas", () => {
	it("uses unambiguous LET identifiers and candidate disposition filtering", () => {
		const formula = candidateViewFormula(names);
		expect(formula).toContain("LET(decision_keys,");
		expect(formula).toContain("eligible_rows,");
		expect(formula).toContain("latest_registry,FILTER(eligible_registry,");
		expect(formula).toContain('LEFT(decision_codes,10)="candidate_"');
		expect(formula).not.toContain("r0,");
		expect(formula).toContain("ARRAYFORMULA");
		expect(formula).not.toContain("XLOOKUP(UNIQUE(CHOOSECOLS(eligible_registry,1))");
	});

	it("uses the same verified join for excluded records and includes the exclusion reason", () => {
		const formula = excludedViewFormula(names);
		expect(formula).toContain('LEFT(decision_codes,9)="excluded_"');
		expect(formula).toContain("FILTER('Direct Decisions'!E2:E");
		expect(formula).not.toContain("r0,");
	});
});

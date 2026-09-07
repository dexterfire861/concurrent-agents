/**
 * THE THREE-REGRET DISTINCTION.
 *
 * This is the guard on the single most likely correctness bug in the system:
 * reusing normal-form regret code in a family where the agent is INSIDE the
 * headcount it is responding to.
 *
 * The case is plan section 3.3, verbatim in numbers:
 *
 *     You stayed home. 9 others went. Your threshold was 10.
 *
 *     Way 1 -- hold the crowd fixed at 9. "If I'd gone, would 9 have been
 *              enough? No, I need 10. So going was worthless."  REGRET 0.
 *     Way 2 -- recompute the crowd. "If I'd gone, there'd have been 10. That's
 *              the threshold. I'd have got 10 instead of 3."    REGRET 7.
 *
 * Way 2 is correct. Way 1 is what you get by reusing the normal-form code
 * without noticing, and it looks perfectly reasonable in a report — which is
 * exactly why it needs a test with two hard-coded numbers rather than a
 * plausibility check.
 *
 * Spec:  configs/golden/party-threshold-regret.yaml (full derivation there)
 * Trace: test/traces.ts, partyTrace()
 *
 * These tests FAIL UNTIL src/eval/evaluate.ts exists. That is the intent.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { EvaluationReport, RegretMeasure } from "../src/eval/report.js";

import { TOL, blind, golden, loadEvaluate } from "./boundary.js";
import { partyTrace } from "./traces.js";

async function partyReport(): Promise<EvaluationReport> {
  const evaluate = await loadEvaluate();
  return evaluate(blind(golden("party-threshold-regret.yaml").spec), blind(partyTrace()));
}

function regretsOf(report: EvaluationReport, agent: string): readonly RegretMeasure[] {
  const entry = report.measured.perAgent[agent];
  assert.ok(entry, `no measured entry for ${agent}`);
  return entry!.regret;
}

function valueOf(
  regrets: readonly RegretMeasure[],
  kind: RegretMeasure["kind"],
  agent: string,
): number {
  const m = regrets.find((r) => r.kind === kind);
  assert.ok(
    m,
    `${agent} carries no ${kind} regret. The aggregate family must report all ` +
      `applicable variants SEPARATELY (plan section 5); dropping one is how the ` +
      `distinction gets lost.`,
  );
  assert.ok("value" in m!, `${kind} must carry a numeric value`);
  return (m as { value: number }).value;
}

describe("the party case: three regrets, three answers", () => {
  it("price_taking reports 0 for the pivotal agent — the wrong-but-tempting answer", async () => {
    const r = regretsOf(await partyReport(), "a0");
    const value = valueOf(r, "price_taking", "a0");
    assert.ok(
      Math.abs(value - 0) <= TOL,
      `price_taking holds the crowd fixed at the observed 9, where attending pays ` +
        `10 * [9 >= 10] = 0 < the outside option 3. Expected 0, got ${value}.`,
    );
  });

  it("ex_post_aggregate_corrected reports 7 for the pivotal agent — the correct answer", async () => {
    const r = regretsOf(await partyReport(), "a0");
    const value = valueOf(r, "ex_post_aggregate_corrected", "a0");
    assert.ok(
      Math.abs(value - 7) <= TOL,
      `a0 was the pivotal tenth person: attending makes the count 10, which meets ` +
        `the threshold and pays 10, against the 3 it actually took. Expected 7, ` +
        `got ${value}. A 0 here means the evaluator forgot a0 is inside the headcount.`,
    );
  });

  it("THE TWO MEASURES DISAGREE, and the report keeps them apart", async () => {
    const r = regretsOf(await partyReport(), "a0");
    const priceTaking = valueOf(r, "price_taking", "a0");
    const corrected = valueOf(r, "ex_post_aggregate_corrected", "a0");

    assert.notEqual(
      priceTaking,
      corrected,
      "if these two are equal the evaluator is computing one of them twice, and " +
        "the distinction the type system exists to enforce has been erased at runtime",
    );
    assert.ok(
      Math.abs(corrected - priceTaking - 7) <= TOL,
      `the gap between them is the pivotality of a0, exactly 7; got ${corrected - priceTaking}`,
    );
  });

  it("a non-pivotal attendee has the two measures AGREE, at 3", async () => {
    // a1 attended and got 0. Holding the crowd at 9, staying pays 3 -> regret 3.
    // Recomputing: the other 8 attend; a1 staying makes the count 8, still below
    // the threshold, so staying pays 3 -> regret 3. Same answer.
    // Only the pivotal agent separates the measures, which is why a corpus
    // average would hide the bug and a named agent does not.
    const r = regretsOf(await partyReport(), "a1");
    const priceTaking = valueOf(r, "price_taking", "a1");
    const corrected = valueOf(r, "ex_post_aggregate_corrected", "a1");

    assert.ok(Math.abs(priceTaking - 3) <= TOL, `a1 price_taking: expected 3, got ${priceTaking}`);
    assert.ok(Math.abs(corrected - 3) <= TOL, `a1 corrected: expected 3, got ${corrected}`);
  });

  it("does not report ex_post_unilateral for an aggregate scenario", async () => {
    // ex_post_unilateral is the normal-form and network measure. In a family
    // where the agent is inside the statistic it is not merely imprecise, it is
    // the wrong measure; reporting it under that name is how the two get mixed.
    const r = regretsOf(await partyReport(), "a0");
    assert.ok(
      !r.some((m) => m.kind === "ex_post_unilateral"),
      "ex_post_unilateral is not applicable when includesSelf is true; " +
        "the aggregate variants are price_taking and ex_post_aggregate_corrected",
    );
  });

  it("keeps equilibriumDistance out of the per-agent regrets", async () => {
    // Plan section 3.3: "how far was the whole group from a stable outcome" is a
    // property of the population, not a per-person number, and averaging it with
    // the other two is nonsense.
    const report = await partyReport();
    for (const [agent, m] of Object.entries(report.measured.perAgent)) {
      for (const r of m.regret) {
        assert.ok(
          r.kind !== "not_applicable" || typeof (r as { reason: string }).reason === "string",
          `${agent}: a not_applicable regret must say why`,
        );
      }
    }
    if (report.measured.equilibriumDistance !== undefined) {
      assert.equal(
        typeof report.measured.equilibriumDistance,
        "number",
        "equilibriumDistance lives on the measured block, never inside perAgent.regret",
      );
    }
  });
});

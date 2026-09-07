/**
 * Property tests from plan section 12.
 *
 * Unlike the golden fixtures these assert INVARIANTS rather than numbers, so
 * they stay true when the payoff parameters change. Four of the five need only
 * `evaluate`; the determinism one needs a runtime.
 *
 * These tests FAIL UNTIL src/eval/evaluate.ts (and, for determinism,
 * src/runtime/run.ts) exist. That is the intent.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { EvaluationReport } from "../src/eval/report.js";

import {
  ADVERSARIAL_DIR,
  GOLDEN_DIR,
  blind,
  canonicalJson,
  countFreeText,
  golden,
  listFixtures,
  loadEvaluate,
  loadRunScenario,
  scrambleText,
  unstripped,
} from "./boundary.js";
import { congestionTrace, cycleTrace, partyTrace } from "./traces.js";

// ---------------------------------------------------------------------------
// Determinism: same seed => byte-identical trace
// ---------------------------------------------------------------------------

describe("property: determinism", () => {
  it("the same spec and seed produce a byte-identical trace, twice", async () => {
    const runScenario = await loadRunScenario();
    const spec = golden("congestion-office-hours.yaml").spec;

    const first = await runScenario(spec);
    const second = await runScenario(spec);

    assert.equal(
      canonicalJson(first),
      canonicalJson(second),
      "two runs of the same spec at the same seed must produce identical traces",
    );
  });

  it("the RNG cursors match round for round, so a divergence is provable", async () => {
    const runScenario = await loadRunScenario();
    const spec = golden("granovetter-cascade.yaml").spec;

    const first = await runScenario(spec);
    const second = await runScenario(spec);

    assert.equal(first.rounds.length, second.rounds.length);
    first.rounds.forEach((r, i) => {
      assert.deepEqual(
        r.rngCursor,
        second.rounds[i]!.rngCursor,
        `rngCursor diverged at round ${i}`,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Purity: same inputs => same report
// ---------------------------------------------------------------------------

describe("property: the evaluator is a pure function", () => {
  it("evaluating the same spec and trace twice gives an identical report", async () => {
    const evaluate = await loadEvaluate();
    const spec = golden("party-threshold-regret.yaml").spec;
    const trace = partyTrace();

    const a = evaluate(blind(spec), blind(trace));
    const b = evaluate(blind(spec), blind(trace));

    assert.equal(canonicalJson(a), canonicalJson(b));
  });

  it("holds across every golden fixture, on an empty trace", async () => {
    const evaluate = await loadEvaluate();
    for (const f of listFixtures(GOLDEN_DIR)) {
      const trace = {
        specHash: `spec-${f.spec.metadata.id}`,
        seed: f.spec.seed,
        cell: {},
        realizedStructure: { types: {}, roleAssignment: {} },
        rounds: [],
      };
      const a = evaluate(blind(f.spec), blind(trace));
      const b = evaluate(blind(f.spec), blind(trace));
      assert.equal(canonicalJson(a), canonicalJson(b), `${f.name} is not pure`);
    }
  });
});

// ---------------------------------------------------------------------------
// Blindness: scramble every persona / title / sourceDescription
// ---------------------------------------------------------------------------

describe("property: evaluator blindness", () => {
  /**
   * The spec is handed over WITH its free text still attached (`unstripped`),
   * not pre-stripped by the test. If the test stripped it first, scrambling
   * afterwards would be a no-op and this would prove nothing. Passing the text
   * through and asserting the report does not move is the behavioural version
   * of the guarantee EvaluatorView makes at the type level.
   */
  it("scrambling every persona, title and sourceDescription leaves the report byte-identical", async () => {
    const evaluate = await loadEvaluate();

    for (const f of [...listFixtures(GOLDEN_DIR), ...listFixtures(ADVERSARIAL_DIR)]) {
      const original = f.spec;
      const scrambled = scrambleText(original);

      assert.ok(
        countFreeText(original) > 0,
        `${f.name} carries no free text, so this test would be vacuous on it`,
      );
      assert.notEqual(
        canonicalJson(original),
        canonicalJson(scrambled),
        `${f.name}: the scramble did not change anything`,
      );

      const trace = {
        specHash: `spec-${original.metadata.id}`,
        seed: original.seed,
        cell: {},
        realizedStructure: { types: {}, roleAssignment: {} },
        rounds: [],
      };

      const before = evaluate(unstripped(original), unstripped(trace));
      const after = evaluate(unstripped(scrambled), unstripped(trace));

      assert.equal(
        canonicalJson(before),
        canonicalJson(after),
        `${f.name}: the report changed when only free text changed. ` +
          `Semantics leaked into the scoring path.`,
      );
    }
  });

  it("scrambling rawOutput and reasoning in a trace leaves the report byte-identical", async () => {
    const evaluate = await loadEvaluate();
    const spec = golden("party-threshold-regret.yaml").spec;

    const trace = partyTrace();
    const scrambled = scrambleText(trace);

    assert.ok(countFreeText(trace) > 0, "the trace must carry free text for this to bite");

    const before = evaluate(unstripped(spec), unstripped(trace));
    const after = evaluate(unstripped(spec), unstripped(scrambled));

    assert.equal(
      canonicalJson(before),
      canonicalJson(after),
      "what the model SAID must not reach the score; only what it CHOSE may",
    );
  });

  it("stripping the free text yourself changes nothing either", async () => {
    const evaluate = await loadEvaluate();
    const spec = golden("party-threshold-regret.yaml").spec;
    const trace = partyTrace();

    const withText = evaluate(unstripped(spec), unstripped(trace));
    const withoutText = evaluate(blind(spec), blind(trace));

    assert.equal(
      canonicalJson(withText),
      canonicalJson(withoutText),
      "the evaluator must not depend on free-text fields even being present",
    );
  });
});

// ---------------------------------------------------------------------------
// Anonymity: shuffling who-did-what leaves aggregate payoffs unchanged
// ---------------------------------------------------------------------------

describe("property: anonymity in the aggregate family", () => {
  /**
   * Plan section 6: "Anonymity holds by construction; assert it as a property
   * test (shuffle who did what, payoffs unchanged)." Two traces with the SAME
   * turnout and DIFFERENT membership must produce the same distribution of
   * payoffs and regrets and the same theory.
   */
  const first12 = Array.from({ length: 12 }, (_, i) => i);
  const last12 = Array.from({ length: 12 }, (_, i) => 29 - i);

  function payoffMultiset(report: EvaluationReport): string {
    return canonicalJson(
      Object.values(report.measured.perAgent)
        .map((m) => canonicalJson({ totalPayoff: m.totalPayoff, regret: m.regret }))
        .sort(),
    );
  }

  it("the same turnout with different people gives the same payoff distribution", async () => {
    const evaluate = await loadEvaluate();
    const spec = golden("congestion-office-hours.yaml").spec;

    const a = evaluate(blind(spec), blind(congestionTrace(first12)));
    const b = evaluate(blind(spec), blind(congestionTrace(last12)));

    assert.equal(
      payoffMultiset(a),
      payoffMultiset(b),
      "an aggregate payoff depends on HOW MANY, never on WHO",
    );
  });

  it("the same turnout with different people gives the same welfare per round", async () => {
    const evaluate = await loadEvaluate();
    const spec = golden("congestion-office-hours.yaml").spec;

    const a = evaluate(blind(spec), blind(congestionTrace(first12)));
    const b = evaluate(blind(spec), blind(congestionTrace(last12)));

    assert.deepEqual(
      a.measured.perRound.map((r) => r.welfare),
      b.measured.perRound.map((r) => r.welfare),
    );
    assert.equal(a.measured.equilibriumDistance, b.measured.equilibriumDistance);
  });

  it("the theory block does not move at all, since it comes from the spec alone", async () => {
    const evaluate = await loadEvaluate();
    const spec = golden("congestion-office-hours.yaml").spec;

    const a = evaluate(blind(spec), blind(congestionTrace(first12)));
    const b = evaluate(blind(spec), blind(congestionTrace(last12)));

    assert.equal(canonicalJson(a.theory), canonicalJson(b.theory));
  });
});

// ---------------------------------------------------------------------------
// Locality: payoffs touch only neighbours
// ---------------------------------------------------------------------------

describe("property: locality in the network family", () => {
  /**
   * Plan section 6: "Payoffs touch only neighbors — by construction; assert as
   * a property test."
   *
   * On the ten-cycle, node 0's neighbours are 9 and 1. Node 5 is its antipode:
   * the furthest possible non-neighbour. Flipping node 5 must leave everything
   * the evaluator says about node 0 exactly where it was.
   */
  it("flipping a non-neighbour leaves node 0's payoff and regret untouched", async () => {
    const evaluate = await loadEvaluate();
    const spec = golden("morris-contagion-cycle.yaml").spec;

    const without5 = evaluate(blind(spec), blind(cycleTrace([0, 1, 2])));
    const with5 = evaluate(blind(spec), blind(cycleTrace([0, 1, 2, 5])));

    assert.equal(
      canonicalJson(without5.measured.perAgent.a0),
      canonicalJson(with5.measured.perAgent.a0),
      "node 5 is not adjacent to node 0, so it cannot enter node 0's payoff or regret",
    );
  });

  it("the same flip DOES move an actual neighbour, so the test is not vacuous", async () => {
    const evaluate = await loadEvaluate();
    const spec = golden("morris-contagion-cycle.yaml").spec;

    const without5 = evaluate(blind(spec), blind(cycleTrace([0, 1, 2])));
    const with5 = evaluate(blind(spec), blind(cycleTrace([0, 1, 2, 5])));

    assert.notEqual(
      canonicalJson(without5.measured.perAgent.a4),
      canonicalJson(with5.measured.perAgent.a4),
      "node 4 IS adjacent to node 5; if nothing changed for it, the locality " +
        "test above passes for the wrong reason",
    );
  });
});

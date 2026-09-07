/**
 * Golden fixtures: every number asserted here is derived by hand in the header
 * comment of the YAML file it belongs to. Nothing is a smoke test.
 *
 * These tests FAIL UNTIL src/spec/validate.ts and src/eval/evaluate.ts exist.
 * That is the intent — they are the executable specification for those files.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import type { AgentId, ActionLabel } from "../src/spec/types.js";
import type {
  AggregateTheory,
  BargainingTheory,
  EvaluationReport,
  MechanismTheory,
  NetworkTheory,
  NormalFormTheory,
  SequentialTheory,
  TheoryBlock,
} from "../src/eval/report.js";
import type { RunTrace } from "../src/trace/types.js";

import {
  GOLDEN_DIR,
  TOL,
  blind,
  closeTo,
  golden,
  listFixtures,
  loadEvaluate,
  loadValidate,
  verdictFor,
  type ValidationResult,
} from "./boundary.js";
import { truthfulSecondPriceTrace } from "./traces.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Theory comes from the SPEC ALONE, so an empty trace is enough to ask for it. */
function emptyTrace(specHash: string, seed: number): RunTrace {
  return {
    specHash,
    seed,
    cell: {},
    realizedStructure: { types: {}, roleAssignment: {} },
    rounds: [],
  };
}

async function theoryOf(fixtureName: string): Promise<EvaluationReport> {
  const evaluate = await loadEvaluate();
  const f = golden(fixtureName);
  return evaluate(
    blind(f.spec),
    blind(emptyTrace(`spec-${f.spec.metadata.id}`, f.spec.seed)),
  );
}

async function validateGolden(fixtureName: string): Promise<ValidationResult> {
  const validate = await loadValidate();
  return validate(golden(fixtureName).spec);
}

function asNormalForm(t: TheoryBlock): NormalFormTheory {
  assert.equal(t.family, "normal_form");
  return t as NormalFormTheory;
}
function asAggregate(t: TheoryBlock): AggregateTheory {
  assert.equal(t.family, "aggregate");
  return t as AggregateTheory;
}
function asNetwork(t: TheoryBlock): NetworkTheory {
  assert.equal(t.family, "network_local");
  return t as NetworkTheory;
}
function asMechanism(t: TheoryBlock): MechanismTheory {
  assert.equal(t.family, "mechanism");
  return t as MechanismTheory;
}
function asSequential(t: TheoryBlock): SequentialTheory {
  assert.equal(t.family, "sequential");
  return t as SequentialTheory;
}
function asBargaining(t: TheoryBlock): BargainingTheory {
  assert.equal(t.family, "bargaining");
  return t as BargainingTheory;
}

/**
 * The actions in a profile, sorted. Agent ids are not pinned by the plan
 * (they could be "a0"/"a1" or the role ids), so profiles are compared by their
 * multiset of actions rather than by key.
 */
function profileActions(
  p: Readonly<Record<AgentId, ActionLabel | number>>,
): string[] {
  return Object.values(p)
    .map(String)
    .sort();
}

function assertClose(actual: number | undefined, expected: number, what: string) {
  assert.ok(
    actual !== undefined && closeTo(actual, expected),
    `${what}: expected ${expected} +/- ${TOL}, got ${String(actual)}`,
  );
}

/** Every fixture must report an explicit tolerance; floats are not reproducible without one. */
function assertMethodIsHonest(report: EvaluationReport) {
  assert.ok(
    Number.isFinite(report.method.tolerance),
    "method.tolerance must be an explicit number",
  );
  if (report.method.equilibrium === "grid_approximation") {
    assert.ok(
      report.method.gridResolution !== undefined,
      "grid_approximation must report gridResolution, or the number is a lower bound presented as an answer",
    );
  }
}

// ---------------------------------------------------------------------------
// Corpus-wide
// ---------------------------------------------------------------------------

describe("golden corpus", () => {
  const fixtures = listFixtures(GOLDEN_DIR);

  it("is non-empty and every file parses to an object with a family tag", () => {
    assert.ok(fixtures.length >= 11, `expected >= 11 golden fixtures, got ${fixtures.length}`);
    for (const f of fixtures) {
      assert.equal(typeof f.spec, "object", `${f.name} did not parse to an object`);
      assert.equal(f.spec.schemaVersion, "1", `${f.name} schemaVersion`);
      assert.ok(typeof f.spec.family === "string", `${f.name} has no family tag`);
      assert.ok(typeof f.spec.metadata?.id === "string", `${f.name} has no metadata.id`);
      assert.ok(Number.isFinite(f.spec.seed), `${f.name} has no seed`);
    }
  });

  it("every fixture has a header comment stating its derivation", () => {
    for (const f of fixtures) {
      assert.ok(
        f.source.startsWith("# GOLDEN"),
        `${f.name} must open with a "# GOLDEN" header comment carrying the derivation`,
      );
      assert.ok(
        /DERIVATION|EXPECTED/.test(f.source),
        `${f.name} header must show its arithmetic and its expected answer`,
      );
    }
  });

  it("every fixture validates with no errors", async () => {
    const validate = await loadValidate();
    for (const f of fixtures) {
      const result = validate(f.spec);
      assert.deepEqual(
        result.errors,
        [],
        `${f.name} must validate clean; got ${JSON.stringify(result.errors)}`,
      );
    }
  });

  it("every claim in a golden fixture comes back confirmed", async () => {
    const validate = await loadValidate();
    for (const f of fixtures) {
      const result = validate(f.spec);
      assert.equal(
        result.claimVerdicts.length,
        f.spec.claims.length,
        `${f.name}: one verdict per claim`,
      );
      for (const v of result.claimVerdicts) {
        assert.equal(
          v.verdict,
          "confirmed",
          `${f.name}: claim ${JSON.stringify(v.claim)} must be confirmed, got ${v.verdict}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Normal form
// ---------------------------------------------------------------------------

describe("golden: prisoners-dilemma.yaml", () => {
  it("defection is strictly dominant for both roles", async () => {
    const t = asNormalForm((await theoryOf("prisoners-dilemma.yaml")).theory);
    assert.deepEqual(t.dominant.row, { action: "D", strict: true });
    assert.deepEqual(t.dominant.column, { action: "D", strict: true });
  });

  it("has exactly one pure equilibrium, (D, D)", async () => {
    const t = asNormalForm((await theoryOf("prisoners-dilemma.yaml")).theory);
    assert.equal(t.pureNash.length, 1);
    assert.deepEqual(profileActions(t.pureNash[0]!), ["D", "D"]);
  });

  it("(D, D) is Pareto-dominated: the frontier is the other three cells", async () => {
    const t = asNormalForm((await theoryOf("prisoners-dilemma.yaml")).theory);
    assert.equal(t.paretoFrontier.length, 3);
    for (const p of t.paretoFrontier) {
      assert.notDeepEqual(
        profileActions(p),
        ["D", "D"],
        "the equilibrium must not be on the Pareto frontier",
      );
    }
  });

  it("price of anarchy and stability are both 3 (welfare 6 vs 2)", async () => {
    const t = asNormalForm((await theoryOf("prisoners-dilemma.yaml")).theory);
    assertClose(t.priceOfAnarchy, 3, "priceOfAnarchy");
    assertClose(t.priceOfStability, 3, "priceOfStability");
  });

  it("detects the archetype", async () => {
    const t = asNormalForm((await theoryOf("prisoners-dilemma.yaml")).theory);
    assert.equal(t.archetypeDetected, "prisoners_dilemma");
  });

  it("if a repeated block is reported, minmax is 1 and the discount cutoff is 0.5", async () => {
    const t = asNormalForm((await theoryOf("prisoners-dilemma.yaml")).theory);
    if (t.repeated) {
      assertClose(t.repeated.minmax.row, 1, "minmax row");
      assertClose(t.repeated.minmax.column, 1, "minmax column");
      assertClose(
        t.repeated.cooperationSustainableAboveDiscount,
        0.5,
        "grim-trigger cutoff (T-R)/(T-P) = 2/4",
      );
    }
  });
});

describe("golden: stag-hunt.yaml", () => {
  it("has exactly two pure equilibria and no dominant strategy", async () => {
    const t = asNormalForm((await theoryOf("stag-hunt.yaml")).theory);
    assert.equal(t.pureNash.length, 2);
    const profiles = t.pureNash.map(profileActions).sort();
    assert.deepEqual(profiles, [
      ["hare", "hare"],
      ["stag", "stag"],
    ]);
    assert.equal(t.dominant.row, null);
    assert.equal(t.dominant.column, null);
  });

  it("the mixed equilibrium puts 0.75 on stag, so hare is risk-dominant", async () => {
    const t = asNormalForm((await theoryOf("stag-hunt.yaml")).theory);
    assert.ok(t.mixedNash && t.mixedNash.length >= 1, "a 2x2 must report its mixed equilibrium");
    for (const mix of Object.values(t.mixedNash![0]!)) {
      assertClose(mix.stag, 0.75, "Pr(stag) in the mixed equilibrium");
      assertClose(mix.hare, 0.25, "Pr(hare) in the mixed equilibrium");
    }
  });

  it("the Pareto frontier is the single payoff-dominant profile", async () => {
    const t = asNormalForm((await theoryOf("stag-hunt.yaml")).theory);
    assert.equal(t.paretoFrontier.length, 1);
    assert.deepEqual(profileActions(t.paretoFrontier[0]!), ["stag", "stag"]);
  });

  it("price of anarchy is 5/3 and price of stability is 1", async () => {
    const t = asNormalForm((await theoryOf("stag-hunt.yaml")).theory);
    assertClose(t.priceOfAnarchy, 5 / 3, "priceOfAnarchy = 10/6");
    assertClose(t.priceOfStability, 1, "priceOfStability");
  });

  it("detects the archetype", async () => {
    const t = asNormalForm((await theoryOf("stag-hunt.yaml")).theory);
    assert.equal(t.archetypeDetected, "stag_hunt");
  });
});

describe("golden: chicken.yaml", () => {
  it("has exactly two pure equilibria, both lopsided", async () => {
    const t = asNormalForm((await theoryOf("chicken.yaml")).theory);
    assert.equal(t.pureNash.length, 2);
    for (const p of t.pureNash) {
      assert.deepEqual(
        profileActions(p),
        ["straight", "swerve"],
        "each equilibrium has exactly one of each action",
      );
    }
  });

  it("has no dominant strategy", async () => {
    const t = asNormalForm((await theoryOf("chicken.yaml")).theory);
    assert.equal(t.dominant.row, null);
    assert.equal(t.dominant.column, null);
  });

  it("the mixed equilibrium puts 0.5 on swerve", async () => {
    const t = asNormalForm((await theoryOf("chicken.yaml")).theory);
    assert.ok(t.mixedNash && t.mixedNash.length >= 1);
    for (const mix of Object.values(t.mixedNash![0]!)) {
      assertClose(mix.swerve, 0.5, "Pr(swerve)");
      assertClose(mix.straight, 0.5, "Pr(straight)");
    }
  });

  it("mutual aggression is the only cell off the Pareto frontier", async () => {
    const t = asNormalForm((await theoryOf("chicken.yaml")).theory);
    assert.equal(t.paretoFrontier.length, 3);
    for (const p of t.paretoFrontier) {
      assert.notDeepEqual(profileActions(p), ["straight", "straight"]);
    }
  });

  it("price of anarchy and stability are both 1.2", async () => {
    const t = asNormalForm((await theoryOf("chicken.yaml")).theory);
    assertClose(t.priceOfAnarchy, 1.2, "priceOfAnarchy = 6/5");
    assertClose(t.priceOfStability, 1.2, "priceOfStability = 6/5");
  });

  it("detects the archetype", async () => {
    const t = asNormalForm((await theoryOf("chicken.yaml")).theory);
    assert.equal(t.archetypeDetected, "chicken");
  });
});

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

describe("golden: granovetter-cascade.yaml", () => {
  it("finds fixed points at 2, 5 and 10 with 5 unstable", async () => {
    const t = asAggregate((await theoryOf("granovetter-cascade.yaml")).theory);
    const sorted = [...t.fixedPoints].sort((a, b) => a.level - b.level);
    assert.deepEqual(sorted, [
      { level: 2, stable: true },
      { level: 5, stable: false },
      { level: 10, stable: true },
    ]);
  });

  it("reports exactly one tipping point, the interior unstable level 5", async () => {
    const t = asAggregate((await theoryOf("granovetter-cascade.yaml")).theory);
    assert.deepEqual([...t.tippingPoints], [5]);
  });

  it("nobody-acts is NOT a fixed point: the zero-threshold agents act unconditionally", async () => {
    const t = asAggregate((await theoryOf("granovetter-cascade.yaml")).theory);
    assert.ok(
      !t.fixedPoints.some((p) => p.level === 0),
      "level 0 must not be reported as a fixed point",
    );
  });

  it("the efficient level is full participation, 10", async () => {
    const t = asAggregate((await theoryOf("granovetter-cascade.yaml")).theory);
    assert.equal(t.efficientLevel, 10);
  });

  it("verifies monotonicity as complement", async () => {
    const t = asAggregate((await theoryOf("granovetter-cascade.yaml")).theory);
    assert.equal(t.monotonicityVerified, "complement");
  });

  it("confirms tipping_point_exists", async () => {
    const v = verdictFor(await validateGolden("granovetter-cascade.yaml"), "tipping_point_exists");
    assert.ok(v, "a verdict for tipping_point_exists must be present");
    assert.equal(v!.verdict, "confirmed");
  });
});

describe("golden: linear-public-good.yaml", () => {
  it("free-riding is the unique stable equilibrium, at 0 contributors", async () => {
    const t = asAggregate((await theoryOf("linear-public-good.yaml")).theory);
    assert.deepEqual([...t.fixedPoints], [{ level: 0, stable: true }]);
    assert.equal(t.equilibriumLevel, 0);
    assert.deepEqual([...t.tippingPoints], []);
  });

  it("the efficient level is full contribution, 4, and the welfare gap is 80", async () => {
    const t = asAggregate((await theoryOf("linear-public-good.yaml")).theory);
    assert.equal(t.efficientLevel, 4);
    assertClose(t.welfareGap, 80, "welfareGap = 160 - 80");
  });

  it("verifies monotonicity as complement", async () => {
    const t = asAggregate((await theoryOf("linear-public-good.yaml")).theory);
    assert.equal(t.monotonicityVerified, "complement");
  });

  it("confirms social_dilemma and the dominance of keeping", async () => {
    const r = await validateGolden("linear-public-good.yaml");
    assert.equal(verdictFor(r, "social_dilemma")?.verdict, "confirmed");
    assert.equal(verdictFor(r, "dominant_strategy")?.verdict, "confirmed");
  });
});

describe("golden: congestion-office-hours.yaml", () => {
  it("the equilibrium turnout is 12 and it is stable and unique", async () => {
    const t = asAggregate((await theoryOf("congestion-office-hours.yaml")).theory);
    assert.deepEqual([...t.fixedPoints], [{ level: 12, stable: true }]);
    assert.equal(t.equilibriumLevel, 12);
    assert.deepEqual([...t.tippingPoints], []);
  });

  it("the efficient turnout is 8 and the welfare gap is 44 (146 vs 102)", async () => {
    const t = asAggregate((await theoryOf("congestion-office-hours.yaml")).theory);
    assert.equal(t.efficientLevel, 8);
    assertClose(t.welfareGap, 44, "welfareGap = 146 - 102");
  });

  it("verifies monotonicity as substitute", async () => {
    const t = asAggregate((await theoryOf("congestion-office-hours.yaml")).theory);
    assert.equal(t.monotonicityVerified, "substitute");
  });

  it("confirms social_dilemma", async () => {
    const r = await validateGolden("congestion-office-hours.yaml");
    assert.equal(verdictFor(r, "social_dilemma")?.verdict, "confirmed");
  });
});

// ---------------------------------------------------------------------------
// Mechanism — the free exact test
// ---------------------------------------------------------------------------

describe("golden: second-price-auction.yaml", () => {
  it("truthful bidding is dominant and expected revenue is exactly 20", async () => {
    const t = asMechanism((await theoryOf("second-price-auction.yaml")).theory);
    assert.equal(t.equilibriumBid, "truthful");
    assert.equal(t.dsicVerified, true);
    assert.equal(t.individuallyRational, true);
    assertClose(t.expectedRevenue, 20, "E[second-highest of 3 iid draws from {10,20,30}]");
    assertClose(t.expectedEfficiency, 1, "the highest value always wins");
  });

  it("TRUTHFUL BIDDING HAS EXACTLY ZERO EX-POST REGRET, for every bidder", async () => {
    const evaluate = await loadEvaluate();
    const f = golden("second-price-auction.yaml");
    const report = evaluate(blind(f.spec), blind(truthfulSecondPriceTrace()));

    const agents = Object.entries(report.measured.perAgent);
    assert.equal(agents.length, 3, "three bidders");

    for (const [id, m] of agents) {
      assert.ok(m.regret.length > 0, `${id} must carry at least one regret measure`);
      for (const r of m.regret) {
        if (r.kind === "not_applicable") continue;
        assert.equal(
          r.value,
          0,
          `${id}: ${r.kind} must be EXACTLY 0 under truthful bidding in a ` +
            `second-price auction, got ${r.value}. This is not a tolerance ` +
            `question — a nonzero value here means the evaluator is broken.`,
        );
      }
    }
  });

  it("reports an explicit solver method", async () => {
    assertMethodIsHonest(await theoryOf("second-price-auction.yaml"));
  });

  it("confirms dsic and individual rationality", async () => {
    const r = await validateGolden("second-price-auction.yaml");
    assert.equal(verdictFor(r, "dsic")?.verdict, "confirmed");
    assert.equal(verdictFor(r, "individually_rational")?.verdict, "confirmed");
  });
});

// ---------------------------------------------------------------------------
// Sequential — backward induction
// ---------------------------------------------------------------------------

describe("golden: ultimatum.yaml", () => {
  it("backward induction gives offer2 / accept / accept", async () => {
    const t = asSequential((await theoryOf("ultimatum.yaml")).theory);
    assert.deepEqual({ ...t.spne }, { ip0: "offer2", ir2: "accept", ir5: "accept" });
  });

  it("equilibrium payoffs are 8 to the proposer and 2 to the responder", async () => {
    const t = asSequential((await theoryOf("ultimatum.yaml")).theory);
    assertClose(t.equilibriumPayoffs.proposer, 8, "proposer");
    assertClose(t.equilibriumPayoffs.responder, 2, "responder");
  });

  it("rejecting a positive offer is not a credible threat at either infoset", async () => {
    const t = asSequential((await theoryOf("ultimatum.yaml")).theory);
    for (const infoset of ["ir2", "ir5"]) {
      const c = t.credibility.find((x) => x.infoset === infoset && x.offPathMove === "reject");
      assert.ok(c, `a credibility entry for reject at ${infoset} must be reported`);
      assert.equal(c!.credible, false);
    }
  });

  it("perfect recall holds and the method is backward induction", async () => {
    const report = await theoryOf("ultimatum.yaml");
    assert.equal(asSequential(report.theory).perfectRecall, true);
    assert.equal(report.method.equilibrium, "backward_induction");
  });

  it("confirms the ultimatum archetype", async () => {
    const r = await validateGolden("ultimatum.yaml");
    assert.equal(verdictFor(r, "archetype")?.verdict, "confirmed");
  });
});

describe("golden: trust-game.yaml", () => {
  it("backward induction gives keep / defect", async () => {
    const t = asSequential((await theoryOf("trust-game.yaml")).theory);
    assert.deepEqual({ ...t.spne }, { ii0: "keep", it0: "defect" });
  });

  it("equilibrium payoffs are 10 to the investor and 0 to the trustee", async () => {
    const t = asSequential((await theoryOf("trust-game.yaml")).theory);
    assertClose(t.equilibriumPayoffs.investor, 10, "investor");
    assertClose(t.equilibriumPayoffs.trustee, 0, "trustee");
  });

  it("returning is not credible", async () => {
    const t = asSequential((await theoryOf("trust-game.yaml")).theory);
    const c = t.credibility.find((x) => x.infoset === "it0");
    assert.ok(c, "a credibility entry for the trustee's move must be reported");
    assert.equal(c!.credible, false);
  });

  it("confirms both the trust archetype and social_dilemma", async () => {
    const r = await validateGolden("trust-game.yaml");
    assert.equal(verdictFor(r, "archetype")?.verdict, "confirmed");
    assert.equal(verdictFor(r, "social_dilemma")?.verdict, "confirmed");
  });
});

// ---------------------------------------------------------------------------
// Bargaining — the Rubinstein formula
// ---------------------------------------------------------------------------

describe("golden: rubinstein-bargaining.yaml", () => {
  it("the Rubinstein share is (1-d2)/(1-d1*d2) = 0.8, so 80 / 20 of a pie of 100", async () => {
    const t = asBargaining((await theoryOf("rubinstein-bargaining.yaml")).theory);
    assertClose(t.rubinsteinShare.alpha, 80, "alpha = 100 * 0.75/0.9375");
    assertClose(t.rubinsteinShare.beta, 20, "beta = 100 * 0.1875/0.9375");
  });

  it("the Nash bargaining solution is the symmetric 50 / 50 split", async () => {
    const t = asBargaining((await theoryOf("rubinstein-bargaining.yaml")).theory);
    assertClose(t.nashBargainingSolution.alpha, 50, "NBS alpha");
    assertClose(t.nashBargainingSolution.beta, 50, "NBS beta");
  });

  it("both benchmarks are reported, and they disagree — that gap is informative", async () => {
    const t = asBargaining((await theoryOf("rubinstein-bargaining.yaml")).theory);
    assert.notEqual(
      t.rubinsteinShare.alpha,
      t.nashBargainingSolution.alpha,
      "the strategic and axiomatic answers must both be present and must differ here",
    );
  });

  it("carries the disagreement point through unchanged", async () => {
    const t = asBargaining((await theoryOf("rubinstein-bargaining.yaml")).theory);
    assertClose(t.disagreement.alpha, 0, "disagreement alpha");
    assertClose(t.disagreement.beta, 0, "disagreement beta");
  });

  it("confirms individual rationality", async () => {
    const r = await validateGolden("rubinstein-bargaining.yaml");
    assert.equal(verdictFor(r, "individually_rational")?.verdict, "confirmed");
  });
});

// ---------------------------------------------------------------------------
// Network — Morris contagion
// ---------------------------------------------------------------------------

describe("golden: morris-contagion-cycle.yaml", () => {
  it("reports the ten-cycle's graph statistics", async () => {
    const t = asNetwork((await theoryOf("morris-contagion-cycle.yaml")).theory);
    assert.equal(t.graphStats.nodes, 10);
    assert.equal(t.graphStats.edges, 10);
    assert.deepEqual([...t.graphStats.components], [10], "one connected component");
    assertClose(t.graphStats.meanDegree, 2, "meanDegree = 2*10/10");
  });

  it("the contagion threshold of the cycle is 0.5", async () => {
    const t = asNetwork((await theoryOf("morris-contagion-cycle.yaml")).theory);
    assertClose(t.contagionThreshold, 0.5, "Morris contagion threshold of the line/cycle");
  });

  it("a single seed produces a complete cascade of 10", async () => {
    const t = asNetwork((await theoryOf("morris-contagion-cycle.yaml")).theory);
    assert.equal(t.predictedCascadeSize, 10);
  });

  it("best-response dynamics converge, and that is reported rather than assumed", async () => {
    const t = asNetwork((await theoryOf("morris-contagion-cycle.yaml")).theory);
    assert.equal(t.bestResponseConverged, true);
  });

  it("declares no claims, so there are no verdicts to render", async () => {
    const r = await validateGolden("morris-contagion-cycle.yaml");
    assert.deepEqual([...r.claimVerdicts], []);
  });
});

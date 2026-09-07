/**
 * Adversarial fixtures: specs that are structurally valid YAML, pass a schema
 * check, and whose CLAIMS ARE FALSE.
 *
 * This is the direct test of "a spec claiming to be a stag hunt but isn't must
 * be detectable" (plan section 14, item 4). Every fixture here must come back
 * `refuted` on its named claim, WITH A WITNESS — a verdict with no
 * counterexample is an assertion, not a refutation, and the report is supposed
 * to carry the reason.
 *
 * These tests FAIL UNTIL src/spec/validate.ts exists. That is the intent.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  ADVERSARIAL_DIR,
  adversarial,
  listFixtures,
  loadValidate,
  verdictFor,
  type ValidationResult,
} from "./boundary.js";

async function validateAdversarial(name: string): Promise<ValidationResult> {
  const validate = await loadValidate();
  return validate(adversarial(name).spec);
}

/** A refutation without a counterexample is not a refutation. */
function assertRefutedWithWitness(
  result: ValidationResult,
  claimKind: string,
  fixture: string,
) {
  const v = verdictFor(result, claimKind);
  assert.ok(v, `${fixture}: no verdict rendered for claim kind ${claimKind}`);
  assert.equal(
    v!.verdict,
    "refuted",
    `${fixture}: claim ${claimKind} must be REFUTED, got ${v!.verdict}`,
  );
  assert.ok(
    v!.witness !== undefined && v!.witness !== null,
    `${fixture}: claim ${claimKind} was refuted with no witness. The witness is ` +
      `the counterexample; without it the report cannot say why.`,
  );
}

function assertHasError(result: ValidationResult, fixture: string, about: RegExp) {
  assert.ok(
    result.errors.length > 0,
    `${fixture}: expected at least one hard error`,
  );
  assert.ok(
    result.errors.some((e) => about.test(e.message) || about.test(e.code ?? "")),
    `${fixture}: expected an error matching ${about}; got ` +
      JSON.stringify(result.errors),
  );
}

// ---------------------------------------------------------------------------
// Corpus-wide
// ---------------------------------------------------------------------------

describe("adversarial corpus", () => {
  const fixtures = listFixtures(ADVERSARIAL_DIR);

  it("is non-empty and every file parses", () => {
    assert.ok(fixtures.length >= 9, `expected >= 9 adversarial fixtures, got ${fixtures.length}`);
    for (const f of fixtures) {
      assert.equal(f.spec.schemaVersion, "1", `${f.name} schemaVersion`);
      assert.ok(typeof f.spec.family === "string", `${f.name} has no family tag`);
    }
  });

  it("every fixture names, in its header, the claim that must be refuted", () => {
    for (const f of fixtures) {
      assert.ok(
        f.source.startsWith("# ADVERSARIAL"),
        `${f.name} must open with an "# ADVERSARIAL" header comment`,
      );
      assert.ok(
        /MUST BE REFUTED/.test(f.source),
        `${f.name} header must state which claim must come back refuted`,
      );
      assert.ok(
        /WITNESS/.test(f.source),
        `${f.name} header must state what the witness should be`,
      );
    }
  });

  it("every fixture declares at least one claim, or it tests nothing", () => {
    for (const f of fixtures) {
      assert.ok(
        Array.isArray(f.spec.claims) && f.spec.claims.length > 0,
        `${f.name} declares no claims`,
      );
    }
  });

  it("every fixture yields at least one refuted verdict carrying a witness", async () => {
    const validate = await loadValidate();
    for (const f of fixtures) {
      const result = validate(f.spec);
      assert.equal(
        result.claimVerdicts.length,
        f.spec.claims.length,
        `${f.name}: one verdict per claim, even when errors are present`,
      );
      const refuted = result.claimVerdicts.filter((v) => v.verdict === "refuted");
      assert.ok(refuted.length > 0, `${f.name}: nothing was refuted`);
      for (const v of refuted) {
        assert.ok(
          v.witness !== undefined && v.witness !== null,
          `${f.name}: refuted ${v.claim.kind} with no witness`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// One test per fixture, naming exactly what must be caught
// ---------------------------------------------------------------------------

describe("adversarial: stag-hunt-equilibria-coincide.yaml", () => {
  const F = "stag-hunt-equilibria-coincide.yaml";

  it("refutes the stag_hunt archetype: payoff-dominant and risk-dominant coincide", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "archetype", F);
  });

  it("is otherwise well-formed — the refutation is a claim verdict, not a schema error", async () => {
    const r = await validateAdversarial(F);
    assert.deepEqual(
      r.errors,
      [],
      "this spec passes the schema; only its claim is false, which is the point",
    );
  });
});

describe("adversarial: prisoners-dilemma-no-dominance.yaml", () => {
  const F = "prisoners-dilemma-no-dominance.yaml";

  it("refutes the prisoners_dilemma archetype", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "archetype", F);
  });

  it("refutes the dominance claim: against D, cooperating pays 1 and defecting pays 0", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "dominant_strategy", F);
  });

  it("is otherwise well-formed", async () => {
    assert.deepEqual((await validateAdversarial(F)).errors, []);
  });
});

describe("adversarial: cascade-only-trivial-fixed-points.yaml", () => {
  const F = "cascade-only-trivial-fixed-points.yaml";

  it("refutes tipping_point_exists: the only fixed points are 0 and N", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "tipping_point_exists", F);
  });

  it("is otherwise well-formed — the threshold is reachable and the sign is right", async () => {
    assert.deepEqual((await validateAdversarial(F)).errors, []);
  });
});

describe("adversarial: social-dilemma-already-efficient.yaml", () => {
  const F = "social-dilemma-already-efficient.yaml";

  it("refutes social_dilemma: the equilibrium already IS the efficient level", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "social_dilemma", F);
  });
});

describe("adversarial: dsic-on-first-price-auction.yaml", () => {
  const F = "dsic-on-first-price-auction.yaml";

  it("refutes dsic on a first-price rule", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "dsic", F);
  });

  it("names the profitable misreport in the witness: value 40 bids 30, gaining 10", async () => {
    const r = await validateAdversarial(F);
    const witness = verdictFor(r, "dsic")!.witness;
    const text = JSON.stringify(witness);
    assert.ok(
      /40/.test(text) && /30/.test(text),
      `the witness must name the lie itself (valuation 40, bid 30), got ${text}`,
    );
  });

  it("does NOT over-refute: individual rationality is genuinely true here", async () => {
    const r = await validateAdversarial(F);
    assert.equal(
      verdictFor(r, "individually_rational")?.verdict,
      "confirmed",
      "truthful bidding never yields negative utility in a first-price auction",
    );
  });
});

describe("adversarial: bargaining-disagreement-above-frontier.yaml", () => {
  const F = "bargaining-disagreement-above-frontier.yaml";

  it("refutes individually_rational: 60 + 60 > 100, so the bargaining set is empty", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "individually_rational", F);
  });

  it("also hard-fails: a disagreement point outside the frontier is not a well-formed spec", async () => {
    assertHasError(await validateAdversarial(F), F, /disagreement|frontier|feasib/i);
  });
});

describe("adversarial: sequential-perfect-recall-violation.yaml", () => {
  const F = "sequential-perfect-recall-violation.yaml";

  it("hard-fails on perfect recall: infoset h2 pools nodes split by p1's own move", async () => {
    assertHasError(await validateAdversarial(F), F, /perfect.?recall|recall/i);
  });

  it("refutes the dominance claim on its own merits: (R, y) pays 4 and beats every L strategy", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "dominant_strategy", F);
  });

  it("does not confirm anything it could not legitimately compute", async () => {
    const r = await validateAdversarial(F);
    assert.ok(
      !r.claimVerdicts.some((v) => v.verdict === "confirmed"),
      "backward induction is invalid without perfect recall, so nothing here may be confirmed",
    );
  });
});

describe("adversarial: contagion-disconnected-graph.yaml", () => {
  const F = "contagion-disconnected-graph.yaml";

  it("refutes the contagion claim on a disconnected graph", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "tipping_point_exists", F);
  });

  it("records the component sizes, which is the whole witness", async () => {
    const r = await validateAdversarial(F);
    const seen = JSON.stringify([
      verdictFor(r, "tipping_point_exists")?.witness,
      r.warnings,
    ]);
    assert.ok(
      /\[\s*5\s*,\s*5\s*\]|"5"|component/i.test(seen),
      `component sizes [5, 5] must be recorded somewhere in the witness or warnings, got ${seen}`,
    );
  });

  it("warns rather than hard-fails: a disconnected graph is legal, just not contagious", async () => {
    const r = await validateAdversarial(F);
    assert.ok(
      r.warnings.length > 0,
      "plan section 6 says warn (not fail) on a disconnected graph, and record component sizes",
    );
  });
});

describe("adversarial: monotonicity-sign-contradiction.yaml", () => {
  const F = "monotonicity-sign-contradiction.yaml";

  it("hard-fails: slopeOver = -2 is a substitute, but the spec declares complement", async () => {
    assertHasError(await validateAdversarial(F), F, /monotonic|slope|sign/i);
  });

  it("refutes tipping_point_exists: the single fixed point at 8 is stable", async () => {
    assertRefutedWithWitness(await validateAdversarial(F), "tipping_point_exists", F);
  });
});

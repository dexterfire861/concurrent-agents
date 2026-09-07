/**
 * Structural validation, in two tiers.
 *
 *   errors / warnings  -> "is this spec well-formed?"
 *   claimVerdicts      -> "is it actually the game it claims to be?"
 *
 * CONTRACT: exactly one verdict per declared claim, in order, EVEN WHEN errors
 * are present. A claim that cannot be judged because of a blocking error comes
 * back `refuted` with a witness naming that error — never `confirmed`.
 *
 * Pure. No I/O, no clock, no RNG, and no free-text field is ever read.
 */

import type { ActionSpace, Scenario, StructuralClaim } from "./types.js";
import type { ClaimVerdict } from "../eval/report.js";
import {
  aggregateEquilibria,
  aggregateModel,
  aggregateWelfare,
  efficientLevel,
  expandDistribution,
  normalFormMatrix,
  num,
} from "./resolve.js";
import {
  aggregateTheory,
  detectArchetype,
  mechanismTheory,
  networkTheory,
  normalFormTheory,
} from "../eval/strategic.js";
import {
  bestTerminalWelfare,
  infosetViolations,
  perfectRecallViolations,
  sequentialTheory,
} from "../eval/extensive.js";

const TOL = 1e-9;

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

export interface ValidationResult {
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  readonly claimVerdicts: readonly ClaimVerdict[];
}

/** Which observation channels a family can actually emit. */
const CHANNELS: Record<Scenario["family"], readonly string[]> = {
  normal_form: ["own_action", "own_payoff", "own_type", "full_profile", "history"],
  aggregate: ["own_action", "own_payoff", "own_type", "aggregate_statistic", "history"],
  network_local: ["own_action", "own_payoff", "own_type", "neighbor_actions", "history"],
  mechanism: [
    "own_action", "own_payoff", "own_type", "mechanism_outcome", "others_types", "history",
  ],
  sequential: ["own_action", "own_payoff", "own_type", "history", "full_profile"],
  bargaining: ["own_action", "own_payoff", "own_type", "history", "full_profile"],
};

export const validate = (spec: Scenario): ValidationResult => {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  // --- envelope ---------------------------------------------------------
  const shares = spec.population.roles.reduce((s, r) => s + r.share, 0);
  if (Math.abs(shares - 1) > 1e-6) {
    errors.push({
      path: "/population/roles",
      code: "shares_not_one",
      message: `role shares must sum to 1, got ${shares}`,
    });
  }

  const allowed = CHANNELS[spec.family];
  for (const channel of spec.information.observes) {
    if (!allowed.includes(channel)) {
      errors.push({
        path: "/information/observes",
        code: "channel_not_emitted",
        message: `the ${spec.family} family does not emit "${channel}"`,
      });
    }
  }

  if (spec.protocol.repetition.termination === "geometric" &&
      spec.protocol.repetition.continuationProb === undefined) {
    errors.push({
      path: "/protocol/repetition",
      code: "missing_continuation_prob",
      message: "geometric termination requires continuationProb",
    });
  }

  if (spec.protocol.commitment) {
    errors.push({
      path: "/protocol/commitment",
      code: "commitment_unsupported",
      message:
        "commitment order converts the game and the solver cannot yet solve the " +
        "ordered version; failing rather than reporting simultaneous theory",
    });
  }

  // --- family-specific --------------------------------------------------
  switch (spec.family) {
    case "aggregate": {
      const n = Math.round(num(spec.population.size));
      const model = aggregateModel(spec, n);
      if (model.monotonicity !== spec.monotonicity) {
        errors.push({
          path: "/monotonicity",
          code: "monotonicity_sign_mismatch",
          message:
            `declared "${spec.monotonicity}" but the payoff slope makes this a ` +
            `"${model.monotonicity}" game`,
        });
      }
      if (spec.payoff.kind === "threshold_binary") {
        for (const t of expandDistribution(spec.payoff.threshold, n)) {
          if (t > n) {
            errors.push({
              path: "/payoff/threshold",
              code: "threshold_unreachable",
              message: `threshold ${t} exceeds the population of ${n} and can never be met`,
            });
            break;
          }
        }
      }
      break;
    }

    case "network_local": {
      const { theory } = networkTheory(spec);
      if (theory.graphStats.components.length > 1) {
        warnings.push({
          path: "/graph",
          code: "disconnected_graph",
          message:
            `graph has ${theory.graphStats.components.length} components with sizes ` +
            `[${theory.graphStats.components.join(", ")}]; a global contagion claim ` +
            `is vacuous on it`,
        });
      }
      break;
    }

    case "sequential": {
      for (const message of infosetViolations(spec)) {
        errors.push({ path: "/tree/infosets", code: "infoset_inconsistent", message });
      }
      for (const message of perfectRecallViolations(spec)) {
        errors.push({
          path: "/tree/infosets",
          code: "perfect_recall_violated",
          message: `${message}; backward induction is invalid without perfect recall`,
        });
      }
      break;
    }

    case "bargaining": {
      const surplus = num(spec.surplus);
      const total = spec.population.roles.reduce(
        (s, r) => s + num(spec.disagreement[r.id] ?? 0),
        0 as number,
      );
      if (total >= surplus - TOL) {
        errors.push({
          path: "/disagreement",
          code: "disagreement_outside_frontier",
          message:
            `the disagreement point sums to ${total}, which is not below the ` +
            `feasible frontier of ${surplus}; there is nothing to bargain over`,
        });
      }
      for (const role of spec.population.roles) {
        const d = num(spec.discount[role.id] ?? 0);
        if (d <= 0 || d >= 1) {
          errors.push({
            path: `/discount/${role.id}`,
            code: "discount_out_of_range",
            message: `discount must lie strictly in (0,1), got ${d}`,
          });
        }
      }
      break;
    }

    case "mechanism": {
      const space = spec.report.kind === "ranking" ? null : spec.report.space;
      if (space && space.kind === "discrete") {
        const bids = space.actions.map(Number);
        const values = spec.valuation.dist.kind === "empirical"
          ? spec.valuation.dist.values
          : [];
        const top = Math.max(...bids, -Infinity);
        for (const v of values) {
          if (v > top + TOL) {
            errors.push({
              path: "/report/space",
              code: "bid_grid_truncates_values",
              message:
                `the bid grid tops out at ${top} but valuations reach ${v}; a grid ` +
                `that truncates the support silently caps bids`,
            });
            break;
          }
        }
      }
      break;
    }

    case "normal_form":
      break;
  }

  const blocking = errors.length > 0;
  const claimVerdicts = spec.claims.map((claim) => judge(spec, claim, blocking, errors));

  return { errors, warnings, claimVerdicts };
};

// ---------------------------------------------------------------------------
// Claim adjudication
// ---------------------------------------------------------------------------

function refute(claim: StructuralClaim, witness: unknown): ClaimVerdict {
  return { claim, verdict: "refuted", witness };
}

function judge(
  spec: Scenario,
  claim: StructuralClaim,
  blocking: boolean,
  errors: readonly ValidationIssue[],
): ClaimVerdict {
  // A blocking error means the claim cannot be judged. Refuting with the error
  // as the witness is the only safe direction: confirming would assert
  // something the validator was unable to compute.
  const blockedWitness = {
    blockedBy: errors.map((e) => ({ path: e.path, code: e.code, message: e.message })),
  };

  switch (claim.kind) {
    case "archetype": {
      if (spec.family === "normal_form") {
        const roles = spec.population.roles.map((r) => r.id);
        const m = normalFormMatrix(spec, roles);
        if (!m) return refute(claim, { reason: "payoffs are not a 2-player matrix" });
        const { theory } = normalFormTheory(spec);
        const detected = detectArchetype(spec, m, theory.pureNash.length, theory.dominant);
        if (detected === claim.value) return { claim, verdict: "confirmed" };
        return refute(claim, {
          claimed: claim.value,
          detected,
          reason: archetypeReason(spec, claim.value, detected),
          pureNash: theory.pureNash,
        });
      }

      if (spec.family === "sequential") {
        if (blocking) return refute(claim, blockedWitness);
        const { theory } = sequentialTheory(spec);
        const payoffs = Object.entries(theory.equilibriumPayoffs);
        if (claim.value === "ultimatum") {
          const ok = payoffs.length === 2 && hasZeroTerminal(spec) &&
            payoffs[0]![1] !== payoffs[1]![1];
          return ok
            ? { claim, verdict: "confirmed" }
            : refute(claim, { reason: "no rejection terminal, or an even split at the SPNE" });
        }
        if (claim.value === "trust") {
          const equilibrium = payoffs.reduce((s, [, v]) => s + v, 0);
          const best = bestTerminalWelfare(spec);
          return equilibrium < best - TOL
            ? { claim, verdict: "confirmed" }
            : refute(claim, {
                reason: "the SPNE already achieves the best joint outcome, so no trust is at stake",
                equilibrium,
                best,
              });
        }
        return refute(claim, { reason: `archetype ${claim.value} is not verifiable here` });
      }

      return refute(claim, { reason: `archetype claims are not supported for ${spec.family}` });
    }

    case "dominant_strategy": {
      if (blocking && spec.family === "sequential") {
        // Perfect recall may be broken, but dominance over the reduced strategy
        // set is still computable, so judge it on its own merits.
      } else if (blocking) {
        return refute(claim, blockedWitness);
      }

      if (spec.family === "normal_form") {
        const { theory } = normalFormTheory(spec);
        const bad = Object.entries(theory.dominant).find(
          ([, d]) => d === null || d.action !== claim.action || (claim.strict && !d.strict),
        );
        if (!bad) return { claim, verdict: "confirmed" };
        return refute(claim, {
          role: bad[0],
          claimedDominant: claim.action,
          actuallyDominant: bad[1],
          reason: `${claim.action} is not ${claim.strict ? "strictly " : ""}dominant for ${bad[0]}`,
        });
      }

      if (spec.family === "aggregate") {
        const n = Math.round(num(spec.population.size));
        const model = aggregateModel(spec, n);
        const abstainLabel = otherAction(spec.actions, spec.statistic.of);
        const abstainDominant = Array.from({ length: n }, (_, j) => j).every(
          (j) => model.abstain(0, j) > model.act(0, j + 1) + TOL,
        );
        const wants = claim.action === abstainLabel ? abstainDominant : !abstainDominant;
        return wants
          ? { claim, verdict: "confirmed" }
          : refute(claim, { reason: `${claim.action} is not dominant at every level` });
      }

      if (spec.family === "sequential") {
        const result = sequentialDominance(spec, claim.action);
        return result.dominant
          ? { claim, verdict: "confirmed" }
          : refute(claim, result.witness);
      }

      return refute(claim, { reason: `dominance is not computed for ${spec.family}` });
    }

    case "tipping_point_exists": {
      if (spec.family === "aggregate") {
        if (blocking) return refute(claim, blockedWitness);
        const n = Math.round(num(spec.population.size));
        const { fixedPoints, tippingPoints } = aggregateEquilibria(aggregateModel(spec, n));
        if (tippingPoints.length > 0) return { claim, verdict: "confirmed" };
        return refute(claim, {
          reason:
            "no interior unstable equilibrium exists, so there is no level at which " +
            "the population tips",
          fixedPoints,
        });
      }

      if (spec.family === "network_local") {
        const { theory } = networkTheory(spec);
        const connected = theory.graphStats.components.length === 1;
        const spreads = (theory.predictedCascadeSize ?? 0) === theory.graphStats.nodes;
        if (connected && spreads && (theory.contagionThreshold ?? 0) > 0) {
          return { claim, verdict: "confirmed" };
        }
        return refute(claim, {
          reason: connected
            ? "the cascade does not reach the whole graph"
            : "the graph is disconnected, so no seed set can reach every node",
          components: theory.graphStats.components,
          cascadeSize: theory.predictedCascadeSize,
        });
      }

      return refute(claim, { reason: `tipping points are not defined for ${spec.family}` });
    }

    case "social_dilemma": {
      if (blocking) return refute(claim, blockedWitness);

      if (spec.family === "aggregate") {
        const { theory } = aggregateTheory(spec);
        // WELFARE definition, not Pareto: total welfare at the equilibrium is
        // strictly below the achievable maximum. The congestion example is
        // welfare-inefficient without being Pareto-dominated, and the Pareto
        // reading would refute a claim that is true.
        if (theory.welfareGap > TOL) return { claim, verdict: "confirmed" };
        return refute(claim, {
          reason: "the equilibrium already attains the maximum achievable welfare",
          equilibriumLevel: theory.equilibriumLevel,
          efficientLevel: theory.efficientLevel,
          welfareGap: theory.welfareGap,
        });
      }

      if (spec.family === "normal_form") {
        const roles = spec.population.roles.map((r) => r.id);
        const m = normalFormMatrix(spec, roles);
        const { theory } = normalFormTheory(spec);
        if (!m || theory.pureNash.length === 0) {
          return refute(claim, { reason: "no pure equilibrium to compare against" });
        }
        const welfareOf = (a: string, b: string) => {
          const [x, y] = m.payoff(a, b);
          return x + y;
        };
        const best = Math.max(
          ...m.actions.flatMap((a) => m.actions.map((b) => welfareOf(a, b))),
        );
        const worstNash = Math.min(
          ...theory.pureNash.map((p) => welfareOf(String(p[m.roles[0]]), String(p[m.roles[1]]))),
        );
        return worstNash < best - TOL
          ? { claim, verdict: "confirmed" }
          : refute(claim, { reason: "the equilibrium is already welfare-optimal", best, worstNash });
      }

      if (spec.family === "sequential") {
        const { theory } = sequentialTheory(spec);
        const equilibrium = Object.values(theory.equilibriumPayoffs).reduce((s, v) => s + v, 0);
        const best = bestTerminalWelfare(spec);
        return equilibrium < best - TOL
          ? { claim, verdict: "confirmed" }
          : refute(claim, { reason: "the SPNE already attains the best joint outcome" });
      }

      return refute(claim, { reason: `social_dilemma is not computed for ${spec.family}` });
    }

    case "dsic": {
      if (spec.family !== "mechanism") {
        return refute(claim, { reason: "dsic applies only to the mechanism family" });
      }
      if (blocking) return refute(claim, blockedWitness);
      const { theory, dsicWitness } = mechanismTheory(spec);
      return theory.dsicVerified
        ? { claim, verdict: "confirmed" }
        : refute(claim, dsicWitness ?? { reason: "a profitable misreport exists" });
    }

    case "individually_rational": {
      if (spec.family === "mechanism") {
        if (blocking) return refute(claim, blockedWitness);
        const { theory } = mechanismTheory(spec);
        return theory.individuallyRational
          ? { claim, verdict: "confirmed" }
          : refute(claim, { reason: "truthful participation can yield negative utility" });
      }

      if (spec.family === "bargaining") {
        const surplus = num(spec.surplus);
        const total = spec.population.roles.reduce(
          (s, r) => s + num(spec.disagreement[r.id] ?? 0),
          0 as number,
        );
        return total < surplus - TOL
          ? { claim, verdict: "confirmed" }
          : refute(claim, {
              reason:
                "the disagreement point is not below the frontier, so no split leaves " +
                "both sides at least as well off as walking away",
              surplus,
              disagreementTotal: total,
            });
      }

      return refute(claim, { reason: `IR is not computed for ${spec.family}` });
    }

    case "contagion_possible": {
      if (spec.family !== "network_local") {
        return refute(claim, { reason: "contagion applies only to the network family" });
      }
      const { theory } = networkTheory(spec);
      const q = theory.contagionThreshold ?? 0;
      return q > 0 && q < 1 && theory.graphStats.components.length === 1
        ? { claim, verdict: "confirmed" }
        : refute(claim, {
            reason: "no interior contagion threshold on a connected graph",
            components: theory.graphStats.components,
            contagionThreshold: q,
          });
    }
  }
}

function archetypeReason(
  spec: Scenario,
  claimed: string,
  detected: string | null,
): string {
  if (spec.family !== "normal_form" || spec.payoff.kind !== "symmetric_2x2") {
    return `detected ${detected ?? "no recognised archetype"}`;
  }
  const R = num(spec.payoff.R);
  const S = num(spec.payoff.S);
  const T = num(spec.payoff.T);
  const P = num(spec.payoff.P);
  if (claimed === "stag_hunt") {
    const payoffDominantIsFirst = R > P;
    const riskDominantIsFirst = R - T > P - S;
    if (payoffDominantIsFirst === riskDominantIsFirst) {
      return (
        `the payoff-dominant and risk-dominant equilibria coincide ` +
        `(R-T = ${R - T}, P-S = ${P - S}), so there is no dilemma and this is not a stag hunt`
      );
    }
  }
  if (claimed === "prisoners_dilemma" && !(P > S)) {
    return `P (${P}) does not exceed S (${S}), so mutual defection is not the ordering a dilemma needs`;
  }
  return `payoff ordering R=${R} S=${S} T=${T} P=${P} does not match ${claimed}`;
}

function hasZeroTerminal(spec: Scenario): boolean {
  if (spec.family !== "sequential" || spec.tree.kind !== "explicit") return false;
  return Object.values(spec.tree.nodes).some(
    (n) => n.kind === "terminal" && Object.values(n.payoffs).every((v) => Math.abs(num(v)) < TOL),
  );
}

/** The non-acting label in a binary aggregate action set. */
function otherAction(actions: ActionSpace, actLabel: string): string {
  if (actions.kind !== "discrete") return "";
  return actions.actions.find((a) => a !== actLabel) ?? "";
}

/**
 * Dominance over the REDUCED strategy set of an extensive-form game.
 *
 * A "strategy" here is a choice at every one of the player's information sets,
 * which is why a single move can look attractive and still not be dominant: the
 * comparison is between complete plans, not between moves.
 */
function sequentialDominance(
  spec: Scenario & { family: "sequential" },
  action: string,
): { dominant: boolean; witness?: unknown } {
  if (spec.tree.kind !== "explicit") return { dominant: false, witness: { reason: "no tree" } };

  const owner = spec.tree.infosets.find((i) =>
    i.nodes.some((id) => {
      const n = spec.tree.kind === "explicit" ? spec.tree.nodes[id] : undefined;
      return n?.kind === "decision" && action in n.moves;
    }),
  )?.owner;
  if (!owner) return { dominant: false, witness: { reason: `no infoset offers ${action}` } };

  const mine = spec.tree.infosets.filter((i) => i.owner === owner);
  const options = mine.map((i) => {
    const node = spec.tree.kind === "explicit" ? spec.tree.nodes[i.nodes[0]!] : undefined;
    return node?.kind === "decision" ? Object.keys(node.moves).sort() : [];
  });

  // Every combination of moves across the player's information sets.
  const strategies: Record<string, string>[] = options.reduce<Record<string, string>[]>(
    (acc, moves, idx) =>
      acc.flatMap((partial) => moves.map((m) => ({ ...partial, [mine[idx]!.id]: m }))),
    [{}],
  );

  const payoffOf = (strategy: Record<string, string>): number => {
    let id = spec.tree.kind === "explicit" ? spec.tree.root : "";
    for (let step = 0; step < 64; step += 1) {
      const node = spec.tree.kind === "explicit" ? spec.tree.nodes[id] : undefined;
      if (!node) return 0;
      if (node.kind === "terminal") return num(node.payoffs[owner] ?? 0);
      if (node.kind === "chance") {
        id = Object.values(node.moves)[0]?.to ?? "";
        continue;
      }
      const move = strategy[node.infoset] ?? Object.keys(node.moves).sort()[0]!;
      id = node.moves[move] ?? "";
    }
    return 0;
  };

  const plays = (s: Record<string, string>) => Object.values(s).includes(action);
  const withAction = strategies.filter(plays);
  const without = strategies.filter((s) => !plays(s));
  if (withAction.length === 0 || without.length === 0) {
    return { dominant: false, witness: { reason: "no comparison available" } };
  }

  const worstWith = Math.min(...withAction.map(payoffOf));
  const bestWithoutStrategy = without.reduce((a, b) => (payoffOf(b) > payoffOf(a) ? b : a));
  const bestWithout = payoffOf(bestWithoutStrategy);

  if (worstWith > bestWithout + TOL) return { dominant: true };
  return {
    dominant: false,
    witness: {
      reason:
        `the best plan that does NOT play ${action} pays ${bestWithout}, which is at ` +
        `least as good as the worst plan that does (${worstWith})`,
      counterStrategy: bestWithoutStrategy,
      counterPayoff: bestWithout,
    },
  };
}

void aggregateWelfare;
void efficientLevel;

/**
 * The evaluator's input and output boundary.
 *
 * Two invariants are enforced here by types rather than by discipline:
 *
 *  1. The evaluator cannot see free text (EvaluatorView). No LLM, and no
 *     semantics, can reach the scoring path.
 *  2. The three meanings of "regret" are three distinct variants, so summing
 *     or averaging them across families is a compile error rather than a
 *     plausible-looking chart.
 */

import type {
  ActionLabel,
  AgentId,
  Archetype,
  RoleId,
  Scenario,
  StructuralClaim,
} from "../spec/types.js";
import type { RunTrace } from "../trace/types.js";

// ---------------------------------------------------------------------------
// Evaluator blindness
// ---------------------------------------------------------------------------

/**
 * Fields an LLM would need in order to score "by vibes". Structurally removed.
 *
 * Declared as a runtime constant with the type DERIVED from it, so the
 * compile-time strip and any runtime strip cannot drift apart.
 */
export const FREE_TEXT_KEYS = [
  "persona",
  "sourceDescription",
  "title",
  "rawOutput",
  "reasoning",
  "promptText",
  "text",
] as const;

type FreeTextKey = (typeof FREE_TEXT_KEYS)[number];

/**
 * A recursive Omit of every free-text field.
 *
 * The payoff of this type is one very cheap, very strong test: scramble every
 * persona and title in a spec, re-score, and assert the report is byte
 * identical. If it isn't, semantics leaked into scoring.
 */
export type EvaluatorView<T> = T extends readonly (infer U)[]
  ? readonly EvaluatorView<U>[]
  : T extends object
    ? // Key REMAPPING over `keyof T`, not `Exclude<keyof T, ...>`. The Exclude
      // form is not homomorphic, so it silently drops `?` and `readonly`
      // modifiers and turns every optional field into a required one — which
      // made the evaluator's input type unsatisfiable by any real spec.
      { [K in keyof T as K extends FreeTextKey ? never : K]: EvaluatorView<T[K]> }
    : T;

/** The evaluator is a pure function. Same inputs, same output, forever. */
export type Evaluate = (
  spec: EvaluatorView<Scenario>,
  trace: EvaluatorView<RunTrace>,
) => EvaluationReport;

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface EvaluationReport {
  readonly specHash: string;
  readonly traceHash: string;
  readonly evaluatorVersion: string;
  readonly claimVerdicts: readonly ClaimVerdict[];
  /** Derived from the SPEC ALONE. Never hand-typed, never read from the trace. */
  readonly theory: TheoryBlock;
  /** Derived from trace + spec. */
  readonly measured: MeasuredBlock;
  readonly method: SolverMethod;
  /** Anything the solver could not compute. Stated, never silently omitted. */
  readonly incompleteness: readonly string[];
}

export interface ClaimVerdict {
  readonly claim: StructuralClaim;
  /**
   * `indeterminate` is not a hedge — it is required for honesty. A perfect-recall
   * violation invalidates backward induction, so an archetype claim on that tree
   * cannot be judged at all. Refuting it would assert something unproven; the
   * blocking error goes in `witness`.
   */
  readonly verdict: "confirmed" | "refuted" | "indeterminate";
  /** The counterexample, when refuted. A profitable lie, a coinciding equilibrium. */
  readonly witness?: unknown;
}

export interface SolverMethod {
  readonly equilibrium:
    | "exhaustive"
    | "support_enumeration"
    | "backward_induction"
    | "fixed_point_iteration"
    | "grid_approximation";
  /** Explicit epsilon, so float comparisons classify identically across machines. */
  readonly tolerance: number;
  /** Mandatory whenever equilibrium is "grid_approximation". */
  readonly gridResolution?: number;
}

// ---------------------------------------------------------------------------
// Regret — three meanings, three types
// ---------------------------------------------------------------------------

/**
 * Deliberately not one number.
 *
 * The party case: you stayed home, 9 others went, your threshold was 10.
 * `price_taking` holds the crowd at 9 and reports regret 0. The correct
 * measure recomputes the crowd as 10 and reports regret 7. Same night, same
 * data, opposite conclusions — and the wrong one is what you get by reusing
 * normal-form regret code without noticing you are inside the headcount.
 */
export type RegretMeasure =
  /** Normal-form and network. Others' actions held fixed. The baseline. */
  | { readonly kind: "ex_post_unilateral"; readonly value: number }
  /** Aggregate, large-N approximation. Holds the statistic fixed. Wrong at the margin. */
  | { readonly kind: "price_taking"; readonly value: number }
  /** Aggregate, correct. Recomputes the statistic without the agent's own action. */
  | { readonly kind: "ex_post_aggregate_corrected"; readonly value: number }
  /** Mechanism. Expectation over others' types, given only own type. */
  | { readonly kind: "interim_bayesian"; readonly value: number }
  /** Sequential. Only defensible at information sets actually reached. */
  | {
      readonly kind: "infoset_counterfactual";
      readonly infoset: string;
      readonly value: number;
    }
  | { readonly kind: "not_applicable"; readonly reason: string };

// ---------------------------------------------------------------------------
// Theory — computed from the spec alone
// ---------------------------------------------------------------------------

export type TheoryBlock =
  | NormalFormTheory
  | AggregateTheory
  | NetworkTheory
  | MechanismTheory
  | SequentialTheory
  | BargainingTheory;

export type ActionProfile = Readonly<Record<AgentId, ActionLabel | number>>;

export interface NormalFormTheory {
  readonly family: "normal_form";
  readonly pureNash: readonly ActionProfile[];
  readonly mixedNash?: readonly Readonly<
    Record<AgentId, Readonly<Record<ActionLabel, number>>>
  >[];
  readonly dominant: Readonly<
    Record<RoleId, { action: ActionLabel; strict: boolean } | null>
  >;
  readonly paretoFrontier: readonly ActionProfile[];
  readonly priceOfAnarchy?: number;
  readonly priceOfStability?: number;
  /**
   * Present whenever repetition is non-trivial. The stage-game equilibrium
   * alone is NOT the theory for a repeated game.
   */
  readonly repeated?: {
    readonly minmax: Readonly<Record<RoleId, number>>;
    readonly cooperationSustainableAboveDiscount?: number;
  };
  readonly archetypeDetected: Archetype | null;
}

export interface AggregateTheory {
  readonly family: "aggregate";
  /** Where the aggregate best-response map settles. The equilibrium is a LEVEL. */
  readonly fixedPoints: readonly {
    readonly level: number;
    readonly stable: boolean;
  }[];
  /** The unstable crossings. These are the tipping points. */
  readonly tippingPoints: readonly number[];
  /**
   * SELECTION RULE, when several stable levels exist: the one best-response
   * dynamics reach from an all-inactive start. Ties broken toward the lower
   * level. `null` when dynamics do not converge — never a silent pick.
   */
  readonly equilibriumLevel: number | null;
  readonly efficientLevel: number;
  /** Positive when the equilibrium is collectively worse than achievable. */
  readonly welfareGap: number;
  readonly monotonicityVerified: "complement" | "substitute";
}

export interface NetworkTheory {
  readonly family: "network_local";
  readonly pureNash: readonly ActionProfile[];
  /** Best-response dynamics need not converge. Reported, never fabricated. */
  readonly bestResponseConverged: boolean;
  readonly contagionThreshold?: number;
  readonly predictedCascadeSize?: number;
  readonly graphStats: {
    readonly nodes: number;
    readonly edges: number;
    readonly components: readonly number[];
    readonly meanDegree: number;
  };
}

export interface MechanismTheory {
  readonly family: "mechanism";
  readonly equilibriumBid: "truthful" | "shaded" | "numeric";
  readonly dsicVerified: boolean;
  readonly expectedRevenue: number;
  readonly expectedEfficiency: number;
  readonly individuallyRational: boolean;
}

export interface SequentialTheory {
  readonly family: "sequential";
  /** Backward induction result: what each information set should do. */
  readonly spne: Readonly<Record<string, ActionLabel>>;
  readonly equilibriumPayoffs: Readonly<Record<RoleId, number>>;
  /**
   * Off-path threats and whether they would actually be carried out. Computed
   * from the tree, never measured from a transcript.
   */
  readonly credibility: readonly {
    readonly infoset: string;
    /** Named neutrally: in entry deterrence this is a threat, in the trust
     *  game it is a promise. Both are off-path moves tested for credibility. */
    readonly offPathMove: ActionLabel;
    readonly credible: boolean;
  }[];
  readonly perfectRecall: true;
}

export interface BargainingTheory {
  readonly family: "bargaining";
  /** Axiomatic benchmark. */
  readonly nashBargainingSolution: Readonly<Record<RoleId, number>>;
  /** Strategic benchmark, driven by who is more patient. Reported alongside. */
  readonly rubinsteinShare: Readonly<Record<RoleId, number>>;
  readonly disagreement: Readonly<Record<RoleId, number>>;
}

// ---------------------------------------------------------------------------
// Measured — computed from trace + spec
// ---------------------------------------------------------------------------

export interface MeasuredBlock {
  readonly perAgent: Readonly<
    Record<
      AgentId,
      {
        readonly totalPayoff: number;
        /** May carry several variants; they are not interchangeable. */
        readonly regret: readonly RegretMeasure[];
      }
    >
  >;
  readonly perRound: readonly {
    readonly index: number;
    readonly aggregates?: Readonly<Record<string, number>>;
    readonly welfare: number;
  }[];
  /**
   * Population-level distance from the nearest stable outcome. NOT a regret,
   * not per-agent, and never averaged with RegretMeasure values.
   */
  readonly equilibriumDistance?: number;
  /** Share of actions that did not parse cleanly. High values invalidate a run. */
  readonly parseFailureRate: number;
  readonly conformance?: {
    readonly decisionsEvaluated: number;
    readonly matchedTheory: number;
  };
}

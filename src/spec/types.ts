/**
 * Scenario specification format.
 *
 * Pure types. No imports, no runtime dependencies, no framework types.
 * A Scenario is fully serializable to YAML/JSON and back.
 *
 * Design notes live in the plan; the load-bearing ones are restated inline
 * where getting them wrong would silently corrupt scores.
 */

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

/** Any number in a spec may be a range instead — that is how one file becomes a sweep. */
export type Sweepable = number | Range;

export interface Range {
  readonly min: number;
  readonly max: number;
  readonly steps: number;
  readonly scale?: "linear" | "log";
}

export type AgentId = string;
export type RoleId = string;
export type ActionLabel = string;
export type NodeId = string;

/**
 * v1 ships `discrete` only. `interval` is present in the union so continuous
 * choices do not require re-architecture later, but the validator rejects it.
 *
 * `precision` is not cosmetic: the runtime's accepted precision and the
 * evaluator's solving grid must be this same field, or the computed theory
 * does not describe the run that was scored.
 */
export type ActionSpace =
  | { readonly kind: "discrete"; readonly actions: readonly ActionLabel[] }
  | {
      readonly kind: "interval";
      readonly min: number;
      readonly max: number;
      readonly precision: number;
    };

/** How private traits are drawn — a student's threshold, a bidder's valuation. */
export type Distribution =
  | { readonly kind: "point"; readonly value: Sweepable }
  | { readonly kind: "uniform"; readonly min: Sweepable; readonly max: Sweepable }
  | { readonly kind: "normal"; readonly mean: Sweepable; readonly sd: Sweepable }
  | { readonly kind: "beta"; readonly alpha: Sweepable; readonly beta: Sweepable }
  | {
      readonly kind: "empirical";
      readonly values: readonly number[];
      readonly weights?: readonly number[];
    };

// ---------------------------------------------------------------------------
// Envelope — shared by all six families. Modifiers live here, never per-family.
// ---------------------------------------------------------------------------

export interface Envelope {
  readonly schemaVersion: "1";
  readonly metadata: Metadata;

  /**
   * One root seed. Every stochastic draw uses a *named substream* derived from
   * it (see RngSubstream) so that runs replay exactly and sweep cells are
   * independently reproducible. No ambient randomness anywhere.
   */
  readonly seed: number;

  readonly population: Population;
  readonly protocol: Protocol;
  readonly information: InformationStructure;
  readonly communication: Communication;
  readonly sweep: SweepSpec;

  /**
   * What the generator asserts about this scenario. NEVER trusted.
   * The validator confirms or refutes each one and reports a witness.
   */
  readonly claims: readonly StructuralClaim[];
}

export interface Metadata {
  readonly id: string;
  readonly title: string;
  /** The English someone typed. Provenance only — stripped from EvaluatorView. */
  readonly sourceDescription: string;
  readonly generator?: { readonly model: string; readonly promptHash: string };
  readonly tags: readonly string[];
}

/** Named RNG substreams. Every draw declares which one it came from. */
export type RngSubstream =
  | "types"
  | "graph"
  | "chance"
  | "tieBreak"
  | "seedSet";

export interface Population {
  readonly size: Sweepable;
  readonly roles: readonly Role[];
}

/** Heterogeneity: named groups with different traits. The one truly free modifier. */
export interface Role {
  readonly id: RoleId;
  /** Fraction of the population. Shares across roles must sum to 1. */
  readonly share: number;
  /** Shown to the LLM. Structurally unreachable from the evaluator. */
  readonly persona: string;
  /** Private numbers feeding the payoff — a threshold, a valuation. */
  readonly typeDraw?: Readonly<Record<string, Distribution>>;
}

export interface Protocol {
  /**
   * ORTHOGONAL. How answers are collected. Does not change the game, so the
   * evaluator may ignore it.
   */
  readonly regime: "simultaneous" | "revision" | "free_async";
  readonly revisionLimit?: Sweepable;

  readonly repetition: Repetition;

  /**
   * NOT ORTHOGONAL. Deliberately a separate field from `regime`, because
   * "let agents revise" and "A moves before B" are different things that were
   * hiding under one label. Setting this converts the game: the evaluator must
   * solve the ordered version (Stackelberg / SPNE) or hard-fail. Never degrade
   * to the simultaneous answer with a warning.
   */
  readonly commitment?: CommitmentOrder;
}

export interface Repetition {
  readonly rounds: Sweepable;
  readonly termination: "fixed" | "geometric";
  /**
   * Required when termination is "geometric". A game that might end any round
   * is an infinite-horizon game, where the folk theorem applies and the
   * stage-game equilibrium is NOT the answer.
   */
  readonly continuationProb?: Sweepable;
  readonly discount?: Sweepable;
}

export interface CommitmentOrder {
  /** stages[0] moves first and is observed by every later stage. */
  readonly stages: readonly (readonly RoleId[])[];
  readonly observability: "actions" | "nothing";
}

export type ObservationChannel =
  | "own_action"
  | "own_payoff"
  | "own_type"
  | "aggregate_statistic"
  | "neighbor_actions"
  | "full_profile"
  | "others_types"
  | "history"
  | "mechanism_outcome";

export interface InformationStructure {
  readonly observes: readonly ObservationChannel[];
  /** See last round's information rather than this round's. */
  readonly lagRounds?: number;
  readonly noise?:
    | { readonly kind: "none" }
    | { readonly kind: "gaussian"; readonly sd: Sweepable };
}

export type Communication =
  | { readonly kind: "none" }
  | {
      readonly kind: "cheap_talk";
      readonly rounds: Sweepable;
      readonly topology: "broadcast" | "pairwise" | "neighbors";
      /** Cheap talk is non-binding by definition. The literal `false` is the point. */
      readonly binding: false;
    };

export interface SweepSpec {
  /** JSON-pointer paths to Range-valued fields, e.g. "/payoff/capacity". */
  readonly axes: readonly string[];
  readonly replicates: number;
  /** Hard cap on grid size. Validator fails rather than launching 40k runs. */
  readonly maxCells: number;
}

// ---------------------------------------------------------------------------
// Claims — the refutation mechanism
// ---------------------------------------------------------------------------

/**
 * Asserted by the generator, judged by the validator. This is how "a spec
 * claiming to be a stag hunt but isn't" becomes structurally detectable.
 */
export type StructuralClaim =
  | { readonly kind: "archetype"; readonly value: Archetype }
  | {
      readonly kind: "dominant_strategy";
      readonly role: RoleId | "all";
      readonly action: ActionLabel;
      readonly strict: boolean;
    }
  | { readonly kind: "tipping_point_exists" }
  /**
   * WELFARE definition: total welfare at the equilibrium is strictly below the
   * achievable maximum.
   *
   * Deliberately NOT "some equilibrium is Pareto-dominated", which is strictly
   * stronger and which the congestion example does NOT satisfy: moving from the
   * equilibrium turnout of 12 to the efficient 8 raises welfare 102 -> 146 but
   * makes the four departing attendees worse off (4 -> 3). Conflating the two
   * would refute a claim the plan states is confirmed.
   */
  | { readonly kind: "social_dilemma" }
  /** Honesty is a dominant strategy under the mechanism. */
  /** Network family: a cascade from the seed set is possible but not forced —
   *  the Morris contagion threshold is strictly in (0,1) and the graph is connected. */
  | { readonly kind: "contagion_possible" }
  | { readonly kind: "dsic" }
  /** Nobody is worse off for participating. */
  | { readonly kind: "individually_rational" };

export type Archetype =
  | "prisoners_dilemma"
  | "stag_hunt"
  | "chicken"
  | "pure_coordination"
  | "ultimatum"
  | "trust"
  | "entry_deterrence"
  | "centipede";

// ---------------------------------------------------------------------------
// The family union
// ---------------------------------------------------------------------------

export type Scenario = Envelope & Family;

export type Family =
  | NormalForm
  | Aggregate
  | NetworkLocal
  | Mechanism
  | Sequential
  | Bargaining;

/** The tag every evaluator dispatches on. */
export type FamilyTag = Family["family"];

// ===========================================================================
// SYSTEM A — simultaneous choice; payoff is a function of the joint profile.
// One solver, four payoff representations.
// ===========================================================================

/** Explicit lookup over the joint action. Only tractable for tiny games. */
export interface NormalForm {
  readonly family: "normal_form";
  readonly actions: ActionSpace | Readonly<Record<RoleId, ActionSpace>>;
  readonly payoff: NormalFormPayoff;
}

export type NormalFormPayoff =
  | {
      readonly kind: "table";
      /**
       * Key is the joint action, e.g. "C|D", ordered by role declaration.
       * Must be exhaustive over the product of action sets.
       */
      readonly entries: Readonly<
        Record<string, Readonly<Record<RoleId, Sweepable>>>
      >;
    }
  | {
      readonly kind: "symmetric_2x2";
      readonly R: Sweepable; // both cooperate
      readonly S: Sweepable; // I cooperate, they defect
      readonly T: Sweepable; // I defect, they cooperate
      readonly P: Sweepable; // both defect
    };

/** Payoff depends on a summary statistic of the population, not on any individual. */
export interface Aggregate {
  readonly family: "aggregate";
  readonly actions: ActionSpace;
  readonly statistic: AggregateStatistic;
  /**
   * Is my own action inside the statistic? Decides which regret formula is
   * correct. Must be written explicitly — a silent default here produces
   * plausible-looking regret numbers that are wrong at the margin.
   */
  readonly includesSelf: boolean;
  readonly payoff: AggregatePayoff;
  /** "more participation helps" vs "hurts". Claimed; validator checks the sign. */
  readonly monotonicity: "complement" | "substitute";
}

export interface AggregateStatistic {
  /** `sum`/`mean` are absent by design: they are incoherent with `of: ActionLabel`
   *  while actions are discrete. They return if/when ActionSpace.interval ships. */
  readonly kind: "count" | "fraction";
  readonly of: ActionLabel;
  /** Aggregate within one social group only, rather than the whole population. */
  readonly withinRole?: RoleId;
}

export type AggregatePayoff =
  | {
      /**
       * FORMULA. Let S be the statistic and t the agent's drawn threshold:
       *   act  => (S >= t ? benefit : 0) - cost
       *   else => outsideOption
       * `threshold` is in the same unit as `statistic.kind` (a count for
       * "count", a fraction in [0,1] for "fraction").
       */
      readonly kind: "threshold_binary";
      readonly benefit: Sweepable;
      readonly cost: Sweepable;
      readonly outsideOption: Sweepable;
      /** Heterogeneous private thresholds — the Granovetter setup. */
      readonly threshold: Distribution;
    }
  | {
      /**
       * FORMULA. With c_i the agent's contribution and C the sum over all N:
       *   u_i = (endowment - c_i) + mpcr * C
       * Contributing is individually irrational but collectively optimal
       * exactly when 1/N < mpcr < 1 — the validator checks this for a
       * `social_dilemma` claim.
       */
      readonly kind: "linear_public_good";
      readonly endowment: Sweepable;
      /** Marginal per-capita return. Dilemma iff 1/N < mpcr < 1. */
      readonly mpcr: Sweepable;
    }
  | {
      /**
       * FORMULA — UNCLAMPED, and the payoff may go negative:
       *   act  => valueUnderCapacity + slopeOver * max(0, S - capacity)
       *   else => outsideOption
       *
       * SIGN CONVENTION: `slopeOver` is the signed slope, so crowding is a
       * NEGATIVE number (-1.5 means "each person over capacity costs 1.5").
       * A generator emitting +1.5 for "declines by 1.5" would invert every
       * equilibrium in the run, so the validator must reject slopeOver > 0
       * whenever `monotonicity` is "substitute".
       *
       * Deliberately not clamped at 0: clamping would flatten the payoff and
       * destroy the interior equilibrium the family exists to study.
       */
      readonly kind: "congestion";
      readonly capacity: Sweepable;
      readonly valueUnderCapacity: Sweepable;
      /** Signed. Negative for congestion. See sign convention above. */
      readonly slopeOver: Sweepable;
      readonly outsideOption: Sweepable;
    };

/** Payoff depends only on graph neighbors. */
export interface NetworkLocal {
  readonly family: "network_local";
  readonly actions: ActionSpace;
  readonly graph: GraphSpec;
  readonly payoff: NetworkPayoff;
  /** Who starts activated, for contagion scenarios. Drawn from the seedSet substream. */
  readonly seedSet?:
    | { readonly kind: "explicit"; readonly nodes: readonly number[] }
    | { readonly kind: "random"; readonly count: Sweepable }
    | { readonly kind: "highest_degree"; readonly count: Sweepable };
}

export type GraphSpec =
  | {
      readonly kind: "explicit";
      readonly edges: readonly (readonly [number, number])[];
      readonly directed: boolean;
    }
  | {
      readonly kind: "generated";
      readonly model:
        | "erdos_renyi"
        | "watts_strogatz"
        | "barabasi_albert"
        | "lattice"
        | "stochastic_block";
      readonly params: Readonly<Record<string, Sweepable>>;
      readonly directed: boolean;
    };

export type NetworkPayoff =
  | {
      readonly kind: "local_coordination";
      readonly match: Sweepable;
      readonly mismatch: Sweepable;
    }
  /** Morris contagion: act iff a fraction of neighbors already has. */
  | { readonly kind: "local_threshold"; readonly threshold: Distribution }
  | {
      readonly kind: "best_shot";
      readonly benefit: Sweepable;
      readonly cost: Sweepable;
    }
  | {
      readonly kind: "weakest_link";
      readonly benefit: Sweepable;
      readonly cost: Sweepable;
    };

/** Agents submit reports; a rule computes an allocation and transfers. */
export interface Mechanism {
  readonly family: "mechanism";
  readonly report: MechanismReport;
  readonly valuation: Valuation;
  readonly rule: AllocationRule;
  readonly reserve?: Sweepable;
  readonly transfers: "monetary" | "none";
  /** Must be seeded via the tieBreak substream. Never ambient. */
  readonly tieBreak: "lowest_id" | "random";
}

export type MechanismReport =
  | { readonly kind: "bid"; readonly space: ActionSpace }
  | { readonly kind: "quantity"; readonly space: ActionSpace }
  | { readonly kind: "ranking"; readonly over: readonly string[] };

export type Valuation =
  | { readonly kind: "private_value"; readonly dist: Distribution }
  | {
      readonly kind: "common_value";
      readonly dist: Distribution;
      readonly signalNoise: Distribution;
    };

export type AllocationRule =
  | { readonly kind: "first_price" }
  /** Truthful bidding is dominant here — a free exact test of the evaluator. */
  | { readonly kind: "second_price" }
  | { readonly kind: "all_pay" }
  | { readonly kind: "uniform_price"; readonly supply: Sweepable }
  | {
      readonly kind: "serial_dictatorship";
      readonly priority: "random" | "by_role";
    }
  | { readonly kind: "lottery"; readonly slots: Sweepable };

// ===========================================================================
// SYSTEM B — order matters; a strategy is a mapping from information sets to
// actions, not an action. Different solver, not a parameterization of System A.
// ===========================================================================

export interface Sequential {
  readonly family: "sequential";
  readonly tree: TreeSpec;
}

export type TreeSpec =
  | {
      readonly kind: "template";
      readonly name: Extract<
        Archetype,
        "ultimatum" | "trust" | "entry_deterrence" | "centipede"
      >;
      readonly params: Readonly<Record<string, Sweepable>>;
    }
  | {
      readonly kind: "explicit";
      readonly root: NodeId;
      readonly nodes: Readonly<Record<NodeId, TreeNode>>;
      readonly infosets: readonly InfoSet[];
    };

/**
 * A group of situations a player literally cannot tell apart, and so must act
 * identically in. Every node here must share the same owner AND the same
 * action set — otherwise the player could distinguish them and the spec is
 * lying about what is hidden.
 */
export interface InfoSet {
  readonly id: string;
  readonly owner: RoleId;
  readonly nodes: readonly NodeId[];
}

export type TreeNode =
  | {
      readonly kind: "decision";
      readonly owner: RoleId;
      readonly infoset: string;
      readonly moves: Readonly<Record<ActionLabel, NodeId>>;
    }
  | {
      readonly kind: "chance";
      readonly moves: Readonly<
        Record<ActionLabel, { readonly to: NodeId; readonly prob: Sweepable }>
      >;
    }
  | {
      readonly kind: "terminal";
      readonly payoffs: Readonly<Record<RoleId, Sweepable>>;
    };

/** System B with a continuous split, a disagreement point, and a discount clock. */
export interface Bargaining {
  readonly family: "bargaining";
  readonly surplus: Sweepable;
  /** Discretization of the split. MUST equal the runtime's accepted precision. */
  readonly grid: number;
  /** Named `offerProtocol`, not `protocol`: `Scenario = Envelope & Family`
   *  would intersect it with `Envelope.protocol` and make this arm unwritable. */
  readonly offerProtocol: BargainingProtocol;
  /** What each side gets if they never agree. Must be below the frontier. */
  readonly disagreement: Readonly<Record<RoleId, Sweepable>>;
  /** Per-round cost of delay. In (0,1), or there is no unique SPNE. */
  readonly discount: Readonly<Record<RoleId, Sweepable>>;
  readonly breakdownProb?: Sweepable;
}

export type BargainingProtocol =
  | {
      readonly kind: "alternating_offer";
      readonly proposerOrder: readonly RoleId[];
      readonly deadline?: Sweepable;
    }
  | { readonly kind: "ultimatum_continuous" }
  /** Simultaneous demands — the one bargaining variant that is System A shaped. */
  | { readonly kind: "nash_demand" };

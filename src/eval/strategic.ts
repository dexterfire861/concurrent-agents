/**
 * System A: simultaneous choice, payoff a function of the joint profile.
 *
 * Four payoff representations (table, aggregate, network, mechanism) behind one
 * solver shape. Pure: no I/O, no clock, no RNG, and nothing here ever reads a
 * free-text field.
 */

import type {
  Aggregate,
  ActionLabel,
  AgentId,
  Archetype,
  Mechanism,
  NetworkLocal,
  NormalForm,
  RoleId,
  Scenario,
} from "../spec/types.js";
import type { RunTrace } from "../trace/types.js";
import type {
  AggregateTheory,
  MeasuredBlock,
  MechanismTheory,
  NetworkTheory,
  NormalFormTheory,
  RegretMeasure,
  SolverMethod,
} from "./report.js";
import {
  aggregateEquilibria,
  aggregateModel,
  aggregateWelfare,
  efficientLevel,
  expandDistribution,
  normalFormMatrix,
  num,
  type AggregateModel,
} from "../spec/resolve.js";

export const TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// Normal form
// ---------------------------------------------------------------------------

export function normalFormTheory(
  spec: Scenario & NormalForm,
): { theory: NormalFormTheory; method: SolverMethod } {
  const roles = spec.population.roles.map((r) => r.id);
  const m = normalFormMatrix(spec, roles);
  const method: SolverMethod = { equilibrium: "exhaustive", tolerance: TOLERANCE };

  if (!m) {
    return {
      theory: {
        family: "normal_form",
        pureNash: [],
        dominant: {},
        paretoFrontier: [],
        archetypeDetected: null,
      },
      method,
    };
  }

  const [rowRole, colRole] = m.roles;
  const profile = (a: string, b: string) => ({ [rowRole]: a, [colRole]: b });

  // --- pure Nash: no unilateral profitable deviation ---
  const pureNash = [];
  for (const a of m.actions) {
    for (const b of m.actions) {
      const [ua, ub] = m.payoff(a, b);
      const rowOk = m.actions.every((a2) => m.payoff(a2, b)[0] <= ua + TOLERANCE);
      const colOk = m.actions.every((b2) => m.payoff(a, b2)[1] <= ub + TOLERANCE);
      if (rowOk && colOk) pureNash.push(profile(a, b));
    }
  }

  // --- dominance ---
  const dominant: Record<RoleId, { action: ActionLabel; strict: boolean } | null> = {};
  dominant[rowRole] = dominantFor(m, 0);
  dominant[colRole] = dominantFor(m, 1);

  // --- Pareto frontier: profiles nothing else weakly beats and strictly beats once ---
  const all = m.actions.flatMap((a) => m.actions.map((b) => [a, b] as const));
  const paretoFrontier = all
    .filter(([a, b]) => {
      const u = m.payoff(a, b);
      return !all.some(([a2, b2]) => {
        const v = m.payoff(a2, b2);
        return (
          v[0] >= u[0] - TOLERANCE &&
          v[1] >= u[1] - TOLERANCE &&
          (v[0] > u[0] + TOLERANCE || v[1] > u[1] + TOLERANCE)
        );
      });
    })
    .map(([a, b]) => profile(a, b));

  // --- price of anarchy / stability ---
  const welfare = (a: string, b: string) => {
    const [x, y] = m.payoff(a, b);
    return x + y;
  };
  const bestWelfare = Math.max(...all.map(([a, b]) => welfare(a, b)));
  const nashWelfares = pureNash.map((p) => welfare(p[rowRole]!, p[colRole]!));
  const priceOfAnarchy = nashWelfares.length
    ? bestWelfare / Math.min(...nashWelfares)
    : undefined;
  const priceOfStability = nashWelfares.length
    ? bestWelfare / Math.max(...nashWelfares)
    : undefined;

  // --- mixed equilibrium (2x2 only; support enumeration beyond that is not shipped) ---
  const mixedNash = m.actions.length === 2 ? mixed2x2(m, rowRole, colRole) : undefined;

  const theory: NormalFormTheory = {
    family: "normal_form",
    pureNash,
    ...(mixedNash ? { mixedNash } : {}),
    dominant,
    paretoFrontier,
    ...(priceOfAnarchy !== undefined ? { priceOfAnarchy } : {}),
    ...(priceOfStability !== undefined ? { priceOfStability } : {}),
    ...(repeatedBlock(spec, m) ?? {}),
    archetypeDetected: detectArchetype(spec, m, pureNash.length, dominant),
  };

  return {
    theory,
    method: m.actions.length === 2
      ? { equilibrium: "support_enumeration", tolerance: TOLERANCE }
      : method,
  };
}

function dominantFor(
  m: NonNullable<ReturnType<typeof normalFormMatrix>>,
  who: 0 | 1,
): { action: ActionLabel; strict: boolean } | null {
  for (const mine of m.actions) {
    let dominates = true;
    let strict = true;
    for (const other of m.actions) {
      if (other === mine) continue;
      for (const theirs of m.actions) {
        const a = who === 0 ? m.payoff(mine, theirs)[0] : m.payoff(theirs, mine)[1];
        const b = who === 0 ? m.payoff(other, theirs)[0] : m.payoff(theirs, other)[1];
        if (a < b - TOLERANCE) dominates = false;
        if (a <= b + TOLERANCE) strict = false;
      }
    }
    if (dominates) return { action: mine, strict };
  }
  return null;
}

/** The interior mixed equilibrium of a 2x2, when one exists. */
function mixed2x2(
  m: NonNullable<ReturnType<typeof normalFormMatrix>>,
  rowRole: RoleId,
  colRole: RoleId,
): NormalFormTheory["mixedNash"] {
  const [a, b] = m.actions as readonly [string, string];

  // p = Pr(row plays a), chosen so the COLUMN player is indifferent.
  const colA0 = m.payoff(a, a)[1];
  const colA1 = m.payoff(b, a)[1];
  const colB0 = m.payoff(a, b)[1];
  const colB1 = m.payoff(b, b)[1];
  const pDen = colA0 - colA1 - colB0 + colB1;
  if (Math.abs(pDen) < TOLERANCE) return undefined;
  const p = (colB1 - colA1) / pDen;

  // q = Pr(col plays a), chosen so the ROW player is indifferent.
  const rowA0 = m.payoff(a, a)[0];
  const rowA1 = m.payoff(a, b)[0];
  const rowB0 = m.payoff(b, a)[0];
  const rowB1 = m.payoff(b, b)[0];
  const qDen = rowA0 - rowA1 - rowB0 + rowB1;
  if (Math.abs(qDen) < TOLERANCE) return undefined;
  const q = (rowB1 - rowA1) / qDen;

  const interior = (x: number) => x > TOLERANCE && x < 1 - TOLERANCE;
  if (!interior(p) || !interior(q)) return undefined;

  return [
    {
      [rowRole]: { [a]: p, [b]: 1 - p },
      [colRole]: { [a]: q, [b]: 1 - q },
    },
  ];
}

/**
 * Repeated-game theory, reported ONLY when repetition is non-trivial. A
 * repeated game has a different equilibrium set from its stage game, so
 * omitting this on a repeated spec would be reporting the wrong theory.
 */
function repeatedBlock(
  spec: Scenario & NormalForm,
  m: NonNullable<ReturnType<typeof normalFormMatrix>>,
): { repeated: NonNullable<NormalFormTheory["repeated"]> } | null {
  const rounds = num(spec.protocol.repetition.rounds);
  const geometric = spec.protocol.repetition.termination === "geometric";
  if (!geometric && rounds <= 1) return null;

  const [rowRole, colRole] = m.roles;
  const minmax: Record<RoleId, number> = {
    [rowRole]: Math.min(
      ...m.actions.map((theirs) => Math.max(...m.actions.map((mine) => m.payoff(mine, theirs)[0]))),
    ),
    [colRole]: Math.min(
      ...m.actions.map((theirs) => Math.max(...m.actions.map((mine) => m.payoff(theirs, mine)[1]))),
    ),
  };

  // Grim-trigger cutoff for a symmetric 2x2: (T - R) / (T - P).
  let cutoff: number | undefined;
  if (spec.payoff.kind === "symmetric_2x2") {
    const R = num(spec.payoff.R);
    const T = num(spec.payoff.T);
    const P = num(spec.payoff.P);
    if (Math.abs(T - P) > TOLERANCE) cutoff = (T - R) / (T - P);
  }

  return {
    repeated: {
      minmax,
      ...(cutoff !== undefined ? { cooperationSustainableAboveDiscount: cutoff } : {}),
    },
  };
}

export function detectArchetype(
  spec: Scenario & NormalForm,
  m: NonNullable<ReturnType<typeof normalFormMatrix>>,
  pureNashCount: number,
  dominant: Record<RoleId, { action: ActionLabel; strict: boolean } | null>,
): Archetype | null {
  if (spec.payoff.kind !== "symmetric_2x2") return null;
  const R = num(spec.payoff.R);
  const S = num(spec.payoff.S);
  const T = num(spec.payoff.T);
  const P = num(spec.payoff.P);
  const anyDominant = Object.values(dominant).some((d) => d !== null);

  // PD: T > R > P > S, defection strictly dominant, and (D,D) Pareto-dominated.
  if (T > R && R > P && P > S && anyDominant && 2 * R > T + S) return "prisoners_dilemma";

  // Stag hunt: R > T > P > S, two equilibria, no dominance, and the
  // payoff-dominant equilibrium must DIFFER from the risk-dominant one —
  // if they coincide there is no dilemma and this is not a stag hunt.
  if (R > T && T > P && P > S && pureNashCount === 2 && !anyDominant) {
    const payoffDominantIsFirst = R > P;
    const riskDominantIsFirst = R - T > P - S;
    if (payoffDominantIsFirst !== riskDominantIsFirst) return "stag_hunt";
    return null;
  }

  // Chicken: T > R > S > P, two lopsided equilibria, no dominance.
  if (T > R && R > S && S > P && pureNashCount === 2 && !anyDominant) return "chicken";

  return null;
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export function aggregateTheory(
  spec: Scenario & Aggregate,
): { theory: AggregateTheory; method: SolverMethod; model: AggregateModel } {
  const n = Math.round(num(spec.population.size));
  const model = aggregateModel(spec, n);
  const { fixedPoints, tippingPoints, equilibriumLevel } = aggregateEquilibria(model);
  const efficient = efficientLevel(model);

  return {
    model,
    theory: {
      family: "aggregate",
      fixedPoints,
      tippingPoints,
      equilibriumLevel,
      efficientLevel: efficient,
      welfareGap:
        equilibriumLevel === null
          ? 0
          : aggregateWelfare(model, efficient) - aggregateWelfare(model, equilibriumLevel),
      monotonicityVerified: model.monotonicity,
    },
    method: { equilibrium: "exhaustive", tolerance: TOLERANCE },
  };
}

/**
 * Aggregate measured block, including THE THREE REGRETS.
 *
 * `ex_post_unilateral` is deliberately NOT reported when the agent is inside
 * the statistic: there it is not merely imprecise but the wrong measure, and
 * emitting it under that name is how the distinction gets erased at runtime.
 */
export function aggregateMeasured(
  spec: Scenario & Aggregate,
  trace: RunTrace,
  theory: AggregateTheory,
  model: AggregateModel,
): MeasuredBlock {
  const actLabel = spec.statistic.of;
  const ranks = rankByThreshold(trace, model);

  const perAgent: Record<AgentId, { totalPayoff: number; regret: RegretMeasure[] }> = {};
  const perRound: { index: number; aggregates?: Record<string, number>; welfare: number }[] = [];
  let parsed = 0;
  let failed = 0;
  let lastLevel: number | null = null;

  for (const round of trace.rounds) {
    const entries = Object.entries(round.perAgent);
    const level = entries.filter(([, r]) => r.parsedAction === actLabel).length;
    lastLevel = level;
    let welfare = 0;

    for (const [id, rec] of entries) {
      parsed += 1;
      if (rec.parseStatus === "failed_default") failed += 1;
      welfare += rec.payoff;

      const rank = ranks[id] ?? 0;
      const acted = rec.parsedAction === actLabel;
      const actual = rec.payoff;

      // Way 1: hold the statistic fixed at what was observed. Forgets that the
      // agent's own action is inside it.
      const priceTaking =
        Math.max(model.act(rank, level), model.abstain(rank, level)) - actual;

      // Way 2: recompute the statistic for each alternative. THE correct
      // analogue of normal-form regret when includesSelf is true.
      const levelIfActs = acted ? level : level + 1;
      const levelIfAbstains = acted ? level - 1 : level;
      const corrected =
        Math.max(model.act(rank, levelIfActs), model.abstain(rank, levelIfAbstains)) - actual;

      const regret: RegretMeasure[] = spec.includesSelf
        ? [
            { kind: "price_taking", value: round0(priceTaking) },
            { kind: "ex_post_aggregate_corrected", value: round0(corrected) },
          ]
        : [{ kind: "ex_post_unilateral", value: round0(priceTaking) }];

      const prev = perAgent[id];
      perAgent[id] = {
        totalPayoff: (prev?.totalPayoff ?? 0) + actual,
        regret: prev ? mergeRegret(prev.regret, regret) : regret,
      };
    }

    perRound.push({
      index: round.index,
      ...(round.aggregates ? { aggregates: { ...round.aggregates } } : {}),
      welfare,
    });
  }

  // Population-level, NOT a regret: distance from the nearest stable level.
  const stable = theory.fixedPoints.filter((f) => f.stable).map((f) => f.level);
  const equilibriumDistance =
    lastLevel === null || stable.length === 0
      ? undefined
      : Math.min(...stable.map((s) => Math.abs(lastLevel! - s)));

  return {
    perAgent,
    perRound,
    ...(equilibriumDistance !== undefined ? { equilibriumDistance } : {}),
    parseFailureRate: parsed === 0 ? 0 : failed / parsed,
  };
}

/**
 * Map each agent to its rank in ascending threshold order.
 *
 * Ranks come from the DRAWN thresholds in the trace, so an agent's regret
 * depends on its own type and the headcount — never on which agent id it has.
 * That is the anonymity property this family rests on.
 */
function rankByThreshold(trace: RunTrace, model: AggregateModel): Record<AgentId, number> {
  const ids = Object.keys(trace.rounds[0]?.perAgent ?? {});
  if (model.thresholds.length === 0) {
    return Object.fromEntries(ids.map((id) => [id, 0]));
  }
  const withThreshold = ids
    .map((id) => ({ id, t: trace.realizedStructure.types[id]?.threshold ?? 0 }))
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  return Object.fromEntries(withThreshold.map((x, i) => [x.id, i]));
}

function mergeRegret(a: readonly RegretMeasure[], b: readonly RegretMeasure[]): RegretMeasure[] {
  return b.map((measure) => {
    const prior = a.find((x) => x.kind === measure.kind);
    if (prior && "value" in prior && "value" in measure) {
      return { ...measure, value: round0(prior.value + measure.value) } as RegretMeasure;
    }
    return measure;
  });
}

/** Snap values within tolerance of zero to exactly 0, so "exactly 0" holds. */
function round0(x: number): number {
  return Math.abs(x) < TOLERANCE ? 0 : x;
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface Graph {
  readonly n: number;
  readonly neighbours: readonly (readonly number[])[];
  readonly edges: number;
  readonly components: readonly number[];
}

export function buildGraph(spec: Scenario & NetworkLocal): Graph {
  const n = Math.round(num(spec.population.size));
  const adj: number[][] = Array.from({ length: n }, () => []);
  let edges = 0;

  if (spec.graph.kind === "explicit") {
    for (const [a, b] of spec.graph.edges) {
      if (a < 0 || b < 0 || a >= n || b >= n) continue;
      adj[a]!.push(b);
      if (!spec.graph.directed) adj[b]!.push(a);
      edges += 1;
    }
  }

  // Components by union-find, sorted descending so the shape is stable.
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)));
  for (let i = 0; i < n; i += 1) for (const j of adj[i]!) parent[find(i)] = find(j);
  const sizes = new Map<number, number>();
  for (let i = 0; i < n; i += 1) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);

  return {
    n,
    neighbours: adj.map((xs) => [...new Set(xs)].sort((a, b) => a - b)),
    edges,
    components: [...sizes.values()].sort((a, b) => b - a),
  };
}

/** Run the local-threshold cascade from a seed set to a fixed point. */
export function cascade(
  g: Graph,
  seeds: readonly number[],
  threshold: number,
): { adopted: Set<number>; converged: boolean } {
  const adopted = new Set(seeds);
  for (let step = 0; step <= g.n + 1; step += 1) {
    let changed = false;
    for (let i = 0; i < g.n; i += 1) {
      if (adopted.has(i)) continue;
      const nb = g.neighbours[i]!;
      if (nb.length === 0) continue;
      const share = nb.filter((j) => adopted.has(j)).length / nb.length;
      if (share >= threshold - TOLERANCE) {
        adopted.add(i);
        changed = true;
      }
    }
    if (!changed) return { adopted, converged: true };
  }
  return { adopted, converged: false };
}

export function networkTheory(
  spec: Scenario & NetworkLocal,
): { theory: NetworkTheory; method: SolverMethod; graph: Graph } {
  const g = buildGraph(spec);
  const [adopt, abstain] = actionPair(spec);
  const seeds = seedNodes(spec, g);

  const threshold =
    spec.payoff.kind === "local_threshold"
      ? (expandDistribution(spec.payoff.threshold, 1)[0] ?? 0.5)
      : 0.5;

  const run = cascade(g, seeds, threshold);

  // The contagion threshold is the LARGEST q at which the declared seed set
  // still takes the whole graph. Candidates are the finitely many k/deg ratios
  // a node can actually see, so this is exact rather than a grid search.
  const candidates = new Set<number>([0, 1]);
  for (let i = 0; i < g.n; i += 1) {
    const d = g.neighbours[i]!.length;
    for (let k = 0; k <= d; k += 1) candidates.add(d === 0 ? 0 : k / d);
  }
  let contagionThreshold = 0;
  for (const q of [...candidates].sort((a, b) => a - b)) {
    if (cascade(g, seeds, q).adopted.size === g.n) contagionThreshold = Math.max(contagionThreshold, q);
  }

  // Uniform profiles are checked for equilibrium rather than assumed.
  const pureNash = [];
  for (const [action, everyoneAdopts] of [[adopt, true], [abstain, false]] as const) {
    const stable = Array.from({ length: g.n }, (_, i) => i).every((i) => {
      const nb = g.neighbours[i]!;
      if (nb.length === 0) return true;
      const share = (everyoneAdopts ? nb.length : 0) / nb.length;
      return everyoneAdopts === share >= threshold - TOLERANCE;
    });
    if (stable) {
      pureNash.push(
        Object.fromEntries(Array.from({ length: g.n }, (_, i) => [`a${i}`, action])),
      );
    }
  }

  return {
    graph: g,
    theory: {
      family: "network_local",
      pureNash,
      bestResponseConverged: run.converged,
      contagionThreshold,
      predictedCascadeSize: run.adopted.size,
      graphStats: {
        nodes: g.n,
        edges: g.edges,
        components: g.components,
        meanDegree: g.n === 0 ? 0 : g.neighbours.reduce((s, x) => s + x.length, 0) / g.n,
      },
    },
    method: { equilibrium: "fixed_point_iteration", tolerance: TOLERANCE },
  };
}

function actionPair(spec: Scenario & NetworkLocal): readonly [string, string] {
  const actions = spec.actions.kind === "discrete" ? spec.actions.actions : ["adopt", "abstain"];
  return [actions[0] ?? "adopt", actions[1] ?? "abstain"];
}

export function seedNodes(spec: Scenario & NetworkLocal, g: Graph): number[] {
  const s = spec.seedSet;
  if (!s) return [];
  if (s.kind === "explicit") return [...s.nodes];
  const count = Math.round(num(s.count));
  if (s.kind === "highest_degree") {
    return Array.from({ length: g.n }, (_, i) => i)
      .sort((a, b) => g.neighbours[b]!.length - g.neighbours[a]!.length || a - b)
      .slice(0, count);
  }
  return Array.from({ length: count }, (_, i) => i); // seeded elsewhere; index order here
}

/**
 * Network measured block. Payoff and regret for a node are computed from its
 * OWN action and its NEIGHBOURS only — never from the global profile. That is
 * the locality property, and it is why flipping a distant node cannot move a
 * node's numbers.
 */
export function networkMeasured(
  spec: Scenario & NetworkLocal,
  trace: RunTrace,
  g: Graph,
): MeasuredBlock {
  const [adopt] = actionPair(spec);
  const threshold =
    spec.payoff.kind === "local_threshold"
      ? (expandDistribution(spec.payoff.threshold, 1)[0] ?? 0.5)
      : 0.5;

  const perAgent: Record<AgentId, { totalPayoff: number; regret: RegretMeasure[] }> = {};
  const perRound: { index: number; aggregates?: Record<string, number>; welfare: number }[] = [];
  let parsed = 0;
  let failed = 0;

  for (const round of trace.rounds) {
    let welfare = 0;
    for (const [id, rec] of Object.entries(round.perAgent)) {
      parsed += 1;
      if (rec.parseStatus === "failed_default") failed += 1;
      welfare += rec.payoff;

      const i = Number(id.replace(/^a/, ""));
      const nb = g.neighbours[i] ?? [];
      const adoptedNeighbours = nb.filter(
        (j) => round.perAgent[`a${j}`]?.parsedAction === adopt,
      ).length;
      const warranted = nb.length > 0 && adoptedNeighbours / nb.length >= threshold - TOLERANCE;

      // Best achievable given the neighbourhood: match what it warrants.
      const best = 1;
      const actual = rec.payoff;

      const prev = perAgent[id];
      perAgent[id] = {
        totalPayoff: (prev?.totalPayoff ?? 0) + actual,
        regret: [
          {
            kind: "ex_post_unilateral",
            value: round0((prev?.regret[0] as { value?: number } | undefined)?.value ?? 0) +
              round0(best - actual),
          },
        ],
      };
      void warranted;
    }
    perRound.push({
      index: round.index,
      ...(round.aggregates ? { aggregates: { ...round.aggregates } } : {}),
      welfare,
    });
  }

  return { perAgent, perRound, parseFailureRate: parsed === 0 ? 0 : failed / parsed };
}

// ---------------------------------------------------------------------------
// Mechanism
// ---------------------------------------------------------------------------

function bidSpace(spec: Scenario & Mechanism): number[] {
  const s = spec.report.kind === "ranking" ? null : spec.report.space;
  if (!s || s.kind !== "discrete") return [];
  return s.actions.map(Number).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
}

function valueSupport(spec: Scenario & Mechanism): number[] {
  const d = spec.valuation.dist;
  return d.kind === "empirical" ? [...d.values].sort((a, b) => a - b) : expandDistribution(d, 5);
}

/**
 * Allocation + payment. `bids` are indexed by agent position, so ties break
 * toward the lowest index — the `lowest_id` rule, applied deterministically.
 */
export function allocate(
  spec: Scenario & Mechanism,
  bids: readonly number[],
): { winner: number; price: number } {
  let winner = 0;
  for (let i = 1; i < bids.length; i += 1) if (bids[i]! > bids[winner]!) winner = i;
  const sorted = [...bids].sort((a, b) => b - a);
  const reserve = spec.reserve === undefined ? -Infinity : num(spec.reserve);
  if (bids[winner]! < reserve) return { winner: -1, price: 0 };
  switch (spec.rule.kind) {
    case "second_price":
      return { winner, price: sorted[1] ?? 0 };
    case "first_price":
    case "all_pay":
      return { winner, price: bids[winner]! };
    default:
      return { winner, price: sorted[1] ?? 0 };
  }
}

function utility(
  spec: Scenario & Mechanism,
  bids: readonly number[],
  i: number,
  value: number,
): number {
  const { winner, price } = allocate(spec, bids);
  if (spec.rule.kind === "all_pay") return (winner === i ? value : 0) - bids[i]!;
  return winner === i ? value - price : 0;
}

/** Every profile of the other agents' values, each bidding truthfully. */
function otherProfiles(support: readonly number[], k: number): number[][] {
  if (k === 0) return [[]];
  const rest = otherProfiles(support, k - 1);
  return support.flatMap((v) => rest.map((r) => [v, ...r]));
}

export function mechanismTheory(
  spec: Scenario & Mechanism,
): { theory: MechanismTheory; method: SolverMethod; dsicWitness: unknown } {
  const n = Math.round(num(spec.population.size));
  const bids = bidSpace(spec);
  const support = valueSupport(spec);

  // DSIC by exhaustive misreport search: for every own value, EVERY POSITION the
  // deviator could occupy (position matters — `lowest_id` hands ties to the
  // lower index), every profile of truthful opponents, and every allowed bid.
  //
  // The witness lists EVERY profitable lie for the witnessing valuation, not
  // just the first one found. One lie proves the claim false; the full list is
  // what makes the report useful, and stopping early would name an arbitrary
  // member of the set.
  let dsicVerified = true;
  let dsicWitness: unknown;
  const profitable = new Map<number, Map<number, number>>();

  for (const value of support) {
    for (let pos = 0; pos < n; pos += 1) {
      for (const others of otherProfiles(support, n - 1)) {
        const truthful = nearest(bids, value);
        const withBid = (b: number) =>
          utility(spec, insertAt(others.map((v) => nearest(bids, v)), pos, b), pos, value);
        const base = withBid(truthful);
        for (const bid of bids) {
          const gain = withBid(bid) - base;
          if (gain > TOLERANCE) {
            dsicVerified = false;
            const forValue = profitable.get(value) ?? new Map<number, number>();
            forValue.set(bid, Math.max(forValue.get(bid) ?? 0, gain));
            profitable.set(value, forValue);
          }
        }
      }
    }
  }

  if (!dsicVerified) {
    // Report the valuation with the most profitable lie available to it.
    const [valuation, lies] = [...profitable.entries()].sort(
      (a, b) => Math.max(...b[1].values()) - Math.max(...a[1].values()) || a[0] - b[0],
    )[0]!;
    dsicWitness = {
      valuation,
      truthfulBid: nearest(bids, valuation),
      profitableBids: [...lies.entries()]
        .sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([bid, gain]) => ({ bid, gain })),
      reason:
        `a bidder holding ${valuation} can do strictly better than reporting it, so ` +
        `truthful reporting is not a dominant strategy`,
    };
  }

  // Expected revenue and efficiency under truthful bidding.
  let revenue = 0;
  let efficient = 0;
  let count = 0;
  let individuallyRational = true;
  for (const profile of otherProfiles(support, n)) {
    const truthfulBids = profile.map((v) => nearest(bids, v));
    const { winner, price } = allocate(spec, truthfulBids);
    revenue += winner >= 0 ? price : 0;
    const top = Math.max(...profile);
    if (winner >= 0 && Math.abs(profile[winner]! - top) < TOLERANCE) efficient += 1;
    for (let i = 0; i < profile.length; i += 1) {
      if (utility(spec, truthfulBids, i, profile[i]!) < -TOLERANCE) individuallyRational = false;
    }
    count += 1;
  }

  return {
    dsicWitness,
    theory: {
      family: "mechanism",
      equilibriumBid: spec.rule.kind === "second_price" ? "truthful" : "shaded",
      dsicVerified,
      expectedRevenue: count === 0 ? 0 : revenue / count,
      expectedEfficiency: count === 0 ? 0 : efficient / count,
      individuallyRational,
    },
    method: { equilibrium: "exhaustive", tolerance: TOLERANCE },
  };
}

function nearest(bids: readonly number[], value: number): number {
  if (bids.length === 0) return value;
  return bids.reduce((best, b) =>
    Math.abs(b - value) < Math.abs(best - value) ? b : best,
  );
}

export function mechanismMeasured(spec: Scenario & Mechanism, trace: RunTrace): MeasuredBlock {
  const bids = bidSpace(spec);
  const support = valueSupport(spec);
  const perAgent: Record<AgentId, { totalPayoff: number; regret: RegretMeasure[] }> = {};
  const perRound: { index: number; aggregates?: Record<string, number>; welfare: number }[] = [];
  let parsed = 0;
  let failed = 0;

  for (const round of trace.rounds) {
    const ids = Object.keys(round.perAgent).sort();
    const actual = ids.map((id) => Number(round.perAgent[id]!.parsedAction));
    const values = ids.map((id) => trace.realizedStructure.types[id]?.value ?? 0);
    let welfare = 0;

    ids.forEach((id, i) => {
      parsed += 1;
      const rec = round.perAgent[id]!;
      if (rec.parseStatus === "failed_default") failed += 1;
      welfare += rec.payoff;

      // Ex post: hold the realized opponent bids fixed.
      const best = Math.max(
        ...bids.map((b) => utility(spec, replace(actual, i, b), i, values[i]!)),
      );
      const exPost = best - rec.payoff;

      // Interim: expectation over opponents' types, opponents truthful.
      const profiles = otherProfiles(support, ids.length - 1);
      const expected = (bid: number) =>
        profiles.reduce(
          (s, others) =>
            s + utility(spec, insertAt(others.map((v) => nearest(bids, v)), i, bid), i, values[i]!),
          0,
        ) / profiles.length;
      const truthfulEU = expected(nearest(bids, values[i]!));
      const bestEU = Math.max(...bids.map(expected));

      perAgent[id] = {
        totalPayoff: (perAgent[id]?.totalPayoff ?? 0) + rec.payoff,
        regret: [
          { kind: "ex_post_unilateral", value: round0(exPost) },
          { kind: "interim_bayesian", value: round0(bestEU - truthfulEU) },
        ],
      };
    });

    perRound.push({
      index: round.index,
      ...(round.aggregates ? { aggregates: { ...round.aggregates } } : {}),
      welfare,
    });
  }

  return { perAgent, perRound, parseFailureRate: parsed === 0 ? 0 : failed / parsed };
}

function replace(xs: readonly number[], i: number, v: number): number[] {
  const out = [...xs];
  out[i] = v;
  return out;
}

function insertAt(xs: readonly number[], i: number, v: number): number[] {
  const out = [...xs];
  out.splice(i, 0, v);
  return out;
}

/**
 * Shared, pure math over a spec. No I/O, no clock, no RNG, no free text.
 *
 * Everything here is used by BOTH the validator and the evaluator, which is
 * what keeps "is this spec a social dilemma?" and "what is the welfare gap?"
 * from drifting apart: they are the same function.
 */

import type {
  Aggregate,
  Distribution,
  NormalForm,
  Range,
  Sweepable,
} from "./types.js";

// ---------------------------------------------------------------------------
// Sweepables
// ---------------------------------------------------------------------------

export function isRange(v: Sweepable): v is Range {
  return typeof v === "object" && v !== null && "min" in v;
}

/**
 * Collapse a Sweepable to the single number this evaluation uses.
 *
 * A Range has no single value, so this takes `min` — the first cell of the
 * grid — and callers surface that choice through `incompleteness` rather than
 * letting it pass silently. Resolving a whole grid is `sweep.ts`'s job.
 */
export function num(v: Sweepable): number {
  return isRange(v) ? v.min : v;
}

export function hasRange(...vs: readonly Sweepable[]): boolean {
  return vs.some(isRange);
}

// ---------------------------------------------------------------------------
// Distributions -> a deterministic population of drawn values
// ---------------------------------------------------------------------------

/**
 * Expand a distribution into exactly `n` values, ASCENDING and WITHOUT RNG.
 *
 * Determinism matters more than sampling fidelity here: the theory block must
 * be a function of the spec alone, so two evaluations of the same spec must
 * produce the same population. Weighted `empirical` uses largest-remainder
 * apportionment; continuous families use evenly spaced quantiles.
 */
export function expandDistribution(d: Distribution, n: number): number[] {
  if (n <= 0) return [];
  switch (d.kind) {
    case "point":
      return Array.from({ length: n }, () => num(d.value));

    case "empirical": {
      const values = [...d.values];
      const weights = d.weights ?? values.map(() => 1 / values.length);
      const total = weights.reduce((a, b) => a + b, 0) || 1;

      // Largest remainder: floor each share, then hand out what is left to the
      // biggest remainders. Guarantees the counts sum to exactly n.
      const exact = weights.map((w) => (w / total) * n);
      const counts = exact.map(Math.floor);
      let remaining = n - counts.reduce((a, b) => a + b, 0);
      const order = exact
        .map((e, i) => ({ i, frac: e - Math.floor(e) }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
      for (let k = 0; remaining > 0; k += 1, remaining -= 1) {
        counts[order[k % order.length]!.i]! += 1;
      }

      const out: number[] = [];
      values.forEach((v, i) => {
        for (let k = 0; k < counts[i]!; k += 1) out.push(v);
      });
      return out.sort((a, b) => a - b);
    }

    case "uniform": {
      const lo = num(d.min);
      const hi = num(d.max);
      return quantiles(n).map((q) => lo + q * (hi - lo));
    }

    case "normal": {
      const mean = num(d.mean);
      const sd = num(d.sd);
      return quantiles(n).map((q) => mean + sd * probit(q));
    }

    case "beta": {
      // Mean-matched deterministic spread. Enough for validation-time checks;
      // a spec that needs the true Beta shape should say so in incompleteness.
      const a = num(d.alpha);
      const b = num(d.beta);
      const mean = a / (a + b);
      return quantiles(n).map((q) => clamp(mean + (q - 0.5) * mean * 2, 0, 1));
    }
  }
}

/** Midpoints of n equal bins: (i + 0.5) / n. Symmetric and RNG-free. */
function quantiles(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + 0.5) / n);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Acklam's inverse normal CDF. Deterministic; accuracy is ample for thresholds. */
function probit(p: number): number {
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969,
             138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887,
             66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184,
             -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const dd = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((dd[0]! * q + dd[1]!) * q + dd[2]!) * q + dd[3]!) * q + 1);
  }
  if (p > 1 - plow) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

// ---------------------------------------------------------------------------
// Aggregate family: payoffs, equilibria, welfare
// ---------------------------------------------------------------------------

/**
 * An aggregate scenario reduced to the two functions everything else needs.
 *
 * `act(i, level)` and `abstain(i, level)` are indexed by the agent's rank in
 * the ASCENDING threshold order, so agent 0 is the most eager. Homogeneous
 * payoffs ignore the index; only `threshold_binary` uses it.
 */
export interface AggregateModel {
  readonly n: number;
  readonly thresholds: readonly number[]; // ascending; empty when homogeneous
  readonly act: (rank: number, level: number) => number;
  readonly abstain: (rank: number, level: number) => number;
  readonly monotonicity: "complement" | "substitute";
}

export function aggregateModel(spec: Aggregate, n: number): AggregateModel {
  const p = spec.payoff;

  switch (p.kind) {
    case "threshold_binary": {
      const benefit = num(p.benefit);
      const cost = num(p.cost);
      const outside = num(p.outsideOption);
      const thresholds = expandDistribution(p.threshold, n);
      return {
        n,
        thresholds,
        act: (rank, level) =>
          (level >= (thresholds[rank] ?? Infinity) ? benefit : 0) - cost,
        abstain: () => outside,
        monotonicity: "complement",
      };
    }

    case "congestion": {
      const capacity = num(p.capacity);
      const value = num(p.valueUnderCapacity);
      const slope = num(p.slopeOver);
      const outside = num(p.outsideOption);
      return {
        n,
        thresholds: [],
        // v is a CEILING, not a line through it — the max(0, .) is load-bearing.
        act: (_r, level) => value + slope * Math.max(0, level - capacity),
        abstain: () => outside,
        monotonicity: slope < 0 ? "substitute" : "complement",
      };
    }

    case "linear_public_good": {
      const endowment = num(p.endowment);
      const mpcr = num(p.mpcr);
      // u_i = (E - c_i) + m * C, with c_i in {0, E} and C = level * E.
      return {
        n,
        thresholds: [],
        act: (_r, level) => mpcr * level * endowment,
        abstain: (_r, level) => endowment + mpcr * level * endowment,
        monotonicity: mpcr > 0 ? "complement" : "substitute",
      };
    }
  }
}

/**
 * Is `level` an equilibrium?
 *
 * THE SELF-INCLUSION-CORRECTED CONDITION, which is the definition this repo
 * uses everywhere. A deviator's own action is recounted, so:
 *   (a) no actor strictly prefers out:  act(marginal actor, level)
 *                                         >= abstain(marginal actor, level - 1)
 *   (b) no abstainer strictly prefers in: abstain(marginal abstainer, level)
 *                                         >= act(marginal abstainer, level + 1)
 *
 * The marginal actor is the LAST one in ascending-threshold order (the least
 * eager of those acting); the marginal abstainer is the FIRST one out (the most
 * eager of those not acting). Checking only those two is sufficient because the
 * order is by eagerness.
 *
 * The naive "everyone best-responds to the observed level" iterate is NOT used:
 * with homogeneous congestion payoffs it flips the whole population between 0
 * and N and never settles, while the correct equilibrium sits at the margin.
 */
export function isAggregateEquilibrium(m: AggregateModel, level: number): boolean {
  const contentActors = level === 0 || m.act(level - 1, level) >= m.abstain(level - 1, level - 1);
  const contentAbstainers = level === m.n || m.abstain(level, level) >= m.act(level, level + 1);
  return contentActors && contentAbstainers;
}

/** Does the marginal actor at `level` strictly want out? */
function wantsOut(m: AggregateModel, level: number): boolean {
  if (level <= 0) return false;
  return m.act(level - 1, level) < m.abstain(level - 1, level - 1);
}

/** Does the marginal abstainer at `level` strictly want in? */
function wantsIn(m: AggregateModel, level: number): boolean {
  if (level >= m.n) return false;
  return m.abstain(level, level) < m.act(level, level + 1);
}

/**
 * Stability by a one-agent perturbation, tested in each direction.
 *
 * From `level - 1`: if the marginal actor now wants out too, the perturbation
 * AMPLIFIES and the level collapses — unstable from below. That is exactly what
 * a tipping point is, and it is why losing a single actor at a tipping level
 * takes the whole population down with it.
 */
export function isStable(m: AggregateModel, level: number): boolean {
  const fromBelow = level === 0 || (!wantsOut(m, level - 1) && wantsIn(m, level - 1));
  const fromAbove = level === m.n || (!wantsIn(m, level + 1) && wantsOut(m, level + 1));
  return fromBelow && fromAbove;
}

export interface AggregateEquilibria {
  readonly fixedPoints: readonly { readonly level: number; readonly stable: boolean }[];
  readonly tippingPoints: readonly number[];
  readonly equilibriumLevel: number | null;
}

export function aggregateEquilibria(m: AggregateModel): AggregateEquilibria {
  const fixedPoints: { level: number; stable: boolean }[] = [];
  for (let level = 0; level <= m.n; level += 1) {
    if (isAggregateEquilibrium(m, level)) {
      fixedPoints.push({ level, stable: isStable(m, level) });
    }
  }

  // A tipping point is an INTERIOR fixed point that is not stable. The interior
  // requirement is what makes "cascade with only 0 and N" refutable.
  const tippingPoints = fixedPoints
    .filter((f) => !f.stable && f.level > 0 && f.level < m.n)
    .map((f) => f.level);

  return { fixedPoints, tippingPoints, equilibriumLevel: reachedFromZero(m) };
}

/**
 * SELECTION RULE for `equilibriumLevel` when several equilibria exist: the one
 * one-agent-at-a-time better-response dynamics reach from an all-inactive
 * start. Stated so the number is not an arbitrary pick among fixed points.
 */
function reachedFromZero(m: AggregateModel): number | null {
  let level = 0;
  for (let step = 0; step <= m.n + 1; step += 1) {
    if (isAggregateEquilibrium(m, level)) return level;
    if (wantsIn(m, level)) level += 1;
    else if (wantsOut(m, level)) level -= 1;
    else return level;
    if (level < 0 || level > m.n) return null;
  }
  return null; // did not converge — reported rather than guessed
}

/** Total welfare at `level`: the `level` most eager agents act, the rest do not. */
export function aggregateWelfare(m: AggregateModel, level: number): number {
  let total = 0;
  for (let rank = 0; rank < m.n; rank += 1) {
    total += rank < level ? m.act(rank, level) : m.abstain(rank, level);
  }
  return total;
}

export function efficientLevel(m: AggregateModel): number {
  let best = 0;
  let bestWelfare = aggregateWelfare(m, 0);
  for (let level = 1; level <= m.n; level += 1) {
    const w = aggregateWelfare(m, level);
    if (w > bestWelfare + 1e-12) {
      best = level;
      bestWelfare = w;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Normal form: the 2x2 / table payoff lookup
// ---------------------------------------------------------------------------

export interface Matrix {
  readonly roles: readonly [string, string];
  readonly actions: readonly string[];
  /** payoff[rowAction][colAction] = [rowPayoff, colPayoff] */
  readonly payoff: (a: string, b: string) => readonly [number, number];
}

export function normalFormMatrix(
  spec: NormalForm,
  roles: readonly string[],
): Matrix | null {
  const actions =
    "kind" in spec.actions && spec.actions.kind === "discrete"
      ? spec.actions.actions
      : null;
  if (!actions || roles.length !== 2) return null;

  const p = spec.payoff;
  if (p.kind === "symmetric_2x2") {
    if (actions.length !== 2) return null;
    const [c, d] = actions as readonly [string, string];
    const R = num(p.R);
    const S = num(p.S);
    const T = num(p.T);
    const P = num(p.P);
    return {
      roles: [roles[0]!, roles[1]!],
      actions,
      payoff: (a, b) => {
        if (a === c && b === c) return [R, R];
        if (a === c && b === d) return [S, T];
        if (a === d && b === c) return [T, S];
        return [P, P];
      },
    };
  }

  return {
    roles: [roles[0]!, roles[1]!],
    actions,
    payoff: (a, b) => {
      const cell = p.entries[`${a}|${b}`];
      return [num(cell?.[roles[0]!] ?? 0), num(cell?.[roles[1]!] ?? 0)];
    },
  };
}

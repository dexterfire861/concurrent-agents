/**
 * The REFERENCE runtime: a deterministic, LLM-free player of a scenario.
 *
 * This is not the agent runtime. It exists so that the structural half of the
 * determinism contract is testable with no API key and no model call:
 *
 *   5a. Structural determinism  -- same spec + seed => identical type draws,
 *       role assignment, graph, seed set and RNG cursors.  ENFORCED HERE.
 *   5b. Evaluator purity        -- same (spec, trace) => identical report.
 *   5c. Replay determinism      -- recorded rawOutput replayed reproduces the trace.
 *
 * What is NOT contractible is identical `rawOutput` across two LIVE runs:
 * `InferenceInput` in the installed SDK carries no temperature and no seed, so
 * every provider samples at its default. That variance is the object of study,
 * not a defect, and it belongs to `sweep.replicates` as a statistical spread.
 * Any live backend must report `deterministicSampling: false` rather than
 * leaving that in a footnote.
 */

import type { AgentId, RngSubstream, Scenario } from "../spec/types.js";
import type { AgentRoundRecord, RoundRecord, RunTrace } from "../trace/types.js";
import { aggregateModel, expandDistribution, num } from "../spec/resolve.js";

/** mulberry32. Small, fast, and identical on every platform. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Named substreams derived from the root seed. No ambient randomness anywhere. */
class Rng {
  private readonly streams = new Map<RngSubstream, () => number>();
  private readonly cursors = new Map<RngSubstream, number>();

  constructor(private readonly seed: number) {}

  next(stream: RngSubstream): number {
    if (!this.streams.has(stream)) {
      const offset = [...stream].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);
      this.streams.set(stream, prng((this.seed + offset) >>> 0));
      this.cursors.set(stream, 0);
    }
    this.cursors.set(stream, (this.cursors.get(stream) ?? 0) + 1);
    return this.streams.get(stream)!();
  }

  cursor(): Readonly<Partial<Record<RngSubstream, number>>> {
    return Object.fromEntries([...this.cursors.entries()].sort()) as Partial<
      Record<RngSubstream, number>
    >;
  }
}

export const runScenario = async (spec: Scenario): Promise<RunTrace> => {
  const n = Math.round(num(spec.population.size));
  const rng = new Rng(spec.seed);
  const ids: AgentId[] = Array.from({ length: n }, (_, i) => `a${i}`);

  // Roles by declared share, apportioned in order. Deterministic, no sampling.
  const roleAssignment: Record<AgentId, string> = {};
  let cursor = 0;
  spec.population.roles.forEach((role, idx) => {
    const count =
      idx === spec.population.roles.length - 1
        ? n - cursor
        : Math.round(role.share * n);
    for (let k = 0; k < count && cursor < n; k += 1, cursor += 1) {
      roleAssignment[ids[cursor]!] = role.id;
    }
  });

  const types: Record<AgentId, Record<string, number>> = {};
  const rounds: RoundRecord[] = [];

  if (spec.family !== "aggregate") {
    // Only the aggregate family has a reference player today. Everything else
    // gets a structurally valid empty trace rather than invented behaviour.
    return {
      specHash: `spec-${spec.metadata.id}`,
      seed: spec.seed,
      cell: {},
      realizedStructure: { types, roleAssignment },
      rounds,
    };
  }

  const model = aggregateModel(spec, n);
  const actLabel = spec.statistic.of;
  const abstainLabel =
    spec.actions.kind === "discrete"
      ? (spec.actions.actions.find((a) => a !== actLabel) ?? "abstain")
      : "abstain";

  // Thresholds are drawn from the seeded `types` substream and recorded, so a
  // replay can be proven to have reproduced them.
  const thresholds =
    spec.payoff.kind === "threshold_binary" ? expandDistribution(spec.payoff.threshold, n) : [];
  ids.forEach((id, i) => {
    rng.next("types");
    if (thresholds.length > 0) types[id] = { threshold: thresholds[i]! };
    else types[id] = {};
  });

  // Rank by threshold ascending: agent 0 is the most eager. Matches the
  // evaluator's ordering exactly, so theory and run speak the same language.
  const rank = new Map<AgentId, number>(
    ids
      .map((id, i) => ({ id, t: thresholds[i] ?? 0 }))
      .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1))
      .map((x, i) => [x.id, i]),
  );

  const roundCount = Math.max(1, Math.round(num(spec.protocol.repetition.rounds)));
  const lag = spec.information.lagRounds ?? 0;
  let level = 0;

  /**
   * MARGINAL adjustment, one agent at a time, to a fixed point.
   *
   * NOT simultaneous full best response. With homogeneous congestion payoffs
   * every attendee has the same payoff, so "everyone best-responds to the
   * observed turnout" flips the entire population between 0 and N forever and
   * never settles — the level oscillates and the run says nothing. The
   * equilibrium is the MARGINAL one, so the reference player adjusts at the
   * margin too, matching the concept the evaluator scores against.
   */
  const settle = (from: number): number => {
    let x = from;
    for (let step = 0; step <= n + 1; step += 1) {
      const joinerWantsIn = x < n && model.abstain(x, x) < model.act(x, x + 1);
      const actorWantsOut = x > 0 && model.act(x - 1, x) < model.abstain(x - 1, x - 1);
      if (joinerWantsIn) x += 1;
      else if (actorWantsOut) x -= 1;
      else return x;
    }
    return x;
  };

  for (let r = 0; r < roundCount; r += 1) {
    const observed = level;
    level = settle(level);
    const perAgent: Record<AgentId, AgentRoundRecord> = {};

    // The `level` most eager agents act; anonymity means only the count matters.
    for (const id of ids) {
      const k = rank.get(id) ?? 0;
      const acts = k < level;
      const payoff = acts ? model.act(k, level) : model.abstain(k, level);
      perAgent[id] = {
        observation: {
          aggregateStatistic: observed,
          ownAction: acts ? actLabel : abstainLabel,
          ownPayoff: payoff,
          ...(lag > 0 ? { lag } : {}),
        },
        rawOutput: `reference runtime: ${acts ? actLabel : abstainLabel}`,
        parsedAction: acts ? actLabel : abstainLabel,
        parseStatus: "ok",
        payoff,
      };
    }

    rounds.push({
      index: r,
      perAgent,
      aggregates: { [actLabel]: level },
      rngCursor: rng.cursor(),
    });
  }

  return {
    specHash: `spec-${spec.metadata.id}`,
    seed: spec.seed,
    cell: {},
    realizedStructure: { types, roleAssignment },
    rounds,
  };
};

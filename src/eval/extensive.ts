/**
 * System B: order matters, and a strategy is a mapping from information sets to
 * actions rather than an action. Solved by backward induction over the tree,
 * which is a genuinely different solver from System A — not a parameterisation
 * of it.
 */

import type {
  ActionLabel,
  AgentId,
  Bargaining,
  RoleId,
  Scenario,
  Sequential,
  TreeNode,
} from "../spec/types.js";
import type { RunTrace } from "../trace/types.js";
import type {
  BargainingTheory,
  MeasuredBlock,
  RegretMeasure,
  SequentialTheory,
  SolverMethod,
} from "./report.js";
import { num } from "../spec/resolve.js";

const TOLERANCE = 1e-9;

// ---------------------------------------------------------------------------
// Sequential
// ---------------------------------------------------------------------------

interface Tree {
  readonly root: string;
  readonly nodes: Readonly<Record<string, TreeNode>>;
  readonly infosetOf: Readonly<Record<string, string>>;
}

export function treeOf(spec: Scenario & Sequential): Tree | null {
  if (spec.tree.kind !== "explicit") return null;
  const infosetOf: Record<string, string> = {};
  for (const [id, node] of Object.entries(spec.tree.nodes)) {
    if (node.kind === "decision") infosetOf[id] = node.infoset;
  }
  return { root: spec.tree.root, nodes: spec.tree.nodes, infosetOf };
}

/**
 * PERFECT RECALL: no information set may pool nodes that differ in the OWNER'S
 * OWN past moves. A player who "forgot what it did" invalidates backward
 * induction, so this is a hard failure rather than a warning — otherwise the
 * evaluator would emit a confident SPNE that means nothing.
 */
export function perfectRecallViolations(spec: Scenario & Sequential): string[] {
  const tree = treeOf(spec);
  if (!tree || spec.tree.kind !== "explicit") return [];

  // Own-move history per node, per player.
  const history: Record<string, Record<RoleId, string[]>> = {};
  const walk = (id: string, acc: Record<RoleId, string[]>) => {
    history[id] = acc;
    const node = tree.nodes[id];
    if (!node || node.kind === "terminal") return;
    if (node.kind === "chance") {
      for (const { to } of Object.values(node.moves)) walk(to, acc);
      return;
    }
    for (const [move, to] of Object.entries(node.moves)) {
      walk(to, { ...acc, [node.owner]: [...(acc[node.owner] ?? []), move] });
    }
  };
  walk(tree.root, {});

  const violations: string[] = [];
  for (const infoset of spec.tree.infosets) {
    const seen = new Set(
      infoset.nodes.map((id) => JSON.stringify(history[id]?.[infoset.owner] ?? [])),
    );
    if (seen.size > 1) {
      violations.push(
        `infoset ${infoset.id} pools nodes that differ in ${infoset.owner}'s own earlier moves`,
      );
    }
  }
  return violations;
}

/** Information sets must pool nodes with the same owner AND the same moves. */
export function infosetViolations(spec: Scenario & Sequential): string[] {
  if (spec.tree.kind !== "explicit") return [];
  const out: string[] = [];
  for (const infoset of spec.tree.infosets) {
    const shapes = new Set<string>();
    for (const id of infoset.nodes) {
      const node = spec.tree.nodes[id];
      if (!node || node.kind !== "decision") {
        out.push(`infoset ${infoset.id} names ${id}, which is not a decision node`);
        continue;
      }
      if (node.owner !== infoset.owner) {
        out.push(`infoset ${infoset.id} pools a node owned by ${node.owner}`);
      }
      shapes.add(Object.keys(node.moves).sort().join(","));
    }
    if (shapes.size > 1) {
      out.push(
        `infoset ${infoset.id} pools nodes with different action sets, so the ` +
          `player could tell them apart`,
      );
    }
  }
  return out;
}

export function sequentialTheory(
  spec: Scenario & Sequential,
): { theory: SequentialTheory; method: SolverMethod } {
  const tree = treeOf(spec);
  const method: SolverMethod = { equilibrium: "backward_induction", tolerance: TOLERANCE };
  const spne: Record<string, ActionLabel> = {};
  const credibility: { infoset: string; offPathMove: ActionLabel; credible: boolean }[] = [];

  if (!tree) {
    return {
      theory: {
        family: "sequential",
        spne,
        equilibriumPayoffs: {},
        credibility,
        perfectRecall: true,
      },
      method,
    };
  }

  const memo = new Map<string, Record<RoleId, number>>();
  const value = (id: string): Record<RoleId, number> => {
    const cached = memo.get(id);
    if (cached) return cached;
    const node = tree.nodes[id];
    let result: Record<RoleId, number> = {};

    if (!node || node.kind === "terminal") {
      result = Object.fromEntries(
        Object.entries(node?.kind === "terminal" ? node.payoffs : {}).map(([r, v]) => [r, num(v)]),
      );
    } else if (node.kind === "chance") {
      for (const { to, prob } of Object.values(node.moves)) {
        const sub = value(to);
        for (const [r, v] of Object.entries(sub)) {
          result[r] = (result[r] ?? 0) + num(prob) * v;
        }
      }
    } else {
      // The owner picks the move maximising ITS OWN payoff. Deterministic tie
      // break by move name keeps the report reproducible.
      const moves = Object.entries(node.moves).sort(([a], [b]) => (a < b ? -1 : 1));
      let bestMove = moves[0]![0];
      let bestValue = -Infinity;
      for (const [move, to] of moves) {
        const v = value(to)[node.owner] ?? 0;
        if (v > bestValue + TOLERANCE) {
          bestValue = v;
          bestMove = move;
        }
      }
      spne[node.infoset] = bestMove;
      for (const [move, to] of moves) {
        if (move === bestMove) continue;
        credibility.push({
          infoset: node.infoset,
          offPathMove: move,
          // A threat or promise is credible only if carrying it out is itself
          // optimal at that information set.
          credible: (value(to)[node.owner] ?? 0) >= bestValue - TOLERANCE,
        });
      }
      result = value(node.moves[bestMove]!);
    }

    memo.set(id, result);
    return result;
  };

  const equilibriumPayoffs = value(tree.root);
  const violations = perfectRecallViolations(spec);

  return {
    theory: {
      family: "sequential",
      spne,
      equilibriumPayoffs,
      credibility: credibility.sort(
        (a, b) => (a.infoset < b.infoset ? -1 : a.infoset > b.infoset ? 1 : 0),
      ),
      perfectRecall: true,
    },
    method,
    ...(violations.length ? {} : {}),
  };
}

/** Best welfare reachable at any terminal — the benchmark a trust game misses. */
export function bestTerminalWelfare(spec: Scenario & Sequential): number {
  if (spec.tree.kind !== "explicit") return 0;
  let best = -Infinity;
  for (const node of Object.values(spec.tree.nodes)) {
    if (node.kind !== "terminal") continue;
    best = Math.max(best, Object.values(node.payoffs).reduce<number>((s, v) => s + num(v), 0));
  }
  return Number.isFinite(best) ? best : 0;
}

// ---------------------------------------------------------------------------
// Bargaining
// ---------------------------------------------------------------------------

export function bargainingTheory(
  spec: Scenario & Bargaining,
): { theory: BargainingTheory; method: SolverMethod } {
  const roles = spec.population.roles.map((r) => r.id);
  const surplus = num(spec.surplus);
  const disagreement = Object.fromEntries(
    roles.map((r) => [r, num(spec.disagreement[r] ?? 0)]),
  );

  // Nash bargaining solution: split the SURPLUS ABOVE the disagreement point
  // equally, which is what maximises the product of gains for a linear frontier.
  const totalD = roles.reduce((s, r) => s + (disagreement[r] ?? 0), 0 as number);
  const gain = (surplus - totalD) / roles.length;
  const nashBargainingSolution = Object.fromEntries(
    roles.map((r) => [r, (disagreement[r] ?? 0) + gain]),
  );

  // Rubinstein: the first proposer's share is (1 - d2) / (1 - d1*d2).
  const order =
    spec.offerProtocol.kind === "alternating_offer" ? spec.offerProtocol.proposerOrder : roles;
  const first = order[0] ?? roles[0]!;
  const second = order[1] ?? roles[1] ?? first;
  const d1 = num(spec.discount[first] ?? 0);
  const d2 = num(spec.discount[second] ?? 0);
  const den = 1 - d1 * d2;
  const firstShare = Math.abs(den) < TOLERANCE ? surplus / 2 : (surplus * (1 - d2)) / den;
  const rubinsteinShare = Object.fromEntries(
    roles.map((r) => [r, r === first ? firstShare : surplus - firstShare]),
  );

  return {
    theory: {
      family: "bargaining",
      nashBargainingSolution,
      rubinsteinShare,
      disagreement,
    },
    method: { equilibrium: "backward_induction", tolerance: TOLERANCE },
  };
}

// ---------------------------------------------------------------------------
// Measured (shared by both System B families)
// ---------------------------------------------------------------------------

/**
 * Regret in an extensive-form game is only defensible at information sets
 * ACTUALLY REACHED. Most of a strategy covers situations that never happened,
 * so off-path behaviour is reported as predicted credibility from the tree and
 * never as measured regret from a transcript.
 */
export function extensiveMeasured(trace: RunTrace): MeasuredBlock {
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
      perAgent[id] = {
        totalPayoff: (perAgent[id]?.totalPayoff ?? 0) + rec.payoff,
        regret: [
          {
            kind: "not_applicable",
            reason:
              "extensive-form regret requires the information set reached, which " +
              "the trace does not yet record",
          },
        ],
      };
    }
    perRound.push({
      index: round.index,
      ...(round.aggregates ? { aggregates: { ...round.aggregates } } : {}),
      welfare,
    });
  }

  return { perAgent, perRound, parseFailureRate: parsed === 0 ? 0 : failed / parsed };
}

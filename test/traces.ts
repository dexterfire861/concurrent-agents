/**
 * Hand-built traces.
 *
 * A trace is a RUN ARTEFACT, not a spec, so it does not belong in configs/.
 * These are written by hand rather than produced by a runtime because the
 * assertions that use them are exact: the point of the party trace is that the
 * evaluator must return 0 and 7 for a specific agent, which requires the input
 * to be pinned to the last action.
 *
 * The derivations for the numbers below live in the header comments of the
 * fixtures they pair with:
 *   configs/golden/party-threshold-regret.yaml
 *   configs/golden/second-price-auction.yaml
 *   configs/golden/congestion-office-hours.yaml
 *   configs/golden/morris-contagion-cycle.yaml
 */

import type { ActionLabel, AgentId } from "../src/spec/types.js";
import type { AgentRoundRecord, RunTrace } from "../src/trace/types.js";

/** One agent's record for a round. `rawOutput` is deliberately non-empty: it is
 *  free text, so if it ever changes a report the blindness test catches it. */
function agentRecord(
  action: ActionLabel | number,
  payoff: number,
  observation: AgentRoundRecord["observation"] = {},
): AgentRoundRecord {
  return {
    observation,
    rawOutput: `I choose ${String(action)}.`,
    reasoning: `Because ${String(action)} looked best to me.`,
    parsedAction: action,
    parseStatus: "ok",
    payoff,
  };
}

function trace(
  specHash: string,
  seed: number,
  perAgent: Readonly<Record<AgentId, AgentRoundRecord>>,
  aggregates: Readonly<Record<string, number>> | undefined,
  types: Readonly<Record<AgentId, Readonly<Record<string, number>>>>,
  roleAssignment: Readonly<Record<AgentId, string>>,
): RunTrace {
  return {
    specHash,
    seed,
    cell: {},
    realizedStructure: { types, roleAssignment },
    rounds: [
      {
        index: 0,
        perAgent,
        aggregates,
        rngCursor: { types: 0 },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The party. Plan section 3.3.
// ---------------------------------------------------------------------------

/**
 * a0 stayed home; a1..a9 attended. Realized count = 9, one short of the
 * threshold of 10, so every attendee earns 10*[9 >= 10] - 0 = 0 and a0 earns
 * the outside option 3.
 *
 * a0 is the pivotal agent: price_taking says its regret is 0, the corrected
 * measure says 7. Those two numbers are the assertion.
 */
export function partyTrace(): RunTrace {
  const perAgent: Record<AgentId, AgentRoundRecord> = {};
  const types: Record<AgentId, Record<string, number>> = {};
  const roleAssignment: Record<AgentId, string> = {};

  for (let i = 0; i < 10; i += 1) {
    const id = `a${i}`;
    const attended = i > 0;
    perAgent[id] = agentRecord(attended ? "attend" : "stay", attended ? 0 : 3, {
      ownAction: attended ? "attend" : "stay",
      ownPayoff: attended ? 0 : 3,
      aggregateStatistic: 9,
    });
    types[id] = { threshold: 10 };
    roleAssignment[id] = "friend";
  }

  return trace(
    "spec-party-threshold-regret",
    20260906,
    perAgent,
    { attend: 9 },
    types,
    roleAssignment,
  );
}

// ---------------------------------------------------------------------------
// Second-price auction, everyone truthful.
// ---------------------------------------------------------------------------

/**
 * Values (30, 20, 10); bids equal to values. a0 wins and pays the second bid,
 * 20, for a utility of 10. a1 and a2 get 0. Every regret must be EXACTLY 0.
 */
export function truthfulSecondPriceTrace(): RunTrace {
  const values = [30, 20, 10];
  const utilities = [10, 0, 0];

  const perAgent: Record<AgentId, AgentRoundRecord> = {};
  const types: Record<AgentId, Record<string, number>> = {};
  const roleAssignment: Record<AgentId, string> = {};

  values.forEach((v, i) => {
    const id = `a${i}`;
    perAgent[id] = agentRecord(String(v), utilities[i]!, {
      ownAction: String(v),
      ownPayoff: utilities[i]!,
      ownType: { value: v },
      mechanismOutcome: { won: i === 0 ? 1 : 0, price: 20 },
    });
    types[id] = { value: v };
    roleAssignment[id] = "bidder";
  });

  return trace(
    "spec-second-price-auction",
    20260906,
    perAgent,
    { winningBid: 30, price: 20 },
    types,
    roleAssignment,
  );
}

// ---------------------------------------------------------------------------
// Congestion, for the anonymity property test.
// ---------------------------------------------------------------------------

/**
 * `attendees` names exactly which of the 30 agents attended. Payoffs follow the
 * congestion formula in src/spec/types.ts:
 *     attend -> 10 + (-1.5) * max(0, n - 8)
 *     skip   -> 3
 * Anonymity means the report must not depend on WHICH agents are in the set,
 * only on how many — so the test builds two traces with the same size and
 * different membership and compares.
 */
export function congestionTrace(attendees: readonly number[]): RunTrace {
  const set = new Set(attendees);
  const n = set.size;
  const attendPayoff = 10 + -1.5 * Math.max(0, n - 8);

  const perAgent: Record<AgentId, AgentRoundRecord> = {};
  const types: Record<AgentId, Record<string, number>> = {};
  const roleAssignment: Record<AgentId, string> = {};

  for (let i = 0; i < 30; i += 1) {
    const id = `a${i}`;
    const attended = set.has(i);
    perAgent[id] = agentRecord(
      attended ? "attend" : "skip",
      attended ? attendPayoff : 3,
      {
        ownAction: attended ? "attend" : "skip",
        ownPayoff: attended ? attendPayoff : 3,
        aggregateStatistic: n,
      },
    );
    types[id] = {};
    // 30 agents, shares 0.4 / 0.6 -> 12 struggling, 18 comfortable.
    roleAssignment[id] = i < 12 ? "struggling" : "comfortable";
  }

  return trace(
    "spec-congestion-office-hours",
    20260905,
    perAgent,
    { attend: n },
    types,
    roleAssignment,
  );
}

// ---------------------------------------------------------------------------
// Ten-cycle network, for the locality property test.
// ---------------------------------------------------------------------------

const CYCLE_NEIGHBOURS = (i: number): readonly number[] => [
  (i + 9) % 10,
  (i + 1) % 10,
];

/**
 * `adopters` names which nodes adopted. Payoff is the local threshold rule:
 * a node scores 1 when its own action matches what its NEIGHBOURHOOD warrants
 * (adopt iff at least half its neighbours adopted), 0 otherwise.
 *
 * That payoff is deliberately a function of the node and its two neighbours
 * ONLY. The locality test flips a distant node and asserts nothing about node 0
 * moves.
 */
export function cycleTrace(adopters: readonly number[]): RunTrace {
  const set = new Set(adopters);

  const perAgent: Record<AgentId, AgentRoundRecord> = {};
  const types: Record<AgentId, Record<string, number>> = {};
  const roleAssignment: Record<AgentId, string> = {};

  for (let i = 0; i < 10; i += 1) {
    const id = `a${i}`;
    const neighbours = CYCLE_NEIGHBOURS(i);
    const adoptedNeighbours = neighbours.filter((j) => set.has(j)).length;
    const warranted = adoptedNeighbours / neighbours.length >= 0.5;
    const adopted = set.has(i);
    const payoff = adopted === warranted ? 1 : 0;

    const neighborActions: Record<AgentId, ActionLabel> = {};
    for (const j of neighbours) {
      neighborActions[`a${j}`] = set.has(j) ? "adopt" : "abstain";
    }

    perAgent[id] = agentRecord(adopted ? "adopt" : "abstain", payoff, {
      ownAction: adopted ? "adopt" : "abstain",
      ownPayoff: payoff,
      ownType: { threshold: 0.5 },
      neighborActions,
    });
    types[id] = { threshold: 0.5 };
    roleAssignment[id] = "node";
  }

  return trace(
    "spec-morris-contagion-cycle",
    20260906,
    perAgent,
    { adopt: set.size },
    types,
    roleAssignment,
  );
}

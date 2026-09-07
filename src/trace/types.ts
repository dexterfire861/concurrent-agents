/**
 * What a run produced.
 *
 * The trace is a first-class serializable artifact, not a log. Both the
 * evaluator and the UI are pure functions of it, which is what makes it
 * impossible for the screen and the score to disagree.
 */

import type { ActionLabel, AgentId, RngSubstream } from "../spec/types.js";

export interface RunTrace {
  readonly specHash: string;
  readonly seed: number;
  /** Resolved sweep coordinates — which cell of the grid this run is. */
  readonly cell: Readonly<Record<string, number>>;
  readonly realizedStructure: RealizedStructure;
  readonly rounds: readonly RoundRecord[];
}

/**
 * Structure that was drawn rather than written down. Hashed so that
 * regenerating from the seed can be proven to reproduce it.
 */
export interface RealizedStructure {
  readonly graphHash?: string;
  readonly graphEdges?: readonly (readonly [number, number])[];
  /** Private traits actually drawn per agent, e.g. { a3: { threshold: 0.42 } }. */
  readonly types: Readonly<Record<AgentId, Readonly<Record<string, number>>>>;
  readonly roleAssignment: Readonly<Record<AgentId, string>>;
}

export interface RoundRecord {
  readonly index: number;
  readonly perAgent: Readonly<Record<AgentId, AgentRoundRecord>>;
  /** Summary statistics for this round, e.g. { attend: 19 }. */
  readonly aggregates?: Readonly<Record<string, number>>;
  readonly messages?: readonly Message[];
  /** Substream cursor positions, so a replay can be proven to have diverged. */
  readonly rngCursor: Readonly<Partial<Record<RngSubstream, number>>>;
}

export interface AgentRoundRecord {
  /**
   * Exactly what this agent was shown. Makes the round independently replayable.
   *
   * Deliberately NOT `unknown`: `EvaluatorView<unknown>` is `unknown`, so an
   * untyped observation is a hole straight through evaluator blindness — free
   * text placed here would reach the scorer untouched. Every free-text field
   * below is a declared FreeTextKey so the strip actually bites.
   */
  readonly observation: ObservationRecord;
  /** The exact rendered prompt. Free text — stripped from EvaluatorView. */
  readonly promptText?: string;
  /** The model's text. For the UI only — stripped from EvaluatorView. */
  readonly rawOutput: string;
  /** Stripped from EvaluatorView. */
  readonly reasoning?: string;
  readonly parsedAction: ActionLabel | number;
  /**
   * Parse failures are first-class data, never silent defaults. A run where
   * 30% of actions failed to parse is not a result, and this is what lets the
   * report say so out loud.
   */
  readonly parseStatus: ParseStatus;
  readonly payoff: number;
}

export type ParseStatus = "ok" | "repaired" | "failed_default";

/**
 * What an agent was shown, mirroring ObservationChannel in the spec.
 * Every field is optional: which ones are populated is dictated by the
 * scenario's `information.observes`.
 */
export interface ObservationRecord {
  readonly ownAction?: ActionLabel | number;
  readonly ownPayoff?: number;
  readonly ownType?: Readonly<Record<string, number>>;
  readonly aggregateStatistic?: number;
  readonly neighborActions?: Readonly<Record<AgentId, ActionLabel | number>>;
  readonly fullProfile?: Readonly<Record<AgentId, ActionLabel | number>>;
  readonly othersTypes?: Readonly<
    Record<AgentId, Readonly<Record<string, number>>>
  >;
  readonly history?: readonly Readonly<Record<string, number>>[];
  readonly mechanismOutcome?: Readonly<Record<string, number>>;
  /** Cheap talk heard. Message.text is a FreeTextKey, so the words are stripped
   *  while the fact that talk occurred — which is structural — survives. */
  readonly heard?: readonly Message[];
  /** How many rounds stale this observation was, per information.lagRounds. */
  readonly lag?: number;
  readonly noised?: boolean;
}

export interface Message {
  readonly from: AgentId;
  readonly to: AgentId | "all";
  /** Cheap talk. Stripped from EvaluatorView — talk must not reach the scorer. */
  readonly text: string;
}

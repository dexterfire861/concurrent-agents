/**
 * Compile-time tests. These assert properties of the type boundary itself;
 * they have no runtime behaviour and are verified by `npm run typecheck`.
 */

import type { Family, Role, Scenario } from "../src/spec/types.js";
import type { EvaluatorView } from "../src/eval/report.js";

// ---------------------------------------------------------------------------
// 1. The family union is exhaustive.
//
// If a seventh family is added and any evaluator forgets to handle it, this
// stops compiling. That is the whole point of the discriminated union.
// ---------------------------------------------------------------------------

const assertNever = (x: never): never => {
  throw new Error(`unreachable family: ${JSON.stringify(x)}`);
};

export function solverFor(f: Family): "systemA" | "systemB" {
  switch (f.family) {
    // System A: simultaneous choice, payoff is a function of the joint profile.
    case "normal_form":
      return "systemA";
    case "aggregate":
      return "systemA";
    case "network_local":
      return "systemA";
    case "mechanism":
      return "systemA";
    // System B: a strategy is a mapping from information sets to actions.
    case "sequential":
      return "systemB";
    case "bargaining":
      return "systemB";
    default:
      return assertNever(f);
  }
}

// ---------------------------------------------------------------------------
// 2. Free text is unreachable from the evaluator's view.
//
// The operational proof that no semantics can reach the scoring path.
// ---------------------------------------------------------------------------

type BlindRole = EvaluatorView<Role>;

// @ts-expect-error `persona` is stripped from the evaluator's view of a spec.
type _PersonaIsGone = BlindRole["persona"];

// @ts-expect-error `sourceDescription` is stripped too.
type _DescriptionIsGone = EvaluatorView<Scenario>["metadata"]["sourceDescription"];

// Structural fields survive the strip.
type _ShareSurvives = BlindRole["share"];
const _shareIsNumber: _ShareSurvives = 0.4;

// Nested and array-valued structure survives.
type _RolesSurvive = EvaluatorView<Scenario>["population"]["roles"];
type _ClaimsSurvive = EvaluatorView<Scenario>["claims"];

export type { _ShareSurvives, _RolesSurvive, _ClaimsSurvive };

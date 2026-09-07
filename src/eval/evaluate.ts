/**
 * The evaluator's single entry point.
 *
 * PURE. Same (spec, trace) in, byte-identical report out, forever. No LLM, no
 * I/O, no clock, no RNG. The `family` tag dispatches to one of two solvers:
 * System A (strategic.ts) or System B (extensive.ts).
 */

import type { Scenario } from "../spec/types.js";
import type { RunTrace } from "../trace/types.js";
import type {
  EvaluationReport,
  EvaluatorView,
  MeasuredBlock,
  SolverMethod,
  TheoryBlock,
} from "./report.js";
import { FREE_TEXT_KEYS } from "./report.js";
import { hasRange } from "../spec/resolve.js";
import {
  aggregateMeasured,
  aggregateTheory,
  buildGraph,
  mechanismMeasured,
  mechanismTheory,
  networkMeasured,
  networkTheory,
  normalFormTheory,
} from "./strategic.js";
import {
  bargainingTheory,
  extensiveMeasured,
  perfectRecallViolations,
  sequentialTheory,
} from "./extensive.js";

export const EVALUATOR_VERSION = "1.0.0";

/**
 * Widen the blind view back to Scenario for internal convenience.
 *
 * This cast does NOT weaken the guarantee. Blindness is enforced at the
 * exported signature (compile time) and by the scramble property test
 * (runtime); nothing below ever reads a free-text field, and the hashes are
 * computed over a stripped copy so even they cannot depend on one.
 */
function widen<T>(v: EvaluatorView<T>): T {
  return v as unknown as T;
}

export const evaluate = (
  blindSpec: EvaluatorView<Scenario>,
  blindTrace: EvaluatorView<RunTrace>,
): EvaluationReport => {
  const spec = widen<Scenario>(blindSpec);
  const trace = widen<RunTrace>(blindTrace);
  const incompleteness: string[] = [];

  let theory: TheoryBlock;
  let measured: MeasuredBlock;
  let method: SolverMethod;

  switch (spec.family) {
    case "normal_form": {
      const r = normalFormTheory(spec);
      theory = r.theory;
      method = r.method;
      measured = extensiveMeasured(trace);
      if (spec.actions && "kind" in spec.actions && spec.actions.kind === "discrete" &&
          spec.actions.actions.length > 2) {
        incompleteness.push("mixed equilibria are computed for 2x2 games only");
      }
      break;
    }

    case "aggregate": {
      const r = aggregateTheory(spec);
      theory = r.theory;
      method = r.method;
      measured = aggregateMeasured(spec, trace, r.theory, r.model);
      if (r.theory.equilibriumLevel === null) {
        incompleteness.push("better-response dynamics did not converge to a level");
      }
      break;
    }

    case "network_local": {
      const r = networkTheory(spec);
      theory = r.theory;
      method = r.method;
      measured = networkMeasured(spec, trace, buildGraph(spec));
      if (!r.theory.bestResponseConverged) {
        incompleteness.push("best-response dynamics did not converge; no equilibrium asserted");
      }
      break;
    }

    case "mechanism": {
      const r = mechanismTheory(spec);
      theory = r.theory;
      method = r.method;
      measured = mechanismMeasured(spec, trace);
      break;
    }

    case "sequential": {
      const r = sequentialTheory(spec);
      theory = r.theory;
      method = r.method;
      measured = extensiveMeasured(trace);
      if (perfectRecallViolations(spec).length > 0) {
        incompleteness.push(
          "perfect recall is violated, so backward induction is invalid here and " +
            "the SPNE below must not be relied on",
        );
      }
      incompleteness.push("sequential equilibrium under imperfect information is not computed");
      break;
    }

    case "bargaining": {
      const r = bargainingTheory(spec);
      theory = r.theory;
      method = r.method;
      measured = extensiveMeasured(trace);
      incompleteness.push(
        "offer-stage regret is a continuous optimisation; only accept/reject is measured",
      );
      break;
    }
  }

  if (specHasRange(spec)) {
    incompleteness.push(
      "a sweepable parameter is a range; this report evaluates the first grid cell only",
    );
  }

  return {
    specHash: hash(strip(spec)),
    traceHash: hash(strip(trace)),
    evaluatorVersion: EVALUATOR_VERSION,
    claimVerdicts: [],
    theory,
    measured,
    method,
    incompleteness,
  };
};

// ---------------------------------------------------------------------------
// Hashing over a STRIPPED copy, so free text cannot reach even the hash
// ---------------------------------------------------------------------------

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    if ((FREE_TEXT_KEYS as readonly string[]).includes(key)) continue;
    out[key] = strip((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** FNV-1a over canonical JSON. Deterministic across machines and runs. */
function hash(value: unknown): string {
  const text = JSON.stringify(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function specHasRange(spec: Scenario): boolean {
  let found = false;
  const walk = (v: unknown) => {
    if (found || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) return v.forEach(walk);
    if ("min" in v && "max" in v && "steps" in v) {
      found = hasRange(v as never);
      if (found) return;
    }
    Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(spec);
  return found;
}

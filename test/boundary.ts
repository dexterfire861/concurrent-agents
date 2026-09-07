/**
 * The boundary the fixtures are written against, plus a clearly-marked TODO
 * shim that loads the real implementations once they exist.
 *
 * WHY A SHIM AT ALL. `src/spec/validate.ts`, `src/eval/evaluate.ts` and
 * `src/runtime/run.ts` do not exist yet. A static `import` of a missing module
 * is a COMPILE error, and these tests are meant to fail at RUNTIME with
 * "not implemented" — a compile failure would take the whole typecheck down
 * with them and hide every other error in the repo.
 *
 * So the signatures are DECLARED here (they are the executable definition of
 * what must be built) and the modules are pulled in through a dynamic import
 * whose specifier is a variable, which TypeScript does not resolve. The day
 * the real files land, every loader below finds them with no edit to any test.
 *
 * Nothing in this file implements any scoring. If you find yourself computing
 * a payoff here, stop: that belongs in src/.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

import type { Scenario } from "../src/spec/types.js";
import type { RunTrace } from "../src/trace/types.js";
import type {
  ClaimVerdict,
  EvaluationReport,
  EvaluatorView,
} from "../src/eval/report.js";

// ---------------------------------------------------------------------------
// Declared interfaces — the contract under test
// ---------------------------------------------------------------------------

/** One error or warning. `path` is a JSON pointer into the spec. */
export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
}

/**
 * What `validate(spec)` returns, per plan section 6. Two tiers in one value:
 * `errors`/`warnings` answer "is it well-formed", `claimVerdicts` answers
 * "is it actually the game it claims to be".
 *
 * CONTRACT: `claimVerdicts` has exactly one entry per `spec.claims` entry, in
 * order, EVEN WHEN `errors` is non-empty. A claim the validator cannot judge
 * because of a blocking error must come back `refuted` with a witness naming
 * that error — never `confirmed`. `ClaimVerdict.verdict` has no third state,
 * so silence would have to be encoded as one of the two, and refuting is the
 * only safe direction.
 */
export interface ValidationResult {
  readonly errors: readonly ValidationIssue[];
  readonly warnings: readonly ValidationIssue[];
  readonly claimVerdicts: readonly ClaimVerdict[];
}

/** Pure. Same spec, same result, forever. No I/O, no clock, no RNG. */
export type Validate = (spec: Scenario) => ValidationResult;

/** Pure. The signature is `Evaluate` from src/eval/report.ts, restated here. */
export type Evaluate = (
  spec: EvaluatorView<Scenario>,
  trace: EvaluatorView<RunTrace>,
) => EvaluationReport;

/**
 * Deterministic given (spec, seed). Used only by the determinism property
 * test. This is the one boundary the plan's file table does not name, so its
 * location is a choice made here and recorded in configs/README.md.
 */
export type RunScenario = (spec: Scenario) => Promise<RunTrace>;

// ---------------------------------------------------------------------------
// TODO shim — replace nothing, delete nothing; these resolve once src/ lands
// ---------------------------------------------------------------------------

/** Prefix on every "the implementation does not exist yet" failure. */
export const NOT_IMPLEMENTED = "NOT_IMPLEMENTED";

const IMPL = {
  /** TODO: src/spec/validate.ts must export `validate`. Plan section 6. */
  validate: { module: "../src/spec/validate.js", name: "validate" },
  /**
   * TODO: src/eval/evaluate.ts must export `evaluate`, dispatching on
   * `spec.family` to src/eval/strategic.ts (System A) or
   * src/eval/extensive.ts (System B). The plan's file table names the two
   * solvers but no single entry point; the tests need one, so this is it.
   */
  evaluate: { module: "../src/eval/evaluate.js", name: "evaluate" },
  /** TODO: src/runtime/run.ts must export `runScenario`. Not in the plan's
   *  file table; named here so the determinism test has something to bind to. */
  runScenario: { module: "../src/runtime/run.js", name: "runScenario" },
} as const;

async function load<T>(key: keyof typeof IMPL): Promise<T> {
  const { module: specifier, name } = IMPL[key];
  let mod: Record<string, unknown>;
  try {
    // Variable specifier on purpose: keeps tsc from resolving a file that is
    // not written yet, so these tests fail at runtime rather than at compile.
    mod = (await import(specifier)) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      `${NOT_IMPLEMENTED}: ${specifier} does not exist yet. ` +
        `This test is the specification for it, not a regression.`,
      { cause },
    );
  }
  const fn = mod[name];
  if (typeof fn !== "function") {
    throw new Error(
      `${NOT_IMPLEMENTED}: ${specifier} exists but exports no \`${name}\` function.`,
    );
  }
  return fn as T;
}

export const loadValidate = (): Promise<Validate> => load<Validate>("validate");
export const loadEvaluate = (): Promise<Evaluate> => load<Evaluate>("evaluate");
export const loadRunScenario = (): Promise<RunScenario> =>
  load<RunScenario>("runScenario");

// ---------------------------------------------------------------------------
// Fixture loading
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
export const CONFIGS_DIR = join(here, "..", "configs");
export const GOLDEN_DIR = join(CONFIGS_DIR, "golden");
export const ADVERSARIAL_DIR = join(CONFIGS_DIR, "adversarial");

export interface Fixture {
  readonly name: string;
  readonly path: string;
  readonly source: string;
  readonly spec: Scenario;
}

/**
 * Parse a fixture. The cast is unavoidable: YAML is untyped at runtime, and
 * checking that the parsed object really is a Scenario is precisely the job of
 * `validate`, which is what these tests exercise.
 */
export function loadFixture(dir: string, name: string): Fixture {
  const path = join(dir, name);
  const source = readFileSync(path, "utf8");
  return {
    name,
    path,
    source,
    spec: parseYaml(source) as Scenario,
  };
}

export function listFixtures(dir: string): readonly Fixture[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => loadFixture(dir, f));
}

/** Look one up by file name, so a test can name the fixture it is about. */
export function golden(name: string): Fixture {
  return loadFixture(GOLDEN_DIR, name);
}

export function adversarial(name: string): Fixture {
  return loadFixture(ADVERSARIAL_DIR, name);
}

// ---------------------------------------------------------------------------
// Evaluator blindness helpers
// ---------------------------------------------------------------------------

/**
 * Exactly the FreeTextKey list in src/eval/report.ts. Kept in sync by the
 * blindness test, which asserts a stripped spec contains none of them.
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

/** Runtime counterpart of `EvaluatorView`: a deep clone with free text removed. */
export function blind<T>(value: T): EvaluatorView<T> {
  return strip(value) as EvaluatorView<T>;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if ((FREE_TEXT_KEYS as readonly string[]).includes(k)) continue;
    out[k] = strip(v);
  }
  return out;
}

/**
 * Hand the evaluator a spec that STILL CARRIES its free text, so blindness is
 * tested behaviourally rather than tautologically. If the test stripped the
 * text itself before both calls, scrambling it afterwards would be a no-op and
 * the test would prove nothing.
 */
export function unstripped<T>(value: T): EvaluatorView<T> {
  return value as unknown as EvaluatorView<T>;
}

/** Replace every free-text string with noise. Structure untouched. */
export function scrambleText<T>(value: T, tag = "SCRAMBLED"): T {
  return scramble(value, tag, { n: 0 }) as T;
}

function scramble(
  value: unknown,
  tag: string,
  counter: { n: number },
): unknown {
  if (Array.isArray(value)) return value.map((v) => scramble(v, tag, counter));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if ((FREE_TEXT_KEYS as readonly string[]).includes(k) && typeof v === "string") {
      counter.n += 1;
      out[k] = `${tag}-${counter.n}-${"zqx".repeat(counter.n % 7)}`;
    } else {
      out[k] = scramble(v, tag, counter);
    }
  }
  return out;
}

/** How many free-text strings a value carries. Guards against a no-op scramble. */
export function countFreeText(value: unknown): number {
  if (Array.isArray(value))
    return value.reduce<number>((n, v) => n + countFreeText(v), 0);
  if (value === null || typeof value !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(value)) {
    if ((FREE_TEXT_KEYS as readonly string[]).includes(k) && typeof v === "string") n += 1;
    else n += countFreeText(v);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

/**
 * Key-sorted JSON. Used for "byte-identical" assertions so that a difference
 * in property insertion order — which is not a difference in the report — does
 * not masquerade as a leak.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(value as Record<string, unknown>).sort()) {
    out[k] = sortKeys((value as Record<string, unknown>)[k]);
  }
  return out;
}

/** The tolerance every golden fixture states in its header. */
export const TOL = 1e-9;

export function closeTo(actual: number, expected: number, tol = TOL): boolean {
  return Number.isFinite(actual) && Math.abs(actual - expected) <= tol;
}

/** Pull the verdict for a claim of a given kind. Fixtures name the kind. */
export function verdictFor(
  result: ValidationResult,
  kind: string,
): ClaimVerdict | undefined {
  return result.claimVerdicts.find((v) => v.claim.kind === kind);
}

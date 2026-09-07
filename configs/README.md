# The two corpora

Every file here is a `Scenario` (`src/spec/types.ts`) written as YAML. They sit
in three places, and the difference is what the test suite is entitled to
assert about them.

| Directory | What it is | What the tests assert |
|---|---|---|
| `configs/*.yaml` | Working scenarios. The office-hours example is the worked one from the plan. | Parses, round-trips. |
| `configs/golden/` | Scenarios with **closed-form known answers**. | Validates clean, every claim `confirmed`, and the evaluated theory matches the derivation in the file header to a stated tolerance. |
| `configs/adversarial/` | Scenarios that are structurally valid, pass a schema check, and whose **claims are false**. | At least one named claim comes back `refuted`, **with a witness**. |

The adversarial corpus does double duty. It is the validator's regression
suite, and it is the hard-negative dataset for fine-tuning the generator
(plan section 11, source 3): a spec that is flawless in shape and false in
substance is exactly the failure mode worth training against.

## Why these are exact tests and not smoke tests

Every golden fixture has a closed form, so the assertion is `equal`, not
`looks reasonable`. Three of them are worth calling out:

- `second-price-auction.yaml` — truthful bidding has **exactly zero** ex-post
  regret. Not approximately zero. Any other number means the evaluator is
  broken, and it costs nothing to check.
- `party-threshold-regret.yaml` — the plan's party case. `price_taking` must
  report 0 and `ex_post_aggregate_corrected` must report 7, for the same agent
  on the same night. This is the guard on the most likely correctness bug in
  the system.
- `rubinstein-bargaining.yaml` — discount factors chosen so
  `(1-d2)/(1-d1*d2)` lands exactly on the offer grid, so the assertion is not
  fighting float error.

## Adding a fixture

1. **Derive the answer first, on paper, before writing the YAML.** If you write
   the spec first you will end up asserting whatever the code returns, and the
   fixture stops being a test.

2. **Write the derivation into the file header, showing the arithmetic.**
   Follow `configs/office-hours-crowding.yaml`. A reader must be able to check
   your number without running anything. Open with `# GOLDEN` or
   `# ADVERSARIAL` — the corpus tests check for it.

3. **State the semantics you relied on.** Where the payoff formula is pinned by
   a `FORMULA` comment in `src/spec/types.ts`, quote it. Where it is not, say
   what you assumed and why. A fixture resting on an unstated convention is a
   trap for whoever implements the solver.

4. **If you cannot derive it confidently, say so in the file.** A wrong golden
   answer is worse than a missing one: it will be treated as ground truth and
   the implementation will be bent to match it. Write down what you could not
   settle and leave that part unasserted. `granovetter-cascade.yaml` does this
   for `equilibriumLevel`, which the plan does not pin when there are three
   equilibria.

5. **Adversarial files must name their target.** The header must contain
   `MUST BE REFUTED:` naming the claim, and `WITNESS` describing the
   counterexample the report should carry. The corpus tests check for both
   strings.

6. **Make the adversarial file pass everything except the one check.** The
   value of `stag-hunt-equilibria-coincide.yaml` is that it satisfies the
   ordering, the equilibrium count, and the no-dominance test, and fails only
   on risk dominance. A fixture that fails five checks at once does not tell
   you which one is doing the work. Each header has a `WHAT PASSES` section for
   this reason.

7. **Give it a unique `metadata.id`** and add a `golden` or `adversarial` tag.

8. **Add the assertions** to `test/golden.test.ts` or
   `test/adversarial.test.ts`, quoting the derived numbers.

Most golden fixtures come with an adversarial twin that differs in one number:

| Golden | Adversarial twin | The single difference |
|---|---|---|
| `stag-hunt.yaml` | `stag-hunt-equilibria-coincide.yaml` | `T`, `P` |
| `prisoners-dilemma.yaml` | `prisoners-dilemma-no-dominance.yaml` | `S` vs `P` swapped |
| `granovetter-cascade.yaml` | `cascade-only-trivial-fixed-points.yaml` | spread thresholds vs a point mass |
| `linear-public-good.yaml` | `social-dilemma-already-efficient.yaml` | `mpcr` 0.5 vs 1.25 |
| `second-price-auction.yaml` | `dsic-on-first-price-auction.yaml` | `rule.kind` |
| `morris-contagion-cycle.yaml` | `contagion-disconnected-graph.yaml` | one edge moved |
| `rubinstein-bargaining.yaml` | `bargaining-disagreement-above-frontier.yaml` | `disagreement` |
| `congestion-office-hours.yaml` | `monotonicity-sign-contradiction.yaml` | declared `monotonicity` |

Keeping a twin honest is the cheapest way to be sure a check is actually
discriminating rather than passing by accident.

## Conventions these fixtures rely on

These are the places where the types leave something open and a fixture had to
pick. Each is restated in the header of every file that depends on it.

**`symmetric_2x2` action order.** The type gives `R`/`S`/`T`/`P` but does not
say which action label is the cooperative one. Convention: the **first** entry
in `actions.actions` is cooperate, the second is defect. So `R` = both play
`actions[0]`, `P` = both play `actions[1]`.

**Two readings of `social_dilemma`.** The type comment says "some equilibrium
is Pareto-dominated". Plan section 6 says "verify the settled level is
genuinely worse than the best level" — a **welfare** test. These are different,
and the corpus contains a case that separates them:

- `linear-public-good.yaml` and `trust-game.yaml` are dilemmas under **both**
  readings. Every agent is strictly better off at the efficient outcome.
- `congestion-office-hours.yaml` is a dilemma under the **welfare** reading
  only. Equilibrium welfare is 102 against an efficient 146, but moving from a
  turnout of 12 to 8 pushes four attendees from 4 down to 3, so it is not
  Pareto-dominated. The plan's own worked example calls this `confirmed`, so
  the welfare reading is what the fixtures assume — and it is written down here
  rather than left as a discrepancy for a future implementer to resolve
  silently.

**What "a fixed point" means in the aggregate family.** Two candidate
definitions, and they do not always agree:

- *Naive iterate:* `G(x) = #{i : agent i wants to act at observed level x}`,
  and a fixed point is `G(x) = x`.
- *Marginal (the one this repo uses):* level `x` is an equilibrium when no
  agent has a profitable unilateral deviation, **with the deviator's own action
  recounted** — because `includesSelf` is true, joining moves the statistic to
  `x+1` and leaving moves it to `x-1`.

`granovetter-cascade.yaml` was constructed so both agree (and its header shows
both calculations). `congestion-office-hours.yaml` is a case where only the
marginal definition works at all: every attendee has the same payoff, so the
naive map flips the whole population between 0 and 30 and never settles, while
the marginal definition gives a unique equilibrium at 12. **Stability** means a
plus-or-minus-one perturbation returns to the level; a `tippingPoint` is a
fixed point that is not stable.

**Errors and verdicts are independent.** `validate` returns
`{ errors, warnings, claimVerdicts }`, and `claimVerdicts` must have one entry
per declared claim **even when `errors` is non-empty**. `ClaimVerdict.verdict`
has only `confirmed | refuted`, so a claim that cannot be judged because of a
blocking error must come back `refuted` with a witness naming that error —
never `confirmed`. Two adversarial fixtures rely on this
(`bargaining-disagreement-above-frontier.yaml` and
`sequential-perfect-recall-violation.yaml`): they produce both a hard error and
a refuted verdict, and the tests assert both.

**Where the implementations are expected to live.** The tests bind to these
paths through a dynamic import in `test/boundary.ts`, so they resolve with no
edit the day the files land:

| Path | Export | Source |
|---|---|---|
| `src/spec/validate.ts` | `validate(spec)` | Plan section 13. |
| `src/eval/evaluate.ts` | `evaluate(spec, trace)` | **Chosen here.** The plan names `src/eval/strategic.ts` (System A) and `src/eval/extensive.ts` (System B) but no single entry point; the tests need one that dispatches on `family`. |
| `src/runtime/run.ts` | `runScenario(spec)` | **Chosen here.** Not in the plan's file table; needed only by the determinism property test. |

## Running them

```
npm run typecheck   # types compile, including test/union.type-test.ts
npm test            # node:test, no framework dependency
```

`npm test` currently fails almost everywhere, on purpose. `validate`,
`evaluate` and `runScenario` do not exist yet, and these tests are the
executable definition of what they must do. Only the round-trip and
corpus-shape tests pass today. Every other failure reads
`NOT_IMPLEMENTED: <path> does not exist yet.`

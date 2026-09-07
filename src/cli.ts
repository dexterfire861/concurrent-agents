/**
 * The first slice: validate a scenario, run it, score it, print two reports.
 *
 *   npm run eval configs/golden/congestion-office-hours.yaml
 *
 * No LLM is involved anywhere. The runtime is the deterministic reference
 * player in src/runtime/run.ts, and the evaluator is pure. Output is plain
 * text with no escape codes, so it pipes and diffs cleanly.
 */

import { readFileSync } from "node:fs";
import { parse } from "yaml";

import type { Scenario } from "./spec/types.js";
import { validate } from "./spec/validate.js";
import { evaluate } from "./eval/evaluate.js";
import { runScenario } from "./runtime/run.js";
import type { EvaluationReport } from "./eval/report.js";

const out = (s: string) => process.stdout.write(s);

function heading(text: string): void {
  out(`\n${text}\n${"-".repeat(text.length)}\n`);
}

function row(label: string, value: unknown): void {
  out(`  ${label.padEnd(26)} ${String(value)}\n`);
}

function round(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

async function main(): Promise<number> {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: npm run eval <spec.yaml>\n");
    return 2;
  }

  const spec = parse(readFileSync(path, "utf8")) as Scenario;
  out(`\n${spec.metadata.id}  [${spec.family}, seed ${spec.seed}]\n`);

  // ---- report 1: well-formed, and is it the game it claims to be? ----
  heading("VALIDATION");
  const result = validate(spec);

  for (const e of result.errors) out(`  ERROR    ${e.path}  ${e.message}\n`);
  for (const w of result.warnings) out(`  warn     ${w.path}  ${w.message}\n`);
  if (result.errors.length === 0 && result.warnings.length === 0) out(`  well-formed\n`);

  if (result.claimVerdicts.length === 0) out(`  (no claims declared)\n`);
  for (const v of result.claimVerdicts) {
    const name = "value" in v.claim ? `${v.claim.kind}:${v.claim.value}` : v.claim.kind;
    out(`  ${v.verdict === "confirmed" ? "CONFIRMED" : "REFUTED  "} ${name}\n`);
    if (v.verdict === "refuted" && v.witness) {
      const reason = (v.witness as { reason?: string }).reason;
      out(`            ${reason ?? JSON.stringify(v.witness)}\n`);
    }
  }

  if (result.errors.length > 0) {
    out(`\nspec is not well-formed; not running it\n\n`);
    return 1;
  }

  // ---- report 2: what theory predicts vs what happened ----
  const trace = await runScenario(spec);
  const report: EvaluationReport = evaluate(spec, trace);

  heading("THEORY (from the spec alone)");
  printTheory(report);

  heading("RUN (deterministic reference player, no LLM)");
  if (trace.rounds.length === 0) {
    out(`  (no reference player for this family yet)\n`);
  } else {
    for (const r of report.measured.perRound) {
      const stat = r.aggregates ? Object.entries(r.aggregates)[0] : undefined;
      row(`round ${r.index}`, `${stat ? `${stat[0]}=${stat[1]}  ` : ""}welfare=${round(r.welfare)}`);
    }
    if (report.measured.equilibriumDistance !== undefined) {
      row("distance from equilibrium", report.measured.equilibriumDistance);
    }
    row("parse failure rate", report.measured.parseFailureRate);
  }

  heading("METHOD");
  row("solver", report.method.equilibrium);
  row("tolerance", report.method.tolerance);
  row("spec hash", report.specHash);
  for (const note of report.incompleteness) out(`  incomplete  ${note}\n`);
  out("\n");
  return 0;
}

function printTheory(report: EvaluationReport): void {
  const t = report.theory;
  switch (t.family) {
    case "aggregate":
      row("equilibrium level", t.equilibriumLevel ?? "did not converge");
      row("efficient level", t.efficientLevel);
      row("welfare gap", round(t.welfareGap));
      row("fixed points",
        t.fixedPoints.map((f) => `${f.level}${f.stable ? "" : "*"}`).join(", ") || "none");
      row("tipping points", t.tippingPoints.join(", ") || "none");
      row("monotonicity", t.monotonicityVerified);
      out(`  (* marks an unstable level, i.e. a tipping point)\n`);
      break;
    case "normal_form":
      row("archetype", t.archetypeDetected ?? "none detected");
      row("pure equilibria",
        t.pureNash.map((p) => Object.values(p).join("/")).join("  ") || "none");
      row("dominant", JSON.stringify(t.dominant));
      row("price of anarchy", t.priceOfAnarchy === undefined ? "n/a" : round(t.priceOfAnarchy));
      break;
    case "sequential":
      row("SPNE", JSON.stringify(t.spne));
      row("equilibrium payoffs", JSON.stringify(t.equilibriumPayoffs));
      for (const c of t.credibility) {
        row(`  ${c.infoset}: "${c.offPathMove}"`, c.credible ? "credible" : "NOT credible");
      }
      break;
    case "bargaining":
      row("Nash bargaining solution", JSON.stringify(t.nashBargainingSolution));
      row("Rubinstein share", JSON.stringify(t.rubinsteinShare));
      row("disagreement point", JSON.stringify(t.disagreement));
      break;
    case "mechanism":
      row("equilibrium bid", t.equilibriumBid);
      row("truthful is dominant", t.dsicVerified);
      row("expected revenue", round(t.expectedRevenue));
      row("expected efficiency", round(t.expectedEfficiency));
      break;
    case "network_local":
      row("nodes / edges", `${t.graphStats.nodes} / ${t.graphStats.edges}`);
      row("components", t.graphStats.components.join(", "));
      row("mean degree", round(t.graphStats.meanDegree));
      row("contagion threshold", t.contagionThreshold ?? "n/a");
      row("predicted cascade", t.predictedCascadeSize ?? "n/a");
      break;
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  },
);

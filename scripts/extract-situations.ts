/**
 * Turn the Adaption dataset into a library of situations you can type into the
 * table.
 *
 * The completions in that CSV each invented their own YAML schema, so none of
 * them round-trip to src/spec/types.ts and none can be scored. What they do
 * carry is prose: a title, a description tighter than the prompt, plus player
 * roles and action labels. That is what this reads out.
 *
 *   npx tsx scripts/extract-situations.ts
 *
 * Writes public/situations.json and prints kept-vs-dropped counts.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSV = path.join(ROOT, "data/game_theory_scenario_yaml.csv");
const OUT = path.join(ROOT, "public/situations.json");

type Situation = {
  id: string;
  title: string;
  premise: string;
  who: string[];
  choices: string[];
  source: "completion" | "prompt" | "hand";
};

/** RFC4180 enough: quoted fields carry embedded newlines and doubled quotes. */
function readCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Completions are usually fenced in ```yaml ... ```. */
function fencedBody(text: string): string {
  const match = /```(?:yaml|yml)?\s*\n([\s\S]*?)```/.exec(text);
  return match ? match[1]! : text;
}

function parseYaml(text: string): unknown {
  try {
    return parse(fencedBody(text));
  } catch {
    return null;
  }
}

type Node = Record<string, unknown>;

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Nodes that describe machinery or one individual, not the room. A description
 * living under one of these is a payoff note or a character sketch.
 */
const OFF_PATH =
  /payoff|utilit|function|equation|formula|player|agent|character|persona|action|strateg|choice|outcome|validation|qa|compliance|metadata_?only|test/i;

/**
 * The keys we want sit at different depths per row — under meta, scenario,
 * scenario_metadata, or the root. Walk breadth-first, shallowest first, and
 * track the path so machinery subtrees can be skipped.
 */
function findString(root: unknown, keys: string[], min: number): string | null {
  const queue: { node: unknown; path: string }[] = [{ node: root, path: "" }];
  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    if (Array.isArray(node)) {
      for (const item of node) queue.push({ node: item, path });
      continue;
    }
    if (!isNode(node)) continue;
    if (!OFF_PATH.test(path)) {
      for (const key of keys) {
        const value = node[key];
        if (typeof value === "string" && collapse(value).length >= min) {
          return collapse(value);
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      queue.push({ node: value, path: `${path}/${key}` });
    }
  }
  return null;
}

/** Role and action labels are strings, or objects with a label-ish field. */
function labelOf(value: unknown): string | null {
  if (typeof value === "string") return collapse(value);
  if (!isNode(value)) return null;
  for (const key of ["role", "label", "name", "title", "id"]) {
    const inner = value[key];
    if (typeof inner === "string" && inner.trim()) return collapse(inner);
  }
  return null;
}

function findLabels(root: unknown, keys: string[]): string[] {
  const queue: unknown[] = [root];
  while (queue.length > 0) {
    const node = queue.shift();
    if (Array.isArray(node)) {
      queue.push(...node);
      continue;
    }
    if (!isNode(node)) continue;
    for (const key of keys) {
      const value = node[key];
      const items = Array.isArray(value) ? value : isNode(value) ? Object.values(value) : [];
      const labels = items.map(labelOf).filter((label): label is string => Boolean(label));
      if (labels.length >= 2) return [...new Set(labels)].slice(0, 6);
    }
    queue.push(...Object.values(node));
  }
  return [];
}

/** Most prompts wrap the situation in an instruction. Strip the lead-in. */
function situationFromPrompt(prompt: string): string {
  const text = collapse(prompt);
  const lead = /^[^.:]{0,140}?(?:yaml|scenario|spec|specification)[^.:]{0,80}?:\s*/i.exec(text);
  return lead ? text.slice(lead[0].length) : text;
}

/**
 * Keep the sentences that describe a room and drop the ones written for a
 * model: instructions, theory framing, and dataset annotations. Row-level
 * rejection would throw away a good scene over a bad closing sentence.
 */
/** "civil vs. social" and "U.S. presidential" are not sentence boundaries. */
function splitSentences(text: string): string[] {
  const HIDE = "\u0001";
  const abbreviations = /\b(?:vs|e\.g|i\.e|etc|approx|cf|al|Dr|Mr|Mrs|Ms|No|Inc|Ltd|St|Fig|U\.S)\.(?=\s)/gi;
  return text
    .replace(abbreviations, (match) => match.replace(/\./g, HIDE))
    .split(/(?<=[.?!])\s+/)
    .map((sentence) => sentence.replaceAll(HIDE, ".").trim());
}

function sceneSentences(text: string): string {
  return splitSentences(text)
    .filter(
      (sentence) =>
        // A sentence not starting clean is debris from an upstream truncation.
        /^["'(]?[A-Z0-9]/.test(sentence) &&
        !INSTRUCTION.test(sentence) &&
        !JARGON.test(sentence) &&
        !ABSTRACT.test(sentence) &&
        !ANNOTATION.test(sentence) &&
        !RESIDUE.test(sentence),
    )
    .join(" ")
    .trim();
}

const DANGLING =
  /\s+(?:a|an|the|and|or|of|to|in|on|for|with|by|from|between|into|whether|that|their|its|which|must|can|will|should|may|are|is|be)$/i;

function titleFromPremise(premise: string): string {
  const first = splitSentences(premise)[0] ?? premise;
  let title = first.split(" ").slice(0, 9).join(" ");
  // An opened parenthesis never closes within nine words.
  if (title.split("(").length > title.split(")").length) {
    title = title.slice(0, title.lastIndexOf("("));
  }
  // Nine words often lands mid-phrase, leaving a title ending in "of a".
  title = title.replace(/[,;:.—-]+$/, "").trim();
  while (DANGLING.test(title)) title = title.replace(DANGLING, "");
  return title.replace(/[,;:.—-]+$/, "").trim();
}

// --- quality gate ---------------------------------------------------------

const META =
  /\brefusal\b|from now on|format all of your responses|ignore (?:previous|prior|all)|system prompt|jailbreak|as an ai\b|respond only in|you are chatgpt/i;

/** The dataset carries roleplay rows that have no place in a demo. */
const UNSAFE =
  /\b(?:dominatrix|submissive|bdsm|fetish|erotic|sexual|nsfw|kink|adult-oriented|hypnotic induction|repressed memory|gore|torture)\b/i;

/**
 * An instruction to a model is not a situation, and neither is an author
 * describing the thing they want built. Most prompt rows are one or the other.
 */
const INSTRUCTION = new RegExp(
  [
    "^(?:model|construct|generate|create|design|write|produce|provide|draft|formalize|analyze|simulate|develop|build|translate|let's|imagine|outline|assume)\\b",
    "\\bi(?:'m| am| need to| want to| will be)?\\s*(?:developing|designing|drafting|building|writing|creating|working on|playing|designing)\\b",
    "\\b(?:provide the|model this as|should be modeled|your task|the story should|the scenario should|the scene needs|describe the scene|keep it raw|ensure the|include the full|step by step)\\b",
    "\\b(?:narrative module|roleplay|role-play|rpg|red-team simulation|campaign setting)\\b",
  ].join("|"),
  "i",
);

/** Theory vocabulary reads as a policy memo, not a room. */
const JARGON = new RegExp(
  [
    "\\b(?:equilibrium|nash|payoffs?|subgame|bayesian|stochastic|rubinstein|externalit)",
    "\\b(?:normal|extensive|finite|infinite)[- ]?(?:form|horizon)\\b",
    "\\b(?:discount factor|backward induction|mechanism design|strategy profile|dominant strategy)\\b",
    "\\b(?:yaml|schema|utility function|utilities|game[- ]theoretic|multi-agent|free[- ]rid|individual rationality|sealed[- ]bid|vcg)\\b",
    "\\b(?:strategic interaction|decision-making problem|aggregate effort|social welfare)\\b",
    "\\b(?:revelation mechanism|mechanism designed|voting mechanism|truthful (?:reporting|revelation|valuations))\\b",
  ].join("|"),
  "i",
);

/**
 * A premise that opens by classifying itself is an abstract, not a scene:
 * "A sequential game model analyzing...", "A formal specification for...".
 */
const ABSTRACT =
  /^(?:(?:a|an|the)\s+)?[\w\-,'() ]{0,60}?\b(?:game|model|modeled|modeling|modelling|scenario|simulation|analysis|formalization|specification|representation|framework|exercise|variant|study)\b/i;

/** A single character sketch is not a situation. Look for a cast. */
const MULTI = /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|both|each|every|several|\d+)\b/i;

/**
 * A scene opens by introducing its cast: a count, an indefinite article, or a
 * setting. Pruning can leave mechanics that reference actors never introduced
 * ("Nature determines the presence of errors..."), which reads as a fragment.
 */
const OPENER =
  /^(?:(?:an?|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\b|(?:in|at|on|during|following|after|inside|aboard|deep)\b)/i;

/** Rows annotate themselves for the trainer. That is not part of the scene. */
const ANNOTATION =
  /\b(?:this text|flavor(?: text)? only|serves only as|no executable|no harmful|contains no|for illustrative purposes|this section|this scenario tests|alternative:)\b/i;

/**
 * Block scalars bleed into sibling keys, so reject anything still YAML-ish.
 * Notation ("(P1, P2)", "exp(-x)") means we grabbed a formula note.
 */
const RESIDUE =
  /:\s*"|^\s*-\s+id:|\b(?:game_type|scenario_id|payoff_matrix|equilibrium_concept|schema_version|move_order|utility_impact)\b|\{\s*\w+\s*:|\(P\d|\b(?:exp|log|min|max)\(|[=≥≤]/;

const MIN = 120;
const MAX = 600;

/**
 * Rows that clear every gate but do not survive reading them. Listed by hand
 * so the curation is visible and the run stays reproducible.
 */
const REJECT = new Set([
  "sit-088", // effort levels 0-10, closer to a homework problem than a room
  "sit-120", // "Exceeding the threshold" — the sentence defining it was pruned
  "sit-423", // Minecraft fan fiction
  "sit-435", // Sender/Receiver labels with no scene behind them
]);

/**
 * The scenes the demo shipped with. The office-hours one is the free-text
 * counterpart to the golden congestion game, so it stays first.
 */
const HAND_WRITTEN: Situation[] = [
  {
    id: "sit-office-hours",
    title: "Office hours, last fifteen minutes",
    premise:
      "Office hours, last fifteen minutes. One professor, five students, three chairs. Everyone needs a signature. Someone is thinking of not going — if it's packed, you wait and still leave empty-handed.",
    who: ["Professor", "Student"],
    choices: ["Attend", "Skip"],
    source: "hand",
  },
  {
    id: "sit-acquisition",
    title: "A kitchen at 1am",
    premise:
      "A kitchen at 1am. Three founders. A $40 million acquisition offer expires tomorrow morning. Two want to take the money. The CTO wants to keep building.",
    who: ["Founder", "CTO"],
    choices: ["Take the offer", "Keep building"],
    source: "hand",
  },
  {
    id: "sit-roommates",
    title: "Sunday night in a walk-up",
    premise:
      "Sunday night. Four roommates in a walk-up. The landlord just texted about the noise. One of them wants the party to keep going. Someone has work at seven.",
    who: ["Roommate"],
    choices: ["Keep the party going", "Shut it down"],
    source: "hand",
  },
];

type Drop =
  | "meta"
  | "unsafe"
  | "no premise"
  | "no scene"
  | "too short"
  | "too long"
  | "headless"
  | "no cast"
  | "curated out"
  | "duplicate";

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function main(): void {
  const rows = readCsv(readFileSync(CSV, "utf8"));
  const header = rows.shift();
  if (!header) throw new Error("empty csv");
  const promptAt = header.indexOf("enhanced_prompt");
  const completionAt = header.indexOf("enhanced_completion");
  if (promptAt < 0 || completionAt < 0) {
    throw new Error(`unexpected columns: ${header.join(", ")}`);
  }

  const kept: Situation[] = [];
  const dropped = new Map<Drop, number>();
  const seen = new Set(HAND_WRITTEN.map((situation) => normalizeKey(situation.title)));
  const drop = (reason: Drop) => dropped.set(reason, (dropped.get(reason) ?? 0) + 1);

  rows.forEach((row, index) => {
    const prompt = row[promptAt] ?? "";
    const completion = row[completionAt] ?? "";
    if (!prompt.trim()) return;

    const id = `sit-${String(index + 1).padStart(3, "0")}`;
    if (REJECT.has(id)) {
      drop("curated out");
      return;
    }

    if (META.test(prompt) || META.test(completion.slice(0, 400))) {
      drop("meta");
      return;
    }
    if (UNSAFE.test(prompt)) {
      drop("unsafe");
      return;
    }

    const doc = parseYaml(completion);
    const fromDoc = findString(doc, ["description", "narrative", "summary", "premise", "context", "scenario_description"], MIN);
    const raw = fromDoc ?? situationFromPrompt(prompt);
    const source: Situation["source"] = fromDoc ? "completion" : "prompt";

    if (!raw) {
      drop("no premise");
      return;
    }

    const premise = sceneSentences(raw);
    if (premise.length < MIN) {
      drop(premise.length === 0 ? "no scene" : "too short");
      return;
    }
    if (premise.length > MAX) {
      drop("too long");
      return;
    }
    if (!OPENER.test(premise)) {
      drop("headless");
      return;
    }

    const who = findLabels(doc, ["players", "agents", "roles"]);
    const choices = findLabels(doc, ["actions", "strategies", "choices", "action_space"]);
    if (who.length < 2 && !MULTI.test(premise)) {
      drop("no cast");
      return;
    }

    const title = findString(doc, ["title"], 6) ?? titleFromPremise(premise);
    const key = normalizeKey(title);
    if (seen.has(key)) {
      drop("duplicate");
      return;
    }
    seen.add(key);

    kept.push({ id, title, premise, who, choices, source });
  });

  const library = [...HAND_WRITTEN, ...kept];
  writeFileSync(OUT, `${JSON.stringify(library, null, 2)}\n`);

  process.stdout.write(`read ${rows.length} rows\n`);
  process.stdout.write(`kept ${kept.length} (+ ${HAND_WRITTEN.length} hand-written)\n`);
  for (const [reason, count] of [...dropped].sort((a, b) => b[1] - a[1])) {
    process.stdout.write(`  dropped ${reason}: ${count}\n`);
  }
  const fromCompletion = kept.filter((s) => s.source === "completion").length;
  process.stdout.write(`  from completion: ${fromCompletion}, from prompt: ${kept.length - fromCompletion}\n`);
  process.stdout.write(`wrote ${path.relative(ROOT, OUT)}\n`);
}

main();

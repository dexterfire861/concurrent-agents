/**
 * One conversation, one process. Mozaik can initialize a runtime only once,
 * so the server starts this file as a child for every run.
 *
 * What it does:
 *   1. Turn the user's situation into a small cast (title, premise, people).
 *   2. Sit those people in a Mozaik room. They only wake when the facilitator
 *      speaks, so they do not reply to each other in an endless loop.
 *   3. Three rounds of concurrent talk.
 *   4. One last model pass: a verdict (decided / split / open) plus short notes.
 *
 * Writes one JSON object per stdout line. Nothing else goes to stdout.
 */
import "dotenv/config";
import {
  Agent,
  DeveloperMessageItem,
  ModelContext,
  ModelMessageItem,
  RuntimeState,
  SituationSpecification,
  UserMessageItem,
  createAgent,
  createHuman,
  defineRuntime,
  type InferenceOutput,
  type SituationContext,
  type SituationHandler,
  type StructuredOutputFormat,
} from "@mozaik-ai/core";
import {
  castFromSpec,
  loadGame,
  scoreFromSpec,
  type Cast,
  type Kind,
  type Player,
  type TallyRow,
} from "./games.js";

const MODEL = "gpt-5.5";
const ROUNDS = 3;
const ROUND_MS = 50_000;

class AppState extends RuntimeState {
  names = new Map<string, string>();
  waiting?: {
    expected: Set<string>;
    got: Map<string, string>;
    finish: () => void;
  };
}

const { initializeRuntime, join, sendMessage, runLoop, resolveRuntime } =
  defineRuntime<AppState>();

type Status = "decided" | "split" | "open";
type Verdict = {
  decided: boolean;
  status: Status;
  outcome: string;
  question: string;
  kind: Kind;
  tally: TallyRow[];
  reading: string;
  notes: string;
};

type Line = { name: string; text: string };

const KINDS = new Set<Kind>(["decision", "crowd", "talk"]);
const STATUSES = new Set<Status>(["decided", "split", "open"]);

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function textOf(output: InferenceOutput): string {
  for (const item of output.items) {
    if (item instanceof ModelMessageItem) return item.content.text.trim();
  }
  throw new Error("the model returned no spoken line");
}

function readJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("expected a JSON object from the model");
  return JSON.parse(text.slice(start, end + 1));
}

async function infer(
  instruction: string,
  prompt: string,
  structuredOutput?: StructuredOutputFormat,
): Promise<string> {
  const runner = resolveRuntime().getInferenceRunner();
  const output = await runner.run({
    model: MODEL,
    context: ModelContext.rehydrate({
      id: crypto.randomUUID(),
      items: [DeveloperMessageItem.create(instruction), UserMessageItem.create(prompt)],
    }),
    ...(structuredOutput ? { structuredOutput } : {}),
  });
  return textOf(output);
}

const CAST_SCHEMA: StructuredOutputFormat = {
  name: "cast",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "premise", "kind", "question", "actions", "players"],
    properties: {
      title: { type: "string" },
      premise: { type: "string" },
      kind: { type: "string", enum: ["decision", "crowd", "talk"] },
      question: { type: "string" },
      actions: {
        type: "array",
        minItems: 2,
        maxItems: 4,
        items: { type: "string" },
      },
      players: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "role", "want"],
          properties: {
            name: { type: "string" },
            role: { type: "string" },
            want: { type: "string" },
          },
        },
      },
    },
  },
};

function asCast(raw: unknown): Cast {
  if (typeof raw !== "object" || raw === null) throw new Error("cast was not an object");
  const rec = raw as Record<string, unknown>;
  if (typeof rec.title !== "string" || typeof rec.premise !== "string") {
    throw new Error("cast was missing a title or premise");
  }
  if (!Array.isArray(rec.players)) throw new Error("cast was missing players");
  const players = rec.players
    .map((row): Player | null => {
      if (typeof row !== "object" || row === null) return null;
      const p = row as Record<string, unknown>;
      if (typeof p.name !== "string" || typeof p.role !== "string" || typeof p.want !== "string") {
        return null;
      }
      return { name: p.name.trim(), role: p.role.trim(), want: p.want.trim() };
    })
    .filter((p): p is Player => p !== null && p.name.length > 0)
    .slice(0, 6);
  if (players.length < 2) throw new Error("need at least two people at the table");
  const kind: Kind = KINDS.has(rec.kind as Kind) ? (rec.kind as Kind) : "decision";
  const question =
    typeof rec.question === "string" && rec.question.trim()
      ? rec.question.trim()
      : "What will they do?";
  const actions = Array.isArray(rec.actions)
    ? rec.actions
        .filter((row): row is string => typeof row === "string")
        .map((row) => row.trim())
        .filter((row) => row.length > 0)
        .slice(0, 4)
    : [];
  return {
    title: rec.title.trim(),
    premise: rec.premise.trim(),
    kind,
    question,
    actions: actions.length >= 2 ? actions : ["yes", "no"],
    players,
  };
}

const VERDICT_SCHEMA: StructuredOutputFormat = {
  name: "verdict",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["decided", "status", "outcome", "question", "kind", "tally", "reading", "notes"],
    properties: {
      decided: { type: "boolean" },
      status: { type: "string", enum: ["decided", "split", "open"] },
      outcome: { type: "string" },
      question: { type: "string" },
      kind: { type: "string", enum: ["decision", "crowd", "talk"] },
      tally: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "action"],
          properties: {
            name: { type: "string" },
            action: { type: "string" },
          },
        },
      },
      reading: { type: "string" },
      notes: { type: "string" },
    },
  },
};

function matchAction(text: string, actions: string[]): string | null {
  const hay = text.toLowerCase();
  let found: { action: string; at: number } | null = null;
  for (const action of actions) {
    const needle = action.toLowerCase();
    if (!needle) continue;
    const at = hay.indexOf(needle);
    if (at < 0) continue;
    if (!found || needle.length > found.action.length || (needle.length === found.action.length && at < found.at)) {
      found = { action, at };
    }
  }
  return found?.action ?? null;
}

function lastLines(lines: Line[]): Map<string, string> {
  const last = new Map<string, string>();
  for (const line of lines) last.set(line.name, line.text);
  return last;
}

function tallyFromSpeech(cast: Cast, lines: Line[]): TallyRow[] {
  const last = lastLines(lines);
  return cast.players.map((player) => ({
    name: player.name,
    action: matchAction(last.get(player.name) ?? "", cast.actions) ?? "uncommitted",
  }));
}

function statusFromTally(tally: TallyRow[], n: number): Status {
  const committed = tally.filter((row) => row.action !== "uncommitted");
  if (committed.length === 0) return "open";
  const counts = new Map<string, number>();
  for (const row of committed) counts.set(row.action, (counts.get(row.action) ?? 0) + 1);
  const top = Math.max(...counts.values());
  if (top > n / 2) return "decided";
  if (counts.size > 1) return "split";
  return committed.length < Math.ceil(n / 2) ? "open" : "decided";
}

function crowdReading(tally: TallyRow[], actions: string[]): string {
  const goish = actions.filter((action) => /go|attend|show|join|come|sit|sign/i.test(action));
  const went = tally.filter((row) => goish.includes(row.action) || /go|attend|show|join|come/i.test(row.action)).length;
  return `${went} of ${tally.length} went. That's why people skip a packed room — it gets worse when everyone shows up.`;
}

function asVerdict(raw: unknown, cast: Cast, lines: Line[]): Verdict {
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const modelTally = Array.isArray(rec.tally)
    ? rec.tally
        .map((row): TallyRow | null => {
          if (typeof row !== "object" || row === null) return null;
          const item = row as Record<string, unknown>;
          if (typeof item.name !== "string" || typeof item.action !== "string") return null;
          const name = item.name.trim();
          const action = item.action.trim();
          if (!name || !action) return null;
          return { name, action: matchAction(action, cast.actions) ?? action };
        })
        .filter((row): row is TallyRow => row !== null)
    : [];
  const inferred = tallyFromSpeech(cast, lines);
  const byName = new Map(modelTally.map((row) => [row.name, row.action]));
  const tally = inferred.map((row) => ({
    name: row.name,
    action: byName.get(row.name) ?? row.action,
  }));
  const modelStatus = STATUSES.has(rec.status as Status) ? (rec.status as Status) : null;
  const vague =
    modelStatus === null ||
    modelTally.length === 0 ||
    typeof rec.outcome !== "string" ||
    !rec.outcome.trim() ||
    tally.every((row) => row.action === "uncommitted");
  const status = vague ? statusFromTally(tally, cast.players.length) : modelStatus;
  const kind = KINDS.has(rec.kind as Kind) ? (rec.kind as Kind) : cast.kind;
  let reading = typeof rec.reading === "string" ? rec.reading.trim() : "";
  if (kind === "crowd" && (vague || reading.length < 12)) reading = crowdReading(tally, cast.actions);
  const outcome =
    typeof rec.outcome === "string" && rec.outcome.trim()
      ? rec.outcome.trim()
      : status === "decided"
        ? `They settled it: ${tally.map((row) => row.action).join(", ")}.`
        : status === "split"
          ? "They chose incompatible things, and nobody closed it."
          : "No one committed.";
  return {
    decided: status === "decided",
    status,
    outcome,
    question: typeof rec.question === "string" && rec.question.trim() ? rec.question.trim() : cast.question,
    kind,
    tally,
    reading:
      reading ||
      (status === "decided" ? "A clear shared outcome landed." : status === "split" ? "The table split." : "It stayed open."),
    notes: typeof rec.notes === "string" ? rec.notes.trim() : "",
  };
}

class WhenFacilitatorSpeaks extends SituationSpecification {
  constructor(private readonly facilitatorId: string) {
    super();
  }
  isSatisfiedBy({ event, participant }: SituationContext): boolean {
    return (
      event.type === "message.sent" &&
      event.producerId === this.facilitatorId &&
      event.producerId !== participant.getId()
    );
  }
}

class WhenSomeoneAnswers extends SituationSpecification {
  isSatisfiedBy({ event }: SituationContext): boolean {
    return event.type === "model.answer";
  }
}

function waitForRound(state: AppState, ids: string[]): Promise<Map<string, string>> {
  return new Promise((resolve) => {
    const got = new Map<string, string>();
    const expected = new Set(ids);
    const done = () => {
      clearTimeout(timer);
      state.waiting = undefined;
      resolve(got);
    };
    const timer = setTimeout(done, ROUND_MS);
    state.waiting = { expected, got, finish: done };
  });
}

type Start = { scenario?: string; game?: string };

async function readStart(): Promise<Start> {
  const fromArg = process.argv.slice(2).join(" ").trim();
  const raw = fromArg || (await readStdin());
  if (raw.startsWith("{")) {
    try {
      const rec = JSON.parse(raw) as { scenario?: unknown; game?: unknown };
      if (typeof rec.game === "string" && rec.game.trim()) return { game: rec.game.trim() };
      if (typeof rec.scenario === "string" && rec.scenario.trim()) return { scenario: rec.scenario.trim() };
    } catch {
      /* fall through and treat the whole string as a situation */
    }
  }
  return { scenario: raw };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing from .env");
  }

  const start = await readStart();
  if (!start.game && (!start.scenario || start.scenario.length < 8)) {
    throw new Error("write a situation first");
  }

  const state = new AppState();
  initializeRuntime({ state });

  emit({ type: "status", text: start.game ? "Sitting the game…" : "Casting the table…" });

  const spec = start.game ? loadGame(start.game) : null;
  // Empty for a golden game, whose scene comes from the frozen spec instead.
  const source = spec ? "" : start.scenario!.trim();
  const cast = spec
    ? castFromSpec(spec)
    : asCast(
        readJsonObject(
          await infer(
            "You turn a situation into a small table conversation. Stay inside the situation you are given. Do not move it to another setting, and do not add facts it does not contain.\n\nPeople: if the situation already says who is involved — named people, roles, sides, factions — seat exactly those and keep their identity in the name. Keep each name short, one or two words: Fire, not Leader of the Fire Guild. Invent people, with first names, only when the situation names none. Seat 3 to 5 of them, and give each one something specific and human they want.\n\nActions: if the situation already states the choices, use exactly those. Otherwise pick 2 to 4 short labels people can actually choose, like accept/reject, go/stay, sign now/wait.\n\ntitle names this situation, in its own terms. premise is two or three sentences putting that same situation in a room — a scene, not a lecture, and not a new story.\n\nAlso set kind and question. kind is decision if they must resolve something (take the offer, sign, stay or go), crowd if the tension is whether people show up to a scarce thing (office hours with few chairs, a packed party — someone might skip because it will be worse if everyone goes), talk if they are mostly talking it through. question is one sentence that must be resolved, like 'Do they take the offer?' or 'Do you go to office hours?'. No game theory. No payoff numbers.",
            start.scenario!,
            CAST_SCHEMA,
          ),
        ),
      );

  emit({
    type: "cast",
    title: cast.title,
    premise: cast.premise,
    kind: cast.kind,
    question: cast.question,
    actions: cast.actions,
    players: cast.players,
  });

  const facilitator = createHuman({ name: "Table", capabilities: [], handlers: [] });

  const listen: SituationHandler = {
    specification: new WhenSomeoneAnswers(),
    processor: {
      apply({ event }) {
        const waiting = state.waiting;
        if (!waiting || !waiting.expected.has(event.producerId)) return;
        if (waiting.got.has(event.producerId)) return;
        const payload = event.payload as { answer: ModelMessageItem };
        const text = payload.answer.content.text.trim();
        if (!text) return;
        waiting.got.set(event.producerId, text);
        emit({
          type: "speech",
          name: state.names.get(event.producerId) ?? event.producerId,
          text,
        });
        if (waiting.got.size >= waiting.expected.size) waiting.finish();
      },
    },
  };

  const watcher = createHuman({
    name: "Watcher",
    capabilities: [],
    handlers: [listen],
  });

  join(facilitator);
  join(watcher);

  const thinkOnCue: SituationHandler = {
    specification: new WhenFacilitatorSpeaks(facilitator.getId()),
    processor: {
      apply({ event, participant }) {
        if (!(participant instanceof Agent)) return;
        const { message } = event.payload as { message: string };
        runLoop(participant.getId(), message, {
          model: MODEL,
          context: participant.getMemory().getContext(),
          tools: participant.getTools(),
        });
      },
    },
  };

  const agents = cast.players.map((player) => {
    const agent = createAgent({
      name: player.name,
      capabilities: ["inference"],
      instruction: `You are ${player.name}, ${player.role}. What you want: ${player.want}. You are sitting at a table with the others. Speak in first person as ${player.name}. One to three short spoken sentences. No stage directions, no lists, no narration. Do not mention being an AI.`,
      tools: [],
      handlers: [thinkOnCue],
    });
    state.names.set(agent.getId(), player.name);
    join(agent);
    return agent;
  });

  const ids = agents.map((agent) => agent.getId());
  const lines: Line[] = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    emit({ type: "round", n: round, of: ROUNDS });

    const heard =
      lines.length === 0
        ? "No one has spoken yet. Open the conversation."
        : `What has been said so far:\n${lines.map((line) => `${line.name}: ${line.text}`).join("\n")}`;

    const last = round === ROUNDS;
    const cue = [
      // The cast is only a reading of the situation. Agents see the original
      // words too, so a loose paraphrase cannot quietly swap in another scene.
      source && `The situation, as it was given:\n${source}`,
      cast.premise,
      `The question: ${cast.question}`,
      `This is round ${round} of ${ROUNDS}.`,
      heard,
      last
        ? `This is the last turn. State clearly what you will do. Use one of these in plain speech: ${cast.actions.join(", ")}.`
        : "Speak to the table, in character, about what you will actually do.",
    ]
      .filter(Boolean)
      .join("\n\n");

    const pending = waitForRound(state, ids);
    sendMessage(cue, facilitator.getId());
    const got = await pending;

    for (const agent of agents) {
      const text = got.get(agent.getId());
      if (!text) continue;
      lines.push({ name: state.names.get(agent.getId()) ?? agent.getId(), text });
    }
  }

  emit({ type: "status", text: "Closing the table…" });

  const transcript = `${cast.title}\n${cast.premise}\nQuestion: ${cast.question}\nKind: ${cast.kind}\nActions: ${cast.actions.join(", ")}\n\n${lines.map((line) => `${line.name}: ${line.text}`).join("\n")}`;
  let rawVerdict: unknown = {};
  try {
    rawVerdict = readJsonObject(
      await infer(
        [
          "You watched this conversation. Extract whether the question was resolved.",
          "decided if a clear shared outcome happened (majority or unanimous action on the question, or someone with authority closed it).",
          "split if they chose incompatible actions and nobody closed it.",
          "open if people hedged or no one committed.",
          "tally each person to one of the given action labels when you can; otherwise say uncommitted.",
          "outcome is one everyday sentence. reading is one or two sentences.",
          "If kind is crowd (office hours, a party, should I go if it's packed), tally go-versus-stay using the action labels, and the reading must say the count in human terms, like: 4 of 5 went for 3 chairs. That's why people skip office hours — it gets worse when everyone shows up.",
          "notes is 2 or 3 short observations about who pushed, who gave in, what changed, then how it ended.",
          "Everyday language. No game theory, no Nash, no regret, no welfare, no payoff formulas, no lecture.",
        ].join(" "),
        transcript,
        VERDICT_SCHEMA,
      ),
    );
  } catch {
    rawVerdict = {};
  }

  const verdict = asVerdict(rawVerdict, cast, lines);
  emit({ type: "verdict", ...verdict });
  if (spec) {
    emit({ type: "score", ...scoreFromSpec(spec, verdict.tally, cast) });
  }
  emit({ type: "done" });
}

main().catch((err: unknown) => {
  emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});

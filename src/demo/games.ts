/**
 * The golden games that fit a table. Everything else in configs/ stays
 * on the evaluator side. Theory is computed from the spec alone — no trace,
 * no evaluate().
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

import { aggregateTheory, normalFormTheory } from "../eval/strategic.js";
import { normalFormMatrix } from "../spec/resolve.js";
import type { Scenario } from "../spec/types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type Kind = "decision" | "crowd" | "talk";
export type Player = { name: string; role: string; want: string };
export type Cast = {
  title: string;
  premise: string;
  kind: Kind;
  question: string;
  actions: string[];
  players: Player[];
};
export type TallyRow = { name: string; action: string };
export type GameCard = { id: string; title: string; blurb: string };
export type TheoryEvent = { lines: string[]; nash?: string; tableVsBook: string };
export type PreviewWho = { name: string; role: string };
export type MatrixCell = { row: number; col: number };
export type MatrixPreview = {
  row: string;
  col: string;
  rowActions: string[];
  colActions: string[];
  cells: MatrixCell[][];
};
export type CongestionPreview = {
  attend: string;
  skip: number;
  samples: { n: number; attend: number; skip: number }[];
};
export type PotPreview = {
  endowment: number;
  mpcr: number;
  samples: { k: number; contribute: number | null; keep: number | null }[];
};
export type GamePreview = {
  id: string;
  title: string;
  premise: string;
  question: string;
  who: PreviewWho[];
  kind: "decision" | "crowd";
  matrix?: MatrixPreview;
  congestion?: CongestionPreview;
  pot?: PotPreview;
  textbook: string;
};
export type ScorePerson = { name: string; action: string; utility: number | null };
export type ScoreEvent = { people: ScorePerson[]; theory: TheoryEvent };

type Entry = {
  id: string;
  file: string;
  blurb: string;
  question: string;
  names: string[];
};

const CATALOG: readonly Entry[] = [
  {
    id: "golden-prisoners-dilemma",
    file: "configs/golden/prisoners-dilemma.yaml",
    blurb: "Two suspects. Talking is safer for you; both talking is worse for both.",
    question: "Do they stay quiet (C) or talk (D)?",
    names: ["Alex", "Sam"],
  },
  {
    id: "golden-stag-hunt",
    file: "configs/golden/stag-hunt.yaml",
    blurb: "Two hunters. A stag feeds both — only if both commit. A hare is certain.",
    question: "Do they hunt the stag or take a hare?",
    names: ["Ren", "Kit"],
  },
  {
    id: "golden-chicken",
    file: "configs/golden/chicken.yaml",
    blurb: "Two drivers. Swerve and lose face, or hold and risk a crash.",
    question: "Do they swerve or go straight?",
    names: ["Vale", "Drew"],
  },
  {
    id: "golden-congestion-office-hours",
    file: "configs/golden/congestion-office-hours.yaml",
    blurb: "Office hours help until the room is packed. That is why people skip.",
    question: "Do you go to office hours?",
    names: ["Priya", "Jordan", "Leo", "Nina", "Sam", "Adele"],
  },
  {
    id: "golden-linear-public-good",
    file: "configs/golden/linear-public-good.yaml",
    blurb: "Four people and a common pot. Putting tokens in helps everyone; keeping them helps you.",
    question: "Do they put the tokens in the pot?",
    names: ["Mira", "Cole", "Tess", "Omar"],
  },
];

const byId = new Map(CATALOG.map((entry) => [entry.id, entry]));

export function listGames(): GameCard[] {
  return CATALOG.map((entry) => {
    const spec = loadGame(entry.id);
    return { id: entry.id, title: spec.metadata.title, blurb: entry.blurb };
  });
}

export function loadGame(id: string): Scenario {
  const entry = byId.get(id);
  if (!entry) throw new Error(`unknown game: ${id}`);
  const raw = parse(readFileSync(path.join(ROOT, entry.file), "utf8")) as Scenario;
  if (raw.metadata.id !== entry.id) throw new Error(`spec id mismatch for ${id}`);
  return raw;
}

function actionLabels(spec: Scenario): string[] {
  if (spec.family !== "normal_form" && spec.family !== "aggregate") return [];
  const space = spec.actions;
  if (space && typeof space === "object" && "kind" in space && space.kind === "discrete") {
    return [...space.actions];
  }
  return [];
}

function crowdPlayers(spec: Scenario, names: string[]): Player[] {
  const roles = spec.population.roles;
  const n = Math.min(6, Math.max(2, names.length));
  const picked = names.slice(0, n);
  const players: Player[] = [];
  let cursor = 0;
  roles.forEach((role, idx) => {
    const count =
      idx === roles.length - 1 ? picked.length - cursor : Math.max(1, Math.round(role.share * picked.length));
    for (let k = 0; k < count && cursor < picked.length; k += 1, cursor += 1) {
      const name = picked[cursor]!;
      players.push({ name, role: role.id, want: role.persona });
    }
  });
  return players;
}

export function castFromSpec(spec: Scenario): Cast {
  const entry = byId.get(spec.metadata.id);
  if (!entry) throw new Error(`spec ${spec.metadata.id} is not a table game`);
  const actions = actionLabels(spec);
  if (actions.length < 2) throw new Error(`spec ${spec.metadata.id} has no actions`);

  const premise = spec.metadata.sourceDescription.trim();
  if (spec.family === "normal_form") {
    const players = spec.population.roles.slice(0, 2).map((role, i) => ({
      name: entry.names[i] ?? role.id,
      role: role.id,
      want: role.persona,
    }));
    return {
      title: spec.metadata.title,
      premise,
      kind: "decision",
      question: entry.question,
      actions,
      players,
    };
  }

  if (spec.family === "aggregate") {
    return {
      title: spec.metadata.title,
      premise,
      kind: "crowd",
      question: entry.question,
      actions,
      players: crowdPlayers(spec, entry.names),
    };
  }

  throw new Error(`spec ${spec.metadata.id} is not a table game`);
}

function profileLabel(profile: Readonly<Record<string, string | number>>): string {
  const values = Object.values(profile).map(String);
  if (values.length === 0) return "none";
  if (values.every((value) => value === values[0])) return `both ${values[0]}`;
  return values.join(" / ");
}

export function theoryFromSpec(spec: Scenario, tally: TallyRow[]): TheoryEvent {
  if (spec.family === "normal_form") {
    const { theory } = normalFormTheory(spec);
    const nash = theory.pureNash.map(profileLabel).join(", or ");
    const lines: string[] = [];
    if (theory.archetypeDetected === "prisoners_dilemma") {
      lines.push("The textbook move is both talk (D). Staying quiet is better for both, but talking is better for you no matter what the other does.");
    } else if (theory.archetypeDetected === "stag_hunt") {
      lines.push("Two textbook endings: both hunt the stag, or both take a hare. The stag feeds everyone better; the hare is safer if you do not trust the other.");
    } else if (theory.archetypeDetected === "chicken") {
      lines.push("Textbook: one swerves and one goes straight. If both go straight they crash.");
    } else if (nash) {
      lines.push(`Textbook Nash: ${nash}.`);
    }
    if (theory.archetypeDetected) {
      lines.push(`This is a ${theory.archetypeDetected.replaceAll("_", " ")}.`);
    }
    const table = tally.map((row) => `${row.name} ${row.action}`).join(", ");
    const matched = matchesNash(tally, theory.pureNash);
    const tableVsBook = matched
      ? `This table landed on a textbook Nash: ${table}.`
      : `This table: ${table}. Textbook Nash: ${nash || "none"}.`;
    return { lines, nash, tableVsBook };
  }

  if (spec.family === "aggregate") {
    const { theory } = aggregateTheory(spec);
    const eq = theory.equilibriumLevel;
    const eff = theory.efficientLevel;
    if (spec.payoff.kind === "linear_public_good") {
      const put = contributeCount(tally);
      const lines = [
        "The textbook move is everyone keeps. Putting tokens in the pot is better for the group, but keeping is better for you no matter what the others do.",
      ];
      const tableVsBook =
        put === 0
          ? `This table landed on the textbook outcome: all ${tally.length || 4} kept.`
          : `At this table ${put} of ${tally.length} put tokens in. Textbook: everyone keeps. All ${eff} contributing is best for everyone.`;
      return { lines, tableVsBook };
    }
    const lines = [
      `In a class of ${Math.round(Number(spec.population.size))} with room for about ${capacityOf(spec)} people, theory says ${eq ?? "?"} show up. ${eff} is best for everyone.`,
    ];
    const go = goCount(tally, actionLabels(spec));
    const tableVsBook = `At this table ${go} of ${tally.length} went. In the class of 30, theory says ${eq ?? "?"} show up; ${eff} is best for everyone.`;
    return { lines, tableVsBook };
  }

  return { lines: [], tableVsBook: "" };
}

function capacityOf(spec: Scenario): number {
  if (spec.family !== "aggregate") return 0;
  const payoff = spec.payoff;
  if (payoff.kind === "congestion") return Number(payoff.capacity);
  return 0;
}

function goCount(tally: TallyRow[], actions: string[]): number {
  const goish = actions.filter((action) => /go|attend|show|join|come|sit/i.test(action));
  return tally.filter((row) => goish.includes(row.action) || /go|attend|show|join|come/i.test(row.action)).length;
}

function contributeCount(tally: TallyRow[]): number {
  return tally.filter((row) => /contribute|put|give/i.test(row.action)).length;
}

function matchesNash(
  tally: TallyRow[],
  nash: readonly Readonly<Record<string, string | number>>[],
): boolean {
  if (tally.some((row) => row.action === "uncommitted")) return false;
  const chosen = tally.map((row) => row.action);
  return nash.some((profile) => {
    const values = Object.values(profile).map(String);
    if (values.length !== chosen.length) return false;
    return values.every((value, i) => value === chosen[i]);
  });
}

export function previewGame(id: string): GamePreview {
  const spec = loadGame(id);
  const cast = castFromSpec(spec);
  const textbook = theoryFromSpec(spec, []).lines[0] ?? "";
  const who = cast.players.map((player) => ({ name: player.name, role: player.role }));

  if (spec.family === "normal_form") {
    return {
      id,
      title: cast.title,
      premise: cast.premise,
      question: cast.question,
      who,
      kind: "decision",
      matrix: matrixPreview(spec, cast),
      textbook,
    };
  }

  if (spec.family === "aggregate" && spec.payoff.kind === "linear_public_good") {
    return {
      id,
      title: cast.title,
      premise: cast.premise,
      question: cast.question,
      who,
      kind: "crowd",
      pot: potPreview(spec),
      textbook,
    };
  }

  return {
    id,
    title: cast.title,
    premise: cast.premise,
    question: cast.question,
    who,
    kind: "crowd",
    congestion: congestionPreview(spec),
    textbook,
  };
}

function matrixPreview(spec: Scenario, cast: Cast): MatrixPreview | undefined {
  if (spec.family !== "normal_form") return undefined;
  const roles = spec.population.roles.slice(0, 2).map((role) => role.id);
  const matrix = normalFormMatrix(spec, roles);
  if (!matrix) return undefined;
  const [rowRole, colRole] = matrix.roles;
  const row = cast.players.find((player) => player.role === rowRole)?.name ?? rowRole;
  const col = cast.players.find((player) => player.role === colRole)?.name ?? colRole;
  const actions = [...matrix.actions];
  return {
    row,
    col,
    rowActions: actions,
    colActions: actions,
    cells: actions.map((rowAction) =>
      actions.map((colAction) => {
        const [rowUtility, colUtility] = matrix.payoff(rowAction, colAction);
        return { row: rowUtility, col: colUtility };
      }),
    ),
  };
}

function congestionNumbers(spec: Scenario): { value: number; slope: number; capacity: number; skip: number } {
  if (spec.family !== "aggregate" || spec.payoff.kind !== "congestion") {
    throw new Error("not a congestion game");
  }
  const payoff = spec.payoff;
  return {
    value: Number(payoff.valueUnderCapacity),
    slope: Number(payoff.slopeOver),
    capacity: Number(payoff.capacity),
    skip: Number(payoff.outsideOption),
  };
}

function attendUtility(spec: Scenario, n: number): number {
  const { value, slope, capacity } = congestionNumbers(spec);
  return value + slope * Math.max(0, n - capacity);
}

function potNumbers(spec: Scenario): { endowment: number; mpcr: number; n: number } {
  if (spec.family !== "aggregate" || spec.payoff.kind !== "linear_public_good") {
    throw new Error("not a public-good game");
  }
  return {
    endowment: Number(spec.payoff.endowment),
    mpcr: Number(spec.payoff.mpcr),
    n: Math.round(Number(spec.population.size)),
  };
}

function potUtilities(spec: Scenario, k: number): { contribute: number; keep: number } {
  const { endowment, mpcr } = potNumbers(spec);
  return {
    contribute: mpcr * k * endowment,
    keep: endowment + mpcr * k * endowment,
  };
}

function potPreview(spec: Scenario): PotPreview {
  const { endowment, mpcr, n } = potNumbers(spec);
  const samples = [0, Math.min(2, n), n].filter((k, i, all) => all.indexOf(k) === i);
  return {
    endowment,
    mpcr,
    samples: samples.map((k) => {
      const { contribute, keep } = potUtilities(spec, k);
      return {
        k,
        contribute: k === 0 ? null : contribute,
        keep: k === n ? null : keep,
      };
    }),
  };
}

function congestionPreview(spec: Scenario): CongestionPreview {
  const { value, slope, capacity, skip } = congestionNumbers(spec);
  const signed = slope < 0 ? `- ${Math.abs(slope)}` : `+ ${slope}`;
  const samples = [4, 8, 12].map((n) => ({
    n,
    attend: attendUtility(spec, n),
    skip,
  }));
  return {
    attend: `${value} ${signed} * max(0, n - ${capacity})`,
    skip,
    samples,
  };
}

export function scoreFromSpec(spec: Scenario, tally: TallyRow[], cast: Cast): ScoreEvent {
  return {
    people: scorePeople(spec, tally, cast),
    theory: theoryFromSpec(spec, tally),
  };
}

function scorePeople(spec: Scenario, tally: TallyRow[], cast: Cast): ScorePerson[] {
  if (spec.family === "normal_form") {
    const roles = spec.population.roles.slice(0, 2).map((role) => role.id);
    const matrix = normalFormMatrix(spec, roles);
    if (!matrix) return tally.map((row) => ({ ...row, utility: null }));
    const [rowRole, colRole] = matrix.roles;
    const rowName = cast.players.find((player) => player.role === rowRole)?.name ?? tally[0]?.name ?? rowRole;
    const colName = cast.players.find((player) => player.role === colRole)?.name ?? tally[1]?.name ?? colRole;
    const rowAction = tally.find((row) => row.name === rowName)?.action;
    const colAction = tally.find((row) => row.name === colName)?.action;
    if (!rowAction || !colAction || rowAction === "uncommitted" || colAction === "uncommitted") {
      return tally.map((row) => ({ name: row.name, action: row.action, utility: null }));
    }
    const [rowUtility, colUtility] = matrix.payoff(rowAction, colAction);
    return [
      { name: rowName, action: rowAction, utility: rowUtility },
      { name: colName, action: colAction, utility: colUtility },
    ];
  }

  if (spec.family === "aggregate" && spec.payoff.kind === "linear_public_good") {
    const k = contributeCount(tally);
    const { contribute, keep } = potUtilities(spec, k);
    return tally.map((row) => {
      if (row.action === "uncommitted") return { name: row.name, action: row.action, utility: null };
      const put = /contribute|put|give/i.test(row.action);
      return { name: row.name, action: row.action, utility: put ? contribute : keep };
    });
  }

  if (spec.family === "aggregate") {
    const n = goCount(tally, actionLabels(spec));
    const skip = congestionNumbers(spec).skip;
    const attend = attendUtility(spec, n);
    return tally.map((row) => {
      if (row.action === "uncommitted") return { name: row.name, action: row.action, utility: null };
      const went = /go|attend|show|join|come/i.test(row.action);
      return { name: row.name, action: row.action, utility: went ? attend : skip };
    });
  }

  return tally.map((row) => ({ name: row.name, action: row.action, utility: null }));
}

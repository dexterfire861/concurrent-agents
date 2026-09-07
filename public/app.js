const SAMPLE =
  "Office hours, last fifteen minutes. One professor, five students, three chairs. Everyone needs a signature. Someone is thinking of not going — if it's packed, you wait and still leave empty-handed.";

const room = document.querySelector("#room");
const form = document.querySelector("#form");
const scenario = document.querySelector("#scenario");
const start = document.querySelector("#start");
const sample = document.querySelector("#sample");
const picked = document.querySelector("#picked");
const table = document.querySelector("#table");
const scene = document.querySelector("#scene");
const sceneTitle = document.querySelector("#scene-title");
const sceneQ = document.querySelector("#scene-q");
const rail = document.querySelector("#rail");
const title = document.querySelector("#title");
const premise = document.querySelector("#premise");
const log = document.querySelector("#log");
const clock = document.querySelector("#clock");
const again = document.querySelector("#again");
const games = document.querySelector("#games");
const inspect = document.querySelector("#inspect");
const inspectTitle = document.querySelector("#inspect-title");
const inspectPremise = document.querySelector("#inspect-premise");
const inspectQuestion = document.querySelector("#inspect-question");
const inspectWho = document.querySelector("#inspect-who");
const inspectPayoffs = document.querySelector("#inspect-payoffs");
const inspectTextbook = document.querySelector("#inspect-textbook");
const sit = document.querySelector("#sit");
const inspectBack = document.querySelector("#inspect-back");
const stage = document.querySelector("#stage");
const results = document.querySelector("#results");
const flag = document.querySelector("#flag");
const outcome = document.querySelector("#outcome");
const tally = document.querySelector("#tally");
const textbook = document.querySelector("#textbook");
const theory = document.querySelector("#theory");
const versus = document.querySelector("#versus");
const notes = document.querySelector("#notes");
const seeResults = document.querySelector("#see-results");
const playEnd = document.querySelector("#play-end");
const freeEnd = document.querySelector("#free-end");
const freeFlag = document.querySelector("#free-flag");
const freeOutcome = document.querySelector("#free-outcome");
const freeTally = document.querySelector("#free-tally");
const freeReading = document.querySelector("#free-reading");
const freeNotes = document.querySelector("#free-notes");
const backTable = document.querySelector("#back-table");
const another = document.querySelector("#another");
const anotherResults = document.querySelector("#another-results");
const known = document.querySelector("#known");

// Used until situations.json loads, and kept as the fallback if it never does.
const EXAMPLES = [
  { title: "Office hours, last fifteen minutes", premise: SAMPLE },
  {
    title: "A kitchen at 1am",
    premise:
      "A kitchen at 1am. Three founders. A $40 million acquisition offer expires tomorrow morning. Two want to take the money. The CTO wants to keep building.",
  },
  {
    title: "Sunday night in a walk-up",
    premise:
      "Sunday night. Four roommates in a walk-up. The landlord just texted about the noise. One of them wants the party to keep going. Someone has work at seven.",
  },
];

let situations = EXAMPLES;
let order = [];

const GAP = 1400;
const queue = [];
let lastSpeech = 0;
let busy = false;
let currentGame = "";
let lastVerdict = null;
let lastScore = null;

loadSituations();

sample?.addEventListener("click", () => {
  const next = nextSituation();
  if (!next) return;
  scenario.value = next.premise;
  picked.textContent = next.title;
  picked.classList.remove("hidden");
  scenario.focus();
});

again?.addEventListener("click", resetTable);
another?.addEventListener("click", resetTable);
anotherResults?.addEventListener("click", resetTable);

inspectBack?.addEventListener("click", () => {
  currentGame = "";
  showView("choose");
});

sit?.addEventListener("click", () => {
  if (!currentGame) return;
  startRun({ game: currentGame });
});

seeResults?.addEventListener("click", () => {
  if (!lastVerdict) return;
  showResults(lastVerdict, lastScore);
  showView("results");
});

backTable?.addEventListener("click", () => showView("play"));

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  currentGame = "";
  startRun({ scenario: scenario.value });
});

for (const button of document.querySelectorAll("[data-game]")) {
  button.addEventListener("click", () => openInspect(button.dataset.game));
}

async function loadSituations() {
  try {
    const response = await fetch("/situations.json");
    if (!response.ok) return;
    const loaded = await response.json();
    if (Array.isArray(loaded) && loaded.length > 0) {
      situations = loaded;
      order = [];
    }
  } catch {
    // Keep the built-in examples so the table never opens broken.
  }
}

/** Walk a shuffled order so repeated clicks do not repeat a scene. */
function nextSituation() {
  if (order.length === 0) {
    order = situations.map((_, index) => index);
    for (let i = order.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }
  return situations[order.pop()];
}

function showView(view) {
  inspect.classList.toggle("hidden", view !== "inspect");
  results.classList.toggle("hidden", view !== "results");
  stage.classList.toggle("hidden", view === "inspect" || view === "results");
  room.classList.toggle("is-play", view === "play");
}

function setReady(on) {
  start.disabled = !on;
  sample.disabled = !on;
  sit.disabled = !on;
  for (const button of games.querySelectorAll("button")) button.disabled = !on;
}

function resetTable() {
  queue.length = 0;
  lastSpeech = 0;
  busy = false;
  currentGame = "";
  lastVerdict = null;
  lastScore = null;
  for (const seat of table.querySelectorAll(".seat")) seat.remove();
  log.replaceChildren();
  title.textContent = "";
  premise.textContent = "";
  sceneTitle.textContent = "";
  sceneQ.textContent = "";
  scene.classList.add("hidden");
  picked.textContent = "";
  picked.classList.add("hidden");
  form.classList.remove("hidden");
  known?.classList.remove("hidden");
  rail.hidden = true;
  playEnd.classList.add("hidden");
  seeResults.classList.add("hidden");
  another.classList.add("hidden");
  freeEnd.classList.add("hidden");
  textbook.classList.add("hidden");
  flag.textContent = "";
  outcome.textContent = "";
  tally.replaceChildren();
  theory.innerHTML = "";
  versus.textContent = "";
  notes.innerHTML = "";
  setReady(true);
  clock.textContent = "Waiting";
  showView("choose");
}

async function openInspect(id) {
  clock.textContent = "Looking at the game";
  const response = await fetch(`/api/games/${encodeURIComponent(id)}`);
  if (!response.ok) {
    clock.textContent = "Could not load that game";
    return;
  }
  const preview = await response.json();
  currentGame = id;
  fillInspect(preview);
  showView("inspect");
  clock.textContent = "Waiting";
}

function fillInspect(preview) {
  inspectTitle.textContent = preview.title ?? "";
  inspectPremise.textContent = preview.premise ?? "";
  inspectQuestion.textContent = preview.question ?? "";
  inspectTextbook.textContent = preview.textbook ?? "";
  inspectWho.replaceChildren();
  for (const person of preview.who ?? []) {
    const item = document.createElement("li");
    item.textContent = `${person.name} — ${person.role}`;
    inspectWho.append(item);
  }
  inspectPayoffs.replaceChildren();
  if (preview.matrix) inspectPayoffs.append(renderMatrix(preview.matrix));
  if (preview.congestion) inspectPayoffs.append(renderCongestion(preview.congestion));
  if (preview.pot) inspectPayoffs.append(renderPot(preview.pot));
}

function renderMatrix(matrix) {
  const tableEl = document.createElement("table");
  tableEl.className = "matrix";
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(cell("th", `${matrix.row} \\ ${matrix.col}`));
  for (const label of matrix.colActions ?? []) headRow.append(cell("th", label));
  head.append(headRow);
  const body = document.createElement("tbody");
  (matrix.rowActions ?? []).forEach((label, i) => {
    const row = document.createElement("tr");
    row.append(cell("th", label));
    for (const pair of matrix.cells?.[i] ?? []) {
      row.append(cell("td", `(${pair.row}, ${pair.col})`));
    }
    body.append(row);
  });
  tableEl.append(head, body);
  return tableEl;
}

function renderPot(pot) {
  const wrap = document.createElement("div");
  wrap.className = "crowd";
  const endowment = document.createElement("p");
  endowment.textContent = `Each person holds ${pot.endowment}.`;
  const mpcr = document.createElement("p");
  mpcr.textContent = `Each token in the pot returns ${pot.mpcr} to everyone.`;
  const tableEl = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(cell("th", "Contributors"), cell("th", "Contribute"), cell("th", "Keep"));
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const sampleRow of pot.samples ?? []) {
    const row = document.createElement("tr");
    row.append(
      cell("td", String(sampleRow.k)),
      cell("td", sampleRow.contribute == null ? "—" : String(sampleRow.contribute)),
      cell("td", sampleRow.keep == null ? "—" : String(sampleRow.keep)),
    );
    body.append(row);
  }
  tableEl.append(head, body);
  wrap.append(endowment, mpcr, tableEl);
  return wrap;
}

function renderCongestion(crowd) {
  const wrap = document.createElement("div");
  wrap.className = "crowd";
  const attend = document.createElement("p");
  attend.textContent = `Attend: ${crowd.attend}`;
  const skip = document.createElement("p");
  skip.textContent = `Skip: ${crowd.skip}`;
  const tableEl = document.createElement("table");
  const head = document.createElement("thead");
  const headRow = document.createElement("tr");
  headRow.append(cell("th", "Crowd"), cell("th", "Attend"), cell("th", "Skip"));
  head.append(headRow);
  const body = document.createElement("tbody");
  for (const sampleRow of crowd.samples ?? []) {
    const row = document.createElement("tr");
    row.append(cell("td", String(sampleRow.n)), cell("td", String(sampleRow.attend)), cell("td", String(sampleRow.skip)));
    body.append(row);
  }
  tableEl.append(head, body);
  wrap.append(attend, skip, tableEl);
  return wrap;
}

function cell(tag, text) {
  const el = document.createElement(tag);
  el.textContent = text;
  return el;
}

async function startRun(body) {
  setReady(false);
  clock.textContent = body.game ? "Sitting the game" : "Casting";
  showView("play");

  const response = await fetch("/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok || !response.body) {
    clock.textContent = "Could not start";
    setReady(true);
    showView(body.game ? "inspect" : "choose");
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      const data = block
        .split("\n")
        .filter((row) => row.startsWith("data:"))
        .map((row) => row.slice(5).trim())
        .join("");
      if (!data.startsWith("{")) continue;
      try {
        handle(JSON.parse(data));
      } catch {
        /* ignore a broken event rather than freeze the table */
      }
    }
  }
}

function handle(event) {
  if (event.type === "status" || event.type === "cast" || event.type === "error") {
    apply(event);
    return;
  }
  queue.push(event);
  pump();
}

function pump() {
  if (busy || queue.length === 0) return;
  const next = queue[0];
  const wait =
    next.type === "speech" && lastSpeech > 0 ? Math.max(0, GAP - (Date.now() - lastSpeech)) : 0;
  busy = true;
  window.setTimeout(() => {
    queue.shift();
    if (next.type === "speech") {
      say(next.name, next.text);
      lastSpeech = Date.now();
    } else {
      apply(next);
    }
    busy = false;
    pump();
  }, wait);
}

function apply(event) {
  switch (event.type) {
    case "status":
      clock.textContent = event.text;
      break;
    case "cast":
      showCast(event);
      break;
    case "round":
      clock.textContent = `Round ${event.n} of ${event.of}`;
      markThinking();
      break;
    case "verdict":
      lastVerdict = event;
      if (!currentGame) showFreeEnd(event);
      break;
    case "score":
      lastScore = event;
      playEnd.classList.remove("hidden");
      seeResults.classList.remove("hidden");
      another.classList.remove("hidden");
      break;
    case "done":
      clock.textContent = "Finished";
      playEnd.classList.remove("hidden");
      if (currentGame) another.classList.remove("hidden");
      break;
    case "error":
      clock.textContent = event.message;
      setReady(true);
      break;
    default:
      break;
  }
}

function showCast(event) {
  form.classList.add("hidden");
  known?.classList.add("hidden");
  scene.classList.remove("hidden");
  rail.hidden = false;
  title.textContent = event.title;
  premise.textContent = event.premise;
  sceneTitle.textContent = event.title;
  sceneQ.textContent = event.question ?? "";
  event.players.forEach((player, index) => {
    const seat = document.createElement("div");
    seat.className = "seat";
    seat.dataset.name = player.name;
    const angle = ((index / event.players.length) * 360 - 90) * (Math.PI / 180);
    const x = 50 + Math.cos(angle) * 46;
    seat.style.left = `${x}%`;
    seat.style.top = `${50 + Math.sin(angle) * 46}%`;
    seat.dataset.side = x < 50 ? "left" : "right";
    seat.innerHTML = `<span class="mark">${escape(player.name.slice(0, 1))}</span><small>${escape(player.name)}</small><span class="dots" aria-hidden="true">…</span><div class="bubble hidden"><strong></strong><p></p></div>`;
    table.append(seat);
    requestAnimationFrame(() => seat.classList.add("on"));
  });
}

function markThinking() {
  for (const seat of table.querySelectorAll(".seat")) {
    seat.classList.add("thinking");
    seat.classList.remove("talking");
  }
}

function say(name, text) {
  for (const seat of table.querySelectorAll(".seat")) {
    const mine = seat.dataset.name === name;
    seat.classList.toggle("talking", mine);
    if (!mine) continue;
    seat.classList.remove("thinking");
    const bubble = seat.querySelector(".bubble");
    const who = bubble.querySelector("strong");
    const line = bubble.querySelector("p");
    who.textContent = name;
    line.textContent = text;
    bubble.classList.remove("hidden");
  }
  const item = document.createElement("li");
  item.innerHTML = `<strong>${escape(name)}</strong><p>${escape(text)}</p>`;
  log.append(item);
  item.scrollIntoView({ block: "nearest" });
}

function showFreeEnd(event) {
  playEnd.classList.remove("hidden");
  freeEnd.classList.remove("hidden");
  const labels = { decided: "DECIDED", split: "SPLIT", open: "STILL OPEN" };
  freeFlag.textContent = labels[event.status] ?? "STILL OPEN";
  freeOutcome.textContent = event.outcome ?? "";
  freeTally.replaceChildren();
  for (const row of event.tally ?? []) {
    const item = document.createElement("li");
    item.textContent = `${row.name} — ${row.action}`;
    freeTally.append(item);
  }
  freeReading.textContent = event.reading ?? "";
  freeNotes.innerHTML = "";
  for (const part of String(event.notes ?? "")
    .split(/\n+/)
    .filter(Boolean)) {
    const p = document.createElement("p");
    p.textContent = part;
    freeNotes.append(p);
  }
}

function showResults(event, score) {
  const labels = { decided: "DECIDED", split: "SPLIT", open: "STILL OPEN" };
  flag.textContent = labels[event.status] ?? "STILL OPEN";
  outcome.textContent = event.outcome ?? "";
  tally.replaceChildren();
  const people = score?.people ?? event.tally ?? [];
  for (const row of people) {
    const item = document.createElement("li");
    const utility = row.utility == null ? "" : ` — ${row.utility}`;
    item.textContent = `${row.name} — ${row.action}${utility}`;
    tally.append(item);
  }
  notes.innerHTML = "";
  for (const part of String(event.notes ?? "")
    .split(/\n+/)
    .filter(Boolean)) {
    const p = document.createElement("p");
    p.textContent = part;
    notes.append(p);
  }
  const theoryEvent = score?.theory;
  if (!theoryEvent) {
    textbook.classList.add("hidden");
    return;
  }
  textbook.classList.remove("hidden");
  theory.innerHTML = "";
  for (const line of theoryEvent.lines ?? []) {
    const p = document.createElement("p");
    p.textContent = line;
    theory.append(p);
  }
  versus.textContent = theoryEvent.tableVsBook ?? "";
}

function escape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

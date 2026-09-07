# Table

People sit. They talk. A frozen spec scores them against the textbook. The table is not the grader.

Five known games, a situation you type, or one of 83 examples. You inspect the payoffs, sit them down, then see each person’s action and utility next to what the book says.

## Run

```bash
cp .env.example .env
```

Put an `OPENAI_API_KEY` in `.env`. Then:

```bash
npm install
npm start
```

Open [http://127.0.0.1:3847](http://127.0.0.1:3847).

Each conversation is a child process — Mozaik (`@mozaik-ai/core` 4.0.5) can initialize a runtime only once. The model is `gpt-5.5`.

## What you can sit

| Game | What it is |
| --- | --- |
| A common pot | Four people. Contribute or keep. Textbook: everyone keeps. |
| Office hours | Crowding. Attend or skip. |
| Prisoner's dilemma | Two suspects. Quiet or talk. |
| Stag hunt | Two hunters. Stag or hare. |
| Chicken | Two drivers. Swerve or straight. |

Free-text situations run the same table. They do not get a textbook page.

## Where the examples come from

"Use an example" draws from [`public/situations.json`](public/situations.json): 80 situations mined from an Adaption Labs dataset, plus 3 written by hand.

The dataset is [`data/game_theory_scenario_yaml.csv`](data/game_theory_scenario_yaml.csv) — 500 prompt/completion pairs, committed so the provenance is visible. It was built for finetuning, and its completions each invent their own schema, none of which matches the `Scenario` type in `src/spec`. So none of them can drive inspect or scoring. Only the prose is used.

[`scripts/extract-situations.ts`](scripts/extract-situations.ts) parses each completion as YAML, walks it for a title and description, and falls back to the prompt. The filtering is per sentence rather than per row, because one closing sentence of theory would otherwise discard a good scene, and the prompts hide real scenes under instruction tails. It drops instructions, author framing, theory vocabulary, self-classifying openers, and dataset annotations, then keeps what is left if it still reads as a room.

```bash
npm run situations
```

That rewrites `public/situations.json` and prints kept-vs-dropped counts. Of 500 rows, 80 survive. Four of the rejections are mine rather than the filters', listed by id in a `REJECT` set in the script so the curation is visible rather than baked into the output.

## How it is scored

Payoffs and Nash / equilibrium lines come from the YAML spec and the last-round tally. The demo does not call `evaluate()` or build a run trace.

- 2×2: look up the joint profile in `normalFormMatrix`
- Office hours: congestion payoff from how many went
- Common pot: `u_i = (20 - c_i) + 0.5 · C`

Code to read first: [`src/demo/play.ts`](src/demo/play.ts), [`src/demo/games.ts`](src/demo/games.ts), [`public/app.js`](public/app.js).

## Deploying

The [`Dockerfile`](Dockerfile) runs anywhere that hosts a long-lived container. Serverless platforms do not work: a run spawns a child process and holds an SSE stream open for the length of the conversation.

```bash
docker build -t table .
docker run --rm -p 7860:7860 --env-file .env table
```

Set `OPENAI_API_KEY` as a platform secret, never in the image.

A public link spends that key — roughly a dozen model calls per run — so the server refuses runs past a per-visitor allowance and a process-lifetime total:

| Variable | Default | What it caps |
| --- | --- | --- |
| `RUNS_PER_IP` | `6` | Runs one visitor may start per window |
| `IP_WINDOW_MS` | `1800000` | Length of that window |
| `RUNS_TOTAL` | `300` | Runs for the life of the process |
| `MAX_CONCURRENT` | `3` | Conversations that may overlap |
| `HOST` | `127.0.0.1` | Bind address; the image sets `0.0.0.0` |
| `PORT` | `3847` | Listen port; the image sets `7860` |

The counters live in memory, so a restart clears them. They guard against a stray crawler, not against spend — set a limit on the key too.

Measured in the image under a 512 MB / 0.1 CPU cap, which is what the smaller free tiers give: it boots in about 15 seconds, one conversation takes about 50 seconds and peaks near 75 MB, and three overlapping conversations peak near 285 MB but stretch to about 135 seconds each as they contend for the CPU. Memory is not the binding constraint; CPU is. Lower `MAX_CONCURRENT` to trade refusals for speed.

## Also in this repo

`src/spec`, `src/eval`, and `configs/` are a closed-form library the table reads. `npm test` checks those fixtures. They are not the UI.

```bash
npm test
npm run typecheck
```

## License

ISC. See [LICENSE](LICENSE).

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

## Also in this repo

`src/spec`, `src/eval`, and `configs/` are a closed-form library the table reads. `npm test` checks those fixtures. They are not the UI.

```bash
npm test
npm run typecheck
```

## License

ISC. See [LICENSE](LICENSE).

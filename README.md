# Table

People sit. They talk. A frozen spec scores them against the textbook. The table is not the grader.

Five known games, or a situation you type. You inspect the payoffs, sit them down, then see each person’s action and utility next to what the book says.

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

ISC

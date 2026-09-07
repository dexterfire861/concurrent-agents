# Working rules

These bind every change in this repo. Product taste (observer ≠ evaluator, theory from the matrix) lives elsewhere if we write it. This file is how to work.

## Think before coding

State assumptions out loud. Make considerations and tradeoffs clear. If the request is ambiguous, ask. If a simpler approach exists, push back. Stop when confused: name what is unclear. Do not pick one interpretation and run with it — evaluate whether it is the best decision.

## Simplicity first

Write the minimum code that solves the problem. No speculative abstractions. No flexibility nobody asked for. Test if unsure: would a senior engineer call this overcomplicated? If yes, it is too complicated.

## Surgical changes

Touch only what the task requires. Do not improve neighboring code. Do not refactor what is not broken. Every changed line should track back to the request.

## Goal-driven execution

Turn vague instructions into verifiable, testable targets before writing a line. "Add validation" becomes "write tests for invalid inputs, then make them pass."

## UI, when it exists

Functional, dynamic, and easy for any user to understand. The first slice is CLI plus two eval reports. These rules apply the moment a UI is in scope.

## Mozaik is new — do not invent its API

Every `@mozaik-ai/core` call, option, event name, and handler must be grounded in current documentation or the installed package types. Before writing a Mozaik line:

1. Read the relevant page on [docs.jigjoy.ai](https://docs.jigjoy.ai/docs/quickstart) (or the version that matches the installed package).
2. Confirm the symbol exists in `node_modules/@mozaik-ai/core` (exports, types, JSDoc).
3. If docs and types disagree, prefer the installed types and say so out loud.
4. If a parameter is not in docs or types, do not add it. Do not guess `SituationSpecification` fields, `defineRuntime` options, or event payload shapes.

Wrong: `runLoop(agentId, msg, { temperature: 0, stream: true })` because it looks like other SDKs.

Right: copy the `InferenceInput` shape from the installed types after reading the quickstart.

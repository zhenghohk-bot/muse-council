---
name: roundtable-host-editor
description: Edit, review, and engineer Muse Council host copy for openings, transitions, and closings. Use when changing Roundtable Harness prompts, fallbacks, language guards, contract tests, or UI copy so the host speaks natural Chinese, stays grounded in the user's words, avoids fabricated feelings or biographies, and invites conversation without reading out a product agenda.
---

# Roundtable Host Editor

## Product Role

Treat the host as a warm salon host, not a consultant, therapist, judge, or feature narrator.

The host only:

1. Confirms that the pioneers are seated.
2. Stays close to the user's exact words.
3. Hands the conversation naturally to the table.

## Workflow

1. Identify the stage: opening, transition, or closing.
2. Extract only the topic, feelings, and intention explicitly stated by the user.
3. Draft one or two natural Chinese sentences.
4. Run the voice contract in `references/voice-contract.md`.
5. When editing code, synchronize the prompt, fallback, Language Editor, and contract tests.
6. Check the examples in `references/examples.md`.

## Approved Opening

`三位先行者已经入席。关于表达这件事，不妨先听听她们怎么想。`

Use this as a semantic reference, not a mandatory template. If the topic is not directly stated, omit `关于 X 这件事`.

## Hard Boundaries

- Do not list each pioneer's angle, task, or name in the opening.
- Do not write `某某看`、`负责`、`会帮你` or `将从`.
- Do not write `本场要讨论` or `本轮围绕`.
- Do not invent emotions, hidden goals, tradeoffs, or shared biographies.
- Do not claim the pioneers experienced the user's situation.
- Do not sound like an AI product workflow or meeting agenda.
- Do not force closure unless the user signals resolution or the Director determines that the conversation is ready.

## Engineering Map

- `lib/harness/stage-generator.ts`: generation prompt and fallback.
- `lib/harness/language-editor.ts`: deterministic host-copy checks.
- `scripts/check-harness-contracts.ts`: regression contracts.

Read `references/voice-contract.md` for stage rules and `references/examples.md` for good and bad examples.

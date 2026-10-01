# Eval closeout — v1.6

This directory holds the retrieval eval reports. The versioned report `*.json` / `*.md` files here are
harness output — regenerate it with the script named in its header, never edit it by
hand. `eval/README.md` documents the harness itself.

## What this closeout lands

The eval work reaches v1.6 and stops at the retrieval layer:

- **Two Ks.** `candidateK` is the first-stage width per channel, `contextK` is how many
  passages reach the prompt. `baseline-v1.6` records both.
- **An explicit split.** `eval/splits.json` assigns every question to `validation` or
  `test`. A parameter is selected on `validation` and reported on `test`.
- **Shipped metrics.** Hit rate@5, MAP@10, context precision/recall, per-query-type
  breakdown, and a separate unanswerable group.
- **Experiments, not wins.** `retrieval-v1.6`, `threshold-v1.6`, `sweep-v1.6`,
  `scores-v1.6` and `paired-v1.6` compare strategies and parameters against the
  baseline.

## What did **not** change

Production retrieval is unchanged: **dense**, `candidateK = 20`, `contextK = 3`,
`threshold = 0.5` (`src/main/ipc/chatHandlers.ts`). No strategy cleared the adoption
rule on `validation`, so `retrieval-v1.6` reports the shipped dense strategy and no
winner. The threshold sweep is **flat** — every threshold from 0 to 0.6 behaves
identically on this corpus — so there is no evidence to move `threshold` either. These
are negative results: validation does not authorize changing the defaults. They do
not establish that other strategies have no value.

## Corpus state

21 documents, 53 chunks, 78 questions (53 answerable, 25 unanswerable). The unanswerable
group is what a threshold decision should move; on this corpus it does not, because no
candidate is ever filtered out.

## Phase 1 boundary

Retrieval Eval v2 Phase 1 (#192) closes with this integration. No further K,
threshold, hybrid or retrieval-metric tuning is planned under that epic.

Generator evaluation is tracked in #213 and citation evaluation in #214. Public
QASPER/MIRACL-zh subsets, a pinned offline reranker (historical PR #170), further
corpus scaling and token accounting beyond the character proxy are deferred, not
claimed complete and not prerequisites for this phase's closure.

The original ~300-chunk target is unmet. At 53 chunks, only 19 answerable questions
are in `validation`: this is a small diagnostic benchmark, not evidence of broad
real-world performance. Expanding it is explicitly outside this closeout.

## Regenerate

```bash
npm run eval:prepare    # one-time, networked: pin the embedding model
npm run eval            # baseline-v1.6.{json,md}
npm run eval:retrieval  # retrieval-v1.6.{json,md}
npm run eval:threshold  # threshold-v1.6.{json,md}
npm run eval:sweep      # sweep-v1.6.{json,md}
npm run eval:scores     # scores-v1.6.{json,md}
npm run eval:paired     # paired-v1.6.{json,md}
```

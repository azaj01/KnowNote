# RAG eval harness

Measures retrieval quality so "did this change make retrieval better?" has an answer.
The current numbers are frozen in [`docs/eval/baseline-v1.6.md`](../docs/eval/baseline-v1.6.md);
every experiment (#77, #78) is reported as a delta against that file.

## Commands

```bash
npm run eval:prepare    # one-time, networked: download the pinned embedding model
npm run eval            # offline and deterministic: run the harness, rewrite the baseline
npm run eval:retrieval  # strategy comparison (#77); validation selects, test reports
npm run eval:threshold  # derive the similarity threshold on validation, report on test
npm run eval:sweep      # bounded grid over strategy × candidateK × contextK, one dashboard
npm run eval:blocks eval/corpus/foo.md   # print the block ordinals ground truth must use
```

### The harness runs the production configuration

From v1.6 the harness defaults to the parameters the app ships, so its numbers describe
the product rather than a research setup. Two Ks, because they answer different questions:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--eval-candidate-k=` | `20` | first-stage width per channel (KNN neighbours, BM25 limit) |
| `--eval-context-k=` | `3` | passages the chat prompt actually takes (`chatHandlers.ts`) |
| `--eval-threshold=` | `0.5` | the similarity floor the app ships |
| `--eval-retrieval=` | `dense` | `dense`, `sparse`, or `hybrid` |
| `--eval-split=` | `all` | `all`, `validation`, or `test` — a deterministic id-based split |
| `--eval-baseline=` | `v1.6` | name written into `docs/eval/baseline-<name>.{json,md}` |

Ranking metrics are computed at `candidateK` depth, not at `contextK`: `Recall@10` needs
at least ten results, and truncation only takes a prefix of the candidate list, so the
truncation cannot change the ranking it is measured on. `contextK` is recorded so the
report describes the whole online path.

### Swept parameters are chosen on `validation`, reported on `test`

A parameter picked on the same questions it is scored on is a fitted number, not a
result. `eval/splits.json` is the committed assignment; `--eval-split=validation` selects
from it and `test` is the rest.

It is an explicit manifest rather than a hash of the question id. A hash
(`hash(id) % 3`) is actually *stable* — it is computed per id, so adding a question does
not move the existing ones. What it cannot do is express the experimental design:

- it does not stratify a small corpus, so a rare type (`multi-hop`, `cross-lingual`) can
  end up entirely on one side without anyone choosing that — which is what happened; and
- a newly added question is assigned silently instead of deliberately, and `test` is the
  side a choice must not be fitted to.

With a manifest, a question with no entry is **refused** rather than defaulted, so every
new question is assigned on purpose.

`npm run eval:sweep` runs a bounded grid (`strategy × candidateK × contextK`) and
writes one dashboard with quality, context precision/recall, prompt size, index size
and latency side by side. Its grid maximum is labelled as **not** a recommendation:
selecting on the same questions is how a benchmark becomes a lookup table.

`contextK > candidateK` is not a cell in that grid. The harness fetches `candidateK`
passages, so a wider window can never be filled; the sweep skips those combinations
and names them in the report, and the harness refuses the same combination from the
command line. Before this was enforced, `contextK=8` at `candidateK=5` was reported as
identical to `contextK=5` — not because 8 assessed the same as 5, but because
passages 6–8 did not exist.

`eval:prepare` downloads the pinned `multilingual-e5-small` revision into the app's model
cache and verifies it. `eval` never touches the network: if the model is missing it stops
with

```
Eval model is not available locally.
Run: npm run eval:prepare
```

"Runs without configuration" means no API keys and no model/provider setup in the app — it
does not mean "no download". The 134 MB of weights are not committed.

## Layout

```text
eval/
  corpus/            first-party documents (markdown today)
  questions.jsonl    one question per line; committed with the corpus
  splits.json        the committed validation/test assignment
```

The corpus is authored for this repository and carries the repository's GPL-3.0 licence,
so it is redistributable. Keeping it first-party avoids a licence question every time the
dataset needs a new question.

`questions.jsonl` schema:

```json
{
  "id": "q001",
  "question": "Why is bedload harder to measure than suspended sediment?",
  "type": "semantic",
  "answerable": true,
  "relevant": [
    {
      "document": "river-monitoring.md",
      "page": null,
      "block": 4,
      "quote": "Bedload is the harder fraction to measure"
    }
  ],
  "goldAnswer": "optional"
}
```

An **unanswerable** question is the same shape with `"answerable": false` and `"relevant": []`.
The harness refuses the reverse combination in either direction — an answerable question
with no ground truth, or an unanswerable one carrying some — because both are silent: the
first reads as a permanent miss, the second as a normal hit.

Ground truth uses **corpus identity, never database identity**:

- `document` is the corpus-relative path.
- `block` is the **`document_blocks.order` the ingestion pipeline produced**, not a line
  number and not a paragraph index a human counted. Use `npm run eval:blocks <file>` to
  print the real ordinals through the same loader the harness uses — guessing them is how a
  dataset drifts.
- `page` is `null` for unpaginated sources.
- `quote` is an optional excerpt. The runner fails if the referenced block no longer
  contains it, so a parser change cannot silently move the ground truth.
- `type` is an optional query class; the report groups every metric by it. Values in use:
  `exact` (number/name/detail), `semantic` (why/how), `multi-hop` (two or more blocks),
  `cross-lingual` (question language differs from the source), `zh` (Chinese over a
  Chinese source). Untagged questions report as `untagged`.

Runtime `documentId`s are random and `blockId`s embed them, so neither may appear here.
This is what lets #78 change chunking without invalidating the dataset: the ground truth
describes the source, and the runner maps it to whatever ids that run produced.

### Dataset design

The dataset is built to avoid saturation, not to produce low scores. A benchmark whose
metric is already 1.0 cannot tell a better retriever from the current one. So the corpus
pairs near-duplicate documents (river vs lake monitoring, street canopy vs green roofs,
tidal vs wave energy), and the questions include:

- questions that distinguish two similar documents by one detail,
- multi-location ground truth that requires several passages at once,
- paraphrases whose wording does not overlap the source,
- Chinese questions, including over English sources, because the local model is
  multilingual.

Every question is answerable from the corpus; difficulty comes from discrimination, not
from unanswerable queries.

## What it does

1. Creates a throwaway database (a temp profile; the developer's own DB is never opened).
2. Indexes the corpus through the normal ingestion path (`addDocumentFromFile`), so blocks,
   chunking and embeddings are the real ones.
3. Maps each ground-truth `document`/`block` to the run's runtime ids.
4. Runs the real `Retriever` (`KnowledgeService.search`) at the configured
   `candidateK` depth; `RetrievalRequest` splits the first-stage width from the final
   `topK` so the two are not silently the same number.
5. Writes `docs/eval/baseline-<version>.json` (deterministic) and `.md` (with timing).

## Metrics

- **Recall@1/5/10** — share of ground-truth blocks covered by the first k passages.
- **MRR** — reciprocal rank of the first relevant passage.
- **nDCG@10** — binary-gain discounted cumulative gain.
- **Hit rate@5** — share of questions with at least one relevant passage in the first 5.
  Deliberately blunt: it says the answer was *reachable*, where Recall@5 says the material
  was *complete*. A two-passage question that finds one scores 1.0 and 0.5 respectively.
- **MAP@10** — mean average precision. The one metric here that combines ranking position
  with coverage, so pulling a second relevant passage from rank 9 to rank 2 moves it.
- **Context precision@`contextK`** — of the first `contextK` retrieved passages, the share
  that cover a ground-truth block. **Context recall@`contextK`** — the share of the needed
  ground-truth blocks that made it into that same window. Both are deterministic: the
  dataset says which blocks answer the question, so no model is needed to score the window.
  Together they are the trade-off a `contextK` decision actually makes — a wider window
  finds more and carries more noise.
- This is **retrieval precision/recall, not answer citation recall**: the harness runs no
  model and produces no answer. Answer-level citation correctness is covered by the
  resolver (#70). Faithfulness, completeness and answer correctness need a generative model
  and are **not evaluated here** — the harness runs offline with only the pinned embedding
  model, the same constraint that keeps the reranker unmeasured (#170).
- **By query type** — the same metrics per `type` in `questions.jsonl` (`exact`,
  `semantic`, `multi-hop`, `cross-lingual`, `zh`). A single average hides a change that
  helps one kind of question and hurts another; the current baseline already shows this,
  with `cross-lingual` at nDCG 0.63 against 0.93–1.00 elsewhere.
- **Unanswerable questions** — a separate group, never averaged in. They have no ground
  truth, so `Recall` on them is 0/0 rather than 0, and the correct outcome is that
  retrieval finds nothing. The reported **no-results** rate is the opposite of a miss:
higher is better, and `mean passages retrieved` is how much irrelevant context was pulled
  in anyway. This is the only metric a similarity-threshold decision should move, which is
  why the threshold sweep reports it separately.
- **Latency p50/p95** — informational only. Timing is **not** frozen, and the committed
  JSON excludes it so two runs diff cleanly.

## Determinism

`npm run eval` twice must print the same `[eval] metrics {...}` line:

```bash
node scripts/eval.mjs | grep '\[eval\] metrics'
node scripts/eval.mjs | grep '\[eval\] metrics'
```

The local embedding backend always runs (`KNOWNOTE_EVAL_MODEL_CACHE` can point CI at its own
cache), so a developer's remote embedding configuration cannot leak into the baseline.

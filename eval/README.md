# RAG eval harness

Measures retrieval quality so "did this change make retrieval better?" has an answer.
The current numbers are frozen in [`docs/eval/baseline-v1.6.md`](../docs/eval/baseline-v1.6.md);
every experiment (#77, #78) is reported as a delta against that file.

## Commands

```bash
npm run eval:prepare    # one-time, networked: download the pinned embedding model
npm run eval            # offline and deterministic: run the harness, rewrite the baseline
npm run eval:retrieval  # strategy comparison (#77)
npm run eval:threshold  # derive the similarity threshold on validation, report on test
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
result. `--eval-split=validation` selects roughly a third of the questions by a
deterministic hash of the id; `test` is the rest. `npm run eval:threshold` uses this
to pick a similarity threshold on `validation` and report it on `test`.

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

Ground truth uses **corpus identity, never database identity**:

- `document` is the corpus-relative path.
- `block` is the block ordinal inside the document (`document_blocks.order`).
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
- **Evidence precision@5** — of the first 5 retrieved passages, the share that cover a
  ground-truth block. This is **retrieval precision, not answer citation recall**: the
  harness runs no model and produces no answer. Answer-level citation correctness is
  covered by the resolver (#70); a model-driven answer eval would be a separate
  deliverable.
- **By query type** — the same metrics per `type` in `questions.jsonl` (`exact`,
  `semantic`, `multi-hop`, `cross-lingual`, `zh`). A single average hides a change that
  helps one kind of question and hurts another; the current baseline already shows this,
  with `cross-lingual` at nDCG 0.63 against 0.93–1.00 elsewhere.
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

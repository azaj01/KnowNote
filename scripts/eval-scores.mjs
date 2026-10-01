#!/usr/bin/env node
/**
 * Dense score diagnostics for #192.
 *
 * Answers one question before any threshold is chosen: **is a single dense similarity
 * threshold even capable of separating "this answers the question" from "this does not"?**
 *
 * Three constraints, all deliberate:
 *
 * - **dense only.** A hybrid `score` is an RRF value (`1 / (60 + rank)`) and is not on the
 *   same scale as a normalised cosine. Mixing them would manufacture a new misleading
 *   number, which is what the threshold discussion is trying to avoid.
 * - **validation only.** The distribution is used to choose where to sweep, so looking at
 *   `test` first would be tuning on the reporting side.
 * - **the whole corpus per query** (`candidateK` ≥ index size) and `threshold = 0`, so the
 *   distribution is not already truncated by the parameter being investigated.
 *
 * Usage:
 *   node scripts/eval-scores.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT_MD = resolve(readArg('--out=', 'docs/eval/scores-v1.6.md'))
const OUT_JSON = OUT_MD.replace(/\.md$/, '.json')

/** The shipped dense pipeline. Only the split and the candidate depth are changed. */
const SPLIT = 'validation'
const CONTEXT_K = 3
/** Above the index size, so every chunk is scored for every query. */
const CANDIDATE_K = 500

function readArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : fallback
}

// Node 24 refuses to spawn a `.cmd`/`.bat` without `shell: true` (EINVAL), and the
// `.bin` entry is exactly that on Windows. Use the real binary the wrapper runs.
const { default: electronBinary } = await import('electron')
const executable = resolve(electronBinary)

if (!existsSync(executable)) {
  console.error('[scores] could not find the electron binary. Run `npm install` first.')
  process.exit(1)
}

function runHarness(outDir) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '.',
      '--eval-harness',
      '--eval-baseline=scores',
      `--eval-out=${outDir}`,
      `--eval-split=${SPLIT}`,
      '--eval-retrieval=dense',
      `--eval-candidate-k=${CANDIDATE_K}`,
      `--eval-context-k=${CONTEXT_K}`,
      '--eval-threshold=0',
      '--eval-scores'
    ]

    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
    if (isRoot || process.env.CI) args.push('--no-sandbox')

    const child = spawn(executable, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`diagnostics harness exited with code ${code}`))
        return
      }
      const reportPath = join(outDir, 'baseline-scores.json')
      if (!existsSync(reportPath)) {
        reject(new Error('diagnostics harness wrote no report'))
        return
      }
      resolvePromise(JSON.parse(readFileSync(reportPath, 'utf8')))
    })
  })
}

/** Nearest-rank quantile, matching `src/main/eval/metrics.ts`. */
function quantile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(Math.max(rank - 1, 0), sorted.length - 1)]
}

/**
 * `score = (1 + cosine) / 2`, from `SQLiteVectorStore`. Reported everywhere alongside the
 * score because `threshold: 0.5` has been read as "cosine ≥ 0.5" and is really "cosine ≥ 0".
 */
const toCosine = (score) => (score === null ? null : 2 * score - 1)

/**
 * A difference of two scores is not an affine map of a difference of two cosines: the
 * `+1` cancels, so `Δcosine = 2 * Δscore`. Applying the absolute transform to a margin
 * would have produced `2Δscore - 1`, which for a near-zero margin reports a cosine margin
 * near −1 — a sign flip on top of a scale error.
 */
const toCosineMargin = (margin) => (margin === null ? null : 2 * margin)

const QUANTILES = [0, 10, 25, 50, 75, 90, 100]

function describe(values) {
  if (values.length === 0) return null
  const out = {}
  for (const p of QUANTILES) out[`p${p}`] = quantile(values, p)
  return out
}

const workDir = mkdtempSync(join(tmpdir(), 'knownote-scores-'))
let report
try {
  console.log('[scores] running the dense harness on validation, threshold 0')
  report = await runHarness(workDir)
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

const perQuestion = report.perQuestion ?? []
const answerable = perQuestion.filter((q) => q.answerable)
const unanswerable = perQuestion.filter((q) => !q.answerable)

if (perQuestion.some((q) => !q.retrievedScores)) {
  console.error('[scores] the report carries no scores; did --eval-scores reach the harness?')
  process.exit(1)
}

/** Per-question score landmarks. */
function landmarks(question) {
  const scores = question.retrievedScores
  const relevant = []
  const nonRelevant = []
  scores.forEach((score, index) => {
    if ((question.matchesByRank[index] ?? []).length > 0) relevant.push(score)
    else nonRelevant.push(score)
  })
  if (relevant.length === 0) return null
  const bestRelevant = Math.max(...relevant)
  const worstRelevant = Math.min(...relevant)
  const bestNonRelevant = nonRelevant.length > 0 ? Math.max(...nonRelevant) : null
  return {
    id: question.id,
    type: question.type,
    bestRelevant,
    worstRelevant,
    bestNonRelevant,
    margin: bestNonRelevant === null ? null : bestRelevant - bestNonRelevant
  }
}

const answerableLandmarks = answerable.map(landmarks).filter((entry) => entry !== null)
const unanswerableMax = unanswerable.map((q) => Math.max(...q.retrievedScores))

const byType = {}
for (const entry of answerableLandmarks) {
  byType[entry.type] = byType[entry.type] ?? []
  byType[entry.type].push(entry)
}

/**
 * The curve that decides whether one threshold can do both jobs. For each candidate `t`:
 *
 * - **hit** — share of answerable questions that still have *some* relevant passage;
 * - **fullRecall** — share whose *every* ground-truth block is still covered;
 * - **abstain** — share of unanswerable questions that now return nothing.
 *
 * A useful threshold needs `abstain` to rise while `fullRecall` holds. If every `t` that
 * raises abstention also drops full recall, no single threshold can carry the job.
 */
const thresholdGrid = []
for (let t = 0.5; t <= 1.0001; t += 0.025) thresholdGrid.push(Number(t.toFixed(3)))

const curve = thresholdGrid.map((threshold) => {
  let hit = 0
  let fullRecall = 0
  for (const question of answerable) {
    const covered = new Set()
    let coveredAbove = 0
    question.matchesByRank.forEach((matches, index) => {
      if (question.retrievedScores[index] < threshold) return
      for (const match of matches) {
        if (!covered.has(match)) {
          covered.add(match)
          coveredAbove += 1
        }
      }
    })
    if (coveredAbove > 0) hit += 1
    if (question.relevantCount > 0 && coveredAbove === question.relevantCount) fullRecall += 1
  }

  const abstained = unanswerable.filter((q) => Math.max(...q.retrievedScores) < threshold).length
  return {
    threshold,
    cosine: Number(toCosine(threshold).toFixed(3)),
    hitRate: answerable.length === 0 ? 0 : hit / answerable.length,
    fullRecallRate: answerable.length === 0 ? 0 : fullRecall / answerable.length,
    abstentionRate: unanswerable.length === 0 ? 0 : abstained / unanswerable.length
  }
})

const format4 = (value) => (value === null ? '—' : value.toFixed(4))
/**
 * `transform` maps a value to its cosine counterpart. It defaults to the absolute-score
 * transform and is overridden for margins, because the two do not share one.
 */
const quantileRow = (label, values, transform = toCosine) => {
  const d = describe(values)
  if (!d) return `| ${label} | 0 | ${QUANTILES.map(() => '—').join(' | ')} |`
  const cells = QUANTILES.map((p) => {
    const value = d[`p${p}`]
    return `${value.toFixed(4)} (${transform(value).toFixed(3)})`
  })
  return `| ${label} | ${values.length} | ${cells.join(' | ')} |`
}

const relevantBest = answerableLandmarks.map((entry) => entry.bestRelevant)
const relevantWorst = answerableLandmarks.map((entry) => entry.worstRelevant)
const nonRelevantBest = answerableLandmarks
  .map((entry) => entry.bestNonRelevant)
  .filter((value) => value !== null)
const margins = answerableLandmarks.map((entry) => entry.margin).filter((value) => value !== null)

const typeRows = Object.entries(byType)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([type, entries]) => {
    const best = describe(entries.map((entry) => entry.bestRelevant))
    const worst = describe(entries.map((entry) => entry.worstRelevant))
    return `| ${type} | ${entries.length} | ${format4(best.p50)} | ${format4(best.p10)} | ${format4(worst.p10)} |`
  })
  .join('\n')

const curveRows = curve
  .map(
    (row) =>
      `| ${row.threshold.toFixed(3)} | ${row.cosine.toFixed(3)} | ${format4(row.hitRate)} | ` +
      `${format4(row.fullRecallRate)} | ${format4(row.abstentionRate)} |`
  )
  .join('\n')

/** Where the three distributions overlap, which is what the threshold decision turns on. */
const overlap = {
  worstRelevantP10: quantile(relevantWorst, 10),
  bestNonRelevantP90: quantile(nonRelevantBest, 90),
  unanswerableMaxP50: quantile(unanswerableMax, 50),
  unanswerableMaxP90: quantile(unanswerableMax, 90)
}
const separable =
  overlap.worstRelevantP10 !== null &&
  overlap.unanswerableMaxP90 !== null &&
  overlap.worstRelevantP10 > overlap.unanswerableMaxP90

const markdown = `# Dense score diagnostics — v1.6 (#192)

Generated by \`node scripts/eval-scores.mjs\`. Numbers are harness output; do not edit them by hand.

## Read this first: the score is not a cosine

\`SQLiteVectorStore\` computes

\`\`\`text
score = 1 - distance / 2
distance = 1 - cosine        (sqlite-vec, distance_metric=cosine)
=> score = (1 + cosine) / 2
\`\`\`

so the configured \`threshold\` is an **affine map of the cosine**, not the cosine:

| threshold | raw cosine |
| --- | --- |
| 0.3 | -0.4 |
| 0.4 | -0.2 |
| **0.5 (shipped)** | **0.0** |
| 0.6 | 0.2 |
| 0.8 | 0.6 |
| 1.0 | 1.0 |

The shipped \`threshold = 0.5\` means **cosine ≥ 0**, which is very permissive. Every
threshold row below carries both columns so the two never get confused again, and every
mention of "the sweep looked too low" has to be read through this table.

## What was measured

Dense only, \`${SPLIT}\` split only, \`threshold = 0\`, \`candidateK = ${CANDIDATE_K}\` (above the
index size, so every chunk is scored for every query), \`contextK = ${CONTEXT_K}\`.

- answerable questions: ${answerable.length}
- unanswerable questions: ${unanswerable.length}
- index size: ${report.config.chunkCount} chunks

Hybrid is deliberately excluded: its \`score\` is an RRF value (\`1 / (60 + rank)\`) and is not
on the same scale as a normalised cosine.

## Distributions (score, with raw cosine in brackets)

\`best relevant\` is the highest-scoring passage that covers ground truth; \`worst relevant\`
is the lowest one that still has to survive for the question to be fully answered;
\`best non-relevant\` is the highest-scoring passage that covers nothing; \`margin\` is the
first minus the third.

The margin is an **oracle** quantity: at runtime nothing knows which result is relevant, so
it describes how much the score separates the two — it is not a signal a product could use.
Reading it as a candidate mechanism is the mistake the runtime-signal evaluation exists to
avoid.

Where a row shows a raw cosine in brackets: an **absolute** score maps as
\`cosine = 2·score − 1\`, while a **margin** maps as \`Δcosine = 2·Δscore\` because the
\`+1\` cancels. The \`margin\` row uses the latter, the others the former.

| Distribution | n | min | p10 | p25 | p50 | p75 | p90 | max |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${quantileRow('best relevant', relevantBest)}
${quantileRow('worst relevant', relevantWorst)}
${quantileRow('best non-relevant', nonRelevantBest)}
${quantileRow('margin (best rel − best non-rel)', margins, toCosineMargin)}
${quantileRow('unanswerable max candidate', unanswerableMax)}

## By query type

\`best relevant\` p50 and p10, and \`worst relevant\` p10 — the last is the one that decides
whether a cross-lingual question survives a threshold that a semantic question tolerates.

| Type | n | best rel p50 | best rel p10 | worst rel p10 |
| --- | --- | --- | --- | --- |
${typeRows}

## Threshold curve

For each candidate threshold: **hit** = share of answerable questions that still have some
relevant passage; **full recall** = share whose every ground-truth block is still covered;
**abstain** = share of unanswerable questions that now return nothing.

| threshold (score) | raw cosine | answerable hit | answerable full recall | unanswerable abstain |
| --- | --- | --- | --- | --- |
${curveRows}

## The separation question

The threshold decision turns on whether these overlap:

| Landmark | score | raw cosine |
| --- | --- | --- |
| worst relevant, p10 | ${format4(overlap.worstRelevantP10)} | ${overlap.worstRelevantP10 === null ? '—' : toCosine(overlap.worstRelevantP10).toFixed(3)} |
| best non-relevant, p90 | ${format4(overlap.bestNonRelevantP90)} | ${overlap.bestNonRelevantP90 === null ? '—' : toCosine(overlap.bestNonRelevantP90).toFixed(3)} |
| unanswerable max, p50 | ${format4(overlap.unanswerableMaxP50)} | ${overlap.unanswerableMaxP50 === null ? '—' : toCosine(overlap.unanswerableMaxP50).toFixed(3)} |
| unanswerable max, p90 | ${format4(overlap.unanswerableMaxP90)} | ${overlap.unanswerableMaxP90 === null ? '—' : toCosine(overlap.unanswerableMaxP90).toFixed(3)} |

**${
  separable
    ? 'The distributions separate at the p10/p90 landmarks, so a single threshold is a plausible mechanism on this corpus. Read the grid above for where to sweep.'
    : 'The distributions **overlap**, so a higher threshold buys abstention by giving up required relevant passages. If the curve above shows abstention rising only as full recall falls, then the honest conclusion is that **a single dense similarity threshold cannot carry both recall and abstention** — and the next mechanism to evaluate is not a finer threshold grid but a different signal (reranker score, top1−top2 margin, per-query thresholds, or claim-level answerability).'
}

## Reproduce

\`\`\`bash
npm run eval:prepare   # one-time, networked model bootstrap
npm run eval:scores    # offline; rewrites this file
\`\`\`
`

mkdirSync(resolve(OUT_MD, '..'), { recursive: true })
writeFileSync(
  OUT_JSON,
  `${JSON.stringify(
    {
      baseline: 'v1.6',
      split: SPLIT,
      candidateK: CANDIDATE_K,
      threshold: 0,
      indexSize: report.config.chunkCount,
      counts: { answerable: answerable.length, unanswerable: unanswerable.length },
      distributions: {
        bestRelevant: describe(relevantBest),
        worstRelevant: describe(relevantWorst),
        bestNonRelevant: describe(nonRelevantBest),
        margin: describe(margins),
        unanswerableMax: describe(unanswerableMax)
      },
      byType: Object.fromEntries(
        Object.entries(byType).map(([type, entries]) => [
          type,
          {
            questions: entries.length,
            bestRelevant: describe(entries.map((entry) => entry.bestRelevant)),
            worstRelevant: describe(entries.map((entry) => entry.worstRelevant))
          }
        ])
      ),
      overlap,
      separable,
      curve
    },
    null,
    2
  )}\n`
)
writeFileSync(OUT_MD, markdown)

console.log(`[scores] answerable ${answerable.length}, unanswerable ${unanswerable.length}, index ${report.config.chunkCount}`)
console.log(
  `[scores] worst relevant p10 = ${format4(overlap.worstRelevantP10)} (cosine ${overlap.worstRelevantP10 === null ? '—' : toCosine(overlap.worstRelevantP10).toFixed(3)}), unanswerable max p90 = ${format4(overlap.unanswerableMaxP90)}`
)
console.log(`[scores] separable = ${separable}`)
console.log(`[scores] wrote ${OUT_JSON} and ${OUT_MD}`)

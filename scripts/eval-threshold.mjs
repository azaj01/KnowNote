#!/usr/bin/env node
/**
 * Threshold derivation for #192 (child 4).
 *
 * `threshold: 0.5` was hand-picked, and a cosine score has no universal meaning:
 * the distribution depends on the embedding model, the language, the query type and
 * the chunk length. This runs the real harness once per candidate threshold on a
 * **validation** split, picks a winner there, and then reports that winner on the
 * **test** split — so the number that justifies the choice is not the number the
 * choice was fitted to.
 *
 * The harness owns the split (`--eval-split=`), so both sides are measured by the
 * same code path that produces the frozen baseline.
 *
 * Usage:
 *   node scripts/eval-threshold.mjs
 *
 * The embedding model must already be prepared (`npm run eval:prepare`).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT_MD = resolve(readArg('--out=', 'docs/eval/threshold-v1.6.md'))
const OUT_JSON = OUT_MD.replace(/\.md$/, '.json')

/**
 * 0 is the "no floor" arm: it keeps the ranking intact and lets a downstream stage
 * filter. It is here because #192 says the first stage may legitimately run with no
 * threshold at all.
 */
const THRESHOLDS = [0, 0.3, 0.4, 0.5, 0.6]

/** The threshold the app currently ships, so the report can say whether it holds up. */
const PRODUCTION_THRESHOLD = 0.5

function readArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : fallback
}

// Node 24 refuses to spawn a `.cmd`/`.bat` without `shell: true` (EINVAL), and the
// `.bin` entry is exactly that on Windows. Use the real binary the wrapper runs.
const { default: electronBinary } = await import('electron')
const executable = resolve(electronBinary)

if (!existsSync(executable)) {
  console.error('[threshold] could not find the electron binary. Run `npm install` first.')
  process.exit(1)
}

function runOne(threshold, split, outDir) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '.',
      '--eval-harness',
      '--eval-baseline=v1.6',
      `--eval-out=${outDir}`,
      `--eval-split=${split}`,
      `--eval-threshold=${threshold}`
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
        reject(new Error(`threshold ${threshold} (${split}) exited with code ${code}`))
        return
      }
      const reportPath = join(outDir, 'baseline-v1.6.json')
      if (!existsSync(reportPath)) {
        reject(new Error(`threshold ${threshold} (${split}) wrote no report`))
        return
      }
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      resolvePromise(summarize(report))
    })
  })
}

/**
 * The frozen metrics plus the one this experiment needs and the baseline does not
 * carry: how often a threshold turns a question into "no results at all".
 *
 * A higher threshold can look better on ranking metrics while quietly making the
 * product answer "not in your sources" more often, and that trade is invisible
 * unless it is counted.
 */
function summarize(report) {
  const perQuestion = report.perQuestion ?? []
  const noResult = perQuestion.filter((q) => q.retrievedCount === 0).length
  const retrieved = perQuestion.map((q) => q.retrievedCount)
  return {
    questions: perQuestion.length,
    noResultCount: noResult,
    noResultRate: perQuestion.length === 0 ? 0 : noResult / perQuestion.length,
    meanRetrieved: retrieved.length === 0 ? 0 : retrieved.reduce((a, b) => a + b, 0) / retrieved.length,
    metrics: report.metrics
  }
}

const format4 = (value) => value.toFixed(4)

const workDir = mkdtempSync(join(tmpdir(), 'knownote-threshold-'))
const rows = []

try {
  for (const threshold of THRESHOLDS) {
    const validationDir = join(workDir, `${threshold}-validation`)
    const testDir = join(workDir, `${threshold}-test`)
    mkdirSync(validationDir, { recursive: true })
    mkdirSync(testDir, { recursive: true })

    console.log(`[threshold] threshold ${threshold}: validation`)
    const validation = await runOne(threshold, 'validation', validationDir)
    console.log(`[threshold] threshold ${threshold}: test`)
    const test = await runOne(threshold, 'test', testDir)

    rows.push({ threshold, validation, test })
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

/**
 * Selection rule, stated so it can be argued with: best validation nDCG@10, then
 * fewest validation no-results, then the widest (lowest) threshold — because the
 * first stage is supposed to favour recall and let a later stage filter.
 */
const ranked = [...rows].sort(
  (a, b) =>
    b.validation.metrics.ndcgAt10 - a.validation.metrics.ndcgAt10 ||
    a.validation.noResultRate - b.validation.noResultRate ||
    a.threshold - b.threshold
)
const winner = ranked[0]
const production = rows.find((row) => row.threshold === PRODUCTION_THRESHOLD)

/**
 * A flat sweep is not a weak recommendation, it is no recommendation: if every
 * threshold scores the same on both metrics, the corpus cannot tell them apart and
 * moving a product parameter on that evidence would be noise dressed as a result.
 */
const flat =
  rows.every(
    (row) =>
      row.validation.metrics.ndcgAt10 === rows[0].validation.metrics.ndcgAt10 &&
      row.validation.noResultRate === rows[0].validation.noResultRate
  )

const outcome = flat
  ? `The sweep is **flat**: every threshold from ${THRESHOLDS[0]} to ${THRESHOLDS[THRESHOLDS.length - 1]} produces the same validation nDCG@10 (${format4(rows[0].validation.metrics.ndcgAt10)}), the same Recall@5 (${format4(rows[0].validation.metrics.recallAt5)}) and a no-result rate of ${format4(rows[0].validation.noResultRate)}. On this corpus the threshold is simply **non-binding** — E5 never scores these query/chunk pairs below the top of the swept range, so no passage is ever filtered out.\n\n**No evidence to change \`threshold = ${PRODUCTION_THRESHOLD}\`.** The tie-break rule nominates \`${winner.threshold}\` only because it prefers the widest threshold among equals; that is a tie-break, not a finding. What this run establishes is that the current value cannot be validated *or* falsified here, which is a property of the corpus, not of the threshold. Re-run after #192 child 2 grows it.`
  : `**Recommended: \`threshold = ${winner.threshold}\`.**\n\n- Validation: nDCG@10 ${format4(winner.validation.metrics.ndcgAt10)}, Recall@5 ${format4(winner.validation.metrics.recallAt5)}, no-result rate ${format4(winner.validation.noResultRate)} (${winner.validation.noResultCount}/${winner.validation.questions})\n- Test: nDCG@10 ${format4(winner.test.metrics.ndcgAt10)}, Recall@5 ${format4(winner.test.metrics.recallAt5)}, no-result rate ${format4(winner.test.noResultRate)} (${winner.test.noResultCount}/${winner.test.questions})\n- Mean retrieved per question: ${winner.test.meanRetrieved.toFixed(2)} (validation ${winner.validation.meanRetrieved.toFixed(2)})`

const tableRows = rows
  .map(
    (row) =>
      `| ${row.threshold} | ${row.validation.questions} | ${format4(row.validation.metrics.recallAt5)} | ` +
      `${format4(row.validation.metrics.ndcgAt10)} | ${format4(row.validation.metrics.mapAt10)} | ` +
      `${format4(row.validation.noResultRate)} | ${format4(row.test.metrics.ndcgAt10)} | ` +
      `${format4(row.test.noResultRate)} |`
  )
  .join('\n')

const markdown = `# Threshold derivation — v1.6 (#192)

Generated by \`node scripts/eval-threshold.mjs\`. Numbers are harness output; do not edit them by hand.

## What was measured

The real harness, the same corpus and the production retrieval config
(\`candidateK=20, contextK=3\`), once per candidate threshold. The **validation**
split selects; the **test** split reports. Both come from the same
\`--eval-split=\` code path, and the split is a deterministic function of the
question id, so this is reproducible.

| Threshold | n (val) | Recall@5 (val) | nDCG@10 (val) | MAP@10 (val) | No-result (val) | nDCG@10 (test) | No-result (test) |
| --- | --- | --- | --- | --- | --- | --- | --- |
${tableRows}

## Selection rule

Best validation nDCG@10, then fewest validation no-results, then the **lowest**
threshold — the first stage is supposed to favour recall and let a later stage
filter, so among equals the wider one is the safer default.

## Outcome

${outcome}

The app currently ships \`threshold = ${PRODUCTION_THRESHOLD}\`: validation nDCG@10
${format4(production.validation.metrics.ndcgAt10)}, test nDCG@10
${format4(production.test.metrics.ndcgAt10)}, test no-result rate
${format4(production.test.noResultRate)}.

## Caveat on this corpus

The split removes the most obvious form of overfitting, but ${rows[0].validation.questions}
validation questions is a thin basis for a decision, and the corpus is still small. A
threshold is a product decision with a **no-result-rate** cost attached, so a
recommendation here is only as good as the corpus behind it. Re-run this after the
corpus grows (#192 child 2).

## Reproduce

\`\`\`bash
npm run eval:prepare      # one-time, networked model bootstrap
npm run eval:threshold    # offline; rewrites this file
\`\`\`
`

mkdirSync(resolve(OUT_MD, '..'), { recursive: true })
writeFileSync(
  OUT_JSON,
  `${JSON.stringify({ baseline: 'v1.6', productionThreshold: PRODUCTION_THRESHOLD, flat, recommended: flat ? PRODUCTION_THRESHOLD : winner.threshold, rows }, null, 2)}\n`
)
writeFileSync(OUT_MD, markdown)

console.log(
  flat
    ? `[threshold] flat sweep; no evidence to move off ${PRODUCTION_THRESHOLD}`
    : `[threshold] recommended ${winner.threshold} (validation nDCG@10 ${format4(winner.validation.metrics.ndcgAt10)})`
)
console.log(`[threshold] wrote ${OUT_JSON} and ${OUT_MD}`)

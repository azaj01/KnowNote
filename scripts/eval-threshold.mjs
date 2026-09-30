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
 * The frozen metrics plus the two the experiment exists for: how often the threshold
 * turns an answerable question into "no results at all", and how often it makes an
 * unanswerable one return nothing (which is the desired outcome for those).
 *
 * A threshold that scores well on ranking metrics but keeps returning the whole corpus
 * for a question the sources do not answer is invisible unless the second number is
 * counted, and the two have to be split: one is a miss, the other is a correct refusal.
 */
function summarize(report) {
  const perQuestion = report.perQuestion ?? []
  const answerable = perQuestion.filter((q) => q.answerable)
  const noResult = answerable.filter((q) => q.retrievedCount === 0).length
  return {
    questions: perQuestion.length,
    answerableQuestions: answerable.length,
    noResultCount: noResult,
    noResultRate: answerable.length === 0 ? 0 : noResult / answerable.length,
    meanRetrieved:
      answerable.length === 0
        ? 0
        : answerable.reduce((a, q) => a + q.retrievedCount, 0) / answerable.length,
    /** 不可答问题时希望返回空，所以这里的“高”是好事。 */
    unanswerable: report.unanswerable,
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
 * Selection rule, stated so it can be argued with (#192).
 *
 * Raising the threshold is only worth it if it refuses more of what the sources do not
 * answer. So: take the widest threshold that does not regress the answerable quality
 * metrics (nDCG@10 and context recall on validation) as the reference, then among the
 * thresholds that hold that line, pick the one that refuses the most unanswerable
 * questions; break ties on the lowest threshold.
 *
 * `threshold = 0` is the reference, because it is the arm that keeps the ranking intact.
 */
const reference = rows.find((row) => row.threshold === 0) ?? rows[0]
const EPSILON = 1e-9
const holdsTheLine = (row) =>
  row.validation.metrics.ndcgAt10 >= reference.validation.metrics.ndcgAt10 - EPSILON &&
  row.validation.metrics.contextRecall >= reference.validation.metrics.contextRecall - EPSILON

const eligible = rows.filter(holdsTheLine)
const ranked = [...eligible].sort(
  (a, b) =>
    b.validation.unanswerable.noResultRate - a.validation.unanswerable.noResultRate ||
    a.threshold - b.threshold
)
/**
 * A flat sweep is not a weak recommendation, it is no recommendation: if no threshold
 * changes either the answerable quality or the unanswerable refusal, the corpus cannot
 * tell them apart and moving a product parameter on that evidence would be noise dressed
 * as a result.
 */
const flat = rows.every(
  (row) =>
    row.validation.metrics.ndcgAt10 === reference.validation.metrics.ndcgAt10 &&
    row.validation.unanswerable.noResultRate === reference.validation.unanswerable.noResultRate
)

/**
 * Refusals are the point of the second number: `noResultCount` of the unanswerable
 * questions came back empty, which is the correct outcome. The rest returned passages the
 * sources cannot support.
 */
const refusals = (row) => `${row.unanswerable.noResultCount}/${row.unanswerable.questions}`
const describe = (row) =>
  `nDCG@10 ${format4(row.metrics.ndcgAt10)}, Recall@5 ${format4(row.metrics.recallAt5)}, ` +
  `answerable no-result ${format4(row.noResultRate)}, ` +
  `unanswerable refused ${refusals(row)}`

const outcome = flat
  ? `The sweep is **flat**: every threshold from ${THRESHOLDS[0]} to ${THRESHOLDS[THRESHOLDS.length - 1]} produces the same validation nDCG@10 (${format4(reference.validation.metrics.ndcgAt10)}), the same Recall@5 (${format4(reference.validation.metrics.recallAt5)}) and the same unanswerable refusal rate (${refusals(reference.validation)}). No passage is ever filtered out, so the threshold is **non-binding** on this corpus — E5 does not score these query/chunk pairs below the top of the swept range.\n\n**No evidence to change \`threshold = ${PRODUCTION_THRESHOLD}\`.** All thresholds hold the line equally; picking one would be arbitrary. The current value can be neither validated nor falsified here, which is a property of the corpus rather than of the threshold.`
  : `**Recommended: \`threshold = ${winner.threshold}\`.**\n\n- **Validation**: ${describe(winner.validation)}\n- **Test**: ${describe(winner.test)}\n- Production ships \`${PRODUCTION_THRESHOLD}\`: validation ${describe(production.validation)}.\n\nThe rule held answerable quality at the \`threshold = 0\` level (nDCG@10 and context recall must not regress, on the validation split) and then took the threshold that refuses the most unanswerable questions. So this is a refusal gain, not a quality gain — if answerable quality had fallen, the threshold would have been ineligible regardless of how much it refused.`

const tableRows = rows
  .map(
    (row) =>
      `| ${row.threshold} | ${row.validation.answerableQuestions} | ${format4(row.validation.metrics.recallAt5)} | ` +
      `${format4(row.validation.metrics.ndcgAt10)} | ${format4(row.validation.noResultRate)} | ` +
      `${format4(row.validation.unanswerable.noResultRate)} | ` +
      `${row.validation.unanswerable.meanRetrieved.toFixed(1)} | ${format4(row.test.metrics.ndcgAt10)} | ` +
      `${format4(row.test.unanswerable.noResultRate)} |`
  )
  .join('\n')

const markdown = `# Threshold derivation — v1.6 (#192)

Generated by \`node scripts/eval-threshold.mjs\`. Numbers are harness output; do not edit them by hand.

## What was measured

The real harness, the same corpus and the production retrieval config
(\`candidateK=20, contextK=3\`), once per candidate threshold. The **validation**
split selects; the **test** split reports. The split is the committed manifest
\`eval/splits.json\`, so the same questions are on the same side on every machine.

Quality columns cover the answerable questions only; **Unans.** columns cover the
unanswerable ones, where returning nothing is the desired outcome and so a *higher*
no-result rate is better.

| Threshold | n (val) | Recall@5 (val) | nDCG@10 (val) | No-result (val) | Unans. no-result (val) | Unans. retrieved (val) | nDCG@10 (test) | Unans. no-result (test) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${tableRows}

## Selection rule

Hold the answerable quality line — validation nDCG@10 and context recall must not
regress versus \`threshold = 0\` — then take the threshold that refuses the most
unanswerable questions. Tie-break on the lowest threshold.

Raising a threshold is only worth anything if it refuses what the sources do not answer;
the quality gate is there so a refusal gain can never be bought with a retrieval loss.

## Outcome

${outcome}

## Caveat on this corpus

The split removes the most obvious form of overfitting, but ${reference.validation.answerableQuestions}
answerable questions on the validation side is a thin basis for a decision, and the corpus
is still small. A threshold is a product decision with a **refusal-rate** cost attached, so
a recommendation here is only as good as the corpus behind it. Re-run this after the
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

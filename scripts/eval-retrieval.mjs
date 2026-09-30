#!/usr/bin/env node
/**
 * Retrieval experiments for #77, with held-out strategy adoption (#192).
 *
 * Runs the real RAG eval harness once per retrieval strategy on the **validation** split,
 * decides there with the amended adoption rule (#192 child 10), and then re-runs the
 * shipped strategy and the selected one on the **test** split. Selection never sees
 * `test`; `test` only reports.
 *
 * That split is the whole point. The previous version decided on `split = all`, which
 * meant the strategy was chosen and scored on the same questions — the same mistake the
 * threshold experiment had already been fixed for.
 *
 * The harness does the measuring; this script only orchestrates and tabulates.
 *
 * Usage:
 *   node scripts/eval-retrieval.mjs
 *
 * The embedding model must already be prepared (`npm run eval:prepare`).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT_MD = resolve(readArg('--out=', 'docs/eval/retrieval-v1.6.md'))
const OUT_JSON = OUT_MD.replace(/\.md$/, '.json')

/**
 * `dense` is the shipped default and the comparison baseline. `sparse` is BM25 over
 * the shared FTS index (#96); `hybrid` is RRF of the two. A reranker is not
 * evaluated: it needs a cross-encoder model, which this offline harness does not
 * have, and pretending otherwise would be a number invented by the script.
 */
const STRATEGIES = [
  { id: 'dense', label: 'dense (vector)' },
  { id: 'sparse', label: 'sparse (BM25)' },
  { id: 'hybrid', label: 'hybrid (RRF of dense + BM25)' }
]

/** The shipped strategy. Everything is reported as a delta against it. */
const BASELINE_ID = 'dense'

function readArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : fallback
}

// Node 24 refuses to spawn a `.cmd`/`.bat` without `shell: true` (EINVAL), and the
// `.bin` entry is exactly that on Windows. Use the real binary the wrapper runs.
const { default: electronBinary } = await import('electron')
const executable = resolve(electronBinary)

if (!existsSync(executable)) {
  console.error('[retrieval] could not find the electron binary. Run `npm install` first.')
  process.exit(1)
}

// The rule lives in `src/main/eval/adoption.ts` so it can be unit tested; it decides
// whether a shipped default moves.
const { ADOPTION_METRICS, decideAdoption } = await import('../src/main/eval/adoption.ts')

function runStrategy(strategy, split, outDir) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '.',
      '--eval-harness',
      '--eval-baseline=v1.6',
      `--eval-out=${outDir}`,
      `--eval-split=${split}`,
      `--eval-retrieval=${strategy.id}`
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
        reject(new Error(`${strategy.id} (${split}) exited with code ${code}`))
        return
      }
      const reportPath = join(outDir, 'baseline-v1.6.json')
      if (!existsSync(reportPath)) {
        reject(new Error(`${strategy.id} (${split}) wrote no report`))
        return
      }
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      resolvePromise({
        id: strategy.id,
        label: strategy.label,
        split,
        questions: report.config.questions,
        answerableCount: report.byType.reduce((total, entry) => total + entry.questions, 0),
        chunking: `${report.config.chunking.chunkSize}/${report.config.chunking.chunkOverlap}`,
        chunkCount: report.config.chunkCount,
        ...report.metrics,
        ...readTiming(join(outDir, 'baseline-v1.6.md'))
      })
    })
  })
}

/** p95 is informational and excluded from the deterministic JSON. */
function readTiming(mdPath) {
  if (!existsSync(mdPath)) return { latencyP95Ms: null }
  const text = readFileSync(mdPath, 'utf8')
  const p95 = /p95 ([\d.]+) ms/.exec(text)
  return { latencyP95Ms: p95 ? Number(p95[1]) : null }
}

function runInto(workDir, strategy, split) {
  const outDir = join(workDir, `${split}-${strategy.id}`)
  mkdirSync(outDir, { recursive: true })
  return runStrategy(strategy, split, outDir)
}

const format4 = (value) => value.toFixed(4)

const workDir = mkdtempSync(join(tmpdir(), 'knownote-retrieval-'))
let validation = []
let test = []
let decision = { primary: null, saturated: [], winner: null }

try {
  // ── Validation: this is the only phase that may choose ────────────────────────
  for (const strategy of STRATEGIES) {
    console.log(`[retrieval] validation: ${strategy.label}`)
    validation.push(await runInto(workDir, strategy, 'validation'))
  }

  const baselineRow = validation.find((row) => row.id === BASELINE_ID)
  if (!baselineRow) throw new Error('the dense strategy did not run on validation')

  decision = decideAdoption(baselineRow, validation)

  // ── Test: reports only. Never lets the choice see these questions. ────────────
  const testIds = [BASELINE_ID]
  if (decision.winner && decision.winner.id !== BASELINE_ID) testIds.push(decision.winner.id)

  for (const id of testIds) {
    const strategy = STRATEGIES.find((entry) => entry.id === id)
    console.log(`[retrieval] test: ${strategy.label}`)
    test.push(await runInto(workDir, strategy, 'test'))
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

const winner = decision.winner
const saturationNote = decision.saturated.length
  ? `Saturated on the validation split (no headroom, so they cannot decide): ${decision.saturated
      .map((key) => `\`${key}\``)
      .join(', ')}.`
  : 'No metric in the rule is saturated on the validation split.'

const metricColumns = ['recallAt1', 'recallAt5', 'mrr', 'ndcgAt10', 'mapAt10', 'contextPrecision']
const tableRow = (row) =>
  `| ${row.label} | ${metricColumns.map((key) => format4(row[key])).join(' | ')} | ${row.questions} | ${
    row.latencyP95Ms?.toFixed(2) ?? '—'
  } ms |`

const validationTable = validation.map(tableRow).join('\n')
const testTable = test.map(tableRow).join('\n')

/** Per-metric delta of the selected strategy against dense, on the test split. */
const testDense = test.find((row) => row.id === BASELINE_ID)
const testWinner = winner ? test.find((row) => row.id === winner.id) : null

const deltaRows =
  testWinner && testDense
    ? ADOPTION_METRICS.map((key) => {
        const delta = testWinner[key] - testDense[key]
        const sign = delta > 0 ? '+' : ''
        return `| ${key} | ${format4(testDense[key])} | ${format4(testWinner[key])} | ${sign}${format4(delta)} |`
      }).join('\n')
    : ''

const outcome = winner
  ? `**\`${winner.label}\` clears the rule on validation.** The deciding metric was \`${decision.primary}\` (${format4(
      winner[decision.primary]
    )} vs dense ${format4(
      validation.find((row) => row.id === BASELINE_ID)[decision.primary]
    )}), and it regressed none of ${ADOPTION_METRICS.map((key) => `\`${key}\``).join(', ')}. ${saturationNote}

That decision was made on questions in \`test\` **not** seeing. What follows is the held-out
result, and it is the only number that should inform shipping it:

| Metric | dense (test) | selected (test) | delta |
| --- | --- | --- | --- |
${deltaRows}

Shipping a new default is a product decision this script does not make. It measures.`
  : `**No strategy cleared the rule on validation**, so there is no adoption candidate and
\`test\` reports the shipped strategy only. ${saturationNote}

A negative result is the point of the experiment: it is the measurement that says the extra
machinery is not worth its cost on this corpus, not a failure to deliver.`

const markdown = `# Retrieval experiments — v1.6 (#77, #192)

Generated by \`node scripts/eval-retrieval.mjs\`. Numbers are harness output; do not edit them by hand.

## What was measured

Each strategy runs the real harness on the **validation** split of
\`eval/splits.json\`, with chunking held fixed at ${validation[0]?.chunking ?? '1000/100'}.

The strategy is then chosen **there**, and only the chosen one (plus the shipped default)
is re-run on **test**. The choice never sees \`test\`; \`test\` only reports. The previous
version decided on \`split = all\`, which scored the choice on the questions it was fitted
to.

## Validation — this is where the choice happens

| Strategy | Recall@1 | Recall@5 | MRR | nDCG@10 | MAP@10 | Context P | n | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${validationTable}

## Test — reported, not selected

| Strategy | Recall@1 | Recall@5 | MRR | nDCG@10 | MAP@10 | Context P | n | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
${testTable}

## Not evaluated

**Reranking.** The issue lists "hybrid + reranker" as a step, but a cross-encoder
model is not available offline and inventing its numbers would defeat the point of
the harness. It stays open until a model can be pinned the way the embedding model
is.

## Adoption rule

> Adopt a strategy when it improves the **first metric with headroom** — in the order
> \`recallAt5\`, \`nDCG@10\`, \`MRR\`, \`MAP@10\` — and regresses none of the others. A metric
> already at its maximum has no headroom and cannot decide anything; a rule that depends
> on one is unsatisfiable, not strict (#192 child 10).
>
> The rule is applied on \`validation\`. A change that trades a large latency increase for a
> marginal quality gain is a product decision, not an automatic win.

## Outcome

${outcome}

## Reproduce

\`\`\`bash
npm run eval:prepare   # one-time, networked model bootstrap
npm run eval:retrieval # offline; runs every strategy and rewrites this file
\`\`\`
`

mkdirSync(resolve(OUT_MD, '..'), { recursive: true })
writeFileSync(
  OUT_JSON,
  `${JSON.stringify(
    {
      baseline: 'v1.6',
      split: { selects: 'validation', reports: 'test', manifest: 'eval/splits.json' },
      decision: { primary: decision.primary, saturated: decision.saturated, winner: winner?.id ?? null },
      validation,
      test
    },
    null,
    2
  )}\n`
)
writeFileSync(OUT_MD, markdown)

console.log(
  `[retrieval] ${winner ? `validation selected: ${winner.label}` : 'validation selected nothing; test reports dense'}`
)
console.log(`[retrieval] wrote ${OUT_JSON} and ${OUT_MD}`)

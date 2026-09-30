#!/usr/bin/env node
/**
 * Per-query paired deltas for dense ↔ hybrid (#192).
 *
 * The aggregate comparison left a question it cannot answer: hybrid is ahead on the full
 * set and level on `validation`, and an average cannot say whether that is a broad small
 * gain or a handful of cases it rescued. A mean over forty questions cannot distinguish
 * "helps a little everywhere" from "helps a lot twice".
 *
 * So this reports the pair per question and the classification per query type:
 *
 *   improved / tied / regressed, with the rank move and the nDCG@10 delta
 *
 * `validation` is the side that selects; the `test` breakdown **explains** the observed
 * difference and must not be used to choose. Nothing here changes the shipped strategy.
 *
 * Metrics come from `src/main/eval/metrics.ts` rather than being reimplemented, so a delta
 * cannot disagree with the metric it is a delta of.
 *
 * Usage:
 *   node scripts/eval-paired.mjs
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT_MD = resolve(readArg('--out=', 'docs/eval/paired-v1.6.md'))
const OUT_JSON = OUT_MD.replace(/\.md$/, '.json')

const SPLITS = ['validation', 'test']
const STRATEGIES = [
  { id: 'dense', label: 'dense (vector)' },
  { id: 'hybrid', label: 'hybrid (RRF of dense + BM25)' }
]

/** How many rows to show in each mover table. */
const MOVER_LIMIT = 8

function readArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : fallback
}

// Node 24 refuses to spawn a `.cmd`/`.bat` without `shell: true` (EINVAL), and the
// `.bin` entry is exactly that on Windows. Use the real binary the wrapper runs.
const { default: electronBinary } = await import('electron')
const executable = resolve(electronBinary)

if (!existsSync(executable)) {
  console.error('[paired] could not find the electron binary. Run `npm install` first.')
  process.exit(1)
}

const { ndcgAtK, recallAtK } = await import('../src/main/eval/metrics.ts')

function runStrategy(strategy, split, outDir) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '.',
      '--eval-harness',
      '--eval-baseline=paired',
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
      const reportPath = join(outDir, 'baseline-paired.json')
      if (!existsSync(reportPath)) {
        reject(new Error(`${strategy.id} (${split}) wrote no report`))
        return
      }
      resolvePromise(JSON.parse(readFileSync(reportPath, 'utf8')))
    })
  })
}

/** One side's per-question view, with the metrics the comparison is made of. */
function sideOf(question) {
  return {
    firstRelevantRank: question.firstRelevantRank,
    recallAt5: recallAtK(question.matchesByRank, question.relevantCount, 5),
    ndcgAt10: ndcgAtK(question.matchesByRank, question.relevantCount, 10)
  }
}

/**
 * Classify the pair. `firstRelevantRank` is 0 for "never found", so the miss cases cannot be
 * folded into an arithmetic delta: going from found to not-found is a regression no rank
 * number expresses.
 */
function classify(dense, hybrid) {
  const denseFound = dense.firstRelevantRank > 0
  const hybridFound = hybrid.firstRelevantRank > 0

  if (denseFound && hybridFound) {
    const rankDelta = dense.firstRelevantRank - hybrid.firstRelevantRank
    return {
      classification: rankDelta > 0 ? 'improved' : rankDelta < 0 ? 'regressed' : 'tied',
      rankDelta
    }
  }
  if (!denseFound && hybridFound) return { classification: 'improved', rankDelta: null }
  if (denseFound && !hybridFound) return { classification: 'regressed', rankDelta: null }
  return { classification: 'tied', rankDelta: null }
}

/** Human-readable rank move that survives the 0 = "not found" sentinel. */
const rankText = (rank) => (rank > 0 ? String(rank) : 'not found')

const format4 = (value) => (value === null ? '—' : value.toFixed(4))
const signed = (value, digits = 4) =>
  value === null ? '—' : `${value > 0 ? '+' : ''}${value.toFixed(digits)}`

const workDir = mkdtempSync(join(tmpdir(), 'knownote-paired-'))
const bySplit = {}

try {
  for (const split of SPLITS) {
    const reports = {}
    for (const strategy of STRATEGIES) {
      console.log(`[paired] ${split}: ${strategy.label}`)
      const outDir = join(workDir, `${split}-${strategy.id}`)
      mkdirSync(outDir, { recursive: true })
      reports[strategy.id] = await runStrategy(strategy, split, outDir)
    }

    const denseById = new Map(reports.dense.perQuestion.map((q) => [q.id, q]))
    const pairs = []
    for (const hybridQuestion of reports.hybrid.perQuestion) {
      const denseQuestion = denseById.get(hybridQuestion.id)
      if (!denseQuestion) continue
      // Unanswerable questions have no rank to compare; they are measured by the
      // abstention diagnostics, not here.
      if (!denseQuestion.answerable) continue

      const dense = sideOf(denseQuestion)
      const hybrid = sideOf(hybridQuestion)
      const { classification, rankDelta } = classify(dense, hybrid)
      pairs.push({
        id: hybridQuestion.id,
        type: hybridQuestion.type,
        question: hybridQuestion.question,
        dense,
        hybrid,
        delta: {
          rank: rankDelta,
          recallAt5: hybrid.recallAt5 - dense.recallAt5,
          ndcgAt10: hybrid.ndcgAt10 - dense.ndcgAt10
        },
        classification
      })
    }

    bySplit[split] = {
      questions: pairs.length,
      pairs,
      byType: aggregateByType(pairs),
      meanDelta: {
        rank: mean(pairs.map((p) => p.delta.rank).filter((value) => value !== null)),
        recallAt5: mean(pairs.map((p) => p.delta.recallAt5)),
        ndcgAt10: mean(pairs.map((p) => p.delta.ndcgAt10))
      }
    }
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

function mean(values) {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

function aggregateByType(pairs) {
  const types = [...new Set(pairs.map((p) => p.type))].sort()
  return types.map((type) => {
    const group = pairs.filter((p) => p.type === type)
    const count = (label) => group.filter((p) => p.classification === label).length
    return {
      type,
      questions: group.length,
      improved: count('improved'),
      tied: count('tied'),
      regressed: count('regressed'),
      meanDeltaNdcg10: mean(group.map((p) => p.delta.ndcgAt10)),
      meanDeltaRank: mean(group.map((p) => p.delta.rank).filter((value) => value !== null))
    }
  })
}

/** Wins and regressions, by rank move. Misses are listed separately and always first. */
function movers(pairs) {
  const withRank = pairs.filter((p) => p.delta.rank !== null && p.delta.rank !== 0)
  const wins = withRank
    .filter((p) => p.delta.rank > 0)
    .sort((a, b) => b.delta.rank - a.delta.rank)
    .slice(0, MOVER_LIMIT)
  const losses = withRank
    .filter((p) => p.delta.rank < 0)
    .sort((a, b) => a.delta.rank - b.delta.rank)
    .slice(0, MOVER_LIMIT)
  const foundByHybrid = pairs.filter(
    (p) => p.dense.firstRelevantRank === 0 && p.hybrid.firstRelevantRank > 0
  )
  const lostByHybrid = pairs.filter(
    (p) => p.dense.firstRelevantRank > 0 && p.hybrid.firstRelevantRank === 0
  )
  return { wins, losses, foundByHybrid, lostByHybrid }
}

const typeTable = (rows) =>
  rows
    .map(
      (row) =>
        `| ${row.type} | ${row.questions} | ${row.improved} | ${row.tied} | ${row.regressed} | ` +
        `${signed(row.meanDeltaNdcg10)} | ${signed(row.meanDeltaRank, 2)} |`
    )
    .join('\n')

const moverTable = (rows) =>
  rows.length === 0
    ? '| — | — | — | — |'
    : rows
        .map(
          (p) =>
            `| ${p.id} | ${p.type} | ${rankText(p.dense.firstRelevantRank)} | ` +
            `${rankText(p.hybrid.firstRelevantRank)} | ${signed(p.delta.rank, 0)} | ` +
            `${signed(p.delta.ndcgAt10)} |`
        )
        .join('\n')

const splitSection = (name, data, note) => {
  const { wins, losses, foundByHybrid, lostByHybrid } = movers(data.pairs)
  return `## ${name}

${note}

Questions compared: ${data.questions}. Mean ΔnDCG@10 ${signed(data.meanDelta.ndcgAt10)},
mean Δrank ${signed(data.meanDelta.rank, 2)}.

### By query type

| Type | n | improved | tied | regressed | mean ΔnDCG@10 | mean Δrank |
| --- | --- | --- | --- | --- | --- | --- |
${typeTable(data.byType)}

### Biggest rank wins

| id | type | dense rank | hybrid rank | Δrank | ΔnDCG@10 |
| --- | --- | --- | --- | --- | --- |
${moverTable(wins)}

### Biggest rank regressions

| id | type | dense rank | hybrid rank | Δrank | ΔnDCG@10 |
| --- | --- | --- | --- | --- | --- |
${moverTable(losses)}

${
  foundByHybrid.length > 0
    ? `**Found by hybrid, missed by dense** (${foundByHybrid.length}): ${foundByHybrid
        .map((p) => `${p.id} (${p.type})`)
        .join(', ')}`
    : '**Found by hybrid, missed by dense**: none.'
}

${
  lostByHybrid.length > 0
    ? `**Lost by hybrid, found by dense** (${lostByHybrid.length}): ${lostByHybrid
        .map((p) => `${p.id} (${p.type})`)
        .join(', ')}`
    : '**Lost by hybrid, found by dense**: none.'
}
`
}

const markdown = `# Paired dense ↔ hybrid deltas — v1.6 (#192)

Generated by \`node scripts/eval-paired.mjs\`. Numbers are harness output; do not edit them by hand.

## What this answers

The aggregate comparison says hybrid is ahead on the full set and level on \`validation\`.
An average cannot say whether that is a broad small gain or a few rescued cases, and those
two readings imply different next steps. This is the per-question pair.

Metrics come from \`src/main/eval/metrics.ts\`, so a delta cannot disagree with the metric it
is a delta of. Unanswerable questions are excluded — they have no rank to compare, and the
abstention diagnostics cover them.

\`validation\` is the side that **selects**; the \`test\` breakdown below **explains** the
difference that was observed and must not be used to choose. Nothing here changes the
shipped strategy.

${splitSection(
  'Validation (this side selects)',
  bySplit.validation,
  'Chosen on this side, so a win here is eligible to inform a decision.'
)}
${splitSection(
  'Test (explanatory only)',
  bySplit.test,
  'Not used to choose anything. Present because the aggregate difference this is meant to explain was measured here.'
)}
## Reproduce

\`\`\`bash
npm run eval:prepare   # one-time, networked model bootstrap
npm run eval:paired    # offline; rewrites this file
\`\`\`
`

mkdirSync(resolve(OUT_MD, '..'), { recursive: true })
writeFileSync(
  OUT_JSON,
  `${JSON.stringify(
    {
      baseline: 'v1.6',
      strategies: ['dense', 'hybrid'],
      splits: Object.fromEntries(
        SPLITS.map((split) => [
          split,
          {
            questions: bySplit[split].questions,
            meanDelta: bySplit[split].meanDelta,
            byType: bySplit[split].byType,
            pairs: bySplit[split].pairs
          }
        ])
      )
    },
    null,
    2
  )}\n`
)
writeFileSync(OUT_MD, markdown)

for (const split of SPLITS) {
  const data = bySplit[split]
  const counts = data.byType.reduce(
    (acc, row) => ({
      improved: acc.improved + row.improved,
      tied: acc.tied + row.tied,
      regressed: acc.regressed + row.regressed
    }),
    { improved: 0, tied: 0, regressed: 0 }
  )
  console.log(
    `[paired] ${split}: ${data.questions} questions, improved ${counts.improved} / tied ${counts.tied} / regressed ${counts.regressed}, mean ΔnDCG@10 ${signed(data.meanDelta.ndcgAt10)}`
  )
}
console.log(`[paired] wrote ${OUT_JSON} and ${OUT_MD}`)

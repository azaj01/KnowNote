#!/usr/bin/env node
/**
 * Parameter sweep + dashboard for #192 (child 7).
 *
 * Runs the real harness over a bounded grid of `strategy × candidateK × contextK` and
 * writes one table. The point is not to find a single number — #192 is explicit that a
 * single aggregate "RAG score" says almost nothing — but to make the trade-offs
 * visible side by side: quality, the context window's precision/recall, prompt size,
 * index size and latency.
 *
 * Chunking is held fixed so a row differs from its neighbour in one parameter.
 *
 * Usage:
 *   node scripts/eval-sweep.mjs
 *   node scripts/eval-sweep.mjs --strategies=dense --candidate-k=10,20 --context-k=3,5
 *
 * The embedding model must already be prepared (`npm run eval:prepare`).
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const OUT_MD = resolve(readArg('--out=', 'docs/eval/sweep-v1.6.md'))
const OUT_JSON = OUT_MD.replace(/\.md$/, '.json')

const STRATEGIES = readList('--strategies=', ['dense', 'hybrid'])
const CANDIDATE_KS = readNumberList('--candidate-k=', [5, 10, 20, 40])
const CONTEXT_KS = readNumberList('--context-k=', [3, 5, 8])

function readArg(prefix, fallback) {
  const arg = process.argv.find((value) => value.startsWith(prefix))
  return arg ? arg.slice(prefix.length) : fallback
}

function readList(prefix, fallback) {
  const raw = readArg(prefix, null)
  return raw ? raw.split(',').filter(Boolean) : fallback
}

function readNumberList(prefix, fallback) {
  const raw = readArg(prefix, null)
  if (!raw) return fallback
  return raw.split(',').map((value) => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) throw new Error(`${prefix} expects numbers, got ${value}`)
    return parsed
  })
}

// Node 24 refuses to spawn a `.cmd`/`.bat` without `shell: true` (EINVAL), and the
// `.bin` entry is exactly that on Windows. Use the real binary the wrapper runs.
const { default: electronBinary } = await import('electron')
const executable = resolve(electronBinary)

if (!existsSync(executable)) {
  console.error('[sweep] could not find the electron binary. Run `npm install` first.')
  process.exit(1)
}

function runOne(strategy, candidateK, contextK, outDir) {
  return new Promise((resolvePromise, reject) => {
    const args = [
      '.',
      '--eval-harness',
      '--eval-baseline=v1.6',
      `--eval-out=${outDir}`,
      `--eval-retrieval=${strategy}`,
      `--eval-candidate-k=${candidateK}`,
      `--eval-context-k=${contextK}`
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
        reject(new Error(`${strategy} candidateK=${candidateK} contextK=${contextK} exited ${code}`))
        return
      }
      const reportPath = join(outDir, 'baseline-v1.6.json')
      if (!existsSync(reportPath)) {
        reject(new Error(`${strategy} candidateK=${candidateK} contextK=${contextK} wrote no report`))
        return
      }
      resolvePromise(JSON.parse(readFileSync(reportPath, 'utf8')))
    })
  })
}

/** p95 and index size are informational; the deterministic JSON excludes timing. */
function readTiming(mdPath) {
  if (!existsSync(mdPath)) return { latencyP95Ms: null }
  const text = readFileSync(mdPath, 'utf8')
  const p95 = /p95 ([\d.]+) ms/.exec(text)
  return { latencyP95Ms: p95 ? Number(p95[1]) : null }
}

const mean = (values) => (values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length)

/**
 * `contextK > candidateK` is not a cell, it is an arithmetic mistake: the harness only
 * fetches `candidateK` passages, so the window can never be filled. Skipping them is why
 * the default grid no longer contains rows that looked like "8 is as good as 5" when
 * passages 6-8 were simply never retrieved (#192 review). The harness refuses the same
 * combination, so a typo on the command line fails loudly instead of silently.
 */
const grid = []
const skipped = []
for (const strategy of STRATEGIES) {
  for (const candidateK of CANDIDATE_KS) {
    for (const contextK of CONTEXT_KS) {
      if (contextK > candidateK) skipped.push({ strategy, candidateK, contextK })
      else grid.push({ strategy, candidateK, contextK })
    }
  }
}

if (skipped.length > 0) {
  console.log(
    `[sweep] skipped ${skipped.length} cell(s) with contextK > candidateK: ` +
      skipped.map((c) => `${c.strategy} ${c.candidateK}/${c.contextK}`).join(', ')
  )
}

const workDir = mkdtempSync(join(tmpdir(), 'knownote-sweep-'))
const rows = []

try {
  for (const cell of grid) {
    const { strategy, candidateK, contextK } = cell
    console.log(`[sweep] ${strategy} candidateK=${candidateK} contextK=${contextK}`)
    const outDir = join(workDir, `${strategy}-${candidateK}-${contextK}`)
    mkdirSync(outDir, { recursive: true })
    const report = await runOne(strategy, candidateK, contextK, outDir)
    const perQuestion = report.perQuestion ?? []
    const noResult = perQuestion.filter((q) => q.retrievedCount === 0).length

    rows.push({
      strategy,
      candidateK,
      contextK,
      recallAt5: report.metrics.recallAt5,
      ndcgAt10: report.metrics.ndcgAt10,
      mapAt10: report.metrics.mapAt10,
      contextPrecision: report.metrics.contextPrecision,
      contextRecall: report.metrics.contextRecall,
      noResultRate: perQuestion.length === 0 ? 0 : noResult / perQuestion.length,
      meanContextChars: mean(perQuestion.map((q) => q.contextChars)),
      chunkCount: report.config.chunkCount,
      ...readTiming(join(outDir, 'baseline-v1.6.md'))
    })
  }
} finally {
  rmSync(workDir, { recursive: true, force: true })
}

const format4 = (value) => value.toFixed(4)

const tableRows = rows
  .map(
    (row) =>
      `| ${row.strategy} | ${row.candidateK} | ${row.contextK} | ${format4(row.recallAt5)} | ` +
      `${format4(row.ndcgAt10)} | ${format4(row.mapAt10)} | ${format4(row.contextPrecision)} | ` +
      `${format4(row.contextRecall)} | ${format4(row.noResultRate)} | ` +
      `${Math.round(row.meanContextChars)} | ${row.chunkCount} | ${row.latencyP95Ms?.toFixed(2) ?? '—'} ms |`
  )
  .join('\n')

const best = (key, filter = () => true) =>
  rows.filter(filter).reduce((a, b) => (a === null || b[key] > a[key] ? b : a), null)

/**
 * A skipped cell is reported, not silently dropped: "we did not measure this" and "this
 * measured the same as its neighbour" are different statements, and the earlier version
 * of this file showed the second when it meant the first.
 */
const skippedNote =
  skipped.length === 0
    ? ''
    : `\n\n## Skipped cells\n\n\`contextK > candidateK\` cannot be filled: the harness fetches \`candidateK\`\npassages, so a wider window would contain fewer passages than it claims. These
${skipped.length} cell(s) are excluded rather than reported as equal to a narrower one:\n\n${skipped
        .map((c) => `- \`${c.strategy}\` candidateK=${c.candidateK}, contextK=${c.contextK}`)
        .join('\n')}\n\nThe harness refuses the same combination at the flag level, so a typo fails loudly.\n`

const bestNdcg = best('ndcgAt10')
const bestContextPrecision = best('contextPrecision')

const markdown = `# Parameter sweep — v1.6 (#192)

Generated by \`node scripts/eval-sweep.mjs\`. Numbers are harness output; do not edit them by hand.

## What was measured

The real harness, the same corpus, chunking held fixed, over
${STRATEGIES.join(' / ')} × candidateK {${CANDIDATE_KS.join(', ')}} × contextK {${CONTEXT_KS.join(', ')}} — ${rows.length} runs.
Each row differs from its neighbour in one parameter.${skipped.length > 0 ? `\n\n${skipped.length} further cell(s) were **skipped** because \`contextK > candidateK\`; see below.` : ''}

| Strategy | candidateK | contextK | Recall@5 | nDCG@10 | MAP@10 | Context P | Context R | No-result | Context chars | Index | p95 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
${tableRows}
${skippedNote}

## How to read it

- **\`candidateK\`** moves the ranking metrics and latency: it is how wide the first
  stage searches. It cannot change \`Context P\`/\`Context R\`, because those look at the
  first \`contextK\` of the fused list and a prefix is unaffected by how deep the list was.
- **\`contextK\`** moves \`Context P\` and \`Context R\` and the context size, not the
  ranking metrics. Wider recall rises and precision falls; that is the trade, and both
  columns are here so it is visible rather than argued about.
- **Context chars** is a proxy for prompt size, not a token count: the harness pins the
  embedding model, not any generation model's tokenizer.
- **No-result** is the share of questions whose retrieval returned nothing at all.

Best nDCG@10 in this grid: \`${bestNdcg.strategy}\` candidateK=${bestNdcg.candidateK},
contextK=${bestNdcg.contextK} (${format4(bestNdcg.ndcgAt10)}).
Best context precision: \`${bestContextPrecision.strategy}\` candidateK=${bestContextPrecision.candidateK},
contextK=${bestContextPrecision.contextK} (${format4(bestContextPrecision.contextPrecision)}).

These are **not** recommendations. Selecting the grid maximum on the same questions is
how a benchmark becomes a lookup table; the adoption rule in \`baseline-v1.6.md\`
decides, and the \`validation\`/\`test\` split is what keeps that honest.

## Reproduce

\`\`\`bash
npm run eval:prepare   # one-time, networked model bootstrap
npm run eval:sweep     # offline; rewrites this file
\`\`\`
`

mkdirSync(resolve(OUT_MD, '..'), { recursive: true })
writeFileSync(OUT_JSON, `${JSON.stringify({ baseline: 'v1.6', rows }, null, 2)}\n`)
writeFileSync(OUT_MD, markdown)

console.log(`[sweep] wrote ${OUT_JSON} and ${OUT_MD}`)

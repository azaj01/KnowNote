#!/usr/bin/env node
/**
 * Print the block ordinals the harness will resolve ground truth against (#192).
 *
 * Ground truth in `eval/questions.jsonl` is expressed as `document` + `block` + `quote`,
 * and `block` is the `document_blocks.order` the ingestion pipeline produced — not a line
 * number and not a paragraph index a human counted. Authoring a corpus by hand and then
 * guessing those ordinals is how a dataset quietly drifts, so this prints the real ones
 * through the **same loader and block builder the harness uses**.
 *
 * Usage:
 *   node --experimental-transform-types scripts/eval-blocks.mjs eval/corpus/river-monitoring.md
 *   node --experimental-transform-types scripts/eval-blocks.mjs eval/corpus/*.md
 */

import { readFile, readdir } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { MarkdownLoader } from '../src/main/services/loaders/MarkdownLoader.ts'
import { buildDocumentBlocks } from '../src/main/services/blocks/documentBlocks.ts'

const targets = process.argv.slice(2)
if (targets.length === 0) {
  console.error('usage: node --experimental-transform-types scripts/eval-blocks.mjs <file.md> [...]')
  process.exit(1)
}

const loader = new MarkdownLoader()

async function printFile(path) {
  const buffer = await readFile(path)
  const result = await loader.loadFromBuffer(buffer)
  const blocks = buildDocumentBlocks({ content: result.content, structure: result.structure })

  console.log(`\n${path} — ${blocks.length} blocks`)
  for (const block of blocks) {
    const text = block.text.replace(/\s+/g, ' ').trim()
    const shown = text.length > 96 ? `${text.slice(0, 93)}...` : text
    console.log(`  ${String(block.order).padStart(3)}  ${block.kind.padEnd(9)}  ${shown}`)
  }
  return blocks.length
}

let total = 0
for (const target of targets) {
  const path = resolve(target)
  if (extname(path) === '.md') {
    total += await printFile(path)
  } else {
    // A directory: every markdown file in it, which is the whole corpus case.
    const entries = (await readdir(path)).filter((name) => name.endsWith('.md')).sort()
    for (const entry of entries) total += await printFile(join(path, entry))
  }
}
console.log(`\ntotal blocks: ${total}`)

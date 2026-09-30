import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runEvalHarness } from '../src/main/eval/harness.ts'

/**
 * The harness's own invariants (#192). These run before any database or retrieval work,
 * so they can be pinned without a store: the check is the first statement of
 * `runEvalHarness`, and a violation must fail loudly rather than produce a number.
 */

const options = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  corpusDir: 'eval/corpus',
  corpusLabel: 'eval/corpus',
  questionsPath: 'eval/questions.jsonl',
  splitsPath: 'eval/splits.json',
  baseline: 'test',
  split: 'all',
  candidateK: 20,
  contextK: 3,
  threshold: 0.5,
  chunkOptions: {
    chunkSize: 1000,
    chunkOverlap: 100,
    minChunkSize: 100,
    allowSpanPages: false,
    respectHeadings: false
  },
  strategy: 'dense',
  ...overrides
})

/**
 * A context window wider than the retrieval depth can never be filled. The sweep used
 * to contain `candidateK=5, contextK=8` and report it as identical to `contextK=5` —
 * not because 8 assessed the same as 5, but because passages 6-8 did not exist (#192
 * review). A wrong number that looks like a measurement is worse than a failure.
 */
test('a context window wider than the retrieval depth is refused', async () => {
  await assert.rejects(
    () => runEvalHarness({} as never, {} as never, options({ candidateK: 5, contextK: 8 }) as never),
    /contextK \(8\) cannot exceed candidateK \(5\)/
  )
})

test('the refusal names both numbers, so the fix is obvious', async () => {
  await assert.rejects(
    () => runEvalHarness({} as never, {} as never, options({ candidateK: 3, contextK: 10 }) as never),
    (error: Error) => {
      assert.match(error.message, /candidateK \(3\)/)
      assert.match(error.message, /contextK \(10\)/)
      assert.match(error.message, /can never be filled/)
      return true
    }
  )
})

test('contextK equal to candidateK is allowed and reaches further invariants', async () => {
  // No database is provided, so the call must fail *after* the window check — proving the
  // boundary value is accepted rather than rejected.
  await assert.rejects(
    () => runEvalHarness({} as never, {} as never, options({ candidateK: 5, contextK: 5 }) as never),
    (error: Error) => !/cannot exceed/.test(error.message)
  )
})

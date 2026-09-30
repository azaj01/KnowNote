import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  selectSplit,
  splitBucket,
  type EvalQuestion,
  type EvalSplit
} from '../src/main/eval/types.ts'

/**
 * The eval split (#192). Thresholds and other swept parameters have to be chosen on
 * questions that did not take part in the choice, so the split has to be
 * deterministic: the same `questions.jsonl` must produce the same validation and
 * test sets on every machine.
 */

const question = (id: string): EvalQuestion => ({
  id,
  question: id,
  relevant: [{ document: 'a.md', page: null, block: 0 }]
})

const questions = Array.from({ length: 30 }, (_, index) => question(`q${String(index + 1).padStart(3, '0')}`))

test('the split buckets only ever return 0, 1 or 2', () => {
  for (const q of questions) {
    const bucket = splitBucket(q.id)
    assert.ok(bucket === 0 || bucket === 1 || bucket === 2, `${q.id} -> ${bucket}`)
  }
})

test('the split is deterministic, not random', () => {
  const first = selectSplit(questions, 'validation').map((q) => q.id)
  const second = selectSplit(questions, 'validation').map((q) => q.id)
  assert.deepEqual(first, second)
})

test('validation and test partition the questions without overlap', () => {
  const validation = selectSplit(questions, 'validation').map((q) => q.id)
  const test = selectSplit(questions, 'test').map((q) => q.id)

  assert.equal(validation.length + test.length, questions.length)
  assert.equal(new Set([...validation, ...test]).size, questions.length)
  // Both sides are non-empty on a 30-question set, so neither arm is vacuous.
  assert.ok(validation.length > 0 && test.length > 0)
})

test('`all` is the whole set, and the selected questions keep their order', () => {
  assert.deepEqual(
    selectSplit(questions, 'all').map((q) => q.id),
    questions.map((q) => q.id)
  )

  for (const split of ['validation', 'test'] as EvalSplit[]) {
    const selected = selectSplit(questions, split).map((q) => q.id)
    const expected = questions
      .filter((q) => (splitBucket(q.id) === 0) === (split === 'validation'))
      .map((q) => q.id)
    assert.deepEqual(selected, expected)
  }
})

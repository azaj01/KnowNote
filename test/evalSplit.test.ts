import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assertQuestionShape,
  parseSplitAssignment,
  selectSplit,
  type EvalQuestion
} from '../src/main/eval/types.ts'

/**
 * The eval split (#192). Parameters that get swept have to be chosen on questions that
 * did not take part in the choice.
 *
 * It used to be a hash of the question id. That was reproducible but not *stable*:
 * adding a question moved others between the sides, and a rare query type could end up
 * entirely on one side without anyone choosing that. The split is now an explicit
 * committed manifest, and these pin the properties that make it trustworthy.
 */

const question = (id: string): EvalQuestion => ({
  id,
  question: id,
  relevant: [{ document: 'a.md', page: null, block: 0 }]
})

const assignment = { q1: 'validation', q2: 'test', q3: 'test' } as const

test('the manifest maps ids to one of the two sides', () => {
  assert.deepEqual(parseSplitAssignment({ q1: 'validation', q2: 'test' }, 'splits.json'), {
    q1: 'validation',
    q2: 'test'
  })
})

test('a manifest that is not an object is rejected, naming the file', () => {
  for (const bad of [null, undefined, [], 'validation', 3]) {
    assert.throws(
      () => parseSplitAssignment(bad, 'eval/splits.json'),
      /eval\/splits\.json must be a JSON object/
    )
  }
})

test('an unknown side is rejected and names the question', () => {
  assert.throws(
    () => parseSplitAssignment({ q7: 'train' }, 'eval/splits.json'),
    /question q7 is assigned "train"/
  )
})

test('`all` is the whole set and needs no manifest', () => {
  const questions = [question('q1'), question('q2')]
  assert.deepEqual(
    selectSplit(questions, 'all', {}).map((q) => q.id),
    ['q1', 'q2']
  )
})

test('the two sides partition the questions and keep their order', () => {
  const questions = [question('q1'), question('q2'), question('q3')]
  const validation = selectSplit(questions, 'validation', assignment)
  const testSide = selectSplit(questions, 'test', assignment)

  assert.deepEqual(validation.map((q) => q.id), ['q1'])
  assert.deepEqual(testSide.map((q) => q.id), ['q2', 'q3'])
  assert.equal(validation.length + testSide.length, questions.length)
})

/**
 * A new question must be assigned deliberately. Defaulting it into `test` would leak it
 * into the reporting side, which is the side a choice must not be fitted to.
 */
test('a question with no manifest entry is refused, not defaulted', () => {
  assert.throws(
    () => selectSplit([question('q9')], 'validation', assignment),
    /question q9 has no entry in the split manifest/
  )
})

/**
 * Reversing these two is silent: an answerable question with no ground truth reads as a
 * permanent miss, and an unanswerable one with ground truth reads as a normal hit.
 */
test('the dataset contract ties answerability to having ground truth', () => {
  const answerable = question('q1')
  const unanswerable: EvalQuestion = { id: 'q2', question: 'q2', answerable: false, relevant: [] }

  assert.doesNotThrow(() => assertQuestionShape(answerable))
  assert.doesNotThrow(() => assertQuestionShape(unanswerable))

  assert.throws(
    () => assertQuestionShape({ ...answerable, relevant: [] }),
    /question q1 is answerable but has no ground truth/
  )
  assert.throws(
    () => assertQuestionShape({ ...unanswerable, relevant: [answerable.relevant[0]] }),
    /question q2 is unanswerable but carries 1 ground-truth location/
  )
})

test('omitting `answerable` means answerable', () => {
  // The pre-#192 dataset has no `answerable` field at all, and every one of those
  // questions is answerable; the default has to preserve that.
  assert.doesNotThrow(() => assertQuestionShape(question('q1')))
})

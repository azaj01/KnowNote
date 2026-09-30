import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  averagePrecisionAtK,
  evidencePrecisionAtK,
  firstRelevantRank,
  hitRateAtK,
  mean,
  type MatchMatrix,
  ndcgAtK,
  percentile,
  recallAtK,
  reciprocalRank
} from '../src/main/eval/metrics.ts'

/**
 * The eval metrics are the only numbers v1.5 experiments (#77, #78) are allowed
 * to argue from, so they are pinned by hand here rather than trusted to the
 * harness that calls them.
 */

test('recall@k covers ground truth within the first k ranks', () => {
  // rank 1 matches gt 0, rank 2 matches nothing, rank 3 matches gt 1
  const matches = [[0], [], [1]]

  assert.equal(recallAtK(matches, 2, 1), 0.5)
  assert.equal(recallAtK(matches, 2, 2), 0.5)
  assert.equal(recallAtK(matches, 2, 3), 1)
})

test('a repeated match does not inflate recall past 1', () => {
  const matches = [[0], [0], [0]]
  assert.equal(recallAtK(matches, 1, 3), 1)
})

test('recall is 0 when there is no ground truth', () => {
  assert.equal(recallAtK([[]], 0, 5), 0)
})

test('first relevant rank is 1-based and 0 when nothing is relevant', () => {
  assert.equal(firstRelevantRank([[], [], [2]]), 3)
  assert.equal(firstRelevantRank([[], []]), 0)
  assert.equal(firstRelevantRank([]), 0)
})

test('reciprocal rank is 1/rank of the first hit', () => {
  assert.equal(reciprocalRank([[0]]), 1)
  assert.equal(reciprocalRank([[], [0]]), 0.5)
  assert.equal(reciprocalRank([[], []]), 0)
})

test('nDCG@k discounts a later hit and is 1 when the hit is first', () => {
  assert.equal(ndcgAtK([[0]], 1, 10), 1)
  // A single ground truth at rank 2: 1/log2(3) over the ideal 1/log2(2)
  assert.ok(Math.abs(ndcgAtK([[], [0]], 1, 10) - 1 / Math.log2(3)) < 1e-12)
  assert.equal(ndcgAtK([[], []], 1, 10), 0)
})

test('nDCG@k counts a ground-truth location once, however many ranks recover it', () => {
  // The bug #78 exposed: three passages all covering the same single ground truth
  // used to score three gains against an ideal that only has one, so nDCG was 3
  // times the valid maximum. Only the first rank is a fresh gain now.
  assert.equal(ndcgAtK([[0], [0], [0]], 1, 10), 1)
  // Two ground truths recovered from the first rank is one binary gain against an
  // ideal that would place them at ranks 1 and 2.
  assert.ok(
    Math.abs(
      ndcgAtK(
        [
          [0, 1],
          [0, 1]
        ],
        2,
        10
      ) -
        1 / (1 + 1 / Math.log2(3))
    ) < 1e-12
  )
})

test('nDCG@k never exceeds 1', () => {
  const cases: Array<{ matrix: MatchMatrix; count: number }> = [
    { matrix: [[0], [0], [0]], count: 1 },
    { matrix: [[0], [0], [0]], count: 3 },
    { matrix: [[0], [1], [0, 1]], count: 2 },
    { matrix: [[0, 1, 2]], count: 3 },
    { matrix: [[], [0], [], [1], [], [2]], count: 3 },
    { matrix: [[]], count: 0 },
    { matrix: [], count: 0 }
  ]

  for (const { matrix, count } of cases) {
    const value = ndcgAtK(matrix, count, 10)
    assert.ok(value >= 0 && value <= 1, `nDCG out of range: ${value} for count ${count}`)
  }
})

test('evidence precision counts grounded passages over retrieved passages', () => {
  // 2 of 3 retrieved passages cover a ground-truth block
  assert.equal(evidencePrecisionAtK([[0], [], [1]], 3), 2 / 3)
  assert.equal(evidencePrecisionAtK([], 5), 0)
  // Each retrieved passage counts once, even when several cover the same block
  assert.equal(evidencePrecisionAtK([[0], [0], [0]], 3), 1)
})

test('hit rate@k says whether the answer was reachable at all', () => {
  assert.equal(hitRateAtK([[0], [], []], 5), 1)
  assert.equal(hitRateAtK([[], [], [1]], 1), 0)
  assert.equal(hitRateAtK([[], [], [1]], 3), 1)
  assert.equal(hitRateAtK([[], []], 5), 0)
  assert.equal(hitRateAtK([], 5), 0)
})

/**
 * The distinction the metric exists for: a two-passage question that finds only
 * one has 0.5 recall but full hit rate — the model had a chance, and recall is what
 * says the material was incomplete.
 */
test('hit rate can be 1 while recall@k is only half', () => {
  const matches: MatchMatrix = [[0], []]
  assert.equal(hitRateAtK(matches, 5), 1)
  assert.equal(recallAtK(matches, 2, 5), 0.5)
})

test('average precision rewards finding the same ground truth earlier', () => {
  // One relevant at rank 1: AP = 1.
  assert.equal(averagePrecisionAtK([[0]], 1, 10), 1)
  // One relevant at rank 2: P@1 = 0, P@2 = 1/2, so AP = 1/2.
  assert.equal(averagePrecisionAtK([[], [0]], 1, 10), 0.5)
  // Two relevant at ranks 1 and 2: (1 + 2/2) / 2 = 1.
  assert.equal(averagePrecisionAtK([[0], [1]], 2, 10), 1)
  // Two relevant, but the second is only found at rank 4: (1 + 2/4) / 2 = 0.75.
  assert.equal(averagePrecisionAtK([[0], [], [], [1]], 2, 10), 0.75)
})

test('average precision counts a repeated match once and never exceeds 1', () => {
  assert.equal(averagePrecisionAtK([[0], [0], [0]], 1, 10), 1)
  assert.equal(averagePrecisionAtK([[], []], 0, 10), 0)
  assert.equal(averagePrecisionAtK([], 3, 10), 0)
})

test('mean and percentile handle the empty and single cases', () => {
  assert.equal(mean([]), 0)
  assert.equal(mean([1, 2, 3]), 2)
  assert.equal(percentile([], 50), 0)
  assert.equal(percentile([42], 95), 42)
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3)
  assert.equal(percentile([5, 1, 4, 2, 3], 95), 5)
})

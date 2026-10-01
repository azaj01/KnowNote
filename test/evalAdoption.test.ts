import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ADOPTION_METRICS,
  decideAdoption,
  decidingMetric,
  regressedMetrics,
  saturatedMetrics
} from '../src/main/eval/adoption.ts'

/**
 * The adoption rule (#192 child 10) decides whether a shipped default moves, so it is
 * pinned here rather than trusted to the sentence the experiment script prints.
 *
 * The bug it exists for: the v1.5 rule made Recall@5 — already 1.0000 on the corpus —
 * its deciding condition, so a hybrid that was better on every other metric came back
 * "inconclusive" forever.
 */

const bag = (overrides: Record<string, number> = {}): Record<string, number> => ({
  recallAt5: 0.9,
  ndcgAt10: 0.9,
  mrr: 0.9,
  mapAt10: 0.9,
  ...overrides
})

test('a metric at its maximum is saturated and cannot decide', () => {
  assert.deepEqual(saturatedMetrics(bag({ recallAt5: 1 })), ['recallAt5'])
  assert.deepEqual(saturatedMetrics(bag()), [])
})

test('the deciding metric is the first one with headroom', () => {
  assert.equal(decidingMetric(bag({ recallAt5: 1 })), 'ndcgAt10')
  assert.equal(decidingMetric(bag({ recallAt5: 1, ndcgAt10: 1 })), 'mrr')
  assert.equal(decidingMetric(bag()), 'recallAt5')
  assert.equal(decidingMetric(bag({ recallAt5: 1, ndcgAt10: 1, mrr: 1, mapAt10: 1 })), null)
})

test('a regression is measured against the baseline, beyond the float slack', () => {
  const baseline = bag()
  assert.deepEqual(regressedMetrics(bag({ ndcgAt10: 0.8 }), baseline), ['ndcgAt10'])
  // Rounding to 6 decimals must not read as a regression.
  assert.deepEqual(regressedMetrics(bag({ ndcgAt10: 0.9 - 1e-12 }), baseline), [])
})

test('the v1.5 stalemate is resolved: improving the deciding metric is enough', () => {
  const dense = bag({ recallAt5: 1, ndcgAt10: 0.9437, mrr: 0.9278, mapAt10: 0.9222 })
  const hybrid = bag({ recallAt5: 1, ndcgAt10: 0.9561, mrr: 0.9444, mapAt10: 0.9389 })

  const decision = decideAdoption(dense, [dense, hybrid])

  assert.deepEqual(decision.saturated, ['recallAt5'])
  assert.equal(decision.primary, 'ndcgAt10')
  assert.equal(decision.winner, hybrid)
})

test('improving one metric while regressing another does not clear the rule', () => {
  const dense = bag({ recallAt5: 1, ndcgAt10: 0.9437, mrr: 0.9278 })
  // Better nDCG, worse MRR: exactly the trade the rule refuses to make silently.
  const trade = bag({ recallAt5: 1, ndcgAt10: 0.99, mrr: 0.9 })

  assert.equal(decideAdoption(dense, [dense, trade]).winner, null)
})

test('the baseline never clears the rule against itself', () => {
  const dense = bag({ recallAt5: 1 })
  assert.equal(decideAdoption(dense, [dense]).winner, null)
})

test('when every metric is saturated nothing can be adopted', () => {
  const all = bag({ recallAt5: 1, ndcgAt10: 1, mrr: 1, mapAt10: 1 })
  const decision = decideAdoption(all, [all, bag({ ndcgAt10: 1 })])

  assert.equal(decision.primary, null)
  assert.equal(decision.winner, null)
  assert.deepEqual(decision.saturated, [...ADOPTION_METRICS])
})

test('the best clearing candidate by the deciding metric wins', () => {
  const dense = bag({ recallAt5: 1, ndcgAt10: 0.9 })
  const good = bag({ recallAt5: 1, ndcgAt10: 0.95 })
  const better = bag({ recallAt5: 1, ndcgAt10: 0.98 })

  assert.equal(decideAdoption(dense, [dense, good, better]).winner, better)
})

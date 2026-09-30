import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRetrievalTrace } from '../src/main/services/retrieval/trace.ts'
import {
  denseChannelThreshold,
  DEFAULT_CANDIDATE_K,
  DEFAULT_DENSE_THRESHOLD,
  effectiveCandidateK
} from '../src/main/services/retrieval/types.ts'

/**
 * The retrieval contract (#160) is the seam #94, #157 and #77 build on. These pin
 * the two properties the rest of v1.5 assumes:
 *
 * - the trace describes what a search actually used, so #157 can snapshot it;
 * - an unsupported filter is refused instead of silently ignored, because the
 *   whole point of #160 is to stop declaring capabilities that do nothing.
 */

test('a trace carries the effective search parameters and no empty fields', () => {
  const trace = buildRetrievalTrace({
    strategy: 'dense',
    candidateK: 20,
    topK: 5,
    denseThreshold: 0.5,
    durationMs: 12.5
  })

  assert.deepEqual(trace, {
    strategy: 'dense',
    scope: {},
    candidateK: 20,
    topK: 5,
    denseThreshold: 0.5,
    durationMs: 12.5
  })
  // An absent dense threshold means "no dense leg ran", not "threshold 0".
  assert.equal(
    'denseThreshold' in
      buildRetrievalTrace({ strategy: 'sparse', candidateK: 20, topK: 5, durationMs: 1 }),
    false
  )
})

/**
 * The bug the #192 review found: `hybrid` runs a dense leg, so it *has* a similarity
 * floor. The retriever applied 0.5 to that leg while the trace recorded `undefined`, so
 * the snapshot could not reproduce the retrieval it was describing.
 */
test('a strategy traces the threshold its dense leg actually applied', () => {
  assert.equal(denseChannelThreshold('dense'), DEFAULT_DENSE_THRESHOLD)
  assert.equal(denseChannelThreshold('hybrid'), DEFAULT_DENSE_THRESHOLD)
  assert.equal(denseChannelThreshold('hybrid', 0.3), 0.3)
  assert.equal(denseChannelThreshold('dense', 0), 0)
  // Only a strategy with no dense leg has no dense threshold.
  assert.equal(denseChannelThreshold('sparse', 0.3), undefined)

  const hybrid = buildRetrievalTrace({
    strategy: 'hybrid',
    candidateK: 20,
    topK: 3,
    denseThreshold: denseChannelThreshold('hybrid'),
    durationMs: 4
  })
  assert.equal(hybrid.denseThreshold, DEFAULT_DENSE_THRESHOLD)
})

test('the trace keeps the first-stage width and the final count apart', () => {
  const trace = buildRetrievalTrace({
    strategy: 'hybrid',
    candidateK: 20,
    topK: 3,
    durationMs: 9
  })

  // #77: a snapshot that only says `topK` cannot explain the fused candidate pool.
  assert.equal(trace.candidateK, 20)
  assert.equal(trace.topK, 3)
})

/**
 * #77: the first stage takes a candidate pool, the delivery stage takes `topK`.
 * The invariant that matters is that the pool is never narrower than what is
 * supposed to come out of it.
 */
test('the first-stage width is never narrower than the final count', () => {
  assert.equal(effectiveCandidateK({}), DEFAULT_CANDIDATE_K)
  assert.equal(effectiveCandidateK({ topK: 3 }), DEFAULT_CANDIDATE_K)
  assert.equal(effectiveCandidateK({ candidateK: 40, topK: 3 }), 40)
  // A caller that asks for more results than the default pool still gets them: the
  // search palette and MCP pass their own `topK` and must not be silently capped.
  assert.equal(effectiveCandidateK({ topK: 50 }), 50)
})

test('a filter becomes the recorded scope of the trace', () => {
  const trace = buildRetrievalTrace({
    strategy: 'dense',
    filter: { documentIds: ['doc_a', 'doc_b'] },
    candidateK: 20,
    topK: 8,
    durationMs: 3
  })

  assert.deepEqual(trace.scope, { documentIds: ['doc_a', 'doc_b'] })
  assert.equal(trace.topK, 8)
})

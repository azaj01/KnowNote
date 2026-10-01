/**
 * The adoption rule for retrieval experiments (#192 child 10).
 *
 * The v1.5 rule was "Recall@5 must improve and nDCG@10 must not regress". On a corpus
 * where dense already scores Recall@5 = 1.0000 that condition can never be met, so the
 * rule was not strict, it was **unsatisfiable**, and every strategy comparison came
 * back "inconclusive" — including a hybrid that was better on every other metric.
 *
 * The amendment: a metric at its maximum has no headroom and is not allowed to decide.
 * The deciding metric is the first one with headroom, and a strategy is adopted when
 * it improves that metric and regresses none of the others.
 *
 * Kept here, not inside the experiment script, so the rule can be unit tested: it
 * decides whether a production default moves, and "the script printed a different
 * sentence" is not a test.
 */

/** Priority order. Recall first because a RAG miss cannot be repaired downstream. */
export const ADOPTION_METRICS = ['recallAt5', 'ndcgAt10', 'mrr', 'mapAt10'] as const

export type AdoptionMetric = (typeof ADOPTION_METRICS)[number]

export type MetricBag = Record<string, number>

/** Float slack: metrics are rounded to 6 decimals before this runs. */
export const ADOPTION_EPSILON = 1e-9

/** Metrics already at their maximum, which therefore cannot decide a comparison. */
export function saturatedMetrics(
  metrics: MetricBag,
  order: readonly string[] = ADOPTION_METRICS
): string[] {
  return order.filter((key) => metrics[key] >= 1 - ADOPTION_EPSILON)
}

/** The first metric in priority order with room to improve, or `null` if none has. */
export function decidingMetric(
  metrics: MetricBag,
  order: readonly string[] = ADOPTION_METRICS
): string | null {
  return order.find((key) => metrics[key] < 1 - ADOPTION_EPSILON) ?? null
}

/** Metrics where `candidate` is worse than `baseline` beyond the epsilon. */
export function regressedMetrics(
  candidate: MetricBag,
  baseline: MetricBag,
  order: readonly string[] = ADOPTION_METRICS
): string[] {
  return order.filter((key) => candidate[key] < baseline[key] - ADOPTION_EPSILON)
}

export interface AdoptionDecision {
  /** The metric that decides, or `null` when every metric is already maxed out. */
  primary: string | null
  saturated: string[]
  /** The best strategy that clears the rule, or `null`. */
  winner: MetricBag | null
}

/**
 * Pick the strategy to recommend. `baseline` is the shipped one and must be part of
 * `candidates`; a candidate that improves the deciding metric and regresses nothing
 * else clears the rule, and the best such candidate by the deciding metric wins.
 */
export function decideAdoption(
  baseline: MetricBag,
  candidates: readonly MetricBag[],
  order: readonly string[] = ADOPTION_METRICS
): AdoptionDecision {
  const saturated = saturatedMetrics(baseline, order)
  const primary = decidingMetric(baseline, order)

  if (primary === null) return { primary: null, saturated, winner: null }

  const cleared = candidates.filter(
    (candidate) =>
      candidate !== baseline &&
      candidate[primary] > baseline[primary] + ADOPTION_EPSILON &&
      regressedMetrics(candidate, baseline, order).length === 0
  )

  const winner =
    [...cleared].sort((a, b) => b[primary] - a[primary])[0] ?? null

  return { primary, saturated, winner }
}

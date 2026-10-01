/**
 * Retrieval contract
 *
 * 检索是一等能力，不是 Chat 的附属逻辑。Chat、MCP、Search 面板都通过同一个
 * `Retriever` 拿到同一份 `RetrievedEvidence`，因此不必各自重写一遍 RAG，也让
 * #75 的 eval harness 有一个稳定的入口。
 *
 * `RetrievedEvidence` 与 `SearchResult` 的关键区别是 provenance 是一等字段：引用
 * 要落到"哪个来源、哪一页、哪一段"，检索结果在交付给上层时就必须带着它。
 */

import type { ChunkProvenanceBlock } from '../chunkProvenance'

/** 检索结果覆盖的单个块（`chunk_blocks` 映射 + `document_blocks`）。 */
export type EvidenceBlock = ChunkProvenanceBlock

/** 证据在来源里的位置。`blocks` 按文档顺序排列。 */
export interface EvidenceLocator {
  pageStart: number | null
  pageEnd: number | null
  blocks: EvidenceBlock[]
}

/** 证据来自哪份来源。 */
export interface EvidenceSource {
  title: string
  type: string
}

/** 一条可供引用/展示的检索证据。 */
export interface RetrievedEvidence {
  chunkId: string
  documentId: string
  content: string
  score: number
  chunkIndex: number
  source: EvidenceSource
  locator: EvidenceLocator
  metadata?: Record<string, unknown>
}

/**
 * 限制检索范围的过滤条件。
 *
 * `documentIds` 为空或缺省都表示「整个 notebook」。当前还没有后端实现预过滤，
 * 所以这个 seam 由 `assertFilterSupported()` 守着：被真正使用前拒绝，而不是静默
 * 忽略（实现落在 #94）。
 */
export interface RetrievalFilter {
  documentIds?: string[]
}

/**
 * 检索策略（#77）。
 *
 * `dense` 是 v1.4 的默认；`sparse` 是 BM25 over `chunks_fts`（#96）；`hybrid` 用 RRF
 * 融合两者。语义解释：dense 找释义，sparse 找字面，hybrid 两者都要。
 */
export type RetrievalStrategy = 'dense' | 'sparse' | 'hybrid'

/**
 * 一次检索请求。
 *
 * 取代旧的 `(notebookId, query, options)` 位置参数：#94 的 scope、#77 的策略参数
 * 与 #157 要快照的 trace 都要挂在这一个对象上，而不是散落在调用点。
 *
 * 两个 K 是分开的，它们回答的是不同的问题：
 *
 *   candidateK  第一阶段每个通道取多宽（KNN 邻居数 / BM25 limit）—— 偏向召回
 *   topK        最终交付多少条证据（chat 里就是送进 prompt 的 context 宽度）—— 偏向精度
 *
 * 合并成一个 K 会让「向量库直接搜几条」冒充两阶段检索：hybrid 时两个通道各取
 * `topK` 条，融合池最多只有 `2 * topK`，再截回 `topK`，融合几乎没有发生空间。
 */
export interface RetrievalRequest {
  notebookId: string
  query: string
  /**
   * 第一阶段候选宽度。缺省 `DEFAULT_CANDIDATE_K`。
   *
   * 实际生效值不会小于 `topK`（见 `effectiveCandidateK`）：一个 `topK=50` 的调用方
   * 不该因为没写 `candidateK` 而只拿到 20 条。
   */
  candidateK?: number
  /** 最终证据条数。缺省 `DEFAULT_TOP_K`。 */
  topK?: number
  threshold?: number
  filter?: RetrievalFilter
  /** 缺省时为 `dense`，与引入策略之前的默认一致。 */
  strategy?: RetrievalStrategy
}

/** 没有显式指定时的第一阶最宽度（#77）。与 chat 的生产配置保持一致。 */
export const DEFAULT_CANDIDATE_K = 20

/** 没有显式指定时的最终证据条数，与引入 `candidateK` 之前一致。 */
export const DEFAULT_TOP_K = 5

/**
 * 第一阶段的真实宽度：`candidateK`，但不小于 `topK`。
 *
 * 没有这条不变式，「取出比交付更宽的一池子」只是多数时候成立：任何 `topK > candidateK`
 * 的调用（搜索面板的 limit、MCP 的 topK）都会静默地少返结果。
 */
export function effectiveCandidateK(request: {
  candidateK?: number
  topK?: number
}): number {
  const topK = request.topK ?? DEFAULT_TOP_K
  return Math.max(request.candidateK ?? DEFAULT_CANDIDATE_K, topK)
}

/** 没有指定时 dense 通道的相似度下限，与引入双 K 之前一致。 */
export const DEFAULT_DENSE_THRESHOLD = 0.5

/**
 * 某个策略真正作用在 **dense 通道** 上的相似度下限。
 *
 * `hybrid` 也跑 dense，所以它同样有阈值；只有 `sparse` 没有，因为 BM25 没有「相似
 * 度阈值」这个概念。
 *
 * 用 **一个** 函数产出这个值，是为了让「传给 dense 通道的值」和「写进 trace 的值」无法
 * 再分开：#192 评审发现的 bug 就是它们各自有一个 `?? 0.5` —— hybrid 的 dense 腿用了
 * 0.5，而 trace 写的 `threshold: undefined`，于是快照无法复现那次检索。
 */
export function denseChannelThreshold(
  strategy: RetrievalStrategy,
  requested?: number
): number | undefined {
  if (strategy === 'sparse') return undefined
  return requested ?? DEFAULT_DENSE_THRESHOLD
}

/**
 * 一次检索实际生效的参数。
 *
 * 它会随回答一起被快照（#157），因此必须由检索层产出、而不是调用方猜：
 * `strategy` 说明用的是哪条检索路径，`scope` 说明结果被限制在哪些来源。
 * `threshold` 缺省表示该策略没有阈值，不是「阈值等于 0」。
 *
 * `candidateK` 与 `topK` 是两个不同的量，快照里都必须有：只看 `topK` 无法解释
 * 「为什么这次只召回三条」，也无法复现 hybrid 的融合池有多宽。
 */
export interface RetrievalTrace {
  strategy: string
  scope: { documentIds?: string[] }
  /** 第一阶段每个通道的实际宽度（已应用 `effectiveCandidateK`）。 */
  candidateK: number
  /** 最终交付的证据条数。 */
  topK: number
  /**
   * 真正作用在 **dense 通道** 上的相似度下限。
   *
   * 字段名不是 `threshold` 而是 `denseThreshold`，因为 `hybrid` 也在跑 dense：它不
   * 是「没有阈值」，而是 dense 那一路有 0.5。叫 `threshold` 会让快照看上去说 hybrid
   * 没有阈值，于是“这次检索是怎么发生的”就复现不出来了（#192 评审）。
   *
   * 缺省只表示 **dense 通道没跑**（`sparse`），不是「阈值等于 0」。
   */
  denseThreshold?: number
  durationMs: number
}

/** 检索结果：证据 + 本次检索的可解释参数。 */
export interface RetrievalResult {
  evidence: RetrievedEvidence[]
  trace: RetrievalTrace
}

/**
 * 检索策略的稳定契约。当前只有 `DenseRetriever`；#77 的 BM25 / hybrid / reranker
 * 只要实现这个接口就能被 eval harness 直接度量与替换。
 */
export interface Retriever {
  search(request: RetrievalRequest): Promise<RetrievalResult>
}

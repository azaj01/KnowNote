import { getDatabase } from '../../db'
import type { EmbeddingService } from '../EmbeddingService'
import { searchChunksFts } from '../fts'
import { rrfFuse, type CandidateHit } from './candidates'
import { DenseRetriever } from './DenseRetriever'
import { hydrateEvidence } from './evidence'
import { buildRetrievalTrace } from './trace'
import {
  denseChannelThreshold,
  effectiveCandidateK,
  DEFAULT_TOP_K,
  type RetrievalRequest,
  type RetrievalResult,
  type RetrievalStrategy,
  type Retriever
} from './types'

/**
 * HybridRetriever (#77)
 *
 * 三条策略共用一条路径，区别只在候选怎么产生：
 *
 *   dense  释义相近的段落（向量）
 *   sparse 字面出现的段落（BM25 over chunks_fts，#96）
 *   hybrid RRF 融合两者
 *
 * 融合在候选层完成（`chunkId + rank`），证据只补齐一次 —— 见 `candidates.ts`。
 * 两个通道的分数（cosine 与 BM25）不可比，所以只用 rank，这正是 RRF 的意义。
 *
 * 两个 K 是两个阶段：每个通道先按 `candidateK` 取宽（融合池最多 `2 * candidateK`），
 * 融合后再截到 `topK`。如果两个通道都只取 `topK`，融合池最多 `2 * topK` 且结果被截回
 * `topK`，融合几乎没有发生空间 —— 那就不是混合检索，只是一个更慢的单路检索。
 */
export class HybridRetriever implements Retriever {
  private readonly dense: DenseRetriever

  constructor(embeddingService: EmbeddingService) {
    this.dense = new DenseRetriever(embeddingService)
  }

  async search(request: RetrievalRequest): Promise<RetrievalResult> {
    const strategy: RetrievalStrategy = request.strategy ?? 'dense'
    const candidateK = effectiveCandidateK(request)
    const topK = request.topK ?? DEFAULT_TOP_K
    const startedAt = performance.now()

    let hits: CandidateHit[]
    // 传给 dense 通道的值和写进 trace 的值是 **同一个** 变量，来自同一个函数。
    // `hybrid` 也跑 dense 所以也有阈值；`sparse` 没有，于是它是 undefined。
    //
    // 分开算两次就是 #192 评审发现的 bug：hybrid 的 dense 腿用着 0.5，而 trace 写
    // `undefined`，快照于是声称那次 hybrid 没有阈值。
    const denseThreshold = denseChannelThreshold(strategy, request.threshold)

    if (strategy === 'sparse') {
      hits = searchChunksFts(request.notebookId, request.query, {
        limit: candidateK,
        documentIds: request.filter?.documentIds
      }).slice(0, topK)
    } else if (strategy === 'hybrid') {
      const denseHits = await this.dense.candidateHits({ ...request, threshold: denseThreshold })
      const sparseHits = searchChunksFts(request.notebookId, request.query, {
        limit: candidateK,
        documentIds: request.filter?.documentIds
      })
      hits = rrfFuse([denseHits, sparseHits]).slice(0, topK)
    } else {
      hits = (await this.dense.candidateHits({ ...request, threshold: denseThreshold })).slice(
        0,
        topK
      )
    }

    const evidence = hits.length === 0 ? [] : hydrateEvidence(getDatabase(), hits)

    return {
      evidence,
      trace: buildRetrievalTrace({
        strategy,
        filter: request.filter,
        candidateK,
        topK,
        denseThreshold,
        durationMs: performance.now() - startedAt
      })
    }
  }
}

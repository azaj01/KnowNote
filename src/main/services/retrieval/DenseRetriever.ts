/**
 * DenseRetriever
 * 当前的默认检索策略：查询向量 → 向量库 KNN → 批量补齐证据。
 *
 * 只负责"怎么检索"。embedding space 校验留在 `KnowledgeService`（那是前置条件，
 * 不是策略），因此这个类可以单独被 eval harness 与后续的 BM25 / hybrid 策略替换。
 */

import { getDatabase } from '../../db'
import { vectorStoreManager } from '../../vectorstore'
import type { EmbeddingService } from '../EmbeddingService'
import type { CandidateHit } from './candidates'
import { hydrateEvidence } from './evidence'
import { buildRetrievalTrace } from './trace'
import { effectiveCandidateK, DEFAULT_TOP_K } from './types'
import type { RetrievalRequest, RetrievalResult, Retriever } from './types'

const STRATEGY = 'dense'

export class DenseRetriever implements Retriever {
  constructor(private readonly embeddingService: EmbeddingService) {}

  /**
   * 只做“向量命中”，不补齐证据。
   *
   * 抽出来是给 hybrid 用的（#77）：融合需要的是 `chunkId + score`，不是已经 join 好
   * 文档/块/偏移的证据。公开方法让 `HybridRetriever` 复用同一条 dense 路径，而不是把
   * embed + KNN 抄一遍。
   */
  async candidateHits(request: RetrievalRequest): Promise<CandidateHit[]> {
    // 第一阶段按 `candidateK` 取宽；`topK` 的截断由调用方决定，因为 hybrid 需要的是
    // 比最终交付更宽的一池子候选。
    const candidateK = effectiveCandidateK(request)
    const threshold = request.threshold ?? 0.5

    // E5 要求 query 前缀，与索引时的 document 前缀区分
    await this.embeddingService.ensureReady()
    const queryEmbedding = await this.embeddingService.embed(request.query, 'query')

    const vectorStore = await vectorStoreManager.getStore(request.notebookId)
    // scope 过滤由向量库在 KNN 之前执行（#94），不是取回 candidateK 之后再筛。
    const hits = await vectorStore.query(queryEmbedding.embedding, {
      topK: candidateK,
      threshold,
      filter: request.filter
    })

    return hits.map((hit) => ({ chunkId: hit.chunkId, score: hit.score }))
  }

  async search(request: RetrievalRequest): Promise<RetrievalResult> {
    const topK = request.topK ?? DEFAULT_TOP_K
    const candidateK = effectiveCandidateK(request)
    const threshold = request.threshold ?? 0.5
    const startedAt = performance.now()

    // 单策略没有可精排的下游，取宽再截到 `topK` 与直接按 `topK` 查 KNN 等价；
    // 两个 K 分开是为了让契约统一，而不是在这里制造差异。
    const hits = (await this.candidateHits(request)).slice(0, topK)
    const evidence = hits.length === 0 ? [] : hydrateEvidence(getDatabase(), hits)

    return {
      evidence,
      trace: buildRetrievalTrace({
        strategy: STRATEGY,
        filter: request.filter,
        candidateK,
        topK,
        threshold,
        durationMs: performance.now() - startedAt
      })
    }
  }
}

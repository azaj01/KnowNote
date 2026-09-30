/**
 * RAG eval harness types (#75).
 *
 * Ground truth is expressed in **corpus identity**, not database identity. A
 * `document` is the corpus-relative path, a `block` is the block ordinal inside
 * that document. Runtime `documentId`s are random, and `blockId` embeds them, so
 * neither may appear in the committed ground truth: #78 changes chunking, and a
 * ground truth bound to a runtime id would break instead of measuring the change.
 */

export interface EvalRelevantLocation {
  /** Corpus-relative path, e.g. `river-monitoring.md`. */
  document: string
  /** Page number when the source is paginated, else null. */
  page: number | null
  /** Block ordinal inside the document (`document_blocks.order`). */
  block: number
  /** Optional excerpt used to detect parser drift in `block`. */
  quote?: string
}

export interface EvalQuestion {
  id: string
  question: string
  relevant: EvalRelevantLocation[]
  goldAnswer?: string
  /**
   * 查询类别（#192）。自由字符串，因为语料还会长出新类别；报告按出现过的值分组，
   * 缺省归入 `untagged`。
   *
   * 分类的意义是：一个提升实体查询、却弄坏释义查询的策略，不该在总平均上显示成
   * 「没变化」。
   */
  type?: string
}

/**
 * 评估切分（#192）。
 *
 * 阈值这类参数必须在**没参与选择**的问题上报数，否则扫参的结果只是把测试集背下来
 * 了。切分按 question id 确定性计算，所以同一份 `questions.jsonl` 在任何机器上切出
 * 同一份 validation / test。
 */
export type EvalSplit = 'all' | 'validation' | 'test'

/** id 分桶，0/1/2；只用于切分，不参与检索。 */
export function splitBucket(id: string): number {
  let hash = 0
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return hash % 3
}

/** validation 是 bucket 0（约 1/3），test 是其余（约 2/3）。 */
export function selectSplit(questions: EvalQuestion[], split: EvalSplit): EvalQuestion[] {
  if (split === 'all') return questions
  const wantValidation = split === 'validation'
  return questions.filter((question) => (splitBucket(question.id) === 0) === wantValidation)
}

/** One resolved ground-truth location, after runtime id mapping. */
export interface ResolvedGroundTruth {
  document: string
  documentId: string
  blockId: string
  page: number | null
  block: number
}

export interface EvalMetrics {
  recallAt1: number
  recallAt5: number
  recallAt10: number
  mrr: number
  ndcgAt10: number
  /**
   * 前 5 名至少命中一个 ground-truth 块的问题占比。
   *
   * 与 Recall@5 并列而不是替代：多块问题只要命中一块，hit rate 就是 1，
   * 而 Recall@5 只有 0.5。「模型有没有机会」和「材料齐不齐」是两件事。
   */
  hitRateAt5: number
  /** AP@10：把「排序位置」和「覆盖面」合成一个数的那个指标。 */
  mapAt10: number
  /**
   * 前 `contextK` 条证据里真的命中 ground-truth 的比例（context 条的精确率）。
   *
   * 这是**检索精度**，不是回答的引用召回：harness 不跑模型、不产生回答。回答层的引用
   * 正确性是 resolver 的事（#70），需要一个真正跑模型的 eval。
   */
  contextPrecision: number
  /**
   * 答案需要的 ground-truth 块有多少进了 `contextK` 宽的窗口。
   *
   * 与 Recall@10 的区别在于它量的是**窗口**：证据排在第 4、而 contextK=3 时，模型
   * 看不到它。这是一个产品指标，不只是检索指标。
   */
  contextRecall: number
}

/** 按查询类别聚合的同一套指标（#192）。总平均会掩盖方向相反的两个变化。 */
export interface EvalTypeBreakdown {
  type: string
  questions: number
  metrics: EvalMetrics
}

export interface QuestionReport {
  id: string
  question: string
  /** 查询类别，与 `EvalQuestion.type` 一致；缺省为 `untagged`。 */
  type: string
  firstRelevantRank: number
  relevantCount: number
  retrievedCount: number
  /** Ground-truth indices matched by each retrieved rank, in rank order. */
  matchesByRank: number[][]
}

export interface EvalReport {
  baseline: string
  generatedBy: string
  config: {
    embedding: string
    chunking: {
      chunkSize: number
      chunkOverlap: number
      minChunkSize: number
      allowSpanPages: boolean
      /** 标题处强制断节（#78）。 */
      respectHeadings: boolean
    }
    retrieval: string
    /** 本次评估用了哪一份切分（#192）：`all` / `validation` / `test`。 */
    split: string
    /**
     * 第一阶段每个通道的宽度（#77）。排名指标（Recall@K / MRR / nDCG@K）在这个深度上
     * 计算，所以它必须 ≥ 指标里最大的 K。
     */
    candidateK: number
    /**
     * 生产 prompt 实际取用的证据条数（#77）。
     *
     * 快照里记它是为了让 benchmark 描述整条线上链路，而不只是检索器；它也是两个
     * context 指标的窗口宽度。
     */
    contextK: number
    threshold: number
    corpus: string
    documents: number
    questions: number
    /** 索引出的 chunk 总数（#78 的 index size）。 */
    chunkCount: number
  }
  metrics: EvalMetrics
  /** 每个查询类别一行；类别来自 `questions.jsonl` 的 `type`。 */
  byType: EvalTypeBreakdown[]
  /** `indexingMs` 只用于 #78 的吞吐比较；它不在确定报告里，也不该成为差异原因。 */
  timing: { latencyP50Ms: number; latencyP95Ms: number; indexingMs: number }
  perQuestion: QuestionReport[]
}

/**
 * The committed report: everything that is identical between two runs. Wall-clock
 * timing is deliberately absent, so `npm run eval` twice produces a byte-identical
 * JSON that a PR can actually diff.
 */
export interface EvalDeterministicReport {
  baseline: string
  generatedBy: string
  config: EvalReport['config']
  metrics: EvalMetrics
  byType: EvalTypeBreakdown[]
  perQuestion: QuestionReport[]
}

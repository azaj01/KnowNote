/**
 * RAG eval harness (#75).
 *
 * Indexes a corpus through the normal ingestion path, runs the real `Retriever`,
 * and reports retrieval and citation metrics. It is the reference point every
 * v1.5 experiment (#77, #78) must be measured against — so the numbers are
 * produced here, never typed by hand.
 *
 * Ground truth is resolved from corpus identity to runtime identity **after**
 * ingestion, because `documentId` is random and `blockId` embeds it. Nothing in
 * the committed dataset references a runtime id.
 */

import { readdir, readFile } from 'fs/promises'
import { join, posix, relative } from 'path'
import { and, eq } from 'drizzle-orm'
import { documentBlocks, notebooks, chunks } from '../db/schema'
import type { getDatabase } from '../db'
import type { KnowledgeService } from '../services/KnowledgeService'
import { DEFAULT_CHUNK_OPTIONS, type ChunkOptions } from '../services/ChunkingService'
import type { RetrievalStrategy } from '../services/retrieval'
import { LOCAL_EMBEDDING_MODEL } from '../embedding/localModel'
import {
  averagePrecisionAtK,
  evidencePrecisionAtK,
  firstRelevantRank,
  hitRateAtK,
  mean,
  ndcgAtK,
  percentile,
  recallAtK,
  reciprocalRank
} from './metrics'
import type {
  EvalDeterministicReport,
  EvalMetrics,
  EvalQuestion,
  EvalReport,
  EvalRelevantLocation,
  EvalSplit,
  EvalTypeBreakdown,
  QuestionReport,
  ResolvedGroundTruth,
  SplitAssignment
} from './types'
import { assertQuestionShape, parseSplitAssignment, selectSplit } from './types'

type Db = ReturnType<typeof getDatabase>

export interface EvalHarnessOptions {
  /** Absolute path used to read the corpus. */
  corpusDir: string
  /** Repo-relative label recorded in the report, so the JSON is machine-independent. */
  corpusLabel: string
  questionsPath: string
  /** 切分清单（`eval/splits.json`）。`split: 'all'` 时不读。 */
  splitsPath: string
  baseline: string
  /** 本次只评这一份切分（#192）；缺省 `all`。 */
  split: EvalSplit
  /**
   * 第一阶段每个通道的宽度，也是排名指标的评估深度（#77）。
   *
   * 与 `contextK` 分开：`candidateK` 决定“找了多宽”（召回），`contextK` 决定“交给
   * LLM 多少”（预算）。只用一个 K 时两者被绑死，benchmark 也无法在足够深的地方算
   * Recall@10。
   */
  candidateK: number
  /** 生产 prompt 实际取用的条数（chat 里的 `topK`）。 */
  contextK: number
  /** Similarity floor; 0 keeps the ranking intact for ranking metrics. */
  threshold: number
  /** 分块配置（#78）。实验变体通过它选择策略；缺省时用生产默认值。 */
  chunkOptions: ChunkOptions
  /** 检索策略（#77）：dense / sparse(BM25) / hybrid(RRF)。 */
  strategy: RetrievalStrategy
}

const NOTEBOOK_ID = 'eval-notebook'

/** A question with no `type` is grouped here rather than dropped from the report. */
const UNTAGGED = 'untagged'

/**
 * 同一套指标既算总平均，也算每个查询类别（#192）。用一个函数是因为分组平均必须与
 * 总平均是同一个定义，否则两个数就不可比。
 */
function summarize(perQuestion: readonly QuestionReport[], contextK: number): EvalMetrics {
  return {
    recallAt1: mean(perQuestion.map((q) => recallAtK(q.matchesByRank, q.relevantCount, 1))),
    recallAt5: mean(perQuestion.map((q) => recallAtK(q.matchesByRank, q.relevantCount, 5))),
    recallAt10: mean(perQuestion.map((q) => recallAtK(q.matchesByRank, q.relevantCount, 10))),
    mrr: mean(perQuestion.map((q) => reciprocalRank(q.matchesByRank))),
    ndcgAt10: mean(perQuestion.map((q) => ndcgAtK(q.matchesByRank, q.relevantCount, 10))),
    hitRateAt5: mean(perQuestion.map((q) => hitRateAtK(q.matchesByRank, 5))),
    mapAt10: mean(
      perQuestion.map((q) => averagePrecisionAtK(q.matchesByRank, q.relevantCount, 10))
    ),
    // 两个 context 指标共用同一个窗口，因为它们回答的是同一个问题的两面：送进 prompt
    // 的那几条里有多少是相关的，以及需要的东西有多少真的进去了。
    contextPrecision: mean(
      perQuestion.map((q) => evidencePrecisionAtK(q.matchesByRank, contextK))
    ),
    contextRecall: mean(
      perQuestion.map((q) => recallAtK(q.matchesByRank, q.relevantCount, contextK))
    )
  }
}

/** Normalised comparison for the optional quote drift check. */
const normalize = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

function parseQuestions(raw: string): EvalQuestion[] {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, index) => {
      try {
        return JSON.parse(line) as EvalQuestion
      } catch (error) {
        throw new Error(`questions.jsonl line ${index + 1} is not valid JSON: ${String(error)}`)
      }
    })
}

/**
 * 把 `document`/`block` 顺序解析成运行期的 `documentId`/`blockId`，并用可选 quote
 * 校验块顺序没有因为 parser 改动而漂移。
 */
function resolveGroundTruth(
  db: Db,
  question: EvalQuestion,
  documentIds: Map<string, string>
): ResolvedGroundTruth[] {
  return question.relevant.map((location: EvalRelevantLocation) => {
    const documentId = documentIds.get(location.document)
    if (!documentId) {
      throw new Error(
        `question ${question.id} references "${location.document}", which is not in the corpus`
      )
    }

    const block = db
      .select()
      .from(documentBlocks)
      .where(
        and(eq(documentBlocks.documentId, documentId), eq(documentBlocks.order, location.block))
      )
      .get()

    if (!block) {
      throw new Error(
        `question ${question.id}: "${location.document}" has no block with ordinal ${location.block}`
      )
    }
    if (location.quote && !normalize(block.text).includes(normalize(location.quote))) {
      throw new Error(
        `question ${question.id}: quote drifted — block ${location.block} of "${location.document}" ` +
          `does not contain ${JSON.stringify(location.quote)}. Update the ground truth deliberately.`
      )
    }
    if (location.page !== null && block.page !== location.page) {
      throw new Error(
        `question ${question.id}: "${location.document}" block ${location.block} is on page ` +
          `${block.page}, ground truth says ${location.page}`
      )
    }

    return {
      document: location.document,
      documentId,
      blockId: block.id,
      page: block.page,
      block: location.block
    }
  })
}

/** Index every corpus document and return `corpus-relative path → runtime documentId`. */
async function indexCorpus(
  db: Db,
  knowledgeService: KnowledgeService,
  corpusDir: string,
  chunkOptions: ChunkOptions
): Promise<{ documentIds: Map<string, string>; chunkCount: number; indexingMs: number }> {
  const indexingStarted = performance.now()
  const now = new Date()
  db.insert(notebooks)
    .values({ id: NOTEBOOK_ID, title: 'Eval corpus', createdAt: now, updatedAt: now })
    .run()

  const files = (await readdir(corpusDir)).filter((name) => !name.startsWith('.')).sort()
  const documentIds = new Map<string, string>()

  for (const file of files) {
    const documentId = await knowledgeService.addDocumentFromFile(
      NOTEBOOK_ID,
      join(corpusDir, file),
      undefined,
      chunkOptions
    )
    documentIds.set(posix.normalize(file), documentId)
  }

  // Index size is a first-class result of a chunking change: more chunks cost more
  // to store and to scan, so a recall win that doubles the index is a trade-off,
  // not a free win.
  const chunkCount = db
    .select({ id: chunks.id })
    .from(chunks)
    .where(eq(chunks.notebookId, NOTEBOOK_ID))
    .all().length

  return { documentIds, chunkCount, indexingMs: performance.now() - indexingStarted }
}

/**
 * 读切分清单。`all` 不需要清单，所以 `all` 的运行不会因为缺清单而失败。
 *
 * JSON 解析错误会把文件路径带上：清单是提交在仓库里的，一份写坏的清单应该指向它自己。
 */
async function loadSplitAssignment(options: EvalHarnessOptions): Promise<SplitAssignment> {
  if (options.split === 'all') return {}

  const label = relative(process.cwd(), options.splitsPath).split(/[\\/]/).join('/')
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(options.splitsPath, 'utf-8'))
  } catch (error) {
    throw new Error(`${label} could not be read as JSON: ${String(error)}`)
  }
  return parseSplitAssignment(parsed, label)
}

export async function runEvalHarness(
  db: Db,
  knowledgeService: KnowledgeService,
  options: EvalHarnessOptions
): Promise<EvalReport> {
  // A context window wider than the retrieval depth can never be filled: the harness
  // fetches `candidateK` passages and the context metrics look at `contextK` of them.
  //
  // Without this check the sweep silently produced rows where `contextK=5` and
  // `contextK=8` at `candidateK=5` were **identical**, not because 8 assessed the same
  // as 5 but because passages 6-8 did not exist (#192 review). A wrong number that
  // looks like a measurement is worse than a failure.
  if (options.contextK > options.candidateK) {
    throw new Error(
      `contextK (${options.contextK}) cannot exceed candidateK (${options.candidateK}): ` +
        'the harness retrieves candidateK passages, so a wider context window can never be filled.'
    )
  }

  const { documentIds, chunkCount, indexingMs } = await indexCorpus(
    db,
    knowledgeService,
    options.corpusDir,
    options.chunkOptions
  )
  const allQuestions = parseQuestions(await readFile(options.questionsPath, 'utf-8'))
  // 数据集自身的契约先校验：可答必须有 ground truth，不可答必须没有。搞反时指标不会
  // 报错，只会静静地失去意义。
  for (const question of allQuestions) assertQuestionShape(question)

  const assignment = await loadSplitAssignment(options)
  const questions = selectSplit(allQuestions, options.split, assignment)
  if (questions.length === 0) {
    throw new Error(`eval split "${options.split}" selected no questions from ${options.questionsPath}`)
  }

  const perQuestion: QuestionReport[] = []
  const latencies: number[] = []

  for (const question of questions) {
    const groundTruth = resolveGroundTruth(db, question, documentIds)
    const groundTruthIds = groundTruth.map((entry) => entry.blockId)

    const started = performance.now()
    // 排名指标在完整的候选深度上计算，不先截到 `contextK`：
    //
    //   - Recall@10 需要至少 10 条结果，而生产的 `contextK` 是 3；
    //   - 截断只取候选列表的前缀，前缀的排序与截断前一致，所以用宽的结果算排名不等于
    //     把两件事混在一个数里。
    const results = await knowledgeService.search(NOTEBOOK_ID, question.question, {
      candidateK: options.candidateK,
      topK: options.candidateK,
      threshold: options.threshold,
      strategy: options.strategy
    })
    const latencyMs = performance.now() - started
    latencies.push(latencyMs)

    const matchesByRank = results.map((result) => {
      const blockIds = new Set(result.locator.blocks.map((block) => block.blockId))
      return groundTruthIds
        .map((blockId, index) => (blockIds.has(blockId) ? index : -1))
        .filter((index) => index >= 0)
    })

    perQuestion.push({
      id: question.id,
      question: question.question,
      type: question.type ?? UNTAGGED,
      answerable: question.answerable ?? true,
      firstRelevantRank: firstRelevantRank(matchesByRank),
      relevantCount: groundTruth.length,
      retrievedCount: results.length,
      contextChars: results
        .slice(0, options.contextK)
        .reduce((total, result) => total + result.content.length, 0),
      matchesByRank
    })
  }

  // 不可答的问题不进排名指标：它们没有 ground truth，`recallAtK` 对它们返回的是 0/0
  // 而不是 0，把“该拒答”算成“漏报”会让整张表失真。它们自成一组。
  const answerable = perQuestion.filter((q) => q.answerable)
  const unanswerableQuestions = perQuestion.filter((q) => !q.answerable)

  const metrics = summarize(answerable, options.contextK)

  // 每个类别一行，按类别名排序，所以同一个 JSON 在两次运行之间可 diff。
  const byType: EvalTypeBreakdown[] = [...new Set(answerable.map((q) => q.type))]
    .sort()
    .map((type) => {
      const group = answerable.filter((q) => q.type === type)
      return { type, questions: group.length, metrics: summarize(group, options.contextK) }
    })

  const unanswerableNoResults = unanswerableQuestions.filter((q) => q.retrievedCount === 0).length
  const unanswerable = {
    questions: unanswerableQuestions.length,
    noResultCount: unanswerableNoResults,
    // 目标方向与其他指标相反：没有相关资料时，返回空才是对的。
    noResultRate:
      unanswerableQuestions.length === 0 ? 0 : unanswerableNoResults / unanswerableQuestions.length,
    meanRetrieved: mean(unanswerableQuestions.map((q) => q.retrievedCount))
  }

  const chunking = { ...DEFAULT_CHUNK_OPTIONS, ...options.chunkOptions }
  return {
    baseline: options.baseline,
    generatedBy: 'npm run eval',
    config: {
      embedding: `${LOCAL_EMBEDDING_MODEL.id}@${LOCAL_EMBEDDING_MODEL.revision} ${LOCAL_EMBEDDING_MODEL.dtype} (${LOCAL_EMBEDDING_MODEL.dimensions}d, local)`,
      chunking: {
        chunkSize: chunking.chunkSize,
        chunkOverlap: chunking.chunkOverlap,
        minChunkSize: chunking.minChunkSize,
        allowSpanPages: chunking.allowSpanPages,
        respectHeadings: chunking.respectHeadings
      },
      retrieval: options.strategy,
      split: options.split,
      candidateK: options.candidateK,
      contextK: options.contextK,
      threshold: options.threshold,
      corpus: options.corpusLabel,
      documents: documentIds.size,
      questions: questions.length,
      chunkCount
    },
    metrics,
    byType,
    unanswerable,
    timing: {
      latencyP50Ms: percentile(latencies, 50),
      latencyP95Ms: percentile(latencies, 95),
      indexingMs
    },
    perQuestion
  }
}

/** Round metrics to a stable number of decimals so the JSON diffs cleanly. */
const roundMetric = (value: number): number => Number(value.toFixed(6))

function roundMetrics(metrics: EvalMetrics): EvalMetrics {
  return {
    recallAt1: roundMetric(metrics.recallAt1),
    recallAt5: roundMetric(metrics.recallAt5),
    recallAt10: roundMetric(metrics.recallAt10),
    mrr: roundMetric(metrics.mrr),
    ndcgAt10: roundMetric(metrics.ndcgAt10),
    hitRateAt5: roundMetric(metrics.hitRateAt5),
    mapAt10: roundMetric(metrics.mapAt10),
    contextPrecision: roundMetric(metrics.contextPrecision),
    contextRecall: roundMetric(metrics.contextRecall)
  }
}

export function stabilize(report: EvalReport): EvalReport {
  return {
    ...report,
    metrics: roundMetrics(report.metrics),
    byType: report.byType.map((entry) => ({ ...entry, metrics: roundMetrics(entry.metrics) })),
    timing: {
      latencyP50Ms: roundMetric(report.timing.latencyP50Ms),
      latencyP95Ms: roundMetric(report.timing.latencyP95Ms),
      // Throughput is informational and excluded from the deterministic report; the
      // full report keeps it for the #78 comparison.
      indexingMs: Math.round(report.timing.indexingMs)
    },
    perQuestion: report.perQuestion
  }
}

/** Strip the non-deterministic timing so the committed JSON is diff-stable. */
export function toDeterministicReport(report: EvalReport): EvalDeterministicReport {
  return {
    baseline: report.baseline,
    generatedBy: report.generatedBy,
    config: report.config,
    metrics: report.metrics,
    byType: report.byType,
    unanswerable: report.unanswerable,
    perQuestion: report.perQuestion
  }
}

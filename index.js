/**
 * 个人 RAG —— Host 侧实现。
 *
 * 把一个本地 Meilisearch 知识库以三个一等公民工具的形式暴露给 agent，外加一个
 * 提示词段落与一条诊断用 HTTP 路由：
 *
 * - `rag_context` —— 针对一个问题做检索，返回可直接用于推理的、带引用编号的上下文包。
 * - `rag_search`  —— 同一次检索，但返回带分数的排序命中列表、doc id 与字节偏移，
 *   供工具化使用而非阅读。
 * - `rag_status`  —— 存活状态、索引规模、embedder，以及可过滤字段
 *   （`rag_search` 与 `rag_context` 接受 Meilisearch 的 `filter` 表达式，
 *   所以模型必须能发现这些字段名）。
 *
 * 对维护有影响的设计说明：
 *
 * - 本模块只导入 Node 内置模块。所有 Harness 能力都通过 `ctx` 获取，因此解析问题
 *   绝不会在导入期把插件拖垮。
 * - 工具定义直接按注册表契约书写（`parameters` 用 JSON Schema，另有
 *   `output.render`），而不是导入 `defineTool`，正是为了保持这个零导入的性质。
 * - 检索委托给 Meilisearch 自己的 hybrid 排序。本插件只在原始 API 之上补充模型
 *   真正需要的东西：合并、引用、预算。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MeiliClient, DEFAULT_BASE_URL, DEFAULT_INDEX } from './lib/meili.js'
import { buildContext, provenanceOf, RETRIEVE_ATTRIBUTES } from './lib/context.js'
import { MeilisearchService, resolvePath, serviceConfig } from './lib/meilisearch-service.js'
import { dropUndefined, pickDeclared } from './lib/output.js'
import { registerRagRoutes } from './lib/web.js'

/** 供 loader 诊断使用的 Cordis 插件名。 */
export const name = 'rag'

/**
 * `<dsh-home>/plugins` 之下存放本插件持久化状态的路径段：先是 owner 目录，然后是插件名。
 *
 * 这个布局是本仓库自己的约定，并非 Harness 提供的：DSH 在自己的 home 下并没有定义
 * `plugins/` 这一层，它自己的包把每个插件的状态平铺存放（`<dsh-home>/llm-deepseek`、
 * `<dsh-home>/attachments`、`<dsh-home>/storages`）。姊妹项目 WeChat 插件用的是同一种
 * 形状：`<dsh-home>/plugins/@wanxxz/dsh-wechat`。因此对两个插件来说，owner 段与 npm
 * scope 都是一致的：本行的包是 `@wanxxz/dsh-rag`，它的状态就放在 `@wanxxz` 下。
 * 字面量 `@` 是有意保留的：npm 自身的布局就会创建 `node_modules/@scope/name` 这样的
 * 目录，而 Windows 能够正常处理它。
 */
const PLUGIN_DATA_SEGMENT = path.join('@wanxxz', 'dsh-rag')

/**
 * 本插件所需的服务。在 desktop profile 中 `tools` 与 `systemPrompt` 总是存在；
 * 不存在的地方插件保持不激活。
 */
export const inject = ['tools', 'systemPrompt']

/** 诊断路由的默认 HTTP 前缀。 */
const DEFAULT_HTTP_PREFIX = '/personal-rag'

/** 本模块自身所在目录，仅供加载日志使用。 */
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))

/**
 * Meilisearch 二进制的默认位置。
 *
 * 有意留空：一份 checkout 出来的插件不应携带作者专属路径。随后由
 * `findMeilisearchBinary` 依次解析：`meilisearchBinary` 配置项、
 * `DSH_RAG_MEILI_BINARY`、`PATH`，最后是平台常见的安装位置。把 Meilisearch 装在
 * 非常规位置的部署，设置该配置项或环境变量即可。
 */
const DEFAULT_MEILI_BINARY = ''

/** 向插件自己的加载日志追加一行。
 *
 * 它回答的是“正在运行的实例执行的是我当前这份文件吗？”——这个问题否则无法回答：
 * 过期的模块缓存与代码 bug 会表现为**同一个**失败的调用结果。按构造即为尽力而为：
 * 写入失败绝不能影响插件。
 *
 * @param {string} message - 要记录的那一行。
 */
function loadLog(message) {
  try {
    fs.appendFileSync(path.join(MODULE_DIR, 'load.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {
    /* 写日志绝不能把插件搞崩 */
  }
}

/** hybrid 检索中全文那一半可选的匹配策略。 */
const MATCHING_STRATEGIES = ['last', 'all', 'frequency']

/** Harness home 目录，与启动器自身的解析方式保持一致。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * 默认数据根：`<dsh-home>/plugins/@wanxxz/dsh-rag`。
 *
 * 它沿用本仓库自己的布局（见 `PLUGIN_DATA_SEGMENT`），把持久化数据挡在插件的代码目录
 * 之外。`DSH_RAG_DATA_ROOT` 可覆盖它，而该行的 `dataRoot` 配置项可覆盖前两者。
 *
 * @returns {string} 绝对路径。
 */
function defaultDataRoot() {
  const fromEnv = process.env.DSH_RAG_DATA_ROOT
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  return path.join(dshHome(), 'plugins', PLUGIN_DATA_SEGMENT)
}

/**
 * 从原始配置解析出一个有界的正整数。
 * @param {unknown} value - 原始配置值。
 * @param {number} fallback - 未设置或非法时使用的值。
 * @returns {number} 解析出的数值。
 */
function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
}

/**
 * 把该行的配置归一化为各模块期望的形状。
 *
 * 有两个根决定了一切东西的位置：
 *
 * - **插件目录**（本文件所在处）只放代码。运行时不会往里写任何东西，因此它可以只读、
 *   可以被升级整体替换，也可以留在版本控制里而不会顺带收进一个数据库。
 * - **数据根**（`dataRoot`）存放所有必须持久化的东西：Meilisearch 数据库、它的日志、
 *   master key 与检索 key。默认是 `<dsh-home>/plugins/@wanxxz/dsh-rag`，且可配置，
 *   所以部署方可以把状态放到别的卷上。
 *
 * 下面每个路径要么是绝对路径，要么相对数据根。
 *
 * @param {object | undefined} raw - 该行的 `config`。
 * @returns {object} 已解析出全部默认值的配置。
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const string = (value, fallback) => (typeof value === 'string' && value.length > 0 ? value : fallback)
  const semanticRatio = Number.isFinite(config.semanticRatio) ? Math.min(1, Math.max(0, config.semanticRatio)) : 0.5
  const matchingStrategy = MATCHING_STRATEGIES.includes(config.matchingStrategy) ? config.matchingStrategy : 'all'
  const dataRoot = string(config.dataRoot, defaultDataRoot())
  return {
    dataRoot,
    baseUrl: string(config.baseUrl, DEFAULT_BASE_URL),
    apiKey: typeof config.apiKey === 'string' ? config.apiKey.trim() : '',
    apiKeyPath: string(config.apiKeyPath, 'corpus/keys/search-key.txt'),
    index: string(config.index, DEFAULT_INDEX),
    embedder: string(config.embedder, DEFAULT_INDEX),
    defaultLimit: positiveInt(config.defaultLimit, 8),
    maxLimit: positiveInt(config.maxLimit, 30),
    defaultContextChars: positiveInt(config.defaultContextChars, 6000),
    maxContextChars: positiveInt(config.maxContextChars, 40_000),
    defaultSemanticRatio: semanticRatio,
    matchingStrategy,
    minScore: Number.isFinite(config.minScore) ? Math.min(1, Math.max(0, config.minScore)) : 0.7,
    timeoutMs: positiveInt(config.timeoutMs, 15_000),
    agentTools: config.agentTools !== false,
    promptGuidance: config.promptGuidance !== false,
    httpPrefix: string(config.httpPrefix, DEFAULT_HTTP_PREFIX).replace(/\/+$/u, ''),
    httpRoute: config.httpRoute !== false,
    // Meilisearch 进程归属。
    serviceAutoStart: config.serviceAutoStart !== false,
    meilisearchBinary: string(config.meilisearchBinary, DEFAULT_MEILI_BINARY),
    meilisearchDbPath: string(config.meilisearchDbPath, 'runtime/data'),
    meilisearchLogPath: string(config.meilisearchLogPath, 'runtime/logs/meili.log'),
    masterKeyPath: string(config.masterKeyPath, 'runtime/master-key.txt'),
    masterKey: typeof config.masterKey === 'string' ? config.masterKey.trim() : '',
    meilisearchMaxIndexingMemory: string(config.meilisearchMaxIndexingMemory, '2GB'),
    meilisearchScheduleSnapshot: positiveInt(config.meilisearchScheduleSnapshot, 86_400),
    serviceStartTimeoutMs: positiveInt(config.serviceStartTimeoutMs, 120_000),
    serviceStopTimeoutMs: positiveInt(config.serviceStopTimeoutMs, 15_000),
    serviceWarmup: config.serviceWarmup !== false,
    serviceWarmupTimeoutMs: positiveInt(config.serviceWarmupTimeoutMs, 600_000),
    servicePollIntervalMs: positiveInt(config.servicePollIntervalMs, 1000),
    dshHome: dshHome(),
  }
}

/**
 * 基于 `ctx.logger` 的极简日志器，带一个 console 兜底。
 * @param {object} ctx - 插件上下文。
 * @returns {{debug: Function, info: Function, warn: Function, error: Function}} 日志器。
 */
function createLogger(ctx) {
  const service = ctx.logger
  const write = (level, message) => {
    try {
      if (service !== undefined && typeof service[level] === 'function') service[level](message)
      else if (level === 'error') console.error(`[rag] ${message}`)
      else if (level === 'warn') console.warn(`[rag] ${message}`)
    } catch {
      /* 写日志绝不能把插件搞崩 */
    }
  }
  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message),
  }
}

/**
 * 构造把配置加 key 文件变成一个有效 key 的解析器。
 *
 * 该文件在**每次调用**时重新读取，因此轮换 key 会在下一次工具调用时生效，而不是等到
 * 下次进程启动。
 * @param {object} config - 已归一化的配置。
 * @returns {() => {key: string, source: string}} 解析器。
 */
function keyResolver(config) {
  return () => {
    if (config.apiKey.length > 0) return { key: config.apiKey, source: 'config' }
    // 相对数据根解析，因此相对的 `apiKeyPath` 与其余持久化状态放在一起，而不是落在
    // 代码目录里面。
    const keyPath = resolvePath(config.apiKeyPath, config.dataRoot)
    try {
      const text = fs.readFileSync(keyPath, 'utf8').trim()
      if (text.length > 0) return { key: text, source: `file:${keyPath}` }
      return { key: '', source: `file:${keyPath} (empty)` }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      return { key: '', source: code === 'ENOENT' ? `file:${keyPath} (missing)` : `file:${keyPath} (unreadable)` }
    }
  }
}

/**
 * 为当前 key 创建一个客户端；key 不可用时以一条可操作的错误消息失败。
 * @param {object} config - 已归一化的配置。
 * @param {() => {key: string, source: string}} resolveKey - key 解析器。
 * @returns {MeiliClient} 客户端。
 */
function clientFor(config, resolveKey) {
  const { key, source } = resolveKey()
  if (key.length === 0) {
    throw new Error(
      `no Meilisearch search key available (checked config.apiKey and ${source}); ` +
        'set the plugin config `apiKey`, or point `apiKeyPath` at the key file',
    )
  }
  return new MeiliClient({ baseUrl: config.baseUrl, apiKey: key, index: config.index, timeoutMs: config.timeoutMs })
}

/**
 * 把请求的返回条数夹到配置允许的区间内。
 * @param {unknown} requested - 模型给出的条数。
 * @param {object} config - 已归一化的配置。
 * @returns {number} 被接受的条数。
 */
function clampLimit(requested, config) {
  if (!Number.isSafeInteger(requested) || requested < 1) return Math.min(config.defaultLimit, config.maxLimit)
  return Math.min(requested, config.maxLimit)
}

/**
 * 把请求的字符预算夹到配置允许的区间内。
 * @param {unknown} requested - 模型给出的预算。
 * @param {object} config - 已归一化的配置。
 * @returns {number} 被接受的预算。
 */
function clampChars(requested, config) {
  if (!Number.isSafeInteger(requested) || requested < 200) return config.defaultContextChars
  return Math.min(requested, config.maxContextChars)
}

/**
 * 解析单次调用的 semantic ratio。
 * @param {unknown} requested - 模型给出的比例。
 * @param {object} config - 已归一化的配置。
 * @returns {number} 落在 `[0, 1]` 内的比例。
 */
function semanticRatio(requested, config) {
  if (!Number.isFinite(requested)) return config.defaultSemanticRatio
  return Math.min(1, Math.max(0, requested))
}

/**
 * 解析单次调用的匹配策略。
 * @param {unknown} requested - 模型给出的策略。
 * @param {object} config - 已归一化的配置。
 * @returns {string} `last`、`all`、`frequency` 之一。
 */
function matchingStrategy(requested, config) {
  return MATCHING_STRATEGIES.includes(requested) ? requested : config.matchingStrategy
}

/**
 * 解析单次调用的最低 ranking score。
 *
 * Meilisearch 的全局 ranking score 是一个**相对**信号，而不是校准过的概率：在 hybrid
 * 模式下，一个小索引对与任何文档都毫无共同之处的文本也会返回约 0.65。默认阈值是在随
 * 附的样本语料上校准出来的，它的作用是阻止一个无关问题拿到八段看起来很有把握的段落；
 * 传入 `minScore: 0` 可以看到全部排序命中。
 *
 * @param {unknown} requested - 模型给出的阈值。
 * @param {object} config - 已归一化的配置。
 * @returns {number} 落在 `[0, 1]` 内的阈值。
 */
function minScore(requested, config) {
  if (!Number.isFinite(requested)) return config.minScore
  return Math.min(1, Math.max(0, requested))
}

/**
 * 执行一次检索，其形态恰好是两个检索工具都需要的。
 *
 * @param {object} config - 已归一化的配置。
 * @param {() => {key: string, source: string}} resolveKey - key 解析器。
 * @param {object} args - 已校验的工具参数。
 * @returns {Promise<{hits: object[], query: string, estimatedTotalHits: number | undefined, semantic: number, threshold: number}>} 检索结果。
 */
async function retrieve(config, resolveKey, args) {
  const query = String(args.query ?? '').trim()
  if (query.length === 0) throw new Error('query must be a non-empty string')
  const client = clientFor(config, resolveKey)
  const ratio = semanticRatio(args.semanticRatio, config)
  const threshold = minScore(args.minScore, config)
  const response = await client.search({
    q: query,
    limit: clampLimit(args.limit, config),
    attributesToRetrieve: RETRIEVE_ATTRIBUTES,
    filter: typeof args.filter === 'string' ? args.filter : undefined,
    matchingStrategy: matchingStrategy(args.matchingStrategy, config),
    // `semanticRatio: 0` 表示仅关键词检索；Meilisearch 仍要求给出 embedder 名字，
    // 所以 hybrid 块总是发送。
    hybrid: { embedder: config.embedder, semanticRatio: ratio },
    ...(threshold > 0 ? { rankingScoreThreshold: threshold } : {}),
  })
  const hits = Array.isArray(response?.hits) ? response.hits : []
  return {
    hits,
    query,
    estimatedTotalHits: Number.isFinite(response?.estimatedTotalHits) ? response.estimatedTotalHits : undefined,
    semantic: ratio,
    threshold,
  }
}

/**
 * 三个工具定义，按注册表契约构造。
 *
 * @param {object} config - 已归一化的配置。
 * @param {() => {key: string, source: string}} resolveKey - key 解析器。
 * @param {object} lifecycle - Meilisearch 生命周期；它的 snapshot 由 `rag_status` 报告。
 * @returns {{ragContext: object, ragSearch: object, ragStatus: object, status: Function}} 工具定义与共享的状态提供者。
 */
export function buildToolDefinitions(config, resolveKey, lifecycle) {
  const filterHelp =
    'Meilisearch filter expression, e.g. `publish_year >= 2023` or `doc_type = "规范性文件"`. ' +
    'Call rag_status to list the exact filterable fields; leave it empty to search everything.'

  const ragContext = {
    name: 'rag_context',
    description:
      'Search the local personal knowledge base and return a citation-numbered context pack. ' +
      'Use it before answering any question that the indexed documents could settle (policies, regulations, notices, internal notes): ' +
      'the result is already merged, de-duplicated, and quoted with provenance headers, so it can be reasoned over directly. ' +
      'Every passage carries a [n] label; cite those labels in your answer and do not invent facts the pack does not contain. ' +
      'Retrieval is hybrid (Chinese full-text via jieba plus bge-m3 embeddings), so a natural-language question works better than keywords. ' +
      'Call it at most two or three times per question, varying the wording rather than the limit.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The question or topic to retrieve for, as a natural-language phrase.' },
        limit: { type: 'number', description: `Maximum chunks to retrieve before merging. Defaults to ${config.defaultLimit}.` },
        maxChars: {
          type: 'number',
          description: `Character budget for the returned context, default ${config.defaultContextChars}. Lower it when you only need the strongest passage.`,
        },
        filter: { type: 'string', description: filterHelp },
        semanticRatio: {
          type: 'number',
          description:
            'Balance of keyword versus semantic retrieval, 0..1. Default ' +
            `${config.defaultSemanticRatio}. Raise it for paraphrased questions, lower it for exact terms, document numbers, or figures.`,
        },
        matchingStrategy: {
          type: 'string',
          enum: MATCHING_STRATEGIES,
          description: `How query terms must match the index. Default ${config.matchingStrategy}.`,
        },
        minScore: {
          type: 'number',
          description:
            `Drop hits scoring below this Meilisearch ranking score, 0..1. Default ${config.minScore}. ` +
            'This is a relative, not calibrated, signal; set it to 0 to see every ranked hit when a query returns fewer passages than expected.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'context', 'sources', 'truncated'],
        properties: {
          query: { type: 'string' },
          context: { type: 'string', description: 'The rendered, citation-numbered context pack; empty when nothing matched.' },
          sources: {
            type: 'array',
            description: 'One entry per [n] label in `context`.',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['n', 'title', 'docId', 'score'],
              properties: {
                n: { type: 'integer' },
                title: { type: 'string' },
                sectionPath: { type: 'string' },
                docId: { type: 'string', description: 'Pass as `doc_id = "<value>"` in a later `filter` to work inside one document.' },
                issuer: { type: 'string' },
                date: { type: 'string' },
                score: { type: 'number' },
                chunkIds: { type: 'array', items: { type: 'string' } },
              },
            },
          },
          truncated: { type: 'boolean', description: 'True when the character budget cut the pack short.' },
          hitCount: { type: 'integer', description: 'Chunks retrieved before merging.' },
        },
      },
      render: (_args, value) => {
        if (value.sources.length === 0) {
          return [
            {
              type: 'text',
              text: `No passages in the knowledge base matched "${value.query}". Try different wording, lower \`minScore\`, or drop the filter before concluding the answer is absent.`,
            },
          ]
        }
        const header = `Retrieved ${value.hitCount} chunks into ${value.sources.length} passage(s) for "${value.query}".`
        const footer = value.truncated
          ? `\n\n(pack truncated at the character budget; ${value.sources.length} of ${value.hitCount} chunks kept)`
          : ''
        return [{ type: 'text', text: `${header}\n\n${value.context}${footer}` }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const { hits, query, estimatedTotalHits } = await retrieve(config, resolveKey, args)
      const pack = buildContext({ hits, maxChars: clampChars(args.maxChars, config) })
      // 注册表**严格**校验 `output.schema`，所以结果是从声明的 schema 投影出来的，
      // 而不是手工列出字段。
      return pickDeclared(
        {
          query,
          context: pack.text,
          sources: pack.sources,
          truncated: pack.truncated,
          hitCount: hits.length,
          estimatedTotalHits,
        },
        ragContext.output.schema,
      )
    },
  }

  const ragSearch = {
    name: 'rag_search',
    description:
      'Search the local personal knowledge base and return raw ranked hits with ranking scores, chunk ids, and the stored ' +
      'provenance fields. Use it to inspect or tune retrieval (which chunk won, how scores separate, which document ids exist); ' +
      'use rag_context instead when the passages are meant to be read and cited. ' +
      'Retrieval is hybrid (Chinese jieba full-text plus bge-m3 embeddings).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: { type: 'string', description: 'The question or topic to retrieve for.' },
        limit: { type: 'number', description: `Maximum hits to return. Defaults to ${config.defaultLimit}, capped at ${config.maxLimit}.` },
        filter: { type: 'string', description: filterHelp },
        semanticRatio: {
          type: 'number',
          description: `Balance of keyword versus semantic retrieval, 0..1. Default ${config.defaultSemanticRatio}; 0 is keyword-only.`,
        },
        matchingStrategy: { type: 'string', enum: MATCHING_STRATEGIES, description: `How query terms must match. Default ${config.matchingStrategy}.` },
        docId: {
          type: 'string',
          description: 'Restrict to one logical document by its `doc_id`. Equivalent to passing `doc_id = "<value>"` as the filter.',
        },
        snippetChars: {
          type: 'number',
          description: 'Characters of chunk text kept per hit in the rendered list. Default 160; raise it when the snippet is too short to judge.',
        },
        minScore: {
          type: 'number',
          description: `Drop hits scoring below this Meilisearch ranking score, 0..1. Default ${config.minScore}; set 0 to inspect the whole ranked tail.`,
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['query', 'hits', 'hitCount'],
        properties: {
          query: { type: 'string' },
          hitCount: { type: 'integer' },
          estimatedTotalHits: { type: 'integer' },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rank', 'id', 'docId', 'title', 'score', 'text'],
              properties: {
                rank: { type: 'integer' },
                id: { type: 'string' },
                docId: { type: 'string' },
                title: { type: 'string' },
                sectionPath: { type: 'string' },
                issuer: { type: 'string' },
                date: { type: 'string' },
                score: { type: 'number' },
                text: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.hits.length === 0) {
          return [{ type: 'text', text: `No hits in the knowledge base for "${value.query}".` }]
        }
        const total = value.estimatedTotalHits === undefined ? '' : ` of ~${value.estimatedTotalHits}`
        const lines = value.hits.map(
          (hit) =>
            `${hit.rank}. score=${hit.score.toFixed(4)} doc_id=${hit.docId} id=${hit.id}\n` +
            `   ${[hit.title, hit.sectionPath, hit.issuer, hit.date].filter((part) => part.length > 0).join(' | ')}\n` +
            `   ${hit.text}`,
        )
        return [{ type: 'text', text: `${value.hitCount}${total} hit(s) for "${value.query}":\n\n${lines.join('\n')}` }]
      },
    },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    async execute(args) {
      const effective = { ...args }
      if (typeof args.docId === 'string' && args.docId.length > 0) {
        effective.filter = `doc_id = ${JSON.stringify(args.docId)}`
      }
      const { hits, query, estimatedTotalHits } = await retrieve(config, resolveKey, effective)
      const snippetChars = positiveInt(args.snippetChars, 160)
      const mapped = hits.map((hit, index) => {
        const full = String(hit.text ?? '').replace(/\s+/gu, ' ').trim()
        return {
          rank: index + 1,
          id: String(hit.id ?? ''),
          docId: String(hit.doc_id ?? ''),
          title: String(hit.title ?? ''),
          sectionPath: String(hit.section_path ?? ''),
          issuer: String(hit.issuer_short ?? ''),
          date: String(hit.publish_date ?? (Number.isFinite(hit.publish_year) ? hit.publish_year : '')),
          score: Number.isFinite(hit._rankingScore) ? hit._rankingScore : 0,
          text: full.length > snippetChars ? `${full.slice(0, snippetChars)}…` : full,
        }
      })
      return pickDeclared(
        {
          query,
          hitCount: hits.length,
          hits: mapped,
          estimatedTotalHits,
        },
        ragSearch.output.schema,
      )
    },
  }

  /** 收集单个探测的值或其失败，使一条被拒的路由无法让整个状态失败。 */
  const probe = async (label, operation) => {
    try {
      return { label, value: await operation(), ok: true }
    } catch (error) {
      return { label, value: error instanceof Error ? error.message : String(error), ok: false }
    }
  }

  /**
   * 组装状态报告。由 `rag_status` 工具与 HTTP 路由共享。
   * @returns {Promise<object>} 可直接 JSON 化的状态。
   */
  const status = async () => {
    const { source } = resolveKey()
    const client = (() => {
      try {
        return clientFor(config, resolveKey)
      } catch {
        return undefined
      }
    })()
    const base = {
      baseUrl: config.baseUrl,
      index: config.index,
      embedder: config.embedder,
      keySource: source,
      semanticRatio: config.defaultSemanticRatio,
      matchingStrategy: config.matchingStrategy,
      minScore: config.minScore,
      contextDefaults: { limit: config.defaultLimit, maxChars: config.defaultContextChars },
      filterableFields: [],
      service: lifecycle.snapshot(),
    }
    if (client === undefined) {
      // 声明的 output schema 在这条路径上也要求 `filterableFields` 以及其他必需键，
      // 所以提前返回也携带同样的形状，而不是更短的形状。
      return {
        ...base,
        reachable: false,
        configured: false,
        error: 'no search key available; retrieval tools will fail until one is set',
      }
    }
    const [health, listed, stats, embedders, filterable, described] = await Promise.all([
      probe('health', () => client.health()),
      probe('listIndexes', () => client.listIndexes()),
      probe('stats', () => client.stats()),
      probe('embedders', () => client.embedders()),
      probe('filterableAttributes', () => client.filterableAttributes()),
      probe('describeIndex', () => client.request(`/indexes/${encodeURIComponent(config.index)}`)),
    ])
    const healthValue = health.ok ? health.value : undefined
    const reachable = healthValue?.status === 'available'
    const listedUids = listed.ok && Array.isArray(listed.value?.results) ? listed.value.results.map((item) => item.uid) : []
    const statsValue = stats.ok ? stats.value : undefined
    const embedderValue = embedders.ok ? embedders.value : undefined
    const activeEmbedder = embedderValue?.[config.embedder]
    const failures = [health, listed, stats, embedders, filterable, described]
      .filter((entry) => !entry.ok)
      .map((entry) => `${entry.label}: ${entry.value}`)
    return {
      ...base,
      configured: true,
      reachable,
      indexVisibleToKey: listedUids.includes(config.index),
      indexUids: listedUids,
      // `documents` 只对携带 `stats.get` 的 key 可见；拿不到时该字段直接省略，而不是
      // 谎报为 0。
      documents: Number.isFinite(statsValue?.numberOfDocuments) ? statsValue.numberOfDocuments : undefined,
      embeddings: Number.isFinite(statsValue?.numberOfEmbeddings) ? statsValue.numberOfEmbeddings : undefined,
      isIndexing: typeof statsValue?.isIndexing === 'boolean' ? statsValue.isIndexing : undefined,
      primaryKey: described.ok ? described.value?.primaryKey : undefined,
      embedderConfig: activeEmbedder === undefined ? undefined : { source: activeEmbedder.source, model: activeEmbedder.model, dimensions: activeEmbedder.dimensions },
      filterableFields: filterable.ok && Array.isArray(filterable.value) ? filterable.value : [],
      ...(failures.length === 0 ? {} : { probeFailures: failures }),
    }
  }

  const ragStatus = {
    name: 'rag_status',
    description:
      'Report the health of the local personal knowledge base: whether Meilisearch is reachable, how many documents and ' +
      'embeddings the index holds, which embedder and pooling it uses, its primary key, and — most usefully — the exact ' +
      'filterable field names that `rag_search` and `rag_context` accept in a `filter`. ' +
      'Call it when a retrieval fails, returns nothing, or when you need to build a filter by a field name you are guessing at. ' +
      'It is read-only and cheap.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['baseUrl', 'index', 'configured', 'reachable', 'filterableFields'],
        properties: {
          baseUrl: { type: 'string' },
          index: { type: 'string' },
          embedder: { type: 'string' },
          configured: { type: 'boolean' },
          reachable: { type: 'boolean' },
          keySource: { type: 'string' },
          indexVisibleToKey: { type: 'boolean' },
          indexUids: { type: 'array', items: { type: 'string' } },
          documents: { type: 'integer' },
          embeddings: { type: 'integer' },
          isIndexing: { type: 'boolean' },
          primaryKey: { type: 'string' },
          embedderConfig: {
            type: 'object',
            additionalProperties: false,
            properties: { source: { type: 'string' }, model: { type: 'string' }, dimensions: { type: 'integer' } },
          },
          filterableFields: { type: 'array', items: { type: 'string' } },
          semanticRatio: { type: 'number' },
          matchingStrategy: { type: 'string' },
          minScore: { type: 'number' },
          contextDefaults: {
            type: 'object',
            additionalProperties: false,
            properties: { limit: { type: 'integer' }, maxChars: { type: 'integer' } },
          },
          service: {
            type: 'object',
            additionalProperties: false,
            description: 'The Meilisearch process this plugin owns or adopted.',
            properties: {
              managed: { type: 'boolean', description: 'True when this plugin started the process.' },
              state: { type: 'string', description: 'stopped | starting | ready | failed | external | disabled' },
              pid: { type: 'integer' },
              adopted: { type: 'boolean', description: 'True when an already-running instance was found and left alone.' },
              binaryPath: { type: 'string' },
              dbPath: { type: 'string' },
              logPath: { type: 'string' },
              warmupMs: { type: 'integer' },
              error: { type: 'string' },
            },
          },
          probeFailures: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.configured === false) {
          return [{ type: 'text', text: `Personal RAG is not configured: ${value.error ?? 'no search key'}` }]
        }
        const lines = [
          value.reachable ? `Meilisearch reachable at ${value.baseUrl}` : `Meilisearch NOT reachable at ${value.baseUrl}`,
          `index \`${value.index}\`: ${value.documents ?? '?'} documents, ${value.embeddings ?? '?'} embeddings${value.isIndexing === true ? ' (indexing now)' : ''}`,
          `embedder \`${value.embedder}\`: ${value.embedderConfig?.model ?? 'unknown'}${value.embedderConfig?.source === undefined ? '' : ` (${value.embedderConfig.source})`}`,
          `filterable fields: ${value.filterableFields.length === 0 ? '(none reported)' : value.filterableFields.join(', ')}`,
        ]
        if (value.service !== undefined) {
          const service = value.service
          const ownership = service.managed === true ? 'started by this plugin' : service.adopted === true ? 'already running (adopted)' : 'not managed'
          const detail = [service.pid === undefined ? undefined : `pid ${service.pid}`, service.warmupMs === undefined ? undefined : `warmup ${(service.warmupMs / 1000).toFixed(1)}s`]
            .filter((part) => part !== undefined)
            .join(', ')
          lines.push(`service: ${service.state ?? 'unknown'} — ${ownership}${detail.length === 0 ? '' : ` (${detail})`}`)
        }
        if (value.probeFailures !== undefined && value.probeFailures.length > 0) {
          lines.push(`probe failures: ${value.probeFailures.join('; ')}`)
        }
        if (value.reachable === false) lines.push('start Meilisearch before relying on retrieval.')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    // 这里 `dropUndefined` 很关键：由可选探测拼装出的状态，对每一个被拒的探测都含有
    // `undefined`，而 `undefined` 在 JSON 里根本无法表示。
    async execute() {
      return dropUndefined(await status())
    },
  }

  return { ragContext, ragSearch, ragStatus, status }
}

/**
 * 注册一个工具定义；注册表拒绝时给出警告而不是抛错。
 * @param {object} ctx - 插件上下文。
 * @param {object} definition - 可直接交给注册表的定义。
 * @param {object} logger - 日志器。
 * @returns {Function | undefined} 注册的 disposer。
 */
function registerTool(ctx, definition, logger) {
  try {
    const dispose = ctx.tools.register(definition)
    logger.info(`rag: registered the ${definition.name} tool`)
    return typeof dispose === 'function' ? dispose : undefined
  } catch (error) {
    logger.warn(`rag: could not register ${definition.name}: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * 注册感知 scope 的提示词指引。
 *
 * 对于工具集里不含 RAG 工具的 agent，该段落渲染为空，于是一个受限的 agent 永远不会
 * 被告知它无法调用的能力。order 取外部区间（位于 5000 段位的一等公民工具指引之上），
 * 因为这是第三方贡献。
 *
 * @param {object} ctx - 插件上下文。
 * @param {object} config - 已归一化的配置。
 * @param {object} logger - 日志器。
 * @returns {Function | undefined} 注册的 disposer。
 */
function registerGuidance(ctx, config, logger) {
  const text = [
    'A personal knowledge base is indexed locally and retrievable through the `rag_context` tool.',
    'Prefer it over guessing whenever the question could be settled by the user\'s own documents, and call it before web search for such questions.',
    '`rag_context` returns passages already numbered `[1]`, `[2]`, …; cite those numbers in your answer so the user can trace every claim.',
    'If a pack is empty, try a differently worded query or relax the filter before telling the user the knowledge base has nothing.',
    'Use `rag_search` only when you need raw scores or chunk ids, and `rag_status` to check health or discover filterable field names.',
  ].join(' ')
  try {
    const order = typeof ctx.systemPrompt.getSectionOrder === 'function' ? ctx.systemPrompt.getSectionOrder('TOOL_RAG') : undefined
    const dispose = ctx.systemPrompt.section({
      name: 'tool:rag',
      ...(Number.isFinite(order) ? { order } : { order: 5500 }),
      text: ({ scope }) => {
        const visible = typeof ctx.tools.get === 'function' && ctx.tools.get('rag_context', scope) !== undefined
        return visible ? text : ''
      },
    })
    logger.info('rag: registered prompt guidance')
    return typeof dispose === 'function' ? dispose : undefined
  } catch (error) {
    // 缺少具名 order、或段落形状不受支持，都不应让检索本身失效；两种情况下工具都
    // 保持注册状态。
    logger.warn(`rag: prompt guidance not registered: ${error instanceof Error ? error.message : String(error)}`)
    return undefined
  }
}

/**
 * 在本 profile 中激活个人 RAG 插件。
 * @param {object} ctx - 插件上下文。
 * @param {object} [rawConfig] - 来自 `cordis.patch.yml` 的该行 `config`。
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = createLogger(ctx)
  const resolveKey = keyResolver(config)
  const lifecycle = new MeilisearchService({ config: serviceConfig(config, config.dataRoot, resolveKey().key), logger })
  const { ragContext, ragSearch, ragStatus, status } = buildToolDefinitions(config, resolveKey, lifecycle)

  const initial = resolveKey()
  loadLog(`apply() ran; index=${config.index} dataRoot=${config.dataRoot} key=${initial.source}`)
  logger.info(`rag: data root ${config.dataRoot}`)
  logger.info(
    `rag: index ${config.index} at ${config.baseUrl}, key from ${initial.source}` +
      (initial.key.length === 0 ? ' — retrieval tools will report a configuration error until a key is set' : ''),
  )

  // 拥有这个引擎。effect 的 disposer 会在插件卸载 / host 关闭时运行，因此本插件启动
  // 的 Meilisearch 不会比应用活得更久。已经在运行的实例会被收养，且永不停掉。
  ctx.effect(() => {
    let stopped = false
    const boot = lifecycle.start().catch((error) => {
      logger.warn(`rag: Meilisearch start failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return async () => {
      if (stopped) return
      stopped = true
      await boot
      await lifecycle.stop()
    }
  }, 'rag: meilisearch service')

  if (config.agentTools) {
    ctx.effect(() => {
      const disposers = [registerTool(ctx, ragContext, logger), registerTool(ctx, ragSearch, logger), registerTool(ctx, ragStatus, logger)]
      return () => {
        for (const dispose of disposers) dispose?.()
      }
    }, 'rag: agent tools')
  }

  if (config.promptGuidance) {
    ctx.effect(() => {
      const dispose = registerGuidance(ctx, config, logger)
      return () => dispose?.()
    }, 'rag: prompt guidance')
  }

  if (config.httpRoute) {
    ctx.inject(['webServer'], (child) => {
      child.effect(() => {
        const dispose = registerRagRoutes({
          register: (route) => child.webServer.register(route),
          prefix: config.httpPrefix,
          status,
          logger,
        })
        logger.info(`rag: status route mounted at ${config.httpPrefix}/status`)
        return dispose
      }, 'rag: status route')
    })
  }
}

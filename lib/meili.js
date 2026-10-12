/**
 * 个人 RAG 插件用的极简 Meilisearch HTTP 客户端。
 *
 * 只使用 Node 全局作用域里的 `fetch`，因此插件**完全没有运行时依赖**：导入这个模块
 * 绝不会因为缺少某个包而失败，解析问题也绝不会把插件拖垮。
 *
 * 每个方法都返回可直接 JSON 化的普通数据。出错时抛出的 `Error` 消息里点名了可能的
 * 补救办法，因为调用失败时模型会原样读到这条消息。
 */

/** 只监听回环的实例的默认 Meilisearch 源地址。 */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:7700'

/** personal-rag 灌库脚本创建的默认索引 uid。 */
export const DEFAULT_INDEX = 'zh'

/**
 * 构造一个 `Error`，其消息说明失败原因与可能的修法。
 * @param {string} what - 失败的操作。
 * @param {string} detail - 底层原因。
 * @param {string} [remedy] - 运维应当检查什么。
 * @returns {Error} 要抛出的错误。
 */
function failure(what, detail, remedy) {
  return new Error(remedy === undefined ? `${what}: ${detail}` : `${what}: ${detail} — ${remedy}`)
}

/**
 * 把一个响应体读成 JSON，并把传输层失败映射为可读的错误。
 * @param {Response} response - fetch 响应。
 * @param {string} what - 错误消息里使用的操作名。
 * @returns {Promise<unknown>} 解析后的 JSON 体；为空时返回 `undefined`。
 */
async function readJson(response, what) {
  const text = await response.text()
  let parsed
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      throw failure(what, `Meilisearch returned non-JSON (HTTP ${response.status})`, text.slice(0, 200))
    }
  }
  if (!response.ok) {
    const message = parsed?.message ?? `HTTP ${response.status}`
    const code = parsed?.code ?? 'unknown'
    if (code === 'missing_authorization_header') {
      throw failure(what, `no bearer key was sent (${code})`, 'set the plugin config `apiKey` or point `apiKeyPath` at the key file')
    }
    if (code === 'invalid_api_key' && response.status === 403) {
      // 实测行为：Meilisearch 用 `invalid_api_key` + 403 表示**权限**不足，而 key
      // 真正不存在时返回 401。把缺失的权限点名出来，这条错误才可操作。
      throw failure(what, `the search key is not allowed to do this (${code}, HTTP 403)`, `${what} needs an action the key does not grant (most often \`stats.get\`)`)
    }
    if (code === 'invalid_api_key') {
      throw failure(what, `Meilisearch rejected the search key (${code})`, 'check the `apiKey` config or the key file path')
    }
    if (code === 'index_not_found') {
      throw failure(what, `index not found (${code})`, 'run the personal-rag ingestion script first')
    }
    throw failure(what, `${code}: ${message}`)
  }
  return parsed
}

/**
 * 一个精简、零依赖、限定到单个索引的 Meilisearch 客户端。
 */
export class MeiliClient {
  /**
   * @param {object} options - 连接设置。
   * @param {string} options.baseUrl - 运行中实例的源地址。
   * @param {string} options.apiKey - 具备 `search`（以及 `indexes.get`）权限的 bearer key。
   * @param {string} options.index - 要检索的索引 uid。
   * @param {number} [options.timeoutMs] - 单次请求超时。
   */
  constructor(options) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '')
    this.apiKey = options.apiKey
    this.index = options.index
    this.timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 15_000
  }

  /**
   * 对该实例执行一次带鉴权的请求。
   * @param {string} path - 源地址之下的路径，例如 `/health`。
   * @param {object} [init] - 追加到 fetch 的初始化参数。
   * @returns {Promise<unknown>} 解析后的 JSON 体。
   */
  async request(path, init = {}) {
    const url = `${this.baseUrl}${path}`
    const headers = { authorization: `Bearer ${this.apiKey}`, ...(init.headers ?? {}) }
    let response
    try {
      response = await fetch(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const hint = /ECONNREFUSED|fetch failed|other side closed/iu.test(message)
        ? `is Meilisearch running at ${this.baseUrl}?`
        : undefined
      throw failure(`Meilisearch request to ${path} failed`, message, hint)
    }
    return readJson(response, `Meilisearch request to ${path}`)
  }

  /**
   * 存活探测；不需要有效 key。
   * @returns {Promise<{status: string}>} health 负载。
   */
  health() {
    return this.request('/health')
  }

  /**
   * 这把 key 能看到的 uid 列表（key 自身的索引过滤已经收窄了范围）。
   * @returns {Promise<{results: Array<{uid: string, primaryKey?: string}>, total: number}>} 索引列表。
   */
  listIndexes() {
    return this.request('/indexes')
  }

  /**
   * 索引统计。需要 `stats.get` 权限，而随附的配置 key 并不带该权限，所以调用方必须
   * 把这里的失败当作“未知”，而不是致命错误。
   * @returns {Promise<object>} 统计负载。
   */
  stats() {
    return this.request(`/indexes/${encodeURIComponent(this.index)}/stats`)
  }

  /**
   * 该索引的 embedder 配置（`settings.get`）。
   * @returns {Promise<Record<string, object>>} embedder 名到配置的映射。
   */
  embedders() {
    return this.request(`/indexes/${encodeURIComponent(this.index)}/settings/embedders`)
  }

  /**
   * 可用于 `filter` 表达式的属性（`settings.get`）。
   * @returns {Promise<string[]>} 可过滤属性名。
   */
  filterableAttributes() {
    return this.request(`/indexes/${encodeURIComponent(this.index)}/settings/filterable-attributes`)
  }

  /**
   * 执行一次 hybrid 检索。
   *
   * @param {object} query - 检索请求。
   * @param {string} query.q - 查询文本。
   * @param {number} [query.limit] - 最大命中数。
   * @param {string[]} [query.attributesToRetrieve] - 要返回的字段。
   * @param {string} [query.filter] - Meilisearch 过滤表达式。
   * @param {string} [query.matchingStrategy] - `last`、`all` 或 `frequency`。
   * @param {{embedder: string, semanticRatio: number}} [query.hybrid] - hybrid 参数；省略则仅全文检索。
   * @param {number} [query.rankingScoreThreshold] - 丢弃低于该全局 ranking score 的命中。
   * @returns {Promise<object>} 原始检索响应。
   */
  async search(query) {
    const body = {
      q: query.q,
      limit: query.limit,
      attributesToRetrieve: query.attributesToRetrieve,
      showRankingScore: true,
      ...(query.filter === undefined || query.filter.length === 0 ? {} : { filter: query.filter }),
      ...(query.matchingStrategy === undefined ? {} : { matchingStrategy: query.matchingStrategy }),
      ...(query.rankingScoreThreshold === undefined ? {} : { rankingScoreThreshold: query.rankingScoreThreshold }),
      // `cmn` 钉住中文分词，不受客户端默认值影响。
      locales: ['cmn'],
      ...(query.hybrid === undefined ? {} : { hybrid: query.hybrid }),
    }
    return this.request(`/indexes/${encodeURIComponent(this.index)}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /**
   * 列出有上限的一批已存文档，可选限定到某一个 `doc_id`。
   *
   * @param {object} options - 查询条件。
   * @param {string} [options.docId] - 限定到某一篇逻辑文档。
   * @param {number} [options.limit] - 最大文档数。
   * @returns {Promise<{results: object[], total: number}>} 匹配的文档。
   */
  documents(options = {}) {
    const params = new URLSearchParams()
    params.set('limit', String(options.limit ?? 50))
    if (typeof options.docId === 'string' && options.docId.length > 0) {
      params.set('filter', `doc_id = ${JSON.stringify(options.docId)}`)
    }
    return this.request(`/indexes/${encodeURIComponent(this.index)}/documents?${params.toString()}`)
  }
}

/**
 * 把 Meilisearch 的原始命中转换成可直接引用的上下文包。
 *
 * Meilisearch 返回的是每个已索引块一行，按它自己的 hybrid 分数排序。语言模型不需要
 * 这种形状：它需要最强的若干段落、在属于同一小节的相邻块之间合并、编号以便引用，并
 * 受预算约束，使得一次调用无法淹没上下文窗口。
 */

/** 向 Meilisearch 请求的字段；这份清单越窄，返回结果越小。 */
export const RETRIEVE_ATTRIBUTES = [
  'id',
  'doc_id',
  'title',
  'section_path',
  'text',
  'keywords',
  'issuer_short',
  'doc_type',
  'publish_date',
  'publish_year',
]

/**
 * 把 `publish_date` 与 `publish_year` 合成为一个短标签。
 * @param {object} hit - 一个已存储的块。
 * @returns {string} `2023-11-08`、`2023`，或空字符串。
 */
function dateLabel(hit) {
  if (typeof hit.publish_date === 'string' && hit.publish_date.length > 0) return hit.publish_date
  if (Number.isFinite(hit.publish_year)) return String(hit.publish_year)
  return ''
}

/**
 * 构造显示在每个段落上方的一行出处信息。
 * @param {object} hit - 一个已存储的块。
 * @returns {string} `标题 > 小节（机构 · 年份）` 形式的标签。
 */
export function provenanceOf(hit) {
  const parts = [hit.title ?? hit.doc_id ?? '未命名文档']
  if (typeof hit.section_path === 'string' && hit.section_path.length > 0) {
    // section_path 的第一段是重复的文档标题。
    const segments = hit.section_path.split('>').map((part) => part.trim()).filter((part) => part.length > 0)
    if (segments.length > 1) parts.push(segments.slice(1).join(' > '))
  }
  const meta = [hit.issuer_short, dateLabel(hit)].filter((value) => typeof value === 'string' && value.length > 0)
  return meta.length === 0 ? parts.join(' > ') : `${parts.join(' > ')}（${meta.join(' · ')}）`
}

/**
 * 块在其文档中的逻辑位置，用于合并相邻块。
 * @param {object} hit - 一个已存储的块。
 * @returns {string} 一个稳定的键。
 */
function locationOf(hit) {
  return `${hit.doc_id ?? ''}\u0000${hit.section_path ?? ''}`
}

/**
 * 灌库脚本产出的块 id 中的数字部分（`<hash>-<seq>`）。
 * @param {object} hit - 一个已存储的块。
 * @returns {{prefix: string, seq: number} | undefined} 匹配时返回解析出的 id。
 */
function idParts(hit) {
  const match = /^(.*)-(\d+)$/u.exec(String(hit.id ?? ''))
  if (match === null) return undefined
  return { prefix: match[1], seq: Number(match[2]) }
}

/**
 * 对命中重新分组，使同一小节的相邻块留在一起。
 *
 * 合并**只**会连接两个在块 id 上互为邻居的命中；出现缺口意味着后续文本没有被检索
 * 到，而跨过缺口静默拼接会伪造出原文并不存在的连续性。
 *
 * @param {object[]} hits - 按排序排列的原始命中。
 * @returns {Array<{hits: object[], score: number}>} 按排序排列的分组段落。
 */
function groupHits(hits) {
  const groups = []
  const openByLocation = new Map()
  for (const hit of hits) {
    const location = locationOf(hit)
    const previous = openByLocation.get(location)
    const current = idParts(hit)
    const previousParts = previous === undefined ? undefined : idParts(previous.at(-1))
    const adjacent =
      previous !== undefined &&
      current !== undefined &&
      previousParts !== undefined &&
      current.prefix === previousParts.prefix &&
      current.seq === previousParts.seq + 1
    if (adjacent) {
      previous.push(hit)
      continue
    }
    const score = Number.isFinite(hit._rankingScore) ? hit._rankingScore : 0
    const group = { hits: [hit], score }
    groups.push(group)
    openByLocation.set(location, group.hits)
  }
  return groups
}

/**
 * 在字符预算生效之前，一个上下文包应包含的段落。
 *
 * @param {object[]} hits - 排序后的原始命中。
 * @returns {Array<{text: string, title: string, sectionPath: string, docId: string, issuer: string, date: string, score: number, chunkIds: string[]}>} 段落列表。
 */
export function buildPassages(hits) {
  return groupHits(hits).map((group) => {
    const head = group.hits[0]
    return {
      text: group.hits.map((hit) => String(hit.text ?? '').trim()).filter((part) => part.length > 0).join('\n'),
      title: String(head.title ?? head.doc_id ?? '未命名文档'),
      sectionPath: String(head.section_path ?? ''),
      docId: String(head.doc_id ?? ''),
      issuer: String(head.issuer_short ?? ''),
      date: dateLabel(head),
      score: group.score,
      chunkIds: group.hits.map((hit) => String(hit.id ?? '')),
    }
  })
}

/**
 * 渲染单个段落的出处，用于引用。
 * @param {object} passage - 已构造的段落。
 * @returns {string} 出处那一行。
 */
export function passageLabel(passage) {
  const parts = [passage.title]
  const segments = passage.sectionPath.split('>').map((part) => part.trim()).filter((part) => part.length > 0)
  // section_path 的第一段是重复的文档标题。
  if (segments.length > 1) parts.push(segments.slice(1).join(' > '))
  const meta = [passage.issuer, passage.date].filter((value) => typeof value === 'string' && value.length > 0)
  return meta.length === 0 ? parts.join(' > ') : `${parts.join(' > ')}（${meta.join(' · ')}）`
}

/**
 * 在字符预算内把段落渲染为带编号、可引用的上下文。
 *
 * @param {object} options - 渲染选项。
 * @param {object[]} options.hits - 排序后的原始命中。
 * @param {number} options.maxChars - 渲染块的预算。
 * @returns {{text: string, sources: object[], truncated: boolean, usedChars: number}} 上下文包。
 */
export function buildContext(options) {
  const passages = buildPassages(options.hits)
  const sources = []
  const blocks = []
  let used = 0
  let truncated = false
  for (const passage of passages) {
    if (passage.text.length === 0) continue
    const block = `[${sources.length + 1}] ${passageLabel(passage)}\n${passage.text}`
    // 至少保留一个段落：预算比最好的那条命中还小时，仍须产出可用的包，而不是空包。
    if (sources.length > 0 && used + block.length > options.maxChars) {
      truncated = true
      break
    }
    sources.push({
      n: sources.length + 1,
      title: passage.title,
      sectionPath: passage.sectionPath,
      docId: passage.docId,
      issuer: passage.issuer,
      date: passage.date,
      score: Number(passage.score.toFixed(4)),
      chunkIds: passage.chunkIds,
    })
    blocks.push(block)
    used += block.length
    if (used >= options.maxChars) {
      truncated = sources.length < passages.length
      break
    }
  }
  return { text: blocks.join('\n\n'), sources, truncated, usedChars: used }
}

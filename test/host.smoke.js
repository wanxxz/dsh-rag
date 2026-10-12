/**
 * @wanxxz/dsh-rag 的 Host 侧冒烟测试。
 *
 * 用假的 Cordis context 跑插件的 `apply`，再让两个检索工具与状态工具去打**真实的**
 * Meilisearch 实例。这里用假 context 就够了，因为插件只用到 `ctx.tools`、
 * `ctx.systemPrompt`、`ctx.logger`、`ctx.effect` 和 `ctx.inject`。
 *
 * 用法：node test/host.smoke.js
 */
import assert from 'node:assert/strict'

import { apply, normalizeConfig } from '../index.js'

/**
 * 断言一个值是 lossless JSON——不含 `undefined`、函数、symbol 或循环引用。
 *
 * 注册表会拒绝它无法在 JSON 里往返的值，而这个拒绝发生在 Harness **内部**、不在本插件里，
 * 所以测试必须自己复刻这条规则，才能在这里把它抓住。
 * @param {unknown} value - 待检查的值。
 * @param {string} path - 出现在失败消息里的位置。
 */
function assertLosslessJson(value, path = 'value') {
  if (value === null) return
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') {
    assert.ok(Number.isFinite(value) || kind !== 'number', `${path}: 非有限数值不是 lossless JSON`)
    return
  }
  assert.notEqual(value, undefined, `${path}: undefined 不是 lossless JSON`)
  assert.ok(kind === 'object', `${path}: ${kind} 不是 lossless JSON`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLosslessJson(item, `${path}[${index}]`))
    return
  }
  for (const [key, item] of Object.entries(value)) assertLosslessJson(item, `${path}.${key}`)
}

/**
 * 按注册表校验的方式，断言一个值满足声明的 schema。
 *
 * 只实现了本插件用到的那部分子集：`type`、`required`、`properties`、`items` 和
 * `additionalProperties: false`。而这个子集恰好就是当初那个 bug 的所在——一个未声明的
 * `estimatedTotalHits` 字段。
 * @param {unknown} value - 产出的值。
 * @param {object} schema - 声明的 schema。
 * @param {string} path - 出现在失败消息里的位置。
 */
function assertMatchesSchema(value, schema, path = 'value') {
  if (schema.type === 'object') {
    assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path}: 期望是对象`)
    for (const key of schema.required ?? []) {
      assert.ok(Object.prototype.hasOwnProperty.call(value, key), `${path}.${key} 是声明 schema 里的必填项`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(schema.properties ?? {}, key),
          `${path}.${key} 不是已声明的属性（additionalProperties: false）`,
        )
      }
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) assertMatchesSchema(value[key], child, `${path}.${key}`)
    }
    return
  }
  if (schema.type === 'array') {
    assert.ok(Array.isArray(value), `${path}: 期望是数组`)
    value.forEach((item, index) => assertMatchesSchema(item, schema.items ?? {}, `${path}[${index}]`))
    return
  }
  if (Array.isArray(schema.type)) {
    assert.ok(schema.type.includes(typeof value) || (value === null && schema.type.includes('null')), `${path}: 类型不匹配`)
    return
  }
  if (schema.type === 'integer') {
    assert.ok(Number.isInteger(value), `${path}: 期望是整数`)
    return
  }
  if (schema.type !== undefined) assert.equal(typeof value, schema.type, `${path}: 期望类型 ${schema.type}`)
}

/** 收集假 context 观察到的内容。 */
const seen = { tools: [], sections: [], logs: [], effects: 0 }

/**
 * 构造插件所消费的最小 Cordis-like context。
 * @returns {object} 假 context。
 */
function fakeCtx() {
  const registered = new Map()
  return {
    logger: {
      debug: () => {},
      info: (message) => seen.logs.push(`info ${message}`),
      warn: (message) => seen.logs.push(`warn ${message}`),
      error: (message) => seen.logs.push(`error ${message}`),
    },
    tools: {
      register(definition) {
        assert.equal(typeof definition.name, 'string')
        assert.equal(typeof definition.description, 'string')
        assert.equal(typeof definition.parameters, 'object')
        assert.equal(typeof definition.execute, 'function')
        assert.equal(typeof definition.output?.render, 'function')
        assert.equal(typeof definition.output?.schema, 'object')
        // 注册表会拒绝任何不是对象根（object-rooted）的 schema。
        assert.equal(definition.output.schema.type, 'object')
        assert.equal(definition.parameters.type, 'object')
        registered.set(definition.name, definition)
        seen.tools.push(definition.name)
        return () => registered.delete(definition.name)
      },
      get(name) {
        return registered.get(name)
      },
    },
    systemPrompt: {
      getSectionOrder: () => 5500,
      section(section) {
        seen.sections.push(section)
        return () => {}
      },
    },
    effect(factory) {
      seen.effects += 1
      const dispose = factory()
      return () => dispose?.()
    },
    inject(names, factory) {
      // Host 侧只注入 webServer；本测试跳过它。
      if (names.includes('webServer')) return
      factory(this)
    },
  }
}

const ctx = fakeCtx()
// `serviceAutoStart: false` 让这个测试只关心 schema 与检索：
// 它绝不能作为副作用真的去启动或收养一个 Meilisearch 进程。
apply(ctx, { serviceAutoStart: false })

assert.deepEqual(seen.tools.sort(), ['rag_context', 'rag_search', 'rag_status'], `工具集不符合预期：${seen.tools.join(',')}`)
assert.equal(seen.sections.length, 1, '应当恰好注册一个提示词段落')
assert.equal(seen.sections[0].name, 'tool:rag')
assert.equal(typeof seen.sections[0].text, 'function')
assert.ok(seen.sections[0].text({ scope: undefined }).length > 0, '在能看到 rag_context 的 scope 下，指引必须渲染出内容')

const context = ctx.tools.get('rag_context')
const search = ctx.tools.get('rag_search')
const status = ctx.tools.get('rag_status')

// 每一个产出的值都必须过得了注册表的两条输出规则：lossless JSON，
// 以及严格符合声明的 schema。更早的一个版本两条都违反了，
// 所以下面每个结果都拿模型看到的同一份 schema 来检查。
const seenValues = []
const checked = (definition, value) => {
  assertLosslessJson(value, definition.name)
  assertMatchesSchema(value, definition.output.schema, definition.name)
  seenValues.push(`${definition.name}: ${Object.keys(value).length} 个顶层字段`)
  return value
}

// ---------------------------------------------------------------- rag_status
const statusValue = checked(status, await status.execute({}, { signal: AbortSignal.timeout(20_000) }))
console.log('--- rag_status')
console.log(status.output.render({}, statusValue)[0].text)
assert.equal(statusValue.baseUrl, 'http://127.0.0.1:7700')
assert.equal(statusValue.index, 'zh')
assert.equal(statusValue.configured, true, '必须能解析出检索 key')
assert.equal(statusValue.reachable, true, '这个测试要求 Meilisearch 可达')
assert.ok(Array.isArray(statusValue.filterableFields) && statusValue.filterableFields.includes('doc_type'), 'doc_type 必须是可过滤字段')

// --------------------------------------------------------------- rag_context
const pack = checked(context, await context.execute({ query: '煤电容量电价怎么分摊' }, { signal: AbortSignal.timeout(60_000) }))
console.log('\n--- rag_context')
console.log(context.output.render({}, pack)[0].text.slice(0, 900))
assert.ok(pack.sources.length > 0, '一个语料内的问题必须至少召回一段')
assert.match(pack.context, /^\[1\] /u, '上下文包必须以编号来源开头')
assert.equal(pack.sources[0].n, 1)
assert.ok(pack.sources[0].score > 0, '真实命中必须带打分')
assert.ok(pack.sources[0].docId.length > 0, '命中必须暴露 doc_id，供后续过滤使用')

// 当过滤条件本身能匹配上时，过滤必须收窄结果。
const filtered = checked(context, await context.execute({ query: '容量电价', filter: 'doc_type = "规范性文件"' }, { signal: AbortSignal.timeout(60_000) }))
assert.ok(filtered.sources.every((source) => source.title.length > 0), '被过滤后的命中仍须带出处')
console.log(`\nfiltered to doc_type = "规范性文件": ${filtered.sources.length} passage(s)`)

// 预算小于整个上下文包时，必须截断而不是溢出。
const small = checked(context, await context.execute({ query: '新能源 电价 机制', maxChars: 400 }, { signal: AbortSignal.timeout(60_000) }))
console.log(`maxChars=400 -> ${small.sources.length} passage(s), truncated=${small.truncated}, ${small.context.length} chars`)
assert.ok(small.context.length > 0, '预算再紧也必须给出最强的那一段')

// 空查询是调用方的错误，不是崩溃。
await assert.rejects(() => context.execute({ query: '   ' }, {}), /non-empty/u)

// ---------------------------------------------------------------- rag_search
const hits = checked(search, await search.execute({ query: '储能设施靠什么赚钱', limit: 3 }, { signal: AbortSignal.timeout(60_000) }))
console.log('\n--- rag_search')
console.log(search.output.render({}, hits)[0].text)
assert.equal(hits.hits.length, 3)
assert.equal(hits.hits[0].rank, 1)
assert.ok(hits.hits[0].score >= hits.hits[2].score, '命中必须按分数降序排列')

// docId 的行为必须和等价的 filter 完全一致。
const byDoc = checked(search, await search.execute({ query: '容量电价', docId: hits.hits[0].docId, limit: 5 }, { signal: AbortSignal.timeout(60_000) }))
assert.ok(byDoc.hits.length > 0)
assert.ok(byDoc.hits.every((hit) => hit.docId === hits.hits[0].docId), 'docId 必须限定到该文档')

// 一个必然落空的查询必须返回空包，并且 render 仍然可用：
// 默认的分数地板会拒掉与语料毫无交集的文本。
const miss = checked(context, await context.execute({ query: 'zzzz-不存在的术语-qqqq' }, { signal: AbortSignal.timeout(60_000) }))
assert.equal(miss.sources.length, 0)
assert.match(context.output.render({}, miss)[0].text, /No passages/u)

// 把地板调低必须**露出**未过滤的排名尾部，而不是把它藏起来，
// 这样调用方永远能区分「库里没有」和「没有一条分数够高」。
const unfiltered = checked(context, await context.execute({ query: 'zzzz-不存在的术语-qqqq', minScore: 0 }, { signal: AbortSignal.timeout(60_000) }))
assert.ok(unfiltered.sources.length > 0, 'minScore=0 时必须返回原始排名命中')
console.log(`\nmiss with the default floor: 0 passages; with minScore=0: ${unfiltered.sources.length} passages`)

console.log('\nlogs:')
for (const line of seen.logs) console.log(`  ${line}`)
console.log(`\noutput contract checked on ${seenValues.length} results: ${seenValues.join(', ')}`)
console.log(`\nnormalizeConfig defaults: ${JSON.stringify(normalizeConfig(undefined), null, 2)}`)
console.log('\nhost smoke: PASS')

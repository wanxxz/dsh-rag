/**
 * 拿 DSH **自己**的注册表实现来校验 schema 契约的测试。
 *
 * `@deepseek-ai/dsh-tools` 就是 Harness 内部校验每个工具返回值的那份代码：它转换声明的 schema、
 * 拒绝它无法执行的 schema 形状、并校验返回值。在冒烟测试里复刻这套规则（`host.smoke.js` 就是
 * 故意这么做，为了在哪儿都能跑）终究只能是个近似——所以这个测试直接导入**真实实现**，把插件的
 * 声明与产出都过一遍。
 *
 * `test/dshtools/` 是这个包连同其依赖闭包的一次性副本，从已安装的应用里抽出来的。缺失时重建：
 *
 *   # 见 plugins/dsh-rag/README.md → "Validating against the registry"
 *   node <extract script> ...
 *
 * 副本不存在时，本测试会**跳过**并打印明确指引。
 *
 * 用法：node test/registry.contract.js
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildToolDefinitions, normalizeConfig } from '../index.js'
import { MeiliClient } from '../lib/meili.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REGISTRY_ENTRY = path.join(HERE, 'dshtools', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')

if (!fs.existsSync(REGISTRY_ENTRY)) {
  console.log(`registry.contract: SKIP — the extracted registry is not present at\n  ${REGISTRY_ENTRY}\nRe-extract it before relying on this test (see the module header).`)
  process.exit(0)
}

const registry = await import(pathToFileURL(REGISTRY_ENTRY).href)
const { assertObjectJsonSchema, assertSupportedJsonSchema, defineTool, parameterSchemaSpecToJsonSchema, valueSchemaSpecToJsonSchema, validateJsonSchemaValue } = registry

/**
 * 把一个原始 JSON Schema 节点转换成注册表面向作者的**值 DSL**。
 *
 * 两者是刻意不同的：原始 schema 用一个 `required` **数组**列出名字，而值 DSL 是在每个属性上
 * 标 `required: true`。`defineTool` 编译的是 DSL，所以喂给它原始 schema 会报
 * "schema.required is not supported by the value schema DSL"——这个区别正是这样实测发现的。
 *
 * @param {object} node - 一个原始 schema 节点。
 * @returns {object} 等价的 value-DSL 规格。
 */
function toValueSpec(node) {
  const spec = { type: node.type }
  if (node.description !== undefined) spec.description = node.description
  if (node.enum !== undefined) spec.enum = node.enum
  if (node.type === 'array' && node.items !== undefined) spec.items = toValueSpec(node.items)
  if (node.type === 'object' && node.properties !== undefined) {
    // 注册表要求显式声明 `additionalProperties`，所以这里照搬节点自己的声明，而不是替它假设。
    spec.additionalProperties = node.additionalProperties === true
    const required = new Set(node.required ?? [])
    spec.properties = Object.fromEntries(
      Object.entries(node.properties).map(([name, child]) => {
        const converted = toValueSpec(child)
        if (required.has(name)) converted.required = true
        return [name, converted]
      }),
    )
  }
  return spec
}

/**
 * 把一个原始的对象根参数 schema 转换成注册表的**参数映射 DSL**。
 *
 * `parameters` 是一张「名字 → 规格」的映射，**不是一个 schema 节点**：
 * `parameterSchemaSpecToJsonSchema` 会拒绝带 `type` 的节点，报
 * "parameters.type must be a value schema object"。
 *
 * @param {object} node - 插件的 `parameters` 节点。
 * @returns {object} 等价的参数映射 DSL。
 */
function toParameterSpec(node) {
  const required = new Set(node.required ?? [])
  return Object.fromEntries(
    Object.entries(node.properties ?? {}).map(([name, child]) => {
      const converted = toValueSpec(child)
      if (required.has(name)) converted.required = true
      return [name, converted]
    }),
  )
}

// 用一把真实 key，工具才能真的检索；这里的重点是把**真实**结果喂给注册表，
// 而不是喂它可能在实际中根本不接受的 fixture。路径按插件自己的数据根规则推导、
// 不写死，所以搬数据或改数据根不会让这个测试悄悄退化成空跑。
const dataRoot =
  process.env.DSH_RAG_DATA_ROOT ??
  path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'plugins', '@wanxxz', 'dsh-rag')
const keyPath = path.resolve(dataRoot, 'corpus', 'keys', 'search-key.txt')
assert.ok(fs.existsSync(keyPath), `检索 key 缺失于 ${keyPath}；否则检索相关的检查会变成空跑`)
const config = normalizeConfig({ apiKey: fs.readFileSync(keyPath, 'utf8').trim() })
// 一个占位的生命周期对象：这个测试只关心 schema 与检索，
// 绝不能真的去启动或收养一个 Meilisearch 进程。
const lifecycle = { snapshot: () => ({ managed: false, state: 'external' }) }
const { ragContext, ragSearch, ragStatus } = buildToolDefinitions(config, () => ({ key: config.apiKey, source: 'test' }), lifecycle)

const definitions = [ragContext, ragSearch, ragStatus]
const checks = []

for (const definition of definitions) {
  // 1. 注册表必须接受声明的参数 schema。
  assert.doesNotThrow(() => assertObjectJsonSchema(definition.parameters), `${definition.name}: parameters 必须是对象根且受支持的 schema`)
  // 2. 注册表必须接受声明的输出 schema。
  assert.doesNotThrow(() => assertObjectJsonSchema(definition.output.schema), `${definition.name}: output.schema 必须是对象根且受支持的 schema`)
  // 3. 这些声明必须过得了注册表自己的编译器：`defineTool` 会把作者 DSL 编译成
  //    插件那份原始 schema 所用的同一套线上形式，并产出注册表在调用时执行的校验器。
  const asTool = defineTool({
    name: definition.name,
    description: definition.description,
    parameters: toParameterSpec(definition.parameters),
    output: { schema: toValueSpec(definition.output.schema), render: definition.output.render },
    execute: definition.execute,
  })
  assert.equal(asTool.name, definition.name)
  // 编译出的参数 schema 必须仍然描述同一个工具。
  assert.deepEqual(
    asTool.parameters.properties !== undefined ? Object.keys(asTool.parameters.properties).sort() : [],
    Object.keys(definition.parameters.properties ?? {}).sort(),
    `${definition.name}: DSL 往返之后必须保持相同的参数名`,
  )
  // 输出 schema 必须是对象根——注册表拒绝其他任何形状。
  assert.equal(asTool.output.schema.type, 'object')
  checks.push(`${definition.name}: parameters + output.schema compiled by the registry`)
}

// 注册表无法执行的 schema 必须被拒绝——这证明上面那些断言是有意义的，而不是空跑。
assert.throws(() => assertObjectJsonSchema({ type: 'array', items: { type: 'string' } }), /object/iu)
assert.throws(() => assertSupportedJsonSchema({ type: 'object', properties: { x: { type: 'string', pattern: '^a$' } } }), /pattern|unsupported/iu)

// execute() 的返回值必须过得了注册表**自己的**校验器——
// 当初那个 `estimatedTotalHits` bug 就是这样被抓出来的。
const cases = [
  [ragContext, { query: '煤电容量电价怎么分摊' }],
  [ragContext, { query: '储能设施靠什么赚钱', limit: 3, maxChars: 1200 }],
  [ragContext, { query: 'zzzz-不存在的术语-qqqq' }],
  [ragSearch, { query: '绿证 交易', limit: 4 }],
  [ragStatus, {}],
]
for (const [definition, args] of cases) {
  const wire = parameterSchemaSpecToJsonSchema(toParameterSpec(definition.parameters))
  const violations = validateJsonSchemaValue(wire, args, '')
  assert.deepEqual(violations, [], `${definition.name}: 注册表拒绝了这些参数：${JSON.stringify(violations)}`)
  const value = await definition.execute(args, {})
  const outputViolations = validateJsonSchemaValue(definition.output.schema, value, '')
  assert.deepEqual(
    outputViolations,
    [],
    `${definition.name}(${JSON.stringify(args)}) 返回了声明的 schema 所拒绝的值：${JSON.stringify(outputViolations)}`,
  )
  checks.push(`${definition.name}(${JSON.stringify(args)}): result satisfies output.schema`)
}

// 注册表的值 DSL 是**逐属性**标记 required 的；在那个位置放一个 `required` 数组会被拒绝。
// 把这条拒绝也断言下来，才不会让这个测试当初发现的那个区别悄悄回归。
assert.throws(
  () => valueSchemaSpecToJsonSchema({ type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer' } } }),
  /required is not supported/iu,
)
// 没有显式 `additionalProperties` 的 object 同样会被拒绝。
assert.throws(
  () => valueSchemaSpecToJsonSchema({ type: 'object', properties: { a: { type: 'integer' } } }),
  /additionalProperties/iu,
)
// ……而同一个 object 按 DSL 想要的写法表达则被接受。
const dslObject = valueSchemaSpecToJsonSchema({
  type: 'object',
  additionalProperties: false,
  properties: { a: { type: 'integer', required: true } },
})
assert.equal(dslObject.type, 'object')
assert.equal(dslObject.additionalProperties, false)
assert.deepEqual(dslObject.required, ['a'], '编译出的线上 schema 必须列出必填名')
checks.push('value DSL: per-property `required` compiles, a `required` array is rejected')

// 用一把故意写错的 key 建客户端时，必须浮现出可据以行动的权限提示，
// 而不是一句原始的 HTTP 失败。
const wrongKey = new MeiliClient({ baseUrl: config.baseUrl, apiKey: 'not-a-real-key', index: config.index, timeoutMs: 8000 })
await assert.rejects(() => wrongKey.search({ q: 'x', limit: 1 }), /rejected the search key|not allowed/iu)

console.log(`registry.contract: PASS (${checks.length} checks)`)
for (const line of checks) console.log(`  ${line}`)

/**
 * 输出整形助手的单元测试。
 *
 * 这两个函数之所以存在，是因为注册表会对工具返回值做**两次**校验——先要求 lossless
 * JSON，再要求严格符合 `output.schema`——而两种失败对外都只表现为同一句不透明的
 * "returned invalid output"。直接测它们，回归时才能拿到有用的堆栈，而不是一句谜语。
 *
 * 用法：node test/output.unit.js
 */
import assert from 'node:assert/strict'

import { dropUndefined, pickDeclared } from '../lib/output.js'

// ---------------------------------------------------------------- dropUndefined
assert.deepEqual(dropUndefined({ a: 1, b: undefined, c: 'x' }), { a: 1, c: 'x' })
assert.deepEqual(dropUndefined({ nested: { keep: 1, drop: undefined } }), { nested: { keep: 1 } })
assert.deepEqual(dropUndefined({ list: [{ a: undefined, b: 2 }] }), { list: [{ b: 2 }] })
assert.deepEqual(dropUndefined({ zero: 0, empty: '', no: false, nul: null }), { zero: 0, empty: '', no: false, nul: null })
assert.equal(dropUndefined(undefined), undefined)
assert.deepEqual(dropUndefined([1, undefined, 2]), [1, undefined, 2])

// ---------------------------------------------------------------- pickDeclared
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['kept'],
  properties: {
    kept: { type: 'string' },
    optional: { type: 'string' },
    nested: {
      type: 'object',
      additionalProperties: false,
      properties: { inner: { type: 'integer' }, other: { type: 'integer' } },
    },
    list: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } },
  },
}

const projected = pickDeclared(
  { kept: 'yes', extra: 'not declared', nested: { inner: 1, other: 2, sneaky: 3 }, list: [{ a: 'x' }] },
  schema,
)
assert.deepEqual(projected, { kept: 'yes', nested: { inner: 1, other: 2 }, list: [{ a: 'x' }] }, '顶层与嵌套里未声明的键都必须被移除')

// 一个已声明但值为 `undefined` 的键必须消失，而不能以 `undefined` 的身份继续传递——
// `undefined` 在 JSON 里根本无法表示。
assert.deepEqual(pickDeclared({ kept: 'x', optional: undefined }, schema), { kept: 'x' })

// 投影不得改动它的输入，否则之后再读原始值的 renderer 会看到一个与模型收到的不同的对象。
const source = { kept: 'a', extra: 'b', nested: { inner: 1, other: 2 } }
const copy = structuredClone(source)
pickDeclared(source, schema)
assert.deepEqual(source, copy, 'pickDeclared 不得改动它的输入')

// 数组按整体走 dropUndefined，而不是逐项投影：条目 schema 声明在数组上，
// 因此顶层调用必须把它们保留下来。
const withArray = pickDeclared({ kept: 'k', list: [{ a: 'x', b: undefined }] }, schema)
assert.deepEqual(withArray, { kept: 'k', list: [{ a: 'x' }] })

console.log('output helpers: PASS')

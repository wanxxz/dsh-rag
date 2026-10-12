/**
 * 工具契约要求的输出整形助手。
 *
 * 注册表对每个工具结果做两重校验：必须是 *lossless JSON*（不含 `undefined`、函数、
 * 循环引用），并且必须**严格**符合声明的 `output.schema`——`additionalProperties:
 * false` 的 schema 连一个有用的多余字段都会拒绝。当结果由多个可选探测拼装而成时，
 * 这两条规则很容易被无意破坏，所以这两个助手把规则显式化，而不是指望每个调用点
 * 都记得它们。
 */

/**
 * 递归删除 `undefined` 属性，使值成为 lossless JSON。
 *
 * `undefined` 在 JSON 中无法表示，注册表会拒绝无法完成往返转换的值，而不是静默丢掉
 * 那个键。
 *
 * @param {unknown} value - 任意结果值。
 * @returns {unknown} 去掉 `undefined` 对象条目后的同一形状。
 */
export function dropUndefined(value) {
  if (Array.isArray(value)) return value.map((item) => dropUndefined(item))
  if (value === null || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = dropUndefined(item)
  }
  return out
}

/**
 * 只保留声明 schema 里命名的属性，丢掉未声明的。
 *
 * 另一种做法——靠人记得同步扩展对象字面量和它的 schema——正是这条流水线用一个失败
 * 调用来惩罚的漂移，所以这里把声明 schema 当作唯一事实来源。
 *
 * @param {object} value - 产出的值。
 * @param {object} schema - 对象为根的 schema，含 `properties`。
 * @returns {object} 不可能携带未声明属性的值。
 */
export function pickDeclared(value, schema) {
  const declared = schema?.properties ?? {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(declared, key)) continue
    if (item === undefined) continue
    const child = declared[key]
    if (child?.type === 'object' && child.properties !== undefined && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      out[key] = pickDeclared(item, child)
      continue
    }
    out[key] = dropUndefined(item)
  }
  return out
}

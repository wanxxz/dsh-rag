/**
 * 从已安装的 DeepSeek Harness 应用里重建 `test/dshtools/`。
 *
 * `test/registry.contract.js` 会导入 DSH **自己**的工具注册表实现
 * （`@deepseek-ai/dsh-tools`），这样插件的 schema 是由**真正会执行校验的那份代码**来验证的，
 * 而不是靠我们复刻一份规则。那份代码在应用的 `app.asar` 里，Node 无法直接从归档内导入，
 * 所以这个脚本把这个包连同它的依赖闭包一起抽到插件的测试目录里。
 *
 * 升级应用后请重新跑一次：注册表会随时间增加新的 schema 规则，新版本可能接受或拒绝
 * 旧版本放行的东西。
 *
 * 用法：
 *   node test/extract-registry.js                  # 从默认安装位置刷新
 *   node test/extract-registry.js <app.asar 路径>   # 从另一个安装位置刷新
 *
 * 它做了什么，以及为什么这里把偏移量算术直接写出来：
 * `app.asar` 是一个 Chromium "pickle" 头，后面接一个 JSON 目录，再接拼接在一起的文件体。
 * 布局是
 *
 *   [u32 pickle tag][u32 body size][u32 string length][JSON 目录…][padding]
 *   [文件体…]
 *
 * 因此第一个文件体从 `8 + bodySize` 开始。这个偏移量**算错 4 字节**——也就是漏掉
 * string-length 字段的宽度——就会把那个长度前缀粘到每个抽出的文件开头；而它的破坏很隐蔽：
 * 文本文件看着仍然像那么回事，但 `package.json` 直接解析失败。踩过这个坑，所以这里把算术
 * 明写出来，而不是藏进一个常量里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'dshtools')
const DEFAULT_ARCHIVE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
  'Programs',
  'DeepSeek Harness',
  'resources',
  'app.asar',
)
const ARCHIVE = process.argv[2] ?? DEFAULT_ARCHIVE
const UNPACKED = `${ARCHIVE}.unpacked`
/** 注册表的入口点；它 import 的一切都会随之被抽出。 */
const ROOTS = ['@deepseek-ai/dsh-tools']

if (!fs.existsSync(ARCHIVE)) {
  console.error(`app.asar not found at ${ARCHIVE}\nPass the path as the first argument.`)
  process.exit(1)
}

const fd = fs.openSync(ARCHIVE, 'r')
const head = Buffer.alloc(16)
fs.readSync(fd, head, 0, 16, 0)
const bodySize = head.readUInt32LE(4)
const jsonSize = head.readUInt32LE(12)
const headerBuf = Buffer.alloc(jsonSize)
fs.readSync(fd, headerBuf, 0, jsonSize, 16)
const header = JSON.parse(headerBuf.toString('utf8'))
const base = 8 + bodySize

const entries = []
const walk = (node, prefix) => {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const full = prefix === '' ? name : `${prefix}/${name}`
    if (value.files) walk(value, full)
    else {
      entries.push({
        path: full,
        size: Number(value.size ?? 0),
        offset: Number(value.offset ?? 0),
        unpacked: value.unpacked === true,
      })
    }
  }
}
walk(header, '')

/**
 * 读取一个条目的字节内容。
 * @param {{path: string, size: number, offset: number, unpacked: boolean}} entry - 一个 asar 条目。
 * @returns {Buffer} 该条目的字节。
 */
function readEntry(entry) {
  if (entry.unpacked) return fs.readFileSync(path.join(UNPACKED, entry.path))
  const buf = Buffer.alloc(entry.size)
  fs.readSync(fd, buf, 0, entry.size, base + entry.offset)
  return buf
}

fs.rmSync(OUT, { recursive: true, force: true })
const done = new Set()
const missing = []
const queue = [...ROOTS]
while (queue.length > 0) {
  const name = queue.shift()
  if (done.has(name)) continue
  const prefix = `dsh/node_modules/${name}/`
  const owned = entries.filter((entry) => entry.path.startsWith(prefix))
  const manifestEntry = owned.find((entry) => entry.path === `${prefix}package.json`)
  if (manifestEntry === undefined) {
    // 平台专属的可选依赖（其他 OS/arch 的构建）本来就不在这个安装里，这不是失败。
    missing.push(name)
    continue
  }
  for (const entry of owned) {
    const target = path.join(OUT, entry.path.replace(/^dsh\//u, ''))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, readEntry(entry))
  }
  done.add(name)
  const manifest = JSON.parse(readEntry(manifestEntry).toString('utf8'))
  for (const dep of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) {
    if (!done.has(dep) && !queue.includes(dep)) queue.push(dep)
  }
}
fs.closeSync(fd)

const size = [...done].reduce((total, name) => {
  const dir = path.join(OUT, 'node_modules', name)
  const walkSize = (current) =>
    fs.readdirSync(current, { withFileTypes: true }).reduce((sum, item) => {
      const full = path.join(current, item.name)
      return sum + (item.isDirectory() ? walkSize(full) : fs.statSync(full).size)
    }, 0)
  return total + (fs.existsSync(dir) ? walkSize(dir) : 0)
}, 0)

console.log(`extracted ${done.size} packages (${(size / 1024 / 1024).toFixed(2)} MB) into ${OUT}`)
console.log(`platform-specific packages skipped: ${missing.length}`)

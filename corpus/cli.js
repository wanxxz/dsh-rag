/**
 * 个人 RAG 插件的运维 CLI：一个跨平台入口，处理所有在 agent 会话之外要做的事。
 *
 * 为什么它取代了四个 shell 脚本：原先的工具链是 Windows 专属的 PowerShell，其中两个
 * 还在重复插件已经做过的事（`run-meili.ps1` 重新实现了一遍引擎启动，`warmup.ps1` 重新
 * 实现了一遍插件加载时的预热）。而且那些 `.ps1` 必须存成 UTF-8 **带 BOM**，因为
 * Windows PowerShell 5.1 会把无 BOM 的 UTF-8 脚本当 ANSI 读，**解析失败且没有任何
 * 日志**。Node 没有这个陷阱，所以这个 CLI 在插件能跑的地方都能跑。
 *
 * 子命令：
 *   status   只读体检：引擎、索引、embedder、引擎归属、插件状态路由、
 *            Meilisearch 的 MCP 路由、失败任务，以及那个会抢端口的残留 Windows 服务。
 *   warmup   发一次混合检索，把 embedding 模型压进内存。插件加载时已经做过；
 *            这个是给手动重跑用的。
 *   start    前台运行 Meilisearch（Ctrl+C 停止）。插件通常会自己启动引擎——
 *            只有在不开 DSH 时才用它。
 *   stop     终止端口上的监听者，包括它的子孙进程。
 *
 * 路径规则与插件一致：数据根 `<dsh-home>/plugins/@wanxxz/dsh-rag`，
 * 可用 `DSH_RAG_DATA_ROOT` 覆盖。
 *
 * 输出用语说明：`status` 的表格左侧标签（`engine`、`index zh`、`mcpRoute`…）刻意保留
 * 英文——它们是窄列里的键，便于 grep，也便于和文档里的中文对照表互查。给操作者看的
 * 提示与错误信息是中文。
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MeiliClient } from '../lib/meili.js'
import { addressOf, findMeilisearchBinary, probeListener } from '../lib/meilisearch-service.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BASE_URL = process.env.DSH_RAG_BASE_URL ?? 'http://127.0.0.1:7700'
const INDEX = process.env.DSH_RAG_INDEX ?? 'zh'
const EMBEDDER = process.env.DSH_RAG_EMBEDDER ?? 'zh'
const DATA_ROOT =
  process.env.DSH_RAG_DATA_ROOT ??
  path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'plugins', '@wanxxz', 'dsh-rag')
const RUNTIME = path.join(DATA_ROOT, 'runtime')
const PLUGIN_STATUS_URL = process.env.DSH_RAG_STATUS_URL ?? 'http://127.0.0.1:19387/personal-rag/status'

/**
 * 从数据根读一个密钥并去掉首尾空白。
 * @param {string} relative - 相对数据根的路径。
 * @returns {string} 读到的值；读不到时返回空字符串。
 */
function readSecret(relative) {
  try {
    return fs.readFileSync(path.join(DATA_ROOT, relative), 'utf8').trim()
  } catch {
    return ''
  }
}

/**
 * 打印一行对齐的报告。宽度要按**终端列**算：CJK 字符占两列，
 * 用 `length` 去补空格会让中文标签整体错位。
 * @param {string} label - 行标签。
 * @param {string} value - 行内容。
 */
function row(label, value) {
  const width = [...label].reduce((total, char) => total + (char.codePointAt(0) > 0x2e7f ? 2 : 1), 0)
  process.stdout.write(`  ${label}${' '.repeat(Math.max(1, 22 - width))}${value}\n`)
}

/**
 * 取 JSON；任何失败都返回 undefined，由调用方决定怎么显示。
 * @param {string} url - 完整 URL。
 * @param {object} [headers] - 额外请求头。
 * @param {number} [timeoutMs] - 单次请求超时。
 * @returns {Promise<any>} 解析后的响应体，或 undefined。
 */
async function getJson(url, headers = {}, timeoutMs = 10_000) {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return undefined
    return await response.json()
  } catch {
    return undefined
  }
}

/**
 * 报告那个会抢端口的 Windows 服务。
 *
 * 该服务注册时参数列表是空的，所以它一旦启动，就会在同一个端口上跑起一个**没有 key**
 * 的 development 实例。留着它并不算错，但操作者应该知道它存在。
 */
function reportLeftoverService() {
  if (process.platform !== 'win32') return
  const result = spawnSync('sc.exe', ['query', 'Meilisearch'], { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    row('leftover service', 'none')
    return
  }
  const state = /STATE\s*:\s*\d+\s+(\w+)/u.exec(result.stdout)?.[1] ?? 'unknown'
  row('leftover service', `${state} —— 它若被拉起会在本端口跑一个无 key 实例；清除：sc.exe delete Meilisearch`)
}

/** `status`：一眼看全的只读报告。 */
async function commandStatus() {
  const masterKey = readSecret('runtime/master-key.txt')
  const searchKey = readSecret('corpus/keys/search-key.txt')
  const key = masterKey || searchKey
  const auth = key.length > 0 ? { authorization: `Bearer ${key}` } : {}

  process.stdout.write(`\n=== 个人 RAG 状态 (${new Date().toISOString().replace('T', ' ').slice(0, 19)}) ===\n\n`)
  row('data root', DATA_ROOT)

  const { host, port } = addressOf(BASE_URL)
  const listening = await probeListener(host, port)
  const health = listening ? await getJson(`${BASE_URL}/health`) : undefined
  row('engine', health?.status === 'available' ? `OK  ${BASE_URL}` : `NOT reachable at ${BASE_URL}`)
  if (health?.status !== 'available') {
    process.stdout.write('\n  插件会在 DSH 加载时自己启动引擎。不开 DSH 时：node corpus/cli.js start\n\n')
    return
  }

  row('keys', `master ${masterKey ? 'yes' : 'no'} / search ${searchKey ? 'yes' : 'no'}`)
  const version = await getJson(`${BASE_URL}/version`, auth)
  if (version?.pkgVersion !== undefined) row('version', version.pkgVersion)

  const experimental = await getJson(`${BASE_URL}/experimental-features/`, auth)
  if (experimental !== undefined) row('mcpRoute', experimental.mcpRoute ? 'enabled' : 'disabled（MCP 工具不会出现）')

  const index = await getJson(`${BASE_URL}/indexes/${encodeURIComponent(INDEX)}/stats`, auth)
  if (index !== undefined) {
    row(`index ${INDEX}`, `${index.numberOfDocuments} docs / ${index.numberOfEmbeddings} embeddings / ${(index.indexSize / 1024 / 1024).toFixed(1)} MB`)
  } else {
    row(`index ${INDEX}`, 'unreadable（这一行需要 key 带 stats.get）')
  }
  const embedders = await getJson(`${BASE_URL}/indexes/${encodeURIComponent(INDEX)}/settings/embedders`, auth)
  if (embedders !== undefined) {
    const active = embedders[EMBEDDER]
    row('  embedder', active === undefined ? '(not configured)' : `${EMBEDDER}: ${active.source}/${active.model}`)
  }

  // 直接对 Meilisearch 自己的 MCP 路由说话，不经过任何客户端。
  const mcp = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'cli', version: '1' } } },
    }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((response) => response.json())
    .catch(() => undefined)
  row('MCP tools', mcp?.result?.tools?.map((tool) => tool.name).join(', ') ?? '(call failed)')

  const failed = await getJson(`${BASE_URL}/tasks?statuses=failed&limit=5`, auth)
  if (failed !== undefined) {
    row('failed tasks', failed.total === 0 ? 'none' : `${failed.total}`)
    for (const task of failed.results ?? []) process.stdout.write(`      uid=${task.uid} ${task.type}: ${task.error?.message ?? ''}\n`)
  }

  reportLeftoverService()

  // 插件自己的视角——它才是"agent 看到什么"的权威。
  const plugin = await getJson(PLUGIN_STATUS_URL)
  if (plugin?.value === undefined) {
    row('plugin route', 'unreachable（DSH 没在运行）')
  } else {
    const value = plugin.value
    row('plugin route', `reachable=${value.reachable} configured=${value.configured}`)
    if (value.service !== undefined) {
      row('  engine owner', `${value.service.state}  managed=${value.service.managed}  adopted=${value.service.adopted ?? false}`)
      if (value.service.warmupMs !== undefined) row('  warmup', `${(value.service.warmupMs / 1000).toFixed(1)} s`)
    }
  }

  row('runtime size', `${(directorySize(RUNTIME) / 1024 / 1024).toFixed(1)} MB`)
  process.stdout.write('\n')
}

/**
 * 统计目录总字节数。
 *
 * 在 Node 里走目录树，而不是去解析 `dir` / `du` 的输出：后者是本地化格式
 * （`2,222,019 bytes` 与 `2222019` 两种都可能），解析它纯属自找麻烦。
 *
 * @param {string} dir - 要统计的目录。
 * @returns {number} 总字节数；读不到时返回 0。
 */
function directorySize(dir) {
  let total = 0
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += directorySize(full)
    else {
      try {
        total += fs.statSync(full).size
      } catch {
        /* 遍历途中消失的文件不贡献体积 */
      }
    }
  }
  return total
}

/** `warmup`：把 embedder 压进内存，免得下一次查询拿到退化的语义结果。 */
async function commandWarmup() {
  const { host, port } = addressOf(BASE_URL)
  if (!(await probeListener(host, port))) {
    process.stderr.write(`${BASE_URL} 上没有任何东西在监听；先启动引擎\n`)
    process.exitCode = 1
    return
  }
  const key = readSecret('runtime/master-key.txt') || readSecret('corpus/keys/search-key.txt')
  const started = Date.now()
  try {
    await fetch(`${BASE_URL}/indexes/${encodeURIComponent(INDEX)}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ q: '预热', hybrid: { embedder: EMBEDDER, semanticRatio: 0.5 }, limit: 1 }),
      signal: AbortSignal.timeout(600_000),
    })
    process.stdout.write(`warmup ok in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
  } catch (error) {
    process.stderr.write(`warmup failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}

/**
 * `start`：运行引擎，参数与插件自己用的那套一致。
 *
 * `--detached` 会以 unref 方式拉起后立刻返回——脚本需要这种模式（前台的服务器会把调用方
 * 永远堵住）。不加 `--detached` 时引擎占用当前终端，Ctrl+C 即可停止。
 */
async function commandStart() {
  const detached = process.argv.includes('--detached')
  const binary = findMeilisearchBinary(process.env.DSH_RAG_MEILI_BINARY ?? '', HERE)
  if (!fs.existsSync(binary)) {
    process.stderr.write(`找不到 meilisearch 可执行文件（解析结果 "${binary}"）\n请设置 DSH_RAG_MEILI_BINARY，或把 meilisearch 加入 PATH。\n`)
    process.exitCode = 1
    return
  }
  const keyPath = path.join(RUNTIME, 'master-key.txt')
  if (!fs.existsSync(keyPath)) {
    process.stderr.write(`${keyPath} 没有 master key；拒绝以 development 模式启动 Meilisearch（那会无鉴权地对外提供索引）\n`)
    process.exitCode = 1
    return
  }
  const { host, port } = addressOf(BASE_URL)
  if (await probeListener(host, port)) {
    process.stderr.write(`${BASE_URL} 上已经有东西在监听；先停掉它（node corpus/cli.js stop）\n`)
    process.exitCode = 1
    return
  }
  const logPath = path.join(RUNTIME, 'logs', 'meili.log')
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  process.stdout.write(`starting ${binary}\n  db ${path.join(RUNTIME, 'data')}\n  url ${BASE_URL}\n`)
  const env = { ...process.env, MEILI_MASTER_KEY: fs.readFileSync(keyPath, 'utf8').trim() }
  const args = [
    '--db-path', path.join(RUNTIME, 'data'),
    '--http-addr', `${host}:${port}`,
    '--env', 'production',
    '--no-analytics',
    '--max-indexing-memory', '2GB',
    '--schedule-snapshot', '86400',
  ]

  if (detached) {
    // 子进程直接写日志文件：本进程随即退出，管道会被关掉。
    const out = fs.openSync(logPath, 'a')
    const child = spawn(binary, args, { env, detached: true, stdio: ['ignore', out, out], windowsHide: true })
    child.unref()
    process.stdout.write(`已分离为 pid ${child.pid}；输出追加到 ${logPath}\n`)
    return
  }

  process.stdout.write('按 Ctrl+C 停止。\n')
  const child = spawn(binary, args, { env, stdio: 'inherit', windowsHide: true })
  process.exitCode = await new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 0)))
}

/** `stop`：终止监听者及其子孙进程。 */
async function commandStop() {
  const { host, port } = addressOf(BASE_URL)
  if (!(await probeListener(host, port))) {
    process.stdout.write(`${BASE_URL} 上没有任何东西在监听\n`)
    return
  }
  if (process.platform === 'win32') {
    // 这里用 `netstat` 而不是 `Get-NetTCPConnection`，为的是让整个脚本保持纯 Node、
    // 不依赖 PowerShell。
    const netstat = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true })
    const line = (netstat.stdout ?? '').split('\n').find((entry) => entry.includes(`:${port} `) && entry.includes('LISTENING'))
    const pid = line?.trim().split(/\s+/u).at(-1)
    if (pid === undefined) {
      process.stderr.write(`无法确定监听 ${port} 的进程\n`)
      process.exitCode = 1
      return
    }
    const killed = spawnSync('taskkill.exe', ['/PID', pid, '/T', '/F'], { encoding: 'utf8', windowsHide: true })
    process.stdout.write(`已停止 pid ${pid}（含子孙进程）\n${killed.stdout ?? ''}`)
    return
  }
  // POSIX：用 `lsof` 找 pid，然后对整个进程组发信号。
  const lsof = spawnSync('lsof', ['-t', `-i:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  const pid = (lsof.stdout ?? '').trim().split('\n')[0]
  if (pid.length === 0) {
    process.stderr.write(`无法确定监听 ${port} 的进程\n`)
    process.exitCode = 1
    return
  }
  process.kill(-Number(pid), 'SIGTERM')
  process.stdout.write(`已停止 pid ${pid}（含其进程组）\n`)
}

const COMMANDS = { status: commandStatus, warmup: commandWarmup, start: commandStart, stop: commandStop }

const requested = process.argv[2]
const command = COMMANDS[requested]
if (command === undefined) {
  process.stderr.write(`用法：node corpus/cli.js <${Object.keys(COMMANDS).join('|')}> [--detached]\n`)
  process.exitCode = 1
} else {
  await command()
}

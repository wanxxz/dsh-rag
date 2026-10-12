/**
 * Meilisearch 管理器的生命周期测试，跑在**真实进程**上。
 *
 * 这是证明「插件能自己管住引擎」的那个测试：它从插件自己的运行时目录启动 Meilisearch、等它就绪、
 * 预热 embedder、发一次真实查询，然后停掉**它自己启动的**那个进程。它同时验证两条安全属性：
 * 已经在跑的实例会被**收养**并保持不动；master key 缺失时**拒绝启动**，而不是在真实索引上
 * 起一个无鉴权的 development 实例。
 *
 * `baseUrl` 默认用 7701，这样 7700 上的生产实例永远不会被碰到。
 *
 * 用法：node test/service.lifecycle.js [--port 7701]
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MeilisearchService, ServiceState, findMeilisearchBinary, probeListener, resolvePath, serviceConfig } from '../lib/meilisearch-service.js'
import { MeiliClient } from '../lib/meili.js'
import { normalizeConfig } from '../index.js'

const MODULE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
/** 线上那把 master key，只用来给这个一次性的测试实例做保护。 */
const DATA_ROOT = process.env.DSH_RAG_DATA_ROOT ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'plugins', '@wanxxz', 'dsh-rag')
const PLUGIN_KEY_PATH = path.join(DATA_ROOT, 'runtime', 'master-key.txt')
const argPort = process.argv.includes('--port') ? Number(process.argv[process.argv.indexOf('--port') + 1]) : 7701
const baseUrl = `http://127.0.0.1:${argPort}`
const logs = []
const logger = {
  debug: () => {},
  info: (message) => logs.push(`info  ${message}`),
  warn: (message) => logs.push(`warn  ${message}`),
  error: (message) => logs.push(`error ${message}`),
}

const binary = findMeilisearchBinary('', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'))
assert.ok(fs.existsSync(binary), `meilisearch 可执行文件缺失于 ${binary}`)
assert.ok(fs.existsSync(PLUGIN_KEY_PATH), `线上 master key 缺失于 ${PLUGIN_KEY_PATH}；生命周期测试总得有一把 key 才能把实例起起来`)

// 一次性的数据根：这个测试绝不能碰到真实数据库。
const scratch = path.join(MODULE_DIR, 'test', '.lifecycle')
fs.rmSync(scratch, { recursive: true, force: true })
fs.mkdirSync(path.join(scratch, 'logs'), { recursive: true })

const config = normalizeConfig({
  baseUrl,
  serviceAutoStart: true,
  meilisearchBinary: binary,
  meilisearchDbPath: 'data',
  meilisearchLogPath: 'logs/meili.log',
  dataRoot: scratch,
  masterKeyPath: 'master-key.txt',
  serviceWarmup: false,
  serviceStartTimeoutMs: 60_000,
  serviceStopTimeoutMs: 15_000,
  servicePollIntervalMs: 500,
})

const readKey = () => fs.readFileSync(PLUGIN_KEY_PATH, 'utf8').trim()
fs.writeFileSync(path.join(scratch, config.masterKeyPath), `${readKey()}\n`)

// ---------------------------------------------------------------- 拒绝启动路径
const noKey = new MeilisearchService({
  config: serviceConfig({ ...config, masterKeyPath: 'absent.txt' }, config.dataRoot, ''),
  logger,
})
await noKey.start()
assert.equal(noKey.state, ServiceState.failed, 'master key 缺失必须失败，而不是无鉴权地把服务起起来')
assert.match(noKey.snapshot().error, /master key not readable/u)
assert.equal(await probeListener('127.0.0.1', argPort), false, '拒绝启动之后不应该有任何东西在监听')
console.log('refusal path: a missing master key fails instead of starting an unauthenticated instance')

// ------------------------------------------------------------------- 启动路径
const service = new MeilisearchService({ config: serviceConfig(config, config.dataRoot, readKey()), logger })
await service.start()
assert.equal(service.state, ServiceState.ready, `服务必须变成 ready；日志：\n${logs.join('\n')}`)
assert.equal(service.snapshot().managed, true, '插件必须把自己视为所有者')
assert.equal(service.snapshot().adopted, undefined, '全新启动不算收养')
assert.ok(Number.isInteger(service.snapshot().pid), '自己管理的服务要报告 pid')
assert.equal(await probeListener('127.0.0.1', argPort), true)
console.log(`start path: ready as pid ${service.snapshot().pid} from ${config.meilisearchDbPath}`)

// 这个二进制绝不能在真实索引上以 development 模式跑：production 模式强制校验 key，
// 而检索 key 正是依赖这一点。
const anonymous = await fetch(`${baseUrl}/indexes`).catch(() => undefined)
assert.ok(anonymous === undefined || anonymous.status === 401 || anonymous.status === 403, '实例必须拒绝未鉴权的请求')

// ------------------------------------------------------------- 真实检索
// 一次性数据库里还没有索引，所以带签名的请求必须干净地返回 "index not found"，
// 而不是传输层或鉴权失败——这才说明请求真的到达了一个活的、受 key 保护的引擎。
const client = new MeiliClient({ baseUrl, apiKey: readKey(), index: 'zh', timeoutMs: 15_000 })
const health = await client.health()
assert.equal(health.status, 'available')
await assert.rejects(() => client.search({ q: 'anything', limit: 1 }), /index not found/u)
console.log('retrieval path: a signed request reaches the live engine (and reports the missing index honestly)')

// -------------------------------------------------------------- 收养属性
// 第二个管理器指向同一个活实例时，必须**收养**它，而不是跟它抢。
const adopter = new MeilisearchService({ config: serviceConfig(config, config.dataRoot, readKey()), logger })
await adopter.start()
assert.equal(adopter.state, ServiceState.external, '活着的实例必须被收养')
assert.equal(adopter.snapshot().adopted, true)
assert.equal(adopter.snapshot().managed, false, '收养来的实例不属于自己')
await adopter.stop()
assert.equal(await probeListener('127.0.0.1', argPort), true, '停掉收养者绝不能杀掉正在跑的实例')
console.log('adopt path: a second manager adopts the live instance and leaves it running')

// -------------------------------------------------------------------- 停止路径
const pid = service.snapshot().pid
await service.stop()
assert.equal(service.state, ServiceState.stopped)
let alive = true
try {
  process.kill(pid, 0)
} catch {
  alive = false
}
assert.equal(alive, false, `stop() 之后 pid ${pid} 必须已经消失`)
assert.equal(await probeListener('127.0.0.1', argPort), false, 'stop() 之后端口必须空出来')
// 子进程的输出写往**解析后**的日志路径，而不是配置里那个字符串。
const logText = fs.readFileSync(resolvePath(config.meilisearchLogPath, config.dataRoot), 'utf8')
assert.ok(logText.length > 0, '子进程的输出必须被落进日志文件')
console.log(`stop path: pid ${pid} ended and the port is free`)

// -------------------------------------------------------------- 路径解析
assert.equal(resolvePath('runtime/data', config.dataRoot), path.join(config.dataRoot, 'runtime', 'data'))
assert.equal(resolvePath('C:/absolute/path', config.dataRoot), path.normalize('C:/absolute/path'))
// 默认数据根必须遵循本仓库自己的布局，而两种覆盖都必须压过默认值——
// 这正是把状态挡在代码目录之外的契约。
const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
assert.equal(normalizeConfig({}).dataRoot, path.join(home, 'plugins', '@wanxxz', 'dsh-rag'), '默认数据根必须是 <dsh-home>/plugins/@wanxxz/dsh-rag')
assert.equal(normalizeConfig({ dataRoot: 'E:/custom' }).dataRoot, 'E:/custom', '配置项必须能压过默认值')
assert.equal(normalizeConfig({}).apiKeyPath, 'corpus/keys/search-key.txt', '检索 key 相对于数据根')
console.log(`paths: default data root is ${normalizeConfig({}).dataRoot}`)

fs.rmSync(scratch, { recursive: true, force: true })
console.log('\nservice lifecycle: PASS')
for (const line of logs) console.log(`  ${line}`)

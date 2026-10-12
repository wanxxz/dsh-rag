/**
 * 个人 RAG 插件的 Meilisearch 进程生命周期。
 *
 * 插件自己拥有检索引擎：当端口上还没有人监听时，它用插件自己的运行时目录启动
 * Meilisearch；等待实例能够应答；预热 embedding 模型，使第一个真实问题不会退化；
 * 并在插件被卸载时关掉该进程。
 *
 * 有两条性质比顺利路径更重要：
 *
 * - **收养，而不是假定。** 如果端口上已有东西在应答，就让它继续运行、绝不去碰它。
 *   同端口上的第二个 Meilisearch 会绑定失败，而杀掉一个不是本插件启动的进程，
 *   比什么都不做更糟。
 * - **启动失败绝不静默。** 绑定失败、二进制缺失、就绪超时，每一种都会在状态工具与
 *   HTTP 路由所报告的 snapshot 上产出一条消息，因为在那种情况下 Meilisearch 不会往
 *   stdout 写任何有用的东西。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/** 管理器认为服务处于什么状态。 */
export const ServiceState = {
  disabled: 'disabled',
  starting: 'starting',
  ready: 'ready',
  failed: 'failed',
  external: 'external',
  stopped: 'stopped',
}

/** 为诊断保留的子进程输出字节数。 */
const OUTPUT_BUFFER_BYTES = 16 * 1024

/**
 * 探测某 host/port 上是否有东西接受 TCP 连接。
 *
 * 用 TCP 探测而不是 HTTP：这里要防的风险是绑定失败，而一个不说 HTTP 的监听者，恰恰
 * 就是“再启动一个实例属于错误”的那种情况。
 *
 * @param {string} host - 要探测的 host。
 * @param {number} port - 要探测的 port。
 * @param {number} [timeoutMs] - 连接超时。
 * @returns {Promise<boolean>} 有东西在监听时为 true。
 */
export function probeListener(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false
    const finish = (listening) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/**
 * 把 base URL 拆成探测所需的 host 与 port。
 * @param {string} baseUrl - 例如 `http://127.0.0.1:7700`。
 * @returns {{host: string, port: number}} 解析出的地址。
 */
export function addressOf(baseUrl) {
  const url = new URL(baseUrl)
  return { host: url.hostname === 'localhost' ? '127.0.0.1' : url.hostname, port: Number(url.port.length > 0 ? url.port : url.protocol === 'https:' ? 443 : 80) }
}

/**
 * 把配置的路径解析到某个基准目录之下。
 *
 * 相对路径是相对插件的**数据根**（而不是它的代码目录）解析的，因此默认配置把所有持久
 * 化产物——数据库、日志、两把 key——都放在同一个可搬移的目录下。
 *
 * @param {string} value - 配置的路径。
 * @param {string} baseDir - 数据根，用于解析相对路径。
 * @returns {string} 绝对路径。
 */
export function resolvePath(value, baseDir) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value)
}

/** 覆盖 Meilisearch 二进制查找位置的环境变量。 */
export const BINARY_ENV_VAR = 'DSH_RAG_MEILI_BINARY'

/** 未显式配置二进制路径时，在 `PATH` 上查找的命令名。 */
const BINARY_COMMAND = 'meilisearch'

/** 平台默认安装位置，在 `PATH` 之后尝试。 */
const BINARY_FALLBACKS = {
  win32: [
    'C:/ProgramData/chocolatey/bin/meilisearch.exe',
    'C:/Program Files/Meilisearch/meilisearch.exe',
  ],
  darwin: ['/opt/homebrew/bin/meilisearch', '/usr/local/bin/meilisearch'],
  linux: ['/usr/local/bin/meilisearch', '/usr/bin/meilisearch'],
}

/**
 * 查找 Meilisearch 可执行文件，且不写死任何人的家目录。
 *
 * 解析顺序，从最具体到最宽泛：显式的 `configured` 路径（绝对路径，或相对数据根的
 * 路径）、`${BINARY_ENV_VAR}`、`PATH`，最后是平台默认安装位置。`configured` 即该行
 * 的 `meilisearchBinary` 配置项所提供的内容，而它自身的默认值是空字符串——因此一份
 * checkout 不携带任何作者专属路径，而部署方通过配置或环境变量指向自己的安装位置。
 *
 * @param {string} configured - 配置的路径，或空字符串。
 * @param {string} baseDir - 数据根，用于解析相对的 `configured` 路径。
 * @returns {string} 绝对路径；什么都没找到时返回裸命令名。
 *   返回裸命令名而不是抛错，是为了让“二进制缺失”表现为一次**被报告的启动失败**
 *   （见 `MeilisearchService.start`），而不是会把插件拖垮的加载期失败。
 */
export function findMeilisearchBinary(configured, baseDir) {
  const explicit = typeof configured === 'string' ? configured.trim() : ''
  if (explicit.length > 0) return resolvePath(explicit, baseDir)

  const fromEnv = process.env[BINARY_ENV_VAR]
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return path.normalize(fromEnv.trim())

  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry.length > 0)
  const names = process.platform === 'win32' ? [`${BINARY_COMMAND}.exe`, BINARY_COMMAND] : [BINARY_COMMAND]
  for (const entry of pathEntries) {
    for (const name of names) {
      const candidate = path.join(entry, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* 不在这里；继续找 */
      }
    }
  }

  for (const candidate of BINARY_FALLBACKS[process.platform] ?? []) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* 不在这里；继续找 */
    }
  }
  return BINARY_COMMAND
}

/** 在插件的整个生命周期内拥有一个 Meilisearch 进程。 */
export class MeilisearchService {
  /**
   * @param {object} options - 接线参数。
   * @param {object} options.config - 已解析的服务配置。
   * @param {object} options.logger - `{ info, warn, debug }`。
   * @param {(url: string, init?: object) => Promise<unknown>} [options.fetchImpl] - 可注入，供测试使用。
   */
  constructor(options) {
    this.config = options.config
    this.logger = options.logger
    this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init))
    this.child = null
    this.adopted = false
    this.warmupMs = undefined
    this.errorText = undefined
    this.buffer = ''
    this.stopping = false
    /** @type {'disabled'|'starting'|'ready'|'failed'|'external'|'stopped'} */
    this.state = options.config.autoStart ? ServiceState.starting : ServiceState.disabled
  }

  /** 由 `rag_status` 与状态路由报告的、可直接 JSON 化的视图。 */
  snapshot() {
    return {
      managed: this.child !== null,
      state: this.state,
      ...(this.child?.pid === undefined ? {} : { pid: this.child.pid }),
      ...(this.adopted ? { adopted: true } : {}),
      binaryPath: this.config.binaryPath,
      dbPath: this.config.dbPath,
      logPath: this.config.logPath,
      ...(this.warmupMs === undefined ? {} : { warmupMs: Math.round(this.warmupMs) }),
      ...(this.errorText === undefined ? {} : { error: this.errorText }),
    }
  }

  /** 子进程输出的末尾若干行，用于给出真正有信息量的失败消息。 */
  outputTail() {
    return this.buffer.trim().split('\n').slice(-4).join(' | ')
  }

  /**
   * 需要时启动引擎，并等待它能够应答。
   * @returns {Promise<void>} 服务就绪或已失败时 resolve；它永不 reject。
   */
  async start() {
    if (!this.config.autoStart) {
      this.state = ServiceState.disabled
      return
    }
    const { host, port } = addressOf(this.config.baseUrl)
    if (await probeListener(host, port)) {
      // 已经有东西在这个端口上提供服务。收养它，并且永不停掉它。
      this.adopted = true
      this.state = ServiceState.external
      this.logger.info(`rag: Meilisearch already listening on ${host}:${port}; adopting the running instance (it will not be stopped)`)
      return
    }
    if (!fs.existsSync(this.config.binaryPath)) {
      this.state = ServiceState.failed
      this.errorText = `meilisearch binary not found at ${this.config.binaryPath}`
      this.logger.warn(`rag: ${this.errorText}; retrieval will fail until the service is started another way`)
      return
    }

    fs.mkdirSync(this.config.dbPath, { recursive: true })
    fs.mkdirSync(path.dirname(this.config.logPath), { recursive: true })
    const env = { ...process.env }
    const key = this.readMasterKey()
    if (key === undefined) {
      this.state = ServiceState.failed
      this.errorText = `master key not readable at ${this.config.masterKeyPath}; refusing to start Meilisearch in development mode (it would serve the real index with no authentication)`
      this.logger.warn(`rag: ${this.errorText}`)
      return
    }
    env.MEILI_MASTER_KEY = key

    const args = [
      '--db-path', this.config.dbPath,
      '--http-addr', `${host}:${port}`,
      '--env', 'production',
      '--no-analytics',
      ...(this.config.maxIndexingMemory === undefined ? [] : ['--max-indexing-memory', this.config.maxIndexingMemory]),
      ...(this.config.scheduleSnapshot === undefined ? [] : ['--schedule-snapshot', String(this.config.scheduleSnapshot)]),
    ]
    this.logger.info(`rag: starting Meilisearch (${this.config.binaryPath}) on ${host}:${port}, db ${this.config.dbPath}`)
    try {
      this.child = spawn(this.config.binaryPath, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      this.state = ServiceState.failed
      this.errorText = `could not spawn Meilisearch: ${error instanceof Error ? error.message : String(error)}`
      this.logger.warn(`rag: ${this.errorText}`)
      return
    }

    const collect = (chunk) => {
      this.buffer = `${this.buffer}${chunk.toString('utf8')}`.slice(-OUTPUT_BUFFER_BYTES)
      try {
        fs.appendFileSync(this.config.logPath, chunk)
      } catch {
        /* 写日志是尽力而为；子进程输出仍保留在内存缓冲区里 */
      }
    }
    this.child.stdout?.on('data', collect)
    this.child.stderr?.on('data', collect)
    this.child.once('error', (error) => {
      this.state = ServiceState.failed
      this.errorText = `Meilisearch process error: ${error.message}`
      this.logger.warn(`rag: ${this.errorText}`)
    })
    this.child.once('exit', (code, signal) => {
      const wasStopping = this.stopping
      this.child = null
      if (wasStopping) {
        this.state = ServiceState.stopped
        return
      }
      this.state = ServiceState.failed
      const tail = this.outputTail()
      this.errorText = `Meilisearch exited unexpectedly (code ${code ?? 'null'}${signal === null ? '' : `, signal ${signal}`})${tail.length === 0 ? '' : `: ${tail}`}`
      this.logger.warn(`rag: ${this.errorText}`)
    })

    const ready = await this.waitUntilReady()
    if (!ready) {
      if (this.state !== ServiceState.failed) {
        this.state = ServiceState.failed
        const tail = this.outputTail()
        this.errorText = `Meilisearch did not become ready within ${this.config.startTimeoutMs} ms${tail.length === 0 ? '' : `: ${tail}`}`
      }
      this.logger.warn(`rag: ${this.errorText}`)
      return
    }
    this.state = ServiceState.ready
    this.logger.info('rag: Meilisearch is ready')

    if (this.config.warmup) await this.warmup()
  }

  /**
   * 轮询 health 端点，直到实例能够应答或超过截止时间。
   * @returns {Promise<boolean>} 实例是否已就绪。
   */
  async waitUntilReady() {
    const deadline = Date.now() + this.config.startTimeoutMs
    while (Date.now() < deadline) {
      // 已经退出的进程不可能再就绪；停止轮询，让退出处理器写下的那条消息成为被报告的
      // 那一条。
      if (this.child === null) return false
      try {
        const response = await this.fetchImpl(`${this.config.baseUrl}/health`, { signal: AbortSignal.timeout(3000) })
        const body = await response.json()
        if (body?.status === 'available') return true
      } catch {
        /* 还没起来 */
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs))
    }
    return false
  }

  /**
   * 用一次 hybrid 查询把 embedding 模型压进内存。
   *
   * Meilisearch 一秒内就能启动，但 embedder 是首次使用时才惰性加载的（bge-m3 约
   * 50 秒）。没有这一步，启动后的第一个问题会拿到退化的语义结果——此前实测为
   * top1 0.91 对 1.00。
   *
   * @returns {Promise<void>} 无论成功与否，尝试结束后 resolve。
   */
  async warmup() {
    const key = this.readMasterKey() ?? this.config.searchKey
    const started = Date.now()
    try {
      await this.fetchImpl(`${this.config.baseUrl}/indexes/${encodeURIComponent(this.config.index)}/search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key ?? ''}`, 'content-type': 'application/json' },
        body: JSON.stringify({ q: '预热', hybrid: { embedder: this.config.embedder, semanticRatio: 0.5 }, limit: 1 }),
        signal: AbortSignal.timeout(this.config.warmupTimeoutMs),
      })
      this.warmupMs = Date.now() - started
      this.logger.info(`rag: embedder warmed in ${(this.warmupMs / 1000).toFixed(1)}s`)
    } catch (error) {
      // 预热失败不等于服务失败：模型仍然会在第一个真实查询时加载，只是更晚。
      this.logger.warn(`rag: warmup query failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * 读取用于启动 Meilisearch 的 master key。
   * @returns {string | undefined} 该 key；读不到时返回 undefined。
   */
  readMasterKey() {
    if (typeof this.config.masterKey === 'string' && this.config.masterKey.length > 0) return this.config.masterKey
    try {
      const key = fs.readFileSync(this.config.masterKeyPath, 'utf8').trim()
      return key.length === 0 ? undefined : key
    } catch {
      return undefined
    }
  }

  /**
   * 停掉由本插件启动的那个进程。
   *
   * 被收养的实例绝不触碰，不是本插件 spawn 出来的进程绝不杀掉。
   * @returns {Promise<void>} 进程已消失、或等待超时后 resolve。
   */
  async stop() {
    if (this.adopted || this.child === null) {
      if (this.adopted) this.logger.info('rag: leaving the adopted Meilisearch instance running')
      return
    }
    const child = this.child
    this.stopping = true
    this.logger.info(`rag: stopping Meilisearch (pid ${child.pid})`)

    // 终止整棵进程树，而不只是直接子进程。
    //
    // 配置的二进制往往是个**转发器**而不是引擎本身：scoop 的
    // `shims/meilisearch.exe`（以及类似的 shim/wrapper）会把真实可执行文件作为
    // **孙进程**启动，而自己保持存活。只杀掉直接子进程会让引擎变成孤儿：仍然占着
    // 端口，而且再没有任何东西持有能停掉它的句柄。`taskkill /T` 是 Windows 上掀掉
    // 整棵树的原生命令；在其他平台上改为向进程组发信号。
    const killed = await this.killTree(child)
    if (!killed) this.logger.warn('rag: Meilisearch did not exit cleanly; forcing termination')

    // 等端口真正释放，而不是假设它释放了：否则调用方“停掉服务后立刻再起一个实例”
    // 就会与监听器的拆除过程竞争。
    const { host, port } = addressOf(this.config.baseUrl)
    const deadline = Date.now() + this.config.stopTimeoutMs
    while (Date.now() < deadline && (await probeListener(host, port, 300))) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    if (await probeListener(host, port, 300)) {
      this.logger.warn(`rag: something is still listening on ${host}:${port} after stop()`)
    }

    this.child = null
    this.state = ServiceState.stopped
  }

  /**
   * 终止一棵已 spawn 的进程树；若它不肯安静退出则升级手段。
   *
   * @param {import('node:child_process').ChildProcess} child - 已 spawn 的进程。
   * @returns {Promise<boolean>} 整棵树是否已消失。
   */
  async killTree(child) {
    const exited = new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(true)
        return
      }
      const timer = setTimeout(() => resolve(false), this.config.stopTimeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })

    if (process.platform === 'win32' && child.pid !== undefined) {
      // `/T` 包含后代进程，`/F` 跳过温和请求（一个没有控制台可接收 CTRL_C 的控制台
      // 程序不会理睬软杀）。
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } catch {
        try {
          child.kill()
        } catch {
          /* 已经没了 */
        }
      }
    } else {
      try {
        // 负数 pid 会给整个进程组发信号，这也是 POSIX 上 spawn 时要把子进程设为
        // detached 的原因。
        process.kill(-child.pid, 'SIGTERM')
      } catch {
        try {
          child.kill()
        } catch {
          /* 已经没了 */
        }
      }
    }

    if (await exited) return true
    try {
      child.kill('SIGKILL')
    } catch {
      /* 已经没了 */
    }
    return false
  }
}

/**
 * 依据插件已归一化的配置构造服务配置。
 *
 * 每个路径都相对数据根表达，使整个持久化足迹就是同一个目录。
 *
 * @param {object} config - 已归一化的插件配置。
 * @param {string} dataRoot - 持久化状态的根；相对路径的基准。
 * @param {string} searchKey - 已解析的检索 key，用作预热时的兜底凭据。
 * @returns {object} 服务配置。
 */
export function serviceConfig(config, dataRoot, searchKey) {
  return {
    dataRoot,
    autoStart: config.serviceAutoStart,
    baseUrl: config.baseUrl,
    binaryPath: findMeilisearchBinary(config.meilisearchBinary, dataRoot),
    dbPath: resolvePath(config.meilisearchDbPath, dataRoot),
    logPath: resolvePath(config.meilisearchLogPath, dataRoot),
    masterKeyPath: resolvePath(config.masterKeyPath, dataRoot),
    masterKey: config.masterKey,
    startTimeoutMs: config.serviceStartTimeoutMs,
    stopTimeoutMs: config.serviceStopTimeoutMs,
    warmup: config.serviceWarmup,
    warmupTimeoutMs: config.serviceWarmupTimeoutMs,
    pollIntervalMs: config.servicePollIntervalMs,
    maxIndexingMemory: config.meilisearchMaxIndexingMemory,
    scheduleSnapshot: config.meilisearchScheduleSnapshot,
    index: config.index,
    embedder: config.embedder,
    searchKey,
  }
}

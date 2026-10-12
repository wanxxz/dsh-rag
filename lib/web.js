/**
 * 插件的诊断用 HTTP 接口。
 *
 * 刻意做得很小：一个只读的本地状态端点，报告的内容与 `rag_status` 一致，可以从
 * 浏览器或 `curl` 直接访问，无需经过 agent。它存在的理由是——最常见的故障形态是
 * “工具返回空”，而这个端点一次请求就能回答：实例是否在跑、这把 key 是否能看到该
 * 索引、里面有多少文档、哪些字段可用于过滤。
 *
 * 这个路由绝不返回 API key，也不接受任何输入。
 */

/**
 * 构造把状态视图序列化为响应的路由处理器。
 * @param {() => Promise<object>} status - 共享的状态提供者。
 * @returns {(request: object, response: object) => Promise<void>} 处理器。
 */
function statusHandler(status) {
  return async (request, response) => {
    if ((request.method ?? 'GET') !== 'GET') {
      response.writeHead(405, { allow: 'GET' })
      response.end()
      return
    }
    let payload
    let code = 200
    try {
      payload = { ok: true, value: await status() }
    } catch (error) {
      code = 500
      payload = { ok: false, error: { code: 'status-failed', message: error instanceof Error ? error.message : String(error) } }
    }
    const body = `${JSON.stringify(payload, null, 2)}\n`
    response.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    response.end(body)
  }
}

/**
 * 注册插件的 HTTP 路由。
 *
 * @param {object} options - 接线参数。
 * @param {(route: object) => (() => void)} options.register - 绑定到 server 的 `ctx.webServer.register`。
 * @param {string} options.prefix - 路由前缀，例如 `/personal-rag`。
 * @param {() => Promise<object>} options.status - 共享的状态提供者。
 * @param {{warn: Function}} options.logger - 日志器。
 * @returns {() => void} 移除全部路由的 disposer。
 */
export function registerRagRoutes(options) {
  const { register, prefix, status, logger } = options
  const disposers = []
  const registerRoute = (routePath, handler) => {
    try {
      disposers.push(register({ path: routePath, kind: 'exact', handler }))
    } catch (error) {
      logger.warn(`rag: could not register ${routePath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  registerRoute(`${prefix}/status`, statusHandler(status))
  // `/health` 是运维人员最先想到的名字；把它做成别名，而不是返回一个看起来像
  // “插件没加载成功”的 404。
  registerRoute(`${prefix}/health`, statusHandler(status))

  return () => {
    for (const dispose of disposers) dispose?.()
  }
}

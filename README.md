# @wanxxz/dsh-rag

DeepSeek Harness 的个人 RAG 插件。自包含：它自己管一个本地 Meilisearch 引擎、引擎里的索引、建库工具，以及 agent 调用的检索工具。

两个根目录，刻意分开：

```text
plugins/dsh-rag/                          CODE —— 运行时绝不往这里写
  index.js  lib/  package.json  cordis.patch.yml
  corpus/                                 建库工具、索引设置
  test/                                   离线测试

<dsh-home>/plugins/@wanxxz/dsh-rag/               DATA —— 全部持久化产物
  runtime/data/                           Meilisearch 数据库（LMDB）
  runtime/logs/meili.log                  引擎输出
  runtime/master-key.txt                  启动引擎用的 key
  corpus/keys/search-key.txt              工具检索用的只读 key
```

数据根默认是 `<dsh-home>/plugins/@wanxxz/dsh-rag` —— 这是**本仓库自己的约定**，不是 Harness 定义的（DSH 自己的每插件状态是平铺的，例如 `<dsh-home>/llm-deepseek`）。它有三层可配置，从最具体到最宽泛：`dataRoot` 配置项 → `DSH_RAG_DATA_ROOT` → 默认值。因为和代码分开，插件目录可以只读、可以被升级整体替换、可以进版本控制而不会带进一个 2 MB 的数据库；想把状态挪到别的盘，改一个键就行。

## 引擎归插件托管

Meilisearch 随插件启停——这才是"RAG 是个 DSH 插件"在实践上该有的意思：打开 DSH 检索就能用，关掉什么都不留。

| 情况 | 插件的行为 |
|---|---|
| `baseUrl` 上没人监听 | 用 `<dataRoot>/runtime/data` 启动 `meilisearch`，production 模式，master key 读自 `<dataRoot>/runtime/master-key.txt` |
| 已经有实例在监听 | **收养它**，并且绝不停掉——第二个实例会绑定失败，而杀掉一个不是自己启动的进程更糟 |
| master key 文件缺失或为空 | **拒绝启动。** 没有 key 启动会让 Meilisearch 进入 development 模式，等于用无鉴权方式对外提供真实索引 |
| 插件启动了它，之后 DSH 退出 | 插件卸载时杀掉该进程，不让它活过应用 |
| 启动失败（二进制不对、端口竞争、超时） | 在 `rag_status` 和状态路由上报，并附上捕获的输出尾部——**启动失败绝不静默** |

实例能被访问之后，插件会发一次混合检索把 embedder 预热：Meilisearch 本身秒级启动，但 bge-m3 是首次使用时才加载（约 50 秒），这个窗口内发出的查询可测地退化（top1 0.91 vs 1.00）。

索引本身由 `corpus/` 建：中文文档切块后用 `BAAI/bge-m3` 在本地向量化，再以 jieba 全文 + 混合排序建索引。见 [`corpus/README.md`](corpus/README.md)。

## 为什么做成插件而不是用 Meilisearch 的 MCP 服务器

两条路都接着，回答的是不同问题。

| | `mcp__meili__*`（MCP 客户端行） | `rag_context`（本插件） |
|---|---|---|
| 形态 | Meilisearch REST API 的镜像 | 一个检索结果 |
| 返回 | 原始检索响应，一个 chunk 一行 | 合并、去重、带引用编号、受字符预算约束的段落 |
| 调用方必须懂 | `hybrid`、`semanticRatio`、`matchingStrategy`、`locales`、字段名 | 只要给一个问题 |
| 提示词开销 | 四个 schema、数百个参数 | 三个小 schema |
| 引擎生命周期 | 无——必须有别的东西先跑起来 | 自己管 |
| 自检 | 无 | `rag_status` + `/personal-rag/status` 路由 |

MCP 那条路对**手工调检索**仍有价值，但它要求引擎已经在跑。回答问题时应调用的是 `rag_context`。

## 工具

| 工具 | 参数 | 返回 |
|---|---|---|
| `rag_context` | `query`、`limit?`、`maxChars?`、`filter?`、`semanticRatio?`、`matchingStrategy?`、`minScore?` | 上下文包：每段以 `[1] …[n]` 开头，出处为 `标题 > 小节（机构 · 日期）`，另有 `sources[]` 数组带 `docId` 供后续过滤 |
| `rag_search` | `query`、`limit?`、`filter?`、`semanticRatio?`、`matchingStrategy?`、`docId?`、`snippetChars?`、`minScore?` | 排序后的命中，带 ranking score、chunk id、出处和文本片段 |
| `rag_status` | — | 可达性、索引规模、主键、embedder 模型与池化、**可过滤字段名**、引擎归属、逐项探针失败原因 |

依赖它们之前值得知道的行为：

- **只在相邻时才合并块。** 同一小节的两个命中，仅在 chunk id 连续时（`<hash>-0007` 接着 `<hash>-0008`）拼接。有缺口说明那段文本没被检索到，跨过缺口拼接会**伪造原文并不存在的连续性**。
- **`minScore` 默认 `0.7`。** Meilisearch 的全局 ranking score 是相对值、不是校准值：在样本语料上，一个与任何文档都无关的问题也能得约 0.65，所以不设地板的话，无关问题会拿到八段"看起来很像"的段落。这个数值是在样本语料上量的——**灌入真实语料后要重新校准**，或者每次调用传 `minScore: 0` 看完整排序尾部。
- **被过滤掉的结果不会静默。** 空包会明确渲染"没有段落命中，换个说法 / 调低 `minScore` / 去掉 filter"，所以"库里没有"和"分数不够"始终可区分。
- **`filter` 是原始 Meilisearch 表达式。** 字段名从 `rag_status` 取，不在这里硬编码，因此灌库时新增一个可过滤字段**不需要改插件**。

## 配置

所有键都是可选的。默认值面向 `corpus/` 灌库脚本建出来的 loopback Meilisearch 实例。

| 键 | 默认 | 含义 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:7700` | Meilisearch 地址 |
| `index` | `zh` | 要检索的索引 uid |
| `embedder` | `zh` | `hybrid` 块里用的 embedder 名 |
| `apiKey` | `''` | Bearer key；留空表示"读 `apiKeyPath`" |
| `apiKeyPath` | `corpus/keys/search-key.txt` | key 文件，**每次调用都重读**，所以轮换 key 不需要重启 |
| `defaultLimit` / `maxLimit` | `8` / `30` | 检索块数，以及单次调用不得超过的上限 |
| `defaultContextChars` / `maxContextChars` | `6000` / `40000` | 上下文包的字符预算 |
| `semanticRatio` | `0.5` | 默认关键字／语义配比 |
| `matchingStrategy` | `all` | `last`（Meilisearch 默认）会丢掉中文问句末尾的词 |
| `minScore` | `0.7` | ranking score 地板；`0` 关闭 |
| `timeoutMs` | `15000` | 单次请求超时 |
| `agentTools` | `true` | 注册那三个工具 |
| `promptGuidance` | `true` | 注册提示词段落 |
| `httpPrefix` / `httpRoute` | `/personal-rag` / `true` | 只读状态路由 |

引擎生命周期相关的键。每个路径要么是绝对路径，要么相对于 `dataRoot`；`serviceAutoStart: false` 会把插件变成纯客户端，绝不启动任何进程。

| 键 | 默认 | 含义 |
|---|---|---|
| `dataRoot` | `<dsh-home>/plugins/@wanxxz/dsh-rag` | **全部持久化状态的根。** `DSH_RAG_DATA_ROOT` 覆盖默认值，本键覆盖两者。指向别的盘即可迁移数据库 |
| `serviceAutoStart` | `true` | 无人监听时启动引擎 |
| `meilisearchBinary` | `''`（按 PATH 查找） | 二进制路径；留空则依次尝试该键 → `DSH_RAG_MEILI_BINARY` → `PATH` → 平台默认位置 |
| `meilisearchDbPath` | `runtime/data` | LMDB 数据库目录 |
| `meilisearchLogPath` | `runtime/logs/meili.log` | 子进程输出追加到这里 |
| `masterKeyPath` / `masterKey` | `runtime/master-key.txt` / `''` | 启动引擎用的 key；文件缺失即"拒绝启动" |
| `meilisearchMaxIndexingMemory` | `2GB` | 限制建索引内存——**不设的话，Windows 上内存涨到 4GB 后引擎会被杀且日志无线索** |
| `meilisearchScheduleSnapshot` | `86400` | 快照间隔（秒） |
| `serviceWarmup` / `serviceWarmupTimeoutMs` | `true` / `600000` | 就绪后预热 embedder |
| `serviceStartTimeoutMs` / `serviceStopTimeoutMs` / `servicePollIntervalMs` | `120000` / `15000` / `1000` | 就绪等待、停止等待、轮询间隔 |

密钥放在 key 文件里，而不是放在 profile patch 里——后者是被跟踪、带注释的配置文件。`apiKeyPath` 同样相对于 `dataRoot`（`corpus/keys/search-key.txt`）。随附的 key 只有 `search`、`documents.get`、`indexes.get`、`settings.get`，作用域限定在 `zh` 索引——够检索和自检，但不足以写文档、改设置或读别的索引。

`stats` 是**故意不申请**的：`GET /indexes/{uid}/stats` 需要 `stats.get`，而 Meilisearch 对权限不足的回答是 **HTTP 403 + `invalid_api_key`**（key 真正不存在才是 401）。`rag_status` 把它报成一条探针失败并**省略**文档数，而不是误报为 0，也不是干脆拒绝回答。

数据根默认在仓库之外，所以不需要为它写忽略规则。如果某个部署把 `dataRoot` 指回插件目录，那里的 `.gitignore` 会把 `runtime/` 和 `corpus/keys/` 挡在版本控制之外。

## 安装

机器相关路径是**解析出来的**，不是硬编码的：Meilisearch 可执行文件依次通过 `meilisearchBinary` 配置项、`DSH_RAG_MEILI_BINARY`、`PATH`、平台常见安装位置查找。

插件是一个 profile bundle：一个声明了 `dsh.bundle.patch` 的 `package.json`、一个插入单条 Host 行的 patch，以及没有任何运行时依赖的 host 代码。

1. 链接进 profile 并选为 bundle：

   ```yaml
   # ~/.dsh/profiles/desktop/package.json
   "dependencies": { "@wanxxz/dsh-rag": "link:<path to this checkout>" },
   "dsh": { "profile": { "bundles": [ "...", "@wanxxz/dsh-rag" ] } }
   ```

   ```powershell
   node <dsh node> <dsh pnpm.mjs> install --offline --dir ~/.dsh/profiles/desktop
   ```

2. 默认值不合适时，在 profile 的 `cordis.patch.yml` 里覆盖该行配置（**行覆盖是整体替换 config，不是合并**）：

   ```yaml
   - id: rag
     name: '@wanxxz/dsh-rag'
     config:
       index: 'zh'
       minScore: 0.6
   ```

3. 重启之前先验证组合能被解析，这样一个改错不会把应用搞挂：

   ```powershell
   $env:ELECTRON_RUN_AS_NODE = '1'
   $app = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
   $cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
   & $app $cli --profile web --patch .\test\compose-probe.patch.yml --dump-config
   ```

   该行必须出现在 dump 出的配置树里且无警告。在 patch 文件里写一条带新 id 的裸条目会被**静默跳过**；新增必须用 `insert` 形式。

4. **重启 Desktop 应用。** 新增 bundle 会重新组合 profile，而那行的模块缓存**不会**因为改源码而替换——HMR 的 watch root 只对模块**首次加载之后**的编辑生效。改 profile patch、touch 源文件、然后等，都只会让原来组合进去的那份继续生效；**重启是唯一办法**。

5. 按顺序验证：

   ```powershell
   # a) 自检（跨平台，不依赖 PowerShell）：引擎/索引/embedder/归属/MCP/失败任务
   node corpus/cli.js status
   # b) 插件到底加载了没有（它自己的加载标记应新增一行）
   Get-Content plugins/dsh-rag/load.log -Tail 3
   # c) host half 能否用真实配置作答
   (Invoke-WebRequest http://127.0.0.1:19387/personal-rag/status -UseBasicParsing).Content
   # d) 在 DSH 内部：先 rag_status，再用中文问题调 rag_context
   ```

   `cli.js status` 覆盖了原先 `status.ps1` 的全部项目，包括别处看不到的四项：失败任务、`mcpRoute`、MCP 工具清单，以及那个会抢端口的残留 Windows 服务。

   如果 (a)(b)(c) 都过、但工具调用报 `returned invalid output`，说明运行中的实例在执行**旧版** `index.js`——先看加载标记，再去调代码。

### 已验证状态

重启后从 DSH 内部实际调用确认（2026-10-12）：

| 调用 | 结果 |
|---|---|
| `rag_status` | 可达；`bge-m3` via `huggingFace`；列出可过滤字段；一条诚实的 `stats` 权限探针失败 |
| `rag_context`「煤电容量电价怎么分摊」 | 8 块 → 8 段可引用内容；`[1]` 是对应通知的容量电价一节 |
| `rag_context` + `filter: doc_type = "规范性文件" AND publish_year >= 2023` + `maxChars: 900` | 过滤器生效；5 块 → **1 段**；并报告了截断 |
| `rag_context` 无意义查询 | 明确的空结果 + 三条补救建议（0.7 地板在工作） |
| `rag_search` + `docId` | **1 of ~1 hit**（0.9978）；`docId` 行为与等值 filter 完全一致 |

## 开发

```powershell
node test/output.unit.js         # 投影助手，不联网
node test/host.smoke.js          # 假 ctx + 活索引；校验输出契约
node test/registry.contract.js   # 用 DSH 自己的注册表代码校验 schema
node test/service.lifecycle.js   # 真实进程的引擎生命周期（拒绝/启动/收养/停止）
node test/score-probe.js         # 打印不同查询类型下的 ranking score 分布
node test/extract-registry.js    # （重新）生成上面那个测试用的注册表副本
```

### 用真注册表校验，而不是复刻版

`test/host.smoke.js` **自己复刻**了注册表执行的两条输出规则——lossless JSON，以及严格符合 `output.schema`——因为这两条是在 Harness **内部**执行的，对外只表现为一句不透明的 `returned invalid output`。早期版本曾经返回过一个带未声明字段 `estimatedTotalHits` 的结果，以及一个带 `undefined` 的状态对象；这两个回归该测试至今能抓到，而且它不需要任何 fixture，在哪都能跑。

`test/registry.contract.js` 更进一步，直接 `import` `@deepseek-ai/dsh-tools`——也就是**真正会执行校验的那份代码**——把每个声明和每个产出结果都过一遍。三个复刻版掩盖掉的真实差别就是这样发现的：

- **`parameters` 是「名字→规格」映射，不是 schema 节点。** 传一个带 `type` 的节点会失败：*"parameters.type must be a value schema object"*。
- **值 DSL 的 required 是逐属性标记**（`{ type: 'integer', required: true }`）；用 `required` 数组会失败：*"schema.required is not supported by the value schema DSL"*。
- **每个 object 都必须显式声明 `additionalProperties`。**

插件发的是**原始 JSON Schema** 而不是作者 DSL——这正是它"零 import"属性的来源——所以测试在两者之间做转换，并证明编译出的线上 schema 与原始 schema 一致。

`test/dshtools/` 存放抽出来的注册表及其依赖闭包（33 个包，约 8 MB，已 gitignore）。全新 checkout 里没有它，测试会**带指引地跳过**而不是失败。升级应用后重新抽取一次：注册表会随时间增加 schema 规则。

### 判断运行中的实例在执行哪份代码

`load.log`（已 gitignore）每次 `apply()` 追加一行。它存在的原因是："运行中的应用还是旧模块"和"我的代码写错了"会产生**同样**的工具调用失败结果，而这是区分二者最便宜的办法：

```powershell
Get-Content plugins/dsh-rag/load.log   # 新增行 = 应用重新加载了这个模块
```

编辑插件源码**不会**刷新一个在启动时就已组合好的插件行：HMR 的 watch root 只对模块首次加载之后的编辑生效。增删 bundle 行需要重启应用。

### 运维 CLI

```powershell
node corpus/cli.js status            # 只读自检（引擎/索引/embedder/归属/MCP/失败任务/残留服务）
node corpus/cli.js warmup            # 手动预热 embedder
node corpus/cli.js start             # 前台运行引擎，Ctrl+C 结束
node corpus/cli.js start --detached  # 分离式，立刻返回（脚本调用用）
node corpus/cli.js stop              # 停掉端口上的实例（含子孙进程）
```

以前这里有四个 PowerShell 脚本，已全部由这一个跨平台 CLI 取代——见下面"已知限制"里关于 BOM 的那条。

## 已知限制

- **Windows 11 不在 Meilisearch 的支持矩阵内**（官方承诺的是 Windows Server 2022+）。这里实测可用，但没有厂商承诺。
- **单进程、单写者。** Meilisearch 只允许一个写者，所以灌库脚本和本插件不能同时以写方式打开数据库。插件**只读**。
- **`estimatedTotalHits` 统计的是候选池，不是命中数。** 向量少于约 30 万时 Meilisearch 走线性扫描，于是它报的是整个索引。请以检索到的命中数（`hitCount`）为准。
- **分数地板是经验值。** 它在 11 篇样本文档上校准过；换语料需要自己重测（`test/score-probe.js`）。
- **没有重排。** 混合融合发生在 Meilisearch 内部，没有 cross-encoder 这一遍，所以 top1 的上限就是 bge-m3 加 jieba 的水平。
- **状态路由无鉴权。** 它只提供 loopback 数据且从不返回 key，但本机任何进程都能读到索引规模、embedder 模型和可过滤字段列表。
- **只用 Node，不用 PowerShell。** 原先的 `.ps1` 脚本带中文注释，必须存成 UTF-8 **with BOM**——无 BOM 的 UTF-8 会被 Windows PowerShell 5.1 当 ANSI 读，**解析失败且静默退出**（连日志都不生成）。改成 `corpus/cli.js` 后这个坑从根上消失，仓库里现在没有任何 PowerShell 脚本。

## 许可证

[MIT](LICENSE) © 2026 Yiwan Zhou &lt;mail@yiwan.me&gt;

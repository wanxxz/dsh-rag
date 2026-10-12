# 个人 RAG — Meilisearch 检索层

全本机运行的中文 RAG **检索层**。只提供检索，不生成答案（生成由 DSH 自己完成）。

## 当前状态

**已实测通过：**

| 项目 | 结果 |
|---|---|
| Meilisearch 1.54.3 在 Windows 11 运行 | ✅ 官方只承诺 Server 2022+，Win11 属"能用但不保证"，实测稳定 |
| 中文 jieba 分词 | ✅ `_matchesPosition` 证明「光伏」按**词**匹配（length=6 字节=2 汉字），非逐字 |
| 原生 MCP 路由 `/mcp` | ✅ 握手方法为 `server.discover`（**不是** `initialize`），4 个工具可用 |
| DSH 侧协议兼容 | ✅ DSH 本体内含 `server/discover` / `io.modelcontextprotocol/clientInfo` / `2026-07-28` |
| **进程内 bge-m3** | ✅ 2.12GB 权重，**sha256 校验通过**，加载+13 块向量化 55 秒 |
| 混合检索 | ✅ 纯关键词/纯语义/混合三档实测，REST 与 MCP 结果一致 |
| 真实中文语料灌库 | ✅ 11 篇政策文档 → 13 块，嵌入 13/13，节级检索命中正确 |
| 最小权限 key | ✅ 限定 `zh` 单索引，`listIndexes` 只返回它 |
| **DSH 侧 MCP 工具** | ✅ 从 DSH 内部实测：`listIndexes` 只返回 `zh`；`searchInIndexes` 中文混合检索命中《绿证全覆盖工作方案》（0.829）。**改 profile 会热重载，无需重启** |
| **目标规模验证** | ✅ 2500 份文档 → 4397 块，灌库 17.7 分钟（bge-small）、索引 72 MB、混合查询 15–29 ms |

**引擎由插件托管**：Meilisearch 现在**随 DSH 的 dsh-rag 插件启停**——打开 DSH 就有了，关掉 DSH 它就停了，不会在后台留东西。实例数据在 **数据根** `<dsh-home>/plugins/@wanxxz/dsh-rag/`（可用配置项 `dataRoot` 或环境变量 `DSH_RAG_DATA_ROOT` 改到别的盘）。

**待办：**
- [ ] 灌入你的真实语料（2–3 千份文档）——需要你给路径与格式；`ingest.py --dry-run` 会先预估耗时
- [ ] （可选）确认 embedder 路线：`bge-m3` 一次性灌库 ~11–28 小时，或先用 `bge-small-zh-v1.5`

## 目录结构

`corpus/`（本目录）是**建库与运维工具**；运行时数据在**数据根** `<dsh-home>/plugins/@wanxxz/dsh-rag/` 下，不在插件代码目录里。

```
plugins/dsh-rag/
├── index.js                  插件入口（工具 + 提示词 + 状态路由 + 引擎托管）
├── lib/
│   ├── meilisearch-service.js  Meilisearch 进程生命周期（启动/收养/预热/停止）
│   ├── meili.js               Meilisearch HTTP 客户端
│   ├── context.js             合并相邻块 → 引用编号 → 字符预算
│   └── output.js              输出契约（schema 投影 + lossless JSON）
├── runtime/                   ← 引擎状态（gitignored）
│   ├── data/                  Meilisearch 数据目录（LMDB）
│   ├── logs/meili.log         引擎输出
│   └── master-key.txt         master key（启动引擎用）
└── corpus/                    ← 本目录（建库与运维）
    ├── ingest.py              灌库脚本（纯标准库；docx/pdf/md/txt/jsonl）
    ├── eval.py                检索质量回归（可扫参数网格）
    ├── cli.js                 运维 CLI（status / warmup / start / stop，跨平台）
    ├── config/
    │   ├── settings.json      索引设置（中文调优）
    │   ├── embedder.json      embedder 配置（bge-m3 + forceCls）
    │   ├── embed-small.json   降级方案（bge-small-zh-v1.5）
    │   └── dsh-mcp.patch.yml  DSH 侧 MCP 配置片段（含真实 key）
    ├── keys/search-key.txt    检索专用最小权限 key（给插件用）
    ├── bench/make-corpus.py   合成语料生成器（规模彩排用，seed 固定）
    ├── testdata/              格式回归样本 + 标注查询集
    └── README.md
```

代码路径由文件自身位置推导；**数据路径由数据根推导**（默认 `<dsh-home>/plugins/@wanxxz/dsh-rag`，可用 `dataRoot` 配置项或 `DSH_RAG_DATA_ROOT` 改到别的盘）。所以插件目录可以整体搬移，数据也可以独立迁移。

## 启动 / 停止 / 归属

**默认（推荐）：什么都不用做。** 插件在 DSH 启动时自己拉起引擎，就绪后自动预热 embedder，DSH 关闭时把它停掉。

| 情况 | 行为 |
|---|---|
| 端口没人监听 | 插件用 `<数据根>/runtime/data` 启动，production 模式，master key 取自 `<数据根>/runtime/master-key.txt` |
| 端口已有实例 | **收养**它，绝不停掉——第二个实例会绑定失败，而杀掉非自己启动的进程更糟 |
| `<数据根>/runtime/master-key.txt` 缺失/为空 | **拒绝启动**：没有 key 的 Meilisearch 是 development 模式，会用无鉴权方式对外提供真实索引 |
| 启动失败 | 在 `rag_status` 与状态路由上报，并附上子进程输出的尾部——**失败不会静默** |

> ⚠️ **历史上踩过的坑**：注册表里残留过一个 `Meilisearch` 服务（`AUTO_START` 但 `AppParameters` 为空），若被拉起会用无参数方式启动一个 development 实例抢占 7700。现在插件会**收养**先到的监听者，但为稳妥仍建议用管理员权限执行一次 `sc.exe delete Meilisearch`。`status.ps1` 会检查它是否还在。

**手动启动（不开 DSH 时用）**：

```powershell
node .\cli.js start                  # 前台运行，Ctrl+C 结束
node .\cli.js start --detached       # 分离式（脚本调用，立刻返回）
node .\cli.js stop                   # 停掉端口上的实例（含子孙进程）
```

`cli.js start` 从数据根读数据与 key，与插件用的是同一套参数；**不要和插件同时启动**（同一端口只会有一个赢，输的那个报绑定失败）。

**手动停止**：

```powershell
# 当前 shell 可能看不到该进程（跨安全上下文），用 taskkill
taskkill /IM meilisearch.exe /F
```

> ⚠️ **`taskkill /IM meilisearch.exe /F` 会杀掉机器上所有 meilisearch 实例**。踩过一次——跑彩排实例时用它，把生产实例一起干掉了（幸好启动脚本 + 预热自愈，几秒恢复）。
> 有多个实例时，按端口找 PID 精确杀：
> ```powershell
> Get-NetTCPConnection -LocalPort 7700 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
> ```

**看日志**：`<数据根>/runtime/logs/meili.log`

> 由插件启动时，子进程的输出由插件捕获后**以 UTF-8 追加**写入该文件，可以直接 `Select-String`。
> 现在只有一种来源：子进程输出由插件或 `cli.js` 捕获后以 **UTF-8** 追加，可直接 `Select-String`。

**关键参数**（插件与 `cli.js` 用的是同一套）：

- `--max-indexing-memory 2GB` **不是可选项**：Windows 上不设，内存涨到 4GB 后会**静默崩溃且日志无线索**（issue #4910）。
- master key 通过 **环境变量 `MEILI_MASTER_KEY`** 传入，不进命令行。注意 cmd 的 `set KEY="X"` 会把引号算进值。
- 插件启动时**必须能读到 master key**，否则拒绝启动（见上表）——这是刻意的，development 模式会用无鉴权方式暴露真实索引。

## 自检（cli.js status）

一条命令看全部关键状态（只读）：

```powershell
node .\cli.js status
```

输出示例：

```
服务                   OK  http://127.0.0.1:7700
版本                   1.54.3
mcpRoute             已开启
索引 zh                文档 13 / 嵌入 13 / 0.9 MB
  embedder           zh:huggingFace/BAAI/bge-m3
最近预热                 (无 warmup.log —— 现在由插件在启动后预热，见 [6])
登入自启脚本             已移除（由插件负责启停）
残留服务                 不存在
MCP 工具               searchInIndexes, facetSearch, listIndexes, describeIndex
失败任务                 无
数据目录                 <数据根>\runtime  (2.1 MB)
插件状态路由             reachable=True configured=True
  插件管理的服务         ready  pid=12345  managed=True
  插件预热耗时           48.3 s
```

它用 master key（因为 `/tasks` 和 `/experimental-features` 检索专用 key 读不到）。脚本已存为 UTF-8 with BOM，PowerShell 5.1 也能正常运行。

> 失败任务会一直保留在列表里（除非删除）。排查完历史问题后可以清掉：
> ```powershell
> curl.exe -X DELETE -H "Authorization: Bearer <master-key>" "http://127.0.0.1:7700/tasks?statuses=failed"
> ```

## 灌库

```powershell
# 干跑：看切块统计与样例，不写库
python ingest.py --src D:\docs --dry-run

# 正式灌库（清空后重建）
python ingest.py --src D:\docs --index zh --key <master-key> --replace --target 600 --max 1000
```

参数：`--target` 目标块长（默认 500，建议 400–800）、`--max` 硬上限、`--overlap` 块间重叠（默认 0）、`--batch` 每批条数。

### 支持的格式

| 格式 | 依赖 | 说明 |
|---|---|---|
| `.md` / `.markdown` | 无 | 解析 YAML frontmatter，抽出 `doc_id / title / issuer / level / publish_date / tags` |
| `.txt` | 无 | 整篇按标题/段落/标点切 |
| `.jsonl` / `.json` | 无 | 每行/每项一个文档，取 `doc_id/title/text/issuer/level/publish_date` |
| `.docx` | **无**（标准库解析 OOXML） | Word 标题样式映射成 Markdown 标题；表格按行转成 `a \| b \| c`，整表不拆 |
| `.pdf` | 需 `pypdf` 或 `pymupdf` | 见下方注意事项 |

PDF 用临时环境跑（不污染系统 Python）：

```powershell
uv run --no-project --with pymupdf -- python ingest.py --src D:\docs --index zh --key <master-key> --replace
```

**PDF 的两个硬前提**（实测确认）：

1. **必须有文本层**。扫描件提取出来是空的——那需要 OCR（docling / MinerU 那类，要 torch + 数 GB 依赖），本脚本不处理。
2. **PDF 必须内嵌中文字体**。实测：同一份 DOCX，用没有中文字形的字体（如 Calibri）导出 PDF 后，提取结果**字序错乱**（「为规 发电项 进 质 发」）；在同一 DOCX 里显式指定 `w:eastAsia = SimSun` 再导出，提取结果**完全正确**（「为规范新能源发电项目并网管理，促进新能源高质量发展，制定本通知。」）。
   三个引擎（pypdf 默认 / pypdf layout / PyMuPDF）在坏样本上表现一致，说明问题在 PDF 而非提取器。

> 所以：**先拿一份真实语料里的 PDF 试一下**，看提取文本是否通顺，再决定要不要上 OCR 方案。

### 切块策略

「标题层级 → 段落 → 中文标点」三级回退，并**把相邻小节合并到目标长度**（否则政策文档会切出大量百字级碎片——实测未合并时中位块长仅 101 字，合并后 455 字）。合并后小节标题保留在正文里，块内结构不丢。

## 索引设置要点

见 `config/settings.json`。

| 设置 | 值 | 为什么 |
|---|---|---|
| `searchableAttributes` | title > section_path > keywords > issuer_short > text | 顺序即权重；**必须显式收窄**，默认全字段可搜会污染相关性 |
| `filterableAttributes` | doc_id / issuer_short / doc_type / publish_year | ⚠️ 单值 ≤468 字节（约 156 汉字） |
| `stopWords` | 28 个中文虚词 | ⚠️ **索引期就移除**，改它触发全量重建 |
| `synonyms` | 单词级（光伏↔太阳能） | ⚠️ 实测**多词/短语同义词对中文无效** |
| `typoTolerance.disableOnNumbers` | true | 防 `2021` 匹配 `2025` |
| `prefixSearch` | `disabled` | agent 场景不做补全；中文前缀噪声大 |
| `localizedAttributes` | `cmn` | 明确指定中文分词管道 |

## Embedder

`config/embedder.json`：

```json
{"zh": {"source": "huggingFace", "model": "BAAI/bge-m3",
        "pooling": "forceCls",
        "documentTemplate": "{{doc.title}}\n{{doc.section_path}}\n{{doc.text}}",
        "documentTemplateMaxBytes": 2048}}
```

- **`pooling` 必须显式写**。serde 默认值是 `ForceMean`，而 BGE 系列要 **CLS**；不写会把检索质量搞坏。
- **`documentTemplateMaxBytes` 必须从默认的 400 调大**。默认 400 字节 ≈ 133 汉字，只截断送进 embedder 的文本（不影响全文索引），意味着 800 字的块有 80% 对语义检索不可见。2048 覆盖约 680 汉字。
- `model` **只接受 HF 仓库 ID，不接受本地路径**（实测报 `HG_HUB 404`）。
- 内存常驻 ≈ 2.3GB（567M 参数 × 4B，candle 是 F32），纯 CPU（官方 GPU 配方要求 Linux）。

## 检索参数

```json
{"q": "<≤10 个中文词>", "matchingStrategy": "all",
 "hybrid": {"embedder": "zh", "semanticRatio": 0.5},
 "limit": 10, "showRankingScore": true, "locales": ["cmn"]}
```

- **`matchingStrategy` 必须显式指定**：默认 `last` 会从查询末尾丢词。
- **`semanticRatio`**：0=纯关键词，1=纯语义，0.5=混合。实测混合最佳——有一条查询纯语义排错、混合纠正回正确答案。
- 中文长问句先抽关键词，别整句丢进去（**10 词上限**，超出静默忽略）。

## 检索质量回归（eval.py）

调参不要靠感觉。`eval.py` 在带标注的查询集上批量评估，输出 top1 / MRR / recall@k：

```powershell
# 单组参数，逐条看结果（调参时用）
python eval.py --queries testdata\queries.sample.jsonl --key <master-key> --sr 0.5 --ms all

# 扫参数网格出对比表
python eval.py --queries testdata\queries.sample.jsonl --key <master-key> --sweep
```

查询集是 JSONL，一行一条：

```json
{"query": "煤电容量电价怎么分摊", "expect": ["煤电灵活性改造与容量电价"], "tag": "释义"}
```

`expect` 填 doc_id，可多个。**建议按 `tag` 区分「释义类」（考语义）与「术语类」（考关键词）**，这样能看出参数各自影响哪一半。

### 样本语料上的实测（11 篇文档 / 11 条查询）

| semanticRatio | matchingStrategy | top1 | MRR | recall@3 |
|---|---|---|---|---|
| 0.0 | last | 0.64 | 0.727 | 0.82 |
| **0.0** | **all** | **0.09** | **0.091** | **0.09** |
| 0.0 | frequency | 0.55 | 0.636 | 0.73 |
| 0.3 | all | 1.00 | 1.000 | 1.00 |
| 0.5 | last / all / frequency | 1.00 | 1.000 | 1.00 |
| 0.7 | last / all / frequency | 1.00 | 1.000 | 1.00 |
| 1.0 | last / all / frequency | 1.00 | 1.000 | 1.00 |

三点结论：

1. **`semanticRatio=0.0` + `matchingStrategy=all` 是灾难**（top1 0.09）。纯关键词 + "所有词都必须出现"在中文上几乎召回不到东西——**这两个参数不能同时顶到极端**。
2. **只要语义侧参与（≥0.3），样本上就满分**。
3. `semanticRatio ≥ 0.5` 之后参数不再敏感。

> ⚠️ **这些数字不具备预测性**：样本只有 11 篇、每篇 1–2 个块，检索本身就容易。**它的价值是验证了评估工具可用**——真正的调参要在你那 2–3 千份文档上跑，届时把 `queries.sample.jsonl` 换成标注好的真实查询集。

## 冷启动陷阱与预热

**Meilisearch 秒级启动，但 bge-m3 是首次查询时才加载的（约 50 秒）。这期间语义检索会退化。**

实测（服务一就绪就查询 vs 等模型加载完）：

| 时刻 | top1 | MRR | 平均延迟 |
|---|---|---|---|
| 服务刚就绪 | 0.91 | 0.955 | 1159 ms |
| 模型加载完 | 1.00 | 1.000 | 354 ms |

插件在引擎就绪后会自己发一次混合检索把模型压进内存（`serviceWarmup`），耗时记录在 `rag_status` 的 `service.warmupMs`。需要手动重跑时：`node .\cli.js warmup`。

```
[warmup] ok in 5.8s 2026-10-12T09:20:08
```

> **已解决：Windows PowerShell 5.1 的编码坑。** 原先这里有四个 `.ps1`/`.cmd` 脚本，而 `.ps1` 里只要有非 ASCII 字符就**必须存成 UTF-8 带 BOM**——无 BOM 的 UTF-8 会被 PS 5.1 当 ANSI 读，**解析失败且静默退出**（日志文件都没生成，排查了很久）。改成跨平台的 `cli.js` 之后这个坑从根上消失：Node 按 UTF-8 读源码，没有 BOM 问题，也不必每次改脚本后记得恢复 BOM。仓库里现在**没有任何 PowerShell 脚本**。



## DSH 接线

有**两种**接线方式，并存互补：

| 方式 | 是什么 | 用在哪 |
|---|---|---|
| **`@wanxxz/dsh-rag` 插件** | 检索层封装成一等公民工具：`rag_context` / `rag_search` / `rag_status` + 提示词段落 + `/personal-rag/status` 自检路由 + **托管 Meilisearch 进程** | **agent 答题时的默认路径** |
| **`mcp-server` 行（Meilisearch 原生 `/mcp`）** | Meilisearch 自己的 4 个只读工具的直通 | 手工调检索、看原始响应 |

> ⚠️ MCP 那条路**假定引擎已经在跑**（它只管检索，不管进程）。引擎现在归插件托管，所以 MCP 行的可用性取决于 DSH 是否开着。

插件的价值在于**模型不用懂 Meilisearch**：`rag_context` 接收一个自然语言问题，返回合并去重、带 `[1]…[n]` 引用编号、受字符预算约束的上下文包；`mcp__meili__searchInIndexes` 则要求调用方自己拼 `hybrid` / `semanticRatio` / `matchingStrategy` / `locales` / 字段名。插件源码与完整说明见 [`../README.md`](../README.md)。

**插件的实测状态（已通过重启在运行中的 DSH 内验证）**：

| 调用 | 结果 |
|---|---|
| `rag_context`「煤电容量电价怎么分摊」 | 8 块 → 8 段上下文包，`[1]` 命中《关于开展煤电机组灵活性改造与容量电价机制的通知》→「一、容量电价水平」 |
| `rag_context` + `filter: doc_type = "规范性文件" AND publish_year >= 2023` + `maxChars: 900` | 5 块 → **1 段**，过滤器生效，且正确报告 `(pack truncated at the character budget)` |
| `rag_context`「zzzz-不存在的术语-qqqq」 | 显式空结果 + 三条补救建议（分数地板 0.7 生效） |
| `rag_search` + `docId: "煤电灵活性改造与容量电价"` | **1 of ~1 hit**（0.9978），docId 等价于 `doc_id` 等值过滤器 |
| `rag_status` | 可达性、embedder（bge-m3 / huggingFace）、可过滤字段名、谁在托管引擎、以及一条诚实的 `stats` 权限 probe failure |

另外四份离线测试全绿：

| 测试 | 覆盖 |
|---|---|
| `test/output.unit.js` | 输出投影助手（schema 投影 + lossless JSON） |
| `test/registry.contract.js` | **用 DSH 自己的注册表代码校验 schema**（9 项） |
| `test/service.lifecycle.js` | 引擎生命周期：拒绝无 key 启动 / 从新路径启动 / 收养已有实例 / 停止只停自己启动的 |
| `test/host.smoke.js` | 三个工具对活索引真实检索 + 输出契约 |

profile 组合经 `--dump-config` 验证无警告。

⚠️ **新增 bundle 必须重启一次 DSH**：已组合的行，其模块缓存不会被"编辑源码"替换（HMR 的 watch root 只对模块首次加载**之后**的编辑生效）。判断"运行的是哪份代码"用 `../load.log`（每次 `apply()` 追加一行），比猜代码错在哪快得多。

### 检索专用 key（已轮换）

原先的 `search` / `documents.get` / `indexes.get` 三权限 key **不足以支撑自检**：`/indexes/zh/stats`、`/settings/embedders`、`/settings/filterable-attributes` 全部被拒。实测发现一个容易误判的行为——

> **Meilisearch 对"有 key 但权限不够"返回的是 `invalid_api_key` + HTTP 403**（key 真正不存在才是 401）。

所以 `keys/search-key.txt` 已轮换为 `personal-rag-plugin` key：
`actions: [search, documents.get, indexes.get, settings.get]`、`indexes: ["zh"]`、无过期。旧 key 备份在 `keys/search-key.txt.bak-searchonly`。
`stats` 仍需要额外的 `stats.get`，插件**刻意不申请**——`rag_status` 会把它报成一条 probe failure 并省略文档数，而不是误报 0。

**实测确认（直接从 DSH 内部调用）**：
- `mcp__meili__listIndexes` → 只返回 `zh`，证明最小权限 key 按索引正确限定
- `mcp__meili__searchInIndexes` 中文混合检索 → 命中《绿证全覆盖工作方案》（0.829），与 REST 结果一致
- **改 profile 后 DSH 会热重载已有的 MCP 行，不需要重启**（新增 bundle 行则要重启，见上）

### ⚠️ 最大的坑：patch 层必须用 `insert` 形式新增条目

`cordis.patch.yml` 是**patch 层**，裸条目只会**按 id 覆盖已有条目**。写一个带新 id 的裸条目：

```yaml
- id: mcp-meili                    # ❌ 错误：这样写不会生效
  name: '@deepseek-ai/dsh-mcp-client'
  config: { ... }
```

会被判为 unknown target，**警告并跳过——而且 exit code 仍是 0**，极易误以为配好了。正确写法：

```yaml
- insert:                         # ✅ 正确：insert 的值是要追加的 entry 列表
    - id: mcp-meili
      name: '@deepseek-ai/dsh-mcp-client'
      config: { ... }
```

依据是 `dsh --dump-config-schema` 里 `$defs.includePatch` 的描述（`@deepseek-ai/dsh-app-boot` 的 `patchStructure()`）。原文是英文，此处附中文对照：

> 原文：*"An insert appends entries, optionally inside the group identified by id. Other patches replace supplied fields; config is replaced wholesale, not deep-merged. A truthy name asserts the existing plugin name rather than renaming it. Unknown targets and non-insert patches without a nonempty id are warned and skipped."*
>
> 中文：`insert` 追加条目，可以指定放进 id 标识的那个分组内。其他 patch 覆盖所给字段；**`config` 是整体替换而不是深合并**。`name` 若为真值，是用来**断言**既有插件名而不是给它改名。**目标不存在、以及没有非空 id 的非 insert patch，都会被警告并跳过。**

**验证方法**（不必重启 DSH）：

```powershell
# 注意：这个安装里没有 dsh.cmd，CLI 是 Electron 的 Node 模式
$env:ELECTRON_RUN_AS_NODE = '1'
$app = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$cli = "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js"
& $app $cli --profile web --patch .\config\dsh-mcp.patch.yml --dump-config
# 看两件事：有没有 "patch:" 警告；配置树里有没有出现你的条目 id
```

### 其他要点

- `transport: streamable-http`，`url: http://127.0.0.1:7700/mcp`
- 必须带 `Authorization: Bearer <search-key>`（**只支持 bearer，不支持 OAuth**）
- 需开实验性功能：`PATCH /experimental-features/ {"mcpRoute": true}`（只能走 API 开，**会持久化**）
- **MCP 与插件都是只读检索**：不能建索引、灌数据、改设置——灌库必须走 REST（`ingest.py` 就是干这个的）

## 规模彩排：灌库要多久（重要）

### 满规模验证：2500 份文档 / 4397 块

用 `bench/make-corpus.py --n 2500` 生成 2500 份合成中文政策文档（183 万字），**跑完整条管线**（`ingest.py` → Meilisearch → bge-small-zh-v1.5 向量化 → 检索）：

| 指标 | 结果 |
|---|---|
| 灌库总耗时 | **17.7 分钟**（bge-small-zh-v1.5）——与 `--dry-run` 预估的 0.3 小时几乎完全吻合 |
| 每批 500 块的耗时 | 96–136 秒（~0.25 秒/块） |
| 索引体积 | **72 MB** |
| 关键词查询延迟 | **1–3 ms** |
| 混合 / 纯语义查询延迟 | **15–29 ms** |
| 检索质量抽检 | 查「抽水蓄能价格怎么定」→ 命中《抽水蓄能中长期发展规划》的「第四章 价格与市场机制」（0.909） |

**结论：管线在目标规模上工作正常，索引小、查询快。** 唯一慢的环节是 bge-m3 的向量化（见下表）。

> 注：合成语料每份约 730 字，真实政策文档通常更长，耗时按**总字符数**等比放大。

### 吞吐基准（8 逻辑核 CPU）

用 200 份合成中文政策文档（18.5 万字 → 404 块）在独立实例上实测：

| 模型 | 每块耗时（~400 字块） | 相对速度 |
|---|---|---|
| **bge-m3**（进程内 F32） | **3.66 秒**（两次独立测量 366.8s / 366.3s per 100 块） | 1× |
| **bge-small-zh-v1.5** | **~0.30 秒**（35.2s / 25.5s per 100 块） | **~12×** |

长度依赖性（微基准，固定 20 块）：

| 块长 | 每块耗时 |
|---|---|
| 24 字 | 0.54 s |
| 256 字 | 1.84 s |

→ **耗时与文本长度成正比（约 8 毫秒/字符），不是固定开销**。可以排除"按最大长度 8194 填充"的猜测（若填充，长短耗时应当相同）。

### 换算到你的真实语料

| 假设 | bge-m3 | bge-small |
|---|---|---|
| 2500 份 × 5KB 中文 ≈ 1250 万字 | **≈ 28 小时** | ≈ 2.3 小时 |
| 2500 份 × 2KB 中文 ≈ 500 万字 | ≈ 11 小时 | ≈ 55 分钟 |

### 改设置到底贵不贵（修正了一个想当然的结论）

我一开始以为"改任何索引设置都会触发全量重建，所以用 bge-m3 就没法调参"。**实测证明这是错的**——要分两类：

| 改动 | 13 块时 | 340 块时 | 是否重新嵌入 |
|---|---|---|---|
| `synonyms` / `stopWords` / `searchableAttributes` / `typoTolerance` / `prefixSearch` / `pagination` | 11–13 秒 | **0.3 秒** | **否**（嵌入数不变） |
| `documentTemplate` 改动 | 69 秒 | — | **是** |
| `documentTemplateMaxBytes` 减小 | 15 秒 | — | 否（调大则会重新嵌入） |

1. **全文索引类设置不会重新嵌入**。340 块规模下只要 **0.3 秒**，且**不随语料规模显著增长**——13 块时那 11–13 秒是"索引里挂着 bge-m3 embedder"的固定开销，不是按块线性。**停用词、同义词、字段权重这些中文调优可以随便迭代。**
2. **只有 embedder 类改动才昂贵**：`source` / `model` / `url` / `pooling` / `documentTemplate`。

> 所以要冻结的只有两件事：**切块策略**（改它等于重新灌库）和 **embedder 配置**。
> 灌库前用 `ingest.py --dry-run` 把切块统计看一遍定下来，就足够了——**不必为了"省重建"而先用小模型试水**。

### 增量添加是廉价的（关键运维结论）

在已有 13 块的索引上追加 2 篇新文档实测：

| 指标 | 结果 |
|---|---|
| 任务耗时 | **1.31 秒** |
| 嵌入数变化 | 13 → **15**（**只算新增的 2 个块，不重算已有文档**） |

**所以这个 RAG 可以随用随加**：以后陆续丢新文档进去，只花新增部分的向量化成本。不必攒够一批再灌。

> ⚠️ 批量删除文档要用 `POST /indexes/{index}/documents/delete-batch` 传 JSON 数组：
> ```powershell
> curl -X POST ".../indexes/zh/documents/delete-batch" -d '["id1","id2"]'
> ```
> 把多个 id 写成逗号分隔的**路径**（`/documents/id1,id2`）不会报错，但**删不掉**——实测踩过。

### 检索侧不受影响

300 块规模下：关键词查询 40 ms、纯语义 407 ms。**查询很快，慢的只有建索引。**

### 三条可选路径

| 路径 | 灌库耗时 | 代价 |
|---|---|---|
| **A. bge-m3 一次性灌库** | ~11–28 小时 | 一次性成本；事后调全文检索设置仍然只有零点几秒 |
| **B. bge-small-zh-v1.5** | ~1–2.3 小时（实测 340 块 / 70.8 秒） | 512 维、语义质量低一档 |
| **C. 本机量化 bge-m3** | 预计 3–9 小时（未实测） | 需装 Ollama + 拉 1.2GB 量化模型，走官方 `ollama` embedder source；量化略损精度 |

**推荐**：既然调参不再受制于重建成本，**直接用 bge-m3 通宵灌一次是合理选择**（路径 A）；如果不想等，用 B 先跑通，之后再决定要不要为质量重建一次。

## 实测踩到的坑

1. **主键必须纯 ASCII**：只允许字母数字、`-`、`_`。中文和 `#` 都会被拒（`invalid_document_id`）。脚本用 `sha1(doc_id)[:10]-序号` 生成主键，稳定且重复灌库会覆盖而非新增。
2. **主键候选必须唯一**：字段名以 `id` 结尾的不能有两个（`id` + `doc_id` 会报 `index_primary_key_multiple_candidates_found`）——脚本显式传 `?primaryKey=id`。
3. **bge-m3 自动下载会卡死**：2.12GB 权重下到 1242MB（55%）后停止增长、进程转入闲置。解决：用 curl `-C -` 断点续传补完，**sha256 校验后再装入 HF 缓存**（`blobs/<sha256>` + `snapshots/<rev>/pytorch_model.bin` 硬链接）。
4. **不要被"改设置触发全量重建"吓到**：只有 **embedder 配置**和**切块策略**（等于重新灌库）代价高；全文索引类设置（停用词/同义词/字段权重等）改一次 0.3 秒，可以随便迭代。详见「规模彩排」。
5. **crop（命中片段截取）在中文上未验证**，有社区 issue 称只对有空格的语言有效。检索结果需要片段时，自己从原文切更稳。
6. **多词同义词对中文无效**（实测）——机构全称↔简称请在**入库侧**处理（写进 `keywords` 字段）。

// 探测打分分布：语料内查询、语料外查询、以及无意义查询各是什么分数。
// 用来在真实语料上重新校准 `minScore`（默认 0.7 是在 11 篇样本语料上量的经验值）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MeiliClient } from '../lib/meili.js'

const dataRoot = process.env.DSH_RAG_DATA_ROOT ?? path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'plugins', '@wanxxz', 'dsh-rag')
const key = fs.readFileSync(path.join(dataRoot, 'corpus', 'keys', 'search-key.txt'), 'utf8').trim()
const client = new MeiliClient({ baseUrl: 'http://127.0.0.1:7700', apiKey: key, index: 'zh' })

const queries = [
  '煤电容量电价怎么分摊',
  '储能设施靠什么赚钱',
  'photosynthesis chlorophyll pathway',
  'zzzz-不存在的术语-qqqq',
  '如何做红烧肉',
]
for (const q of queries) {
  const response = await client.search({
    q,
    limit: 5,
    attributesToRetrieve: ['doc_id', 'title'],
    hybrid: { embedder: 'zh', semanticRatio: 0.5 },
    matchingStrategy: 'all',
  })
  const rows = (response.hits ?? []).map((hit) => `${(hit._rankingScore ?? 0).toFixed(4)} ${hit.doc_id}`)
  console.log(`q="${q}"  hits=${response.hits?.length ?? 0} estimated=${response.estimatedTotalHits}  semanticHitCount=${response.semanticHitCount ?? '-'}`)
  for (const row of rows) console.log(`    ${row}`)
}

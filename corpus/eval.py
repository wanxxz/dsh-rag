#!/usr/bin/env python3
"""检索质量回归：在带标注的查询集上评估 Meilisearch 的中文混合检索。

只用标准库。用来回答"参数该怎么调"，而不是靠感觉。

查询集格式（JSONL，一行一条）：
    {"query": "煤电容量电价怎么分摊", "expect": ["煤电灵活性改造与容量电价"], "tag": "释义"}
    {"query": "氢燃料电池汽车", "expect": ["氢能产业发展中长期规划"], "tag": "术语"}
  expect 是 doc_id 列表，命中其中任意一个即算正确。

用法：
    # 单组参数，看每条查询的结果（调参时用）
    python eval.py --queries testdata/queries.sample.jsonl --sr 0.5 --ms all

    # 扫参数网格，出对比表
    python eval.py --queries testdata/queries.sample.jsonl --sweep

    # 只测语义/只测关键词
    python eval.py --queries testdata/queries.sample.jsonl --sr 1.0
"""

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request

for _s in (sys.stdout, sys.stderr):
    if hasattr(_s, "reconfigure"):
        try:
            _s.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass


def load_queries(path):
    queries = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                queries.append(json.loads(line))
    return queries


def search(url, key, index, query, sr, ms, embedder, k):
    body = {
        "q": query,
        "limit": k,
        "attributesToRetrieve": ["doc_id"],
        "showRankingScore": True,
    }
    if sr is not None:
        body["hybrid"] = {"embedder": embedder, "semanticRatio": sr}
    if ms is not None:
        body["matchingStrategy"] = ms
    req = urllib.request.Request(
        f"{url}/indexes/{index}/search",
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        method="POST",
    )
    req.add_header("Content-Type", "application/json")
    req.add_header("Authorization", f"Bearer {key}")
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')}")
    dt = (time.perf_counter() - t0) * 1000
    return [h.get("doc_id") for h in data.get("hits", [])], dt


def evaluate(queries, url, key, index, sr, ms, embedder, k, verbose=False):
    top1 = mrr = recall = 0.0
    total_ms = 0.0
    rows = []
    for item in queries:
        q = item["query"]
        expect = set(item.get("expect") or [])
        hits, dt = search(url, key, index, q, sr, ms, embedder, k)
        total_ms += dt
        rank = next((i + 1 for i, d in enumerate(hits) if d in expect), None)
        top1 += 1.0 if rank == 1 else 0.0
        mrr += (1.0 / rank) if rank else 0.0
        recall += 1.0 if rank and rank <= k else 0.0
        rows.append((q, item.get("tag", ""), rank, hits[:3], sorted(expect)))
    n = max(len(queries), 1)
    metrics = {
        "top1": top1 / n,
        "mrr": mrr / n,
        f"recall@{k}": recall / n,
        "avg_ms": total_ms / n,
    }
    if verbose:
        print(f"\n参数: semanticRatio={sr}  matchingStrategy={ms}  k={k}")
        for q, tag, rank, hits, expect in rows:
            mark = "✅" if rank == 1 else ("🔸" if rank else "❌")
            print(f"  {mark} [{tag}] {q}")
            print(f"        期望 {expect}")
            print(f"        实得 {hits}" + (f"   (正确排名 {rank})" if rank else ""))
        m = metrics
        print(f"\n  top1={m['top1']:.2f}  MRR={m['mrr']:.3f}  recall@{k}={m[f'recall@{k}']:.2f}  "
              f"平均 {m['avg_ms']:.0f} ms")
    return metrics


def main():
    ap = argparse.ArgumentParser(description="Meilisearch 中文混合检索质量回归")
    ap.add_argument("--queries", required=True, help="带标注的查询集（JSONL）")
    ap.add_argument("--index", default="zh")
    ap.add_argument("--url", default="http://127.0.0.1:7700")
    ap.add_argument("--key", default=os.environ.get("MEILI_MASTER_KEY", ""))
    ap.add_argument("--embedder", default="zh")
    ap.add_argument("--k", type=int, default=3, help="评估的 top-k")
    ap.add_argument("--sr", type=float, default=None, help="semanticRatio；不传则不启用 hybrid")
    ap.add_argument("--ms", default=None, choices=["last", "all", "frequency"], help="matchingStrategy")
    ap.add_argument("--sweep", action="store_true", help="扫参数网格出对比表")
    args = ap.parse_args()

    if not args.key:
        raise SystemExit("缺少 --key（或设 MEILI_MASTER_KEY）")
    queries = load_queries(args.queries)
    print(f"查询集 {args.queries}：{len(queries)} 条")
    tags = {}
    for it in queries:
        tags[it.get("tag", "-")] = tags.get(it.get("tag", "-"), 0) + 1
    print("类型分布: " + ", ".join(f"{k}×{v}" for k, v in sorted(tags.items())) + "\n")

    if not args.sweep:
        evaluate(queries, args.url, args.key, args.index, args.sr, args.ms,
                 args.embedder, args.k, verbose=True)
        return

    grid = [(sr, ms) for sr in (0.0, 0.3, 0.5, 0.7, 1.0) for ms in ("last", "all", "frequency")]
    print(f"{'semanticRatio':>14} {'matchingStrategy':>17} {'top1':>7} {'MRR':>7} "
          f"{'recall@' + str(args.k):>10} {'avg_ms':>8}")
    print("-" * 70)
    best = None
    for sr, ms in grid:
        m = evaluate(queries, args.url, args.key, args.index, sr, ms, args.embedder, args.k)
        print(f"{sr:>14.1f} {ms:>17} {m['top1']:>7.2f} {m['mrr']:>7.3f} "
              f"{m[f'recall@{args.k}']:>10.2f} {m['avg_ms']:>8.0f}")
        if best is None or (m["mrr"], m["top1"]) > (best[0]["mrr"], best[0]["top1"]):
            best = (m, sr, ms)
    m, sr, ms = best
    print("-" * 70)
    print(f"最优: semanticRatio={sr}  matchingStrategy={ms}  "
          f"(top1={m['top1']:.2f}, MRR={m['mrr']:.3f})")


if __name__ == "__main__":
    main()

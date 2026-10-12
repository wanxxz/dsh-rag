#!/usr/bin/env python3
"""把本地中文文档切块并灌入 Meilisearch。

只用标准库。设计要点：
  - 按「标题层级 -> 段落 -> 中文标点」三级回退切分
  - 每块自带 title / section_path，满足 Meilisearch 官方「chunk 必须自包含」的要求
  - 过滤字段的值会截断到 156 汉字以内（Meilisearch 的 filterableAttributes 单值上限 468 字节）
  - 所有索引设置必须在灌库前定稿，改设置会触发全量重建

用法：
    # 先干跑，看切块统计和样例，不写库
    python ingest.py --src D:\\docs --dry-run

    # 正式灌库
    python ingest.py --src D:\\docs --index zh --key <master-key>

    # 控制切块
    python ingest.py --src D:\\docs --target 500 --max 900 --overlap 80 --dry-run
"""

import argparse
import hashlib
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

# Windows 控制台默认不是 UTF-8，中文输出会崩；强制切到 UTF-8
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):
            pass

TEXT_EXT = {".md", ".markdown", ".txt", ".jsonl", ".json", ".docx", ".pdf"}
BINARY_EXT = {".docx", ".pdf"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".obsidian", ".venv"}

# 中文断句点（也接受英文标点与换行）
SENT_END = "。！？；!?;"
MAX_FILTER_VALUE_BYTES = 468  # Meilisearch 硬限制
HEADING_RE = re.compile(r"^(#{1,6})\s+(.*)$")


# ---------------------------------------------------------------- 文件读取

def parse_frontmatter(text):
    """极简 YAML frontmatter 解析（只支持 key: value 与 key: [a, b] / 短横线列表）。"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    raw = text[3:end]
    body = text[end + 4:].lstrip("\n")
    meta, key = {}, None
    for line in raw.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith(("  - ", "- ")) and key:           # 列表项
            meta.setdefault(key, [])
            if isinstance(meta[key], list):
                meta[key].append(line.split("-", 1)[1].strip().strip("'\""))
            continue
        if ":" in line:
            key, _, val = line.partition(":")
            key, val = key.strip(), val.strip()
            if val.startswith("[") and val.endswith("]"):
                meta[key] = [v.strip().strip("'\"") for v in val[1:-1].split(",") if v.strip()]
            elif val == "":
                meta[key] = []
            else:
                meta[key] = val.strip("'\"")
    return meta, body


def clip(value, limit=MAX_FILTER_VALUE_BYTES):
    """按 UTF-8 字节截断，用于可过滤字段。"""
    if value is None:
        return ""
    s = str(value)
    while len(s.encode("utf-8")) > limit:
        s = s[:-1]
    return s


def normalize_date(value):
    s = str(value or "")
    m = re.search(r"(\d{4})[-/年]?(\d{1,2})?[-/月]?(\d{1,2})?", s)
    if not m:
        return "", None
    y, mo, d = m.group(1), m.group(2) or "01", m.group(3) or "01"
    return f"{y}-{int(mo):02d}-{int(d):02d}", int(y)


# ---------------------------------------------------------------- 二进制格式转换
# 思路：DOCX / PDF 先转成 Markdown，再走同一条中文切块管线。

W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def docx_to_markdown(path):
    """用标准库解析 DOCX（OOXML 就是一个 zip）。不依赖 python-docx。

    标题样式（Heading 1 / 标题 1 / Title）映射成 Markdown 的 #；
    表格按行转成 "a | b | c"，避免整表被拆散得看不出结构。
    """
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        if "word/document.xml" not in names:
            raise ValueError("不是有效的 DOCX（缺 word/document.xml）")
        root = ET.fromstring(z.read("word/document.xml"))

    body = root.find(f"{W_NS}body")
    if body is None:
        return ""
    lines = []
    for el in body:
        if el.tag == f"{W_NS}p":
            style = ""
            ppr = el.find(f"{W_NS}pPr")
            if ppr is not None:
                ps = ppr.find(f"{W_NS}pStyle")
                if ps is not None:
                    style = (ps.get(f"{W_NS}val") or "").strip()
            text = "".join(t.text or "" for t in el.iter(f"{W_NS}t")).strip()
            if not text:
                lines.append("")
                continue
            m = re.match(r"(?i)^(?:heading|标题|标题\s*)\s*(\d+)$", style) or re.match(r"(\d+)$", style)
            if style.lower() in ("title", "标题"):
                lines.append("# " + text)
            elif m:
                lines.append("#" * min(int(m.group(1)), 6) + " " + text)
            else:
                lines.append(text)
        elif el.tag == f"{W_NS}tbl":
            for row in el.findall(f"{W_NS}tr"):
                cells = []
                for tc in row.findall(f"{W_NS}tc"):
                    cells.append("".join(t.text or "" for t in tc.iter(f"{W_NS}t")).strip())
                if any(cells):
                    lines.append(" | ".join(cells))
            lines.append("")
    return "\n".join(lines)


def pdf_to_markdown(path):
    """PDF 提取文本：优先 PyMuPDF（版面还原最好），退回 pypdf（更轻）。

    ⚠️ 两个前提，缺一不可：
      1. **只对「有文本层」的 PDF 有效。扫描件提取出来是空的**，需要 OCR
         （docling / MinerU 那类，要 torch + 数 GB 依赖）。
      2. **PDF 必须内嵌了中文字体**。若原文档用无中文字形的字体（如 Calibri）
         再由某些导出器生成，中文字形会走回退字体、被分开绘制，
         导致提取出来的字序错乱（实测：同一份 DOCX，不指定中文字体时
         导出 PDF 提取结果乱序，显式指定 SimSun 后完全正确）。
    """
    # 1) PyMuPDF
    pymupdf = None
    try:
        import pymupdf
    except ImportError:
        try:
            import fitz as pymupdf          # 旧名
        except ImportError:
            pass
    if pymupdf is not None:
        doc = pymupdf.open(path)
        parts = []
        for i in range(doc.page_count):
            txt = (doc[i].get_text() or "").strip()
            if txt:
                parts.append(f"## 第 {i + 1} 页\n{txt}")
        return "\n\n".join(parts)

    # 2) pypdf
    try:
        from pypdf import PdfReader
    except ImportError:
        raise RuntimeError(
            "需要 PDF 解析库。用临时环境跑（不污染系统 Python）：\n"
            "    uv run --no-project --with pypdf -- python ingest.py ...\n"
            "或长期安装：pip install pypdf"
        )
    reader = PdfReader(path)
    parts = []
    for i, page in enumerate(reader.pages, 1):
        try:
            txt = (page.extract_text() or "").strip()
        except Exception as e:                                   # 单页失败不影响整体
            parts.append(f"## 第 {i} 页\n（本页提取失败：{e}）")
            continue
        if txt:
            parts.append(f"## 第 {i} 页\n{txt}")
    return "\n\n".join(parts)


def first_heading(text):
    """取正文里第一个 Markdown 标题，用作没有 frontmatter 时的 title。"""
    for line in text.splitlines():
        m = HEADING_RE.match(line.strip())
        if m:
            return m.group(2).strip()
    return ""


# ---------------------------------------------------------------- 切块

def split_sentences(text):
    """按中文标点切句，标点保留在句尾。"""
    out, buf = [], ""
    for ch in text:
        buf += ch
        if ch in SENT_END:
            out.append(buf)
            buf = ""
    if buf.strip():
        out.append(buf)
    return [s.strip() for s in out if s.strip()]


def chunk_section(body, target, hard_max, overlap):
    """把一个小节的正文切成若干块。先按段落聚合，超长再按句子切。"""
    paras = [p.strip() for p in re.split(r"\n\s*\n", body) if p.strip()]
    units = []
    for p in paras:
        if len(p) <= hard_max:
            units.append(p)
        else:
            units.extend(split_sentences(p))

    chunks, cur = [], ""
    for u in units:
        if len(cur) + len(u) + 1 <= target or not cur:
            cur = (cur + "\n" + u).strip() if cur else u
        else:
            chunks.append(cur)
            tail = cur[-overlap:] if overlap > 0 else ""
            cur = (tail + "\n" + u).strip() if tail else u
    if cur:
        chunks.append(cur)

    # 兜底：仍超硬上限的，按字符强制切
    final = []
    for c in chunks:
        while len(c) > hard_max:
            final.append(c[:hard_max])
            c = c[hard_max:]
        if c:
            final.append(c)
    return final


def iter_markdown(text):
    """按标题层级切小节，产出 (section_path, section_title, body)。"""
    stack, buf = [], []
    for line in text.splitlines():
        m = HEADING_RE.match(line)
        if m:
            if buf:
                yield " > ".join(stack), (stack[-1] if stack else ""), "\n".join(buf)
                buf = []
            level, title = len(m.group(1)), m.group(2).strip()
            stack = stack[: level - 1] + [title]
        else:
            buf.append(line)
    if buf:
        yield " > ".join(stack), (stack[-1] if stack else ""), "\n".join(buf)


def merge_sections(sections, target):
    """把相邻的小节合并到目标长度，避免"一小节一块"切出大量碎片。

    合并时把小节标题保留在正文里，所以块内结构不会丢；
    section_path 取该块第一个小节的路径。
    """
    merged, cur_path, cur_text = [], "", ""
    for path, stitle, body in sections:
        body = body.strip()
        if not body:
            continue
        piece = f"{stitle}\n{body}" if stitle else body
        if not cur_text:
            cur_path, cur_text = path, piece
        elif len(cur_text) + len(piece) + 1 <= target:
            cur_text += "\n" + piece
        else:
            merged.append((cur_path, cur_text))
            cur_path, cur_text = path, piece
    if cur_text:
        merged.append((cur_path, cur_text))
    return merged


def build_documents(src, target, hard_max, overlap):
    docs, stats = [], {"files": 0, "skipped": {}, "chunks": 0, "chars": 0}
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in sorted(files):
            path = os.path.join(root, fn)
            ext = os.path.splitext(fn)[1].lower()
            if ext not in TEXT_EXT:
                stats["skipped"][ext or "(无扩展名)"] = stats["skipped"].get(ext or "(无扩展名)", 0) + 1
                continue
            if ext in BINARY_EXT:
                try:
                    raw = docx_to_markdown(path) if ext == ".docx" else pdf_to_markdown(path)
                except Exception as e:                      # 缺依赖 / 文件损坏
                    key = f"{ext}（{type(e).__name__}）"
                    stats["skipped"][key] = stats["skipped"].get(key, 0) + 1
                    stats.setdefault("notes", []).append(f"{os.path.basename(path)}: {e}")
                    continue
            else:
                try:
                    raw = open(path, encoding="utf-8").read()
                except (UnicodeDecodeError, OSError):
                    stats["skipped"][ext + "(读失败)"] = stats["skipped"].get(ext + "(读失败)", 0) + 1
                    continue
            stats["files"] += 1

            if ext == ".jsonl" or ext == ".json":
                records = []
                if ext == ".jsonl":
                    for line in raw.splitlines():
                        if line.strip():
                            try:
                                records.append(json.loads(line))
                            except json.JSONDecodeError:
                                pass
                else:
                    try:
                        parsed = json.loads(raw)
                        records = parsed if isinstance(parsed, list) else [parsed]
                    except json.JSONDecodeError:
                        pass
                for rec in records:
                    did = str(rec.get("doc_id") or rec.get("id") or os.path.splitext(fn)[0])
                    title = str(rec.get("title") or did)
                    for i, c in enumerate(chunk_section(str(rec.get("text", "")), target, hard_max, overlap)):
                        docs.append(make_doc(did, i, title, "", c,
                                             rec.get("issuer") or rec.get("issuer_short"),
                                             rec.get("level") or rec.get("doc_type"),
                                             rec.get("publish_date")))
                continue

            meta, body = ({}, raw) if ext in BINARY_EXT else parse_frontmatter(raw)
            doc_id = str(meta.get("doc_id") or meta.get("id") or os.path.splitext(fn)[0])
            if meta.get("title"):
                title = str(meta["title"])
            elif ext == ".pdf":
                title = doc_id          # PDF 正文首行是「第 N 页」页标记，不如用文件名做标题
            else:
                title = first_heading(body) or doc_id
            issuer = meta.get("issuer") or meta.get("issuer_short")
            level = meta.get("level") or meta.get("doc_type")
            pub = meta.get("publish_date") or meta.get("date")
            tags = meta.get("tags") or meta.get("keywords") or []
            if isinstance(tags, str):
                tags = re.split(r"[,\s，]+", tags)
            kw = " ".join(t for t in tags if t)

            idx = 0
            for section_path, merged_text in merge_sections(iter_markdown(body), target):
                for c in chunk_section(merged_text, target, hard_max, overlap):
                    d = make_doc(doc_id, idx, title, section_path, c, issuer, level, pub)
                    if kw:
                        d["keywords"] = kw
                    docs.append(d)
                    idx += 1
    stats["chunks"] = len(docs)
    stats["chars"] = sum(len(d["text"]) for d in docs)
    return docs, stats


def make_doc(doc_id, idx, title, section_path, text, issuer, level, pub_date):
    iso, year = normalize_date(pub_date)
    # Meilisearch 主键只允许 ASCII 字母数字、-、_（中文和 # 都会被拒），
    # 所以用 doc_id 的哈希做前缀：ASCII、确定、重复灌库时覆盖而不是新增。
    digest = hashlib.sha1(doc_id.encode("utf-8")).hexdigest()[:10]
    return {
        "id": f"{digest}-{idx:04d}",
        "doc_id": clip(doc_id),
        "title": title,
        "section_path": section_path,
        "keywords": "",
        "text": text,
        "issuer_short": clip(issuer),
        "doc_type": clip(level),
        "publish_date": iso,
        "publish_year": year,
    }


# ---------------------------------------------------------------- 上传

def request(method, url, key=None, payload=None, timeout=120):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} on {method} {url}\n{e.read().decode('utf-8', 'replace')}")


def wait_task(base, key, uid, timeout=1800):
    deadline = time.time() + timeout
    while time.time() < deadline:
        t = request("GET", f"{base}/tasks/{uid}", key)
        st = t.get("status")
        if st in ("succeeded", "failed", "canceled"):
            return t
        time.sleep(1.0)
    return {"status": "timeout"}


def main():
    ap = argparse.ArgumentParser(description="中文文档切块并灌入 Meilisearch")
    ap.add_argument("--src", required=True, help="语料目录")
    ap.add_argument("--index", default="zh")
    ap.add_argument("--url", default="http://127.0.0.1:7700")
    ap.add_argument("--key", default=os.environ.get("MEILI_MASTER_KEY", ""))
    ap.add_argument("--target", type=int, default=500, help="目标块长（汉字数），建议 400-800")
    ap.add_argument("--max", type=int, default=900, dest="hard_max", help="硬上限")
    ap.add_argument("--overlap", type=int, default=0, help="块间重叠字符数，建议 0 或 50-100")
    ap.add_argument("--batch", type=int, default=5000, help="每批上传条数")
    ap.add_argument("--dry-run", action="store_true", help="只统计与抽样，不写库")
    ap.add_argument("--replace", action="store_true", help="先清空该索引的文档再灌")
    args = ap.parse_args()

    if not os.path.isdir(args.src):
        raise SystemExit(f"目录不存在: {args.src}")

    docs, stats = build_documents(args.src, args.target, args.hard_max, args.overlap)

    print(f"文件: {stats['files']}   块数: {stats['chunks']}   总字符: {stats['chars']}")
    if stats["chunks"]:
        lens = sorted(len(d["text"]) for d in docs)
        print(f"块长: 中位数 {lens[len(lens)//2]}  最小 {lens[0]}  最大 {lens[-1]}  平均 {stats['chars']//stats['chunks']}")
    if stats["skipped"]:
        print("跳过: " + ", ".join(f"{k}×{v}" for k, v in sorted(stats["skipped"].items())))
    for note in stats.get("notes", [])[:5]:
        print("  原因: " + note)
    if len(stats.get("notes", [])) > 5:
        print(f"  …另有 {len(stats['notes']) - 5} 条同类原因")

    docs_per_file = {}
    for d in docs:
        docs_per_file[d["doc_id"]] = docs_per_file.get(d["doc_id"], 0) + 1
    print(f"文档数: {len(docs_per_file)}   每文档块数中位数: "
          f"{sorted(docs_per_file.values())[len(docs_per_file)//2] if docs_per_file else 0}")

    # 嵌入耗时预估。系数来自规模彩排实测（8 逻辑核 CPU，见 README「规模彩排」）：
    #   bge-m3 约 10.3 ms/字符（404 块实测 1479 秒，预估误差 <15%）
    #   bge-small-zh-v1.5 约 0.6 ms/字符（340 块实测 70.8 秒）
    # 只估嵌入，不含上传/索引开销；换机器或换核数会变。
    if stats["chars"]:
        m3_h = stats["chars"] * 10.3 / 1000 / 3600
        sm_h = stats["chars"] * 0.6 / 1000 / 3600
        print(f"\n嵌入耗时预估（基于本机实测，仅供量级参考）:")
        print(f"  bge-m3（进程内 F32）  ≈ {m3_h:.1f} 小时")
        print(f"  bge-small-zh-v1.5     ≈ {sm_h:.1f} 小时")
        if m3_h > 3:
            print("  ⚠️ bge-m3 耗时较长（这是一次性成本）。注意只有**切块策略**和"
                  "**embedder 配置**改动才需要重新嵌入；\n"
                  "     停用词/同义词/字段权重等全文索引设置改一次只要零点几秒，可以随便迭代。")

    print("\n--- 抽样 2 块 ---")
    for d in docs[:2]:
        print(json.dumps({k: (v[:120] + "…" if k == "text" and len(v) > 120 else v)
                          for k, v in d.items()}, ensure_ascii=False, indent=2))

    if args.dry_run:
        print("\n[dry-run] 未写库。")
        return
    if not args.key:
        raise SystemExit("缺少 --key（master key）")

    if args.replace:
        r = request("DELETE", f"{args.url}/indexes/{args.index}/documents", args.key)
        wait_task(args.url, args.key, r["taskUid"])
        print("已清空原文档")

    total = len(docs)
    for i in range(0, total, args.batch):
        batch = docs[i:i + args.batch]
        r = request("POST", f"{args.url}/indexes/{args.index}/documents?primaryKey=id", args.key, batch)
        t = wait_task(args.url, args.key, r["taskUid"])
        flag = "OK" if t.get("status") == "succeeded" else f"!! {t.get('status')}"
        print(f"[{min(i + args.batch, total)}/{total}] {flag}")
        if t.get("status") != "succeeded":
            print(json.dumps(t.get("error"), ensure_ascii=False, indent=2))
            sys.exit(1)
    print("完成。下一步：等嵌入生成（GET /tasks 看 settingsUpdate/documentAddition 状态）。")


if __name__ == "__main__":
    main()

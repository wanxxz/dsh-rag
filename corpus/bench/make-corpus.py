"""生成合成中文政策语料，用于灌库规模彩排。

不用真实语料，只为了量出「N 份文档要多久、占多大、内存什么曲线」。

用法：
    python make-corpus.py --out bench/corpus --n 200
"""

import argparse
import os
import random

TOPICS = [
    ("分布式光伏发电项目管理办法", "分布式光伏", "屋顶光伏"),
    ("新型储能发展实施方案", "新型储能", "电化学储能"),
    ("绿色电力证书交易规则", "绿证", "可再生能源证书"),
    ("电力现货市场运营规则", "电力现货", "日前市场"),
    ("氢能产业发展中长期规划", "氢能", "燃料电池"),
    ("煤电机组灵活性改造通知", "煤电灵活性", "深度调峰"),
    ("农村电网巩固提升工程方案", "农村电网", "配变过载"),
    ("新能源上网电价市场化改革通知", "上网电价", "机制电价"),
    ("节能审查与能耗双控衔接办法", "节能审查", "能耗双控"),
    ("省级风电光伏竞争性配置方案", "竞争性配置", "风光指标"),
    ("抽水蓄能中长期发展规划", "抽水蓄能", "调峰填谷"),
    ("绿电交易实施细则", "绿电交易", "环境价值"),
]

ARTICLES = [
    "第{n}条 {t}项目应当依法依规办理{i}，不得设置法律法规之外的前置条件。",
    "第{n}条 电网企业应当为{t}提供便捷高效的{i}服务，自受理之日起{d}个工作日内完成答复。",
    "第{n}条 省级能源主管部门负责统筹{t}的{i}管理，并于每年{q}月底前报送年度执行情况。",
    "第{n}条 {t}项目年度规模不低于{v}万千瓦，其中保障性并网规模不低于{w}万千瓦。",
    "第{n}条 鼓励{t}参与电力市场交易，通过{i}等方式体现绿色环境价值。",
    "第{n}条 对未按期完成{i}的项目，由派出机构责令限期整改；逾期未整改的，暂停其并网申请。",
    "第{n}条 {t}价格按照现行政策执行，{y}年起新投产项目原则上通过竞价方式确定。",
    "第{n}条 各地应当加强{t}与国土空间规划、生态环境保护规划的衔接，不得占用永久基本农田。",
    "第{n}条 支持{t}开展{i}试点示范，对纳入示范清单的项目给予优先调度支持。",
    "第{n}条 本办法自{y}年{m}月{d}日起施行，有效期{v}年。",
]

SECTIONS = [
    "第一章 总则", "第二章 规划与规模管理", "第三章 并网与消纳",
    "第四章 价格与市场机制", "第五章 监督管理", "第六章 附则",
    "一、总体要求", "二、重点任务", "三、保障措施", "四、组织实施",
]

ISSUERS = ["国家发展改革委", "国家能源局", "国家发展改革委、国家能源局", "某省能源局", "某省发展改革委"]
LEVELS = ["部门规章", "规范性文件", "规划", "通知"]


def make_doc(rng, idx):
    title_base, topic, kw2 = rng.choice(TOPICS)
    year = rng.choice([2021, 2022, 2023, 2024, 2025])
    issuer = rng.choice(ISSUERS)
    level = rng.choice(LEVELS)
    doc_id = f"synth-{idx:05d}"

    lines = [f"# {title_base}（{year}年）", ""]
    n = 0
    for sec in rng.sample(SECTIONS, rng.randint(4, 7)):
        lines.append(f"## {sec}")
        lines.append("")
        for _ in range(rng.randint(2, 4)):
            n += 1
            tpl = rng.choice(ARTICLES)
            lines.append(tpl.format(
                n=n, t=topic, i=rng.choice(["备案", "并网", "核准", "交易", "结算", "监督", "验收"]),
                d=rng.choice([10, 15, 20, 30]), q=rng.choice([1, 3, 6, 9]),
                v=rng.choice([100, 300, 500, 800, 1000, 3000]),
                w=rng.choice([50, 100, 200]), y=rng.choice([2025, 2026, 2027]),
                m=rng.randint(1, 12),
            ))
        lines.append("")

    body = "\n".join(lines)
    front = (
        "---\n"
        f"doc_id: {doc_id}\n"
        f"title: {title_base}（{year}年）\n"
        f"doc_number: 国能发{rng.choice(['新能', '电力', '规划'])}〔{year}〕{rng.randint(1, 99)}号\n"
        f"issuer: {issuer}\n"
        f"level: {level}\n"
        f"publish_date: {year}-{rng.randint(1, 12):02d}-{rng.randint(1, 28):02d}\n"
        f"tags: [{topic}, {kw2}, {rng.choice(['并网', '补贴', '市场', '监管'])}]\n"
        "---\n\n"
    )
    return doc_id, front + body


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--n", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    os.makedirs(args.out, exist_ok=True)
    total = 0
    for i in range(1, args.n + 1):
        doc_id, text = make_doc(rng, i)
        with open(os.path.join(args.out, f"{doc_id}.md"), "w", encoding="utf-8") as f:
            f.write(text)
        total += len(text)
    print(f"已生成 {args.n} 份文档 → {args.out}")
    print(f"总字符 {total}，平均每份 {total // max(args.n, 1)} 字")


if __name__ == "__main__":
    main()

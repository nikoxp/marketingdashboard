/** 板块口径与层级标注(单一事实源)
 *
 *  实测基线(2026-09-29 本机直连上游, 回归见 board-taxonomy.test.ts):
 *  - 腾讯 `/api/boards?type=01`(mktHs/rank t=01)= 124 个板块, code = `pt01` + 6 位申万代码,
 *    与腾讯 `getRank?board_type=hy2` 的 124 个 `BK-HY-2` **集合完全相等** → 申万二级, 单层级。
 *  - 腾讯 `getRank?board_type=hy` → 31 个 `BK-HY-1` = 申万一级, 代码末位均为 `0`;
 *    二级 124 个代码末位均为 1..9。故: 末位 `0` = 一级, 其余 = 二级。
 *  - `/api/boards?type=02`(t=02)= 概念板块(804 个), 概念是单层口径, 无层级可言。
 *  - `/api/board-flow` 的 envelope.source ∈ {eastmoney, sina-hy, tencent-hy, sina-gn, last-good}:
 *    只有 eastmoney 是多层级混排(m:90+t:2), 其余均为单层口径。
 *
 *  用途: 榜单渲染前先按层级分组(只在组内排序/比较), 并把口径与层级显式写进 UI,
 *  避免低层(细分)板块与高层(大行业)板块被放进同一张榜按涨跌幅或绝对净额竞争。
 */

export type BoardFamily =
  | "sw-industry" // 腾讯申万行业(pt01 + 6 位申万代码)
  | "concept" // 腾讯概念(pt02*)
  | "region" // 腾讯地域(pt03*)
  | "sina-industry" // 新浪行业(new_* / gn_* / hangye_*)
  | "em-industry" // 东财行业(BK####)
  | "unknown";

export interface BoardScope {
  family: BoardFamily;
  /** 申万层级: 1=一级 / 2=二级 / null=来源不提供层级 */
  level: 1 | 2 | null;
  /** 口径全名, 如 "申万二级行业" / "概念板块" / "新浪行业板块" */
  label: string;
  /** 层级短标签, 无层级为 null */
  levelLabel: "一级" | "二级" | null;
}

const SW_INDUSTRY_CODE = /^pt01(\d{6})$/;
const SW_REGION_CODE = /^pt03/;
const TENCENT_CONCEPT_CODE = /^pt0[24]/i;
const SINA_BOARD_CODE = /^(new_|gn_|hangye_|zhishu_|diyu_|hs300$)/i;
const EM_BOARD_CODE = /^BK\d+/i;

/** 申万行业层级: 代码末位 `0` = 一级(31 个), 其余 = 二级(124 个); 非申万行业代码返回 null */
export function swIndustryLevel(code: string): 1 | 2 | null {
  const m = SW_INDUSTRY_CODE.exec(code || "");
  if (!m) return null;
  return m[1].endsWith("0") ? 1 : 2;
}

/** 板块 code → 口径/层级标注 */
export function boardScope(code: string): BoardScope {
  const c = code || "";
  if (SW_REGION_CODE.test(c)) return { family: "region", level: null, label: "地域板块", levelLabel: null };
  const sw = swIndustryLevel(c);
  if (sw === 1) return { family: "sw-industry", level: 1, label: "申万一级行业", levelLabel: "一级" };
  if (sw === 2) return { family: "sw-industry", level: 2, label: "申万二级行业", levelLabel: "二级" };
  if (TENCENT_CONCEPT_CODE.test(c)) return { family: "concept", level: null, label: "概念板块", levelLabel: null };
  if (SINA_BOARD_CODE.test(c)) return { family: "sina-industry", level: null, label: "新浪行业板块", levelLabel: null };
  if (EM_BOARD_CODE.test(c)) return { family: "em-industry", level: null, label: "东财行业板块", levelLabel: null };
  return { family: "unknown", level: null, label: "未标注板块", levelLabel: null };
}

/** 一组榜单的分层结果: 组内保持输入顺序(即该榜原有排序口径), 组间顺序 = 各组最佳名次先后 */
export interface BoardGroup<T> {
  key: string;
  label: string;
  level: 1 | 2 | null;
  items: T[];
}

/** 按口径/层级分组: 输入须已按目标口径排好序; 单层级榜单只会得到 1 个组(渲染不变) */
export function groupBoardsByScope<T extends { code: string }>(items: T[]): BoardGroup<T>[] {
  const groups = new Map<string, BoardGroup<T>>();
  for (const it of items) {
    const s = boardScope(it.code);
    const key = `${s.family}:${s.level ?? "flat"}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, label: s.label, level: s.level, items: [] };
      groups.set(key, g);
    }
    g.items.push(it);
  }
  return [...groups.values()];
}

/** 榜单口径摘要, 如 "申万二级行业 · 单一层级 · 124 个" / "申万一级行业 31 个 + 申万二级行业 124 个(分层)" */
export function boardScopeSummary<T extends { code: string }>(items: T[]): string {
  const groups = groupBoardsByScope(items);
  if (!groups.length) return "";
  if (groups.length === 1) return `${groups[0].label} · 单一层级 · ${groups[0].items.length} 个`;
  const detail = groups.map((g) => `${g.label} ${g.items.length} 个`).join(" + ");
  return `${detail}(分层展示)`;
}

/** 资金流源的层级说明(来自 /api/board-flow envelope.source) */
export interface BoardFlowScope {
  label: string;
  /** 该源是否为单一口径/单层级 */
  singleLevel: boolean;
  /** 排序口径与可比性说明(写进 UI, 不偷改口径) */
  note: string;
}

/** envelope.source → 口径/层级说明 */
export function boardFlowScope(source?: string): BoardFlowScope {
  switch (source) {
    case "sina-hy":
      return {
        label: "新浪行业板块",
        singleLevel: true,
        note: "新浪自有行业分类(接口不提供层级字段, 按单一口径使用), 与申万行业口径不同名不同集, 不可与其他面板的“行业”逐项对比",
      };
    case "sina-gn":
      return { label: "新浪概念板块", singleLevel: true, note: "新浪概念分类, 单一口径不分层" };
    case "tencent-hy":
      return { label: "申万一级行业", singleLevel: true, note: "腾讯申万一级(31 个), 单一层级" };
    case "eastmoney":
      return {
        label: "东财行业板块",
        singleLevel: false,
        note: "东财 m:90+t:2 为多层级板块混排(一级/二级/三级同榜), 且该接口无层级字段, 本口径下仅能按绝对净额排序",
      };
    case "last-good":
      return { label: "上次成功快照", singleLevel: false, note: "上游全失败时的降级快照, 口径随上次成功源" };
    default:
      return { label: "未知来源", singleLevel: false, note: "来源未标注, 口径不明" };
  }
}

/** 排序口径文案(资金流面板: 绝对额, 未做市值归一) */
export const FLOW_RANK_NOTE = "排序: 板块主力净额(绝对额) — 未做流通市值归一, 不同体量板块不可直接比较";

/** 排序口径文案(涨跌幅榜) */
export const pctRankNote = (dir: 0 | 1) => `排序: 涨跌幅 ${dir === 0 ? "降序(领涨)" : "升序(领跌)"}`;

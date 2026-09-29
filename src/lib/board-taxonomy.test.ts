// 板块口径/层级单一事实源的回归测试。
// 夹具 = 2026-09-29 本机实测: 腾讯 getRank?board_type=hy 的 31 个 BK-HY-1(=申万一级),
// 以及 /api/boards?type=01(mktHs/rank t=01)的 124 个板块 = getRank?board_type=hy2 的 124 个 BK-HY-2(申万二级)。
// 二者集合完全相等 → 该榜单本身是单层级, 本模块负责"按层级分组 + 标注口径", 保证分组后不跨层混排。
import { describe, expect, it } from "vitest";
import { boardFlowScope, boardScopeSummary, groupBoardsByScope, swIndustryLevel, boardScope, pctRankNote, FLOW_RANK_NOTE } from "./board-taxonomy";

/** 实测申万一级(腾讯 BK-HY-1, 31 个), 来源 getRank?board_type=hy */
const SW_L1 = [
  "pt01801010", "pt01801030", "pt01801040", "pt01801050", "pt01801080", "pt01801110",
  "pt01801120", "pt01801130", "pt01801140", "pt01801150", "pt01801160", "pt01801170",
  "pt01801180", "pt01801200", "pt01801210", "pt01801230", "pt01801710", "pt01801720",
  "pt01801730", "pt01801740", "pt01801750", "pt01801760", "pt01801770", "pt01801780",
  "pt01801790", "pt01801880", "pt01801890", "pt01801950", "pt01801960", "pt01801970",
  "pt01801980",
];

/** 实测 /api/boards?type=01 的 124 个板块(申万二级, 无一级/三级混入) */
const SW_L2 = [
  "pt01801012", "pt01801014", "pt01801015", "pt01801016", "pt01801017", "pt01801018", "pt01801032", "pt01801033",
  "pt01801034", "pt01801036", "pt01801037", "pt01801038", "pt01801039", "pt01801043", "pt01801044", "pt01801045",
  "pt01801051", "pt01801053", "pt01801054", "pt01801055", "pt01801056", "pt01801072", "pt01801074", "pt01801076",
  "pt01801077", "pt01801078", "pt01801081", "pt01801082", "pt01801083", "pt01801084", "pt01801085", "pt01801086",
  "pt01801092", "pt01801093", "pt01801095", "pt01801096", "pt01801101", "pt01801102", "pt01801103", "pt01801104",
  "pt01801111", "pt01801112", "pt01801113", "pt01801114", "pt01801115", "pt01801116", "pt01801124", "pt01801125",
  "pt01801126", "pt01801127", "pt01801128", "pt01801129", "pt01801131", "pt01801132", "pt01801133", "pt01801141",
  "pt01801142", "pt01801143", "pt01801145", "pt01801151", "pt01801152", "pt01801153", "pt01801154", "pt01801155",
  "pt01801156", "pt01801161", "pt01801163", "pt01801178", "pt01801179", "pt01801181", "pt01801183", "pt01801191",
  "pt01801193", "pt01801194", "pt01801202", "pt01801203", "pt01801204", "pt01801206", "pt01801218", "pt01801219",
  "pt01801223", "pt01801231", "pt01801711", "pt01801712", "pt01801713", "pt01801721", "pt01801722", "pt01801723",
  "pt01801724", "pt01801726", "pt01801731", "pt01801733", "pt01801735", "pt01801736", "pt01801737", "pt01801738",
  "pt01801741", "pt01801742", "pt01801743", "pt01801744", "pt01801745", "pt01801764", "pt01801765", "pt01801766",
  "pt01801767", "pt01801769", "pt01801782", "pt01801783", "pt01801784", "pt01801785", "pt01801881", "pt01801951",
  "pt01801952", "pt01801962", "pt01801963", "pt01801971", "pt01801972", "pt01801981", "pt01801982", "pt01801991",
  "pt01801992", "pt01801993", "pt01801994", "pt01801995",
];

const mixed = [
  { code: "pt01801096", name: "商用车", pct: 3.34 },   // 二级
  { code: "pt01801120", name: "食品饮料", pct: 2.10 }, // 一级
  { code: "pt01801017", name: "养殖业", pct: 2.03 },   // 二级
  { code: "pt01801080", name: "电子", pct: 1.50 },     // 一级
  { code: "pt01801161", name: "电力", pct: 0.18 },     // 二级
];

describe("swIndustryLevel — 申万层级判定(代码末位 0 = 一级)", () => {
  it("实测 31 个申万一级代码全部判为 1 级", () => {
    expect(SW_L1).toHaveLength(31);
    expect(SW_L1.filter((c) => swIndustryLevel(c) === 1)).toHaveLength(31);
  });
  it("实测 124 个二级榜单板块全部判为 2 级, 无一被判成一级", () => {
    expect(SW_L2).toHaveLength(124);
    expect(SW_L2.filter((c) => swIndustryLevel(c) === 2)).toHaveLength(124);
    expect(SW_L2.some((c) => c.endsWith("0"))).toBe(false);
  });
  it("一级与二级集合不相交", () => {
    expect(SW_L1.filter((c) => SW_L2.includes(c))).toHaveLength(0);
  });
  it("非申万行业代码不判层级", () => {
    for (const c of ["pt02GN2233", "pt02020003", "pt03001173", "new_qczz", "gn_zq", "BK0475"]) {
      expect(swIndustryLevel(c)).toBeNull();
    }
  });
  it("名称里的 Ⅱ 是申万二级命名(与更高级同名时加的罗马数字), 不代表第三层", () => {
    // 实测样本: 白酒Ⅱ/中药Ⅱ/国有大型银行Ⅱ 的代码末位均非 0 → 二级, 不存在 Ⅲ 级榜单
    for (const c of ["pt01801125", "pt01801155", "pt01801782"]) expect(swIndustryLevel(c)).toBe(2);
    expect(SW_L2.every((c) => boardScope(c).level === 2)).toBe(true);
  });
});

describe("boardScope — 口径标注", () => {
  it("申万一级/二级/概念/地域/新浪/东财 各自标注口径名", () => {
    expect(boardScope("pt01801120")).toMatchObject({ family: "sw-industry", level: 1, label: "申万一级行业" });
    expect(boardScope("pt01801096")).toMatchObject({ family: "sw-industry", level: 2, label: "申万二级行业" });
    expect(boardScope("pt02GN2233")).toMatchObject({ family: "concept", level: null, label: "概念板块" });
    expect(boardScope("pt02020003")).toMatchObject({ family: "concept", level: null, label: "概念板块" });
    expect(boardScope("pt03001173")).toMatchObject({ family: "region", level: null, label: "地域板块" });
    expect(boardScope("new_qczz")).toMatchObject({ family: "sina-industry", level: null, label: "新浪行业板块" });
    expect(boardScope("BK0475")).toMatchObject({ family: "em-industry", level: null, label: "东财行业板块" });
  });
});

describe("groupBoardsByScope — 榜内不跨层级混排", () => {
  it("单层级榜单只得到一个组, 组内保持原排序", () => {
    const g = groupBoardsByScope(mixed.filter((b) => !["pt01801120", "pt01801080"].includes(b.code)));
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("申万二级行业");
    expect(g[0].items.map((b) => b.name)).toEqual(["商用车", "养殖业", "电力"]);
  });
  it("多层级榜单拆成多个组, 组间按最佳名次排序, 组内保持原排序(不跨层比较)", () => {
    const g = groupBoardsByScope(mixed);
    expect(g.map((x) => x.label)).toEqual(["申万二级行业", "申万一级行业"]);
    expect(g[0].items.map((b) => b.name)).toEqual(["商用车", "养殖业", "电力"]);
    expect(g[1].items.map((b) => b.name)).toEqual(["食品饮料", "电子"]);
    // 分层只插入组边界: 每组内部次序 = 原榜单里该层板块的相对次序(不重排)
    for (const grp of g) {
      const expectIn = mixed.filter((b) => grp.items.some((x) => x.code === b.code));
      expect(grp.items.map((b) => b.code)).toEqual(expectIn.map((b) => b.code));
    }
  });
  it("概念榜(单层口径)只得到一个组", () => {
    const g = groupBoardsByScope([{ code: "pt02GN2233" }, { code: "pt02020003" }]);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe("概念板块");
  });
});

describe("boardScopeSummary / 排序口径文案", () => {
  it("单层级摘要写明口径与个数", () => {
    const items = mixed.filter((b) => swIndustryLevel(b.code) === 2);
    expect(items).toHaveLength(3);
    expect(boardScopeSummary(items)).toBe(`申万二级行业 · 单一层级 · 3 个`);
  });
  it("多层级摘要列出各组个数并标注分层展示", () => {
    expect(boardScopeSummary(mixed)).toBe("申万二级行业 3 个 + 申万一级行业 2 个(分层展示)");
  });
  it("空榜单不产出摘要", () => {
    expect(boardScopeSummary([])).toBe("");
  });
  it("涨跌幅排序文案区分领涨/领跌", () => {
    expect(pctRankNote(0)).toBe("排序: 涨跌幅 降序(领涨)");
    expect(pctRankNote(1)).toBe("排序: 涨跌幅 升序(领跌)");
  });
});

describe("boardFlowScope — 资金流源口径(不偷改口径)", () => {
  it("新浪行业为单一口径", () => {
    expect(boardFlowScope("sina-hy")).toMatchObject({ label: "新浪行业板块", singleLevel: true });
  });
  it("腾讯申万一级为单层", () => {
    expect(boardFlowScope("tencent-hy")).toMatchObject({ label: "申万一级行业", singleLevel: true });
  });
  it("东财为多层级混排且明确告知仅能按绝对净额排序", () => {
    const s = boardFlowScope("eastmoney");
    expect(s.singleLevel).toBe(false);
    expect(s.note).toContain("多层级");
  });
  it("未知来源不冒充已知口径", () => {
    expect(boardFlowScope(undefined).label).toBe("未知来源");
    expect(FLOW_RANK_NOTE).toContain("绝对额");
  });
});

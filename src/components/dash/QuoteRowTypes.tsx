import type { ReactNode } from "react";

/** 统一个股行 props(所有变体共享) */
export interface QuoteRowProps {
  code: string;
  name: string;
  price?: number;
  pct?: number;
  /** 底部标签(个股模式, 显示在行业/概念前) */
  tag?: string;
  rank?: number;
  /** 成交额(元格式化文本, IndexPanel 直接传文本) */
  amount?: string;
  turnover?: string;
  /** 显示分时曲线(60s 轮询) — compact 模式下配合 sparkData 使用 */
  spark?: boolean;
  /** 显示所属行业/概念(5min 重试, 服务端 24h 缓存) */
  boards?: boolean;
  /** 显示主力净额/净占比(东财口径, 30s 轮询) */
  flow?: boolean;
  /** card = 带边框的卡片样式(产业链); compact = 单行商品行; index = 指数四列(徽标|名称+代码|分时/成交额|点位/涨幅) */
  variant?: "plain" | "card" | "compact" | "index";
  active?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  className?: string;
  /** 名称下方副文本 — compact 模式传入单位("元/吨"), 其他模式不传时显示 code */
  unit?: string;
  /** 外部 Spark 数据 — 传入则直接渲染, 跳过内部 minute 轮询 */
  sparkData?: {
    points: { t: string; p: number }[];
    prec: number;
    session?: "ashare" | "h24" | "daily";
  };
  /** 分时区占位文本(降级提示, 如汇率 "分时暂不可用·上游限流") — 无分时数据时替代 "——" 诚实显示 */
  sparkNote?: string;
  /** 左侧彩色 accent 竖条(商品面板强调色) */
  accent?: string;
  /** 名称前短徽标(IndexPanel 传地区简写: CN/US/HK/FX) */
  badge?: string;
  /** 现期对照(基差)行: 品种 | 现货 | 期货 | 基差 | 基差率 — 仅 compact 模式使用 */
  basis?: { spot: number; futures: number; basis: number; basisPct: number };
  /** 附加财务列(财报列表): 每列上下两值, 与价/幅同一网格 — 仅 plain 模式使用 */
  extraCols?: { top?: ReactNode; bottom?: ReactNode; w: number }[];
  /** 前置列(财报预告的日期+趋势pill, 渲染在名称之前) — 仅 plain 模式使用 */
  leadingCols?: { top?: ReactNode; bottom?: ReactNode; w: number }[];
  /** 分时图同列附加内容(财报预告的净利/同比区间, 小字标签前置) — 仅 plain 模式使用 */
  sparkExtra?: ReactNode;
}

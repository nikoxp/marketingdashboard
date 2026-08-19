import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTv } from "@/lib/tv";
import { hostingToken, hostingLayout, hostingLayoutSave } from "@/lib/hosting";
import { loadJson, saveJson } from "@/lib/storage";

export interface ZoomPanelDef {
  id: string;
  defaultW: number;
  /** 放大宽度上限(0~1, 默认 0.5): 宽图表面板放大过宽时收紧 */
  maxZoomW?: number;
}

export interface ZoomRowDef {
  defaultH: number;
  panels: ZoomPanelDef[];
}

export interface PanelLayout {
  rowHeights: number[];
  rowWidths: number[][];
}

export interface PanelZoomOptions {
  /** 页面标识(持久化隔离): home/goods/fin 各页独立; 缺省 "home" */
  pageKey?: string;
}

/** 持久化写入 debounce(ms): toggle 连点只发最后一次, 防服务端写放大 */
const SAVE_DEBOUNCE_MS = 500;

/**
 * 面板缩放状态 + 持久化(0819-d: host 版跨设备同步 zoom):
 * - 托管模式(有 hostingToken): 挂载时 hostingLayout() 拉取恢复(按 pageKey), toggle 后 debounce 写服务端
 * - 开源模式: localStorage(key: dash:zoom:<pageKey>), 刷新后恢复
 * - TV 模式(?tv=1): 不持久化, 行为与以往完全一致
 * - 恢复时校验 id 存在于 rows 才 setZoomedId(防脏数据); 服务端失败静默降级不阻塞看板
 */
export function usePanelZoom(rows: ZoomRowDef[], options?: PanelZoomOptions) {
  const pageKey = options?.pageKey || "home";
  const [zoomedId, setZoomedId] = useState<string | null>(null);

  // 恢复完成前不写回(避免挂载时把初始 null 覆盖掉服务端/本地已存状态)
  const restoredRef = useRef(false);
  // 托管模式(有 token)快照 — 挂载时判定一次, 会话内不翻转
  const hostedRef = useRef(false);
  // TV 模式: 整个 hook 不持久化(仅内存态)
  const tvRef = useRef(isTv);

  const isZoomed = useCallback((id: string) => zoomedId === id, [zoomedId]);

  // 用户手动操作过 → restore 不覆盖(防"先点击后服务端恢复值到达"竞态覆盖用户选择)
  const userTouchedRef = useRef(false);
  const toggle = useCallback((id: string) => {
    userTouchedRef.current = true;
    setZoomedId((prev) => (prev === id ? null : id));
  }, []);

  const reset = useCallback(() => {
    userTouchedRef.current = true;
    setZoomedId(null);
  }, []);

  /** 恢复值校验: id 必须是当前 rows 里的面板 id(防脏数据/版本错位) */
  const isValidId = useCallback(
    (id: string | null): id is string => !!id && rows.some((r) => r.panels.some((p) => p.id === id)),
    [rows]
  );

  // 挂载: 恢复持久化 zoom(托管 → 服务端; 开源 → localStorage)
  useEffect(() => {
    if (tvRef.current) { restoredRef.current = true; return; }
    let alive = true;
    (async () => {
      const hosted = !!hostingToken();
      hostedRef.current = hosted;
      let id: string | null = null;
      try {
        if (hosted) {
          const obj = await hostingLayout();
          if (alive && obj && typeof obj === "object") id = obj[pageKey] ?? null;
        } else {
          id = loadJson<string | null>(`dash:zoom:${pageKey}`, null);
        }
      } catch {
        // 服务端暂不可用: 静默降级为默认布局, 不阻塞首屏(参照 WatchlistPanel)
      }
      if (!alive) return;
      if (isValidId(id) && !userTouchedRef.current) setZoomedId(id);
      restoredRef.current = true;
    })();
    return () => { alive = false; };
  }, [pageKey, isValidId]);

  // zoomedId 变化 → debounce 写回。写回防抖基线(prevZoomedRef):
  // 首跑只记录基线不写; 恢复未完成(托管异步 GET)时, 用户已手动操作则立即放行写回,
  // 否则等待 restore 完成(避免把未恢复的初始态提前写掉, 或把用户操作基线化丢失)
  const prevZoomedRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (tvRef.current) return;
    if (prevZoomedRef.current === undefined) { prevZoomedRef.current = zoomedId; return; }
    if (prevZoomedRef.current === zoomedId) return;
    prevZoomedRef.current = zoomedId;
    if (!restoredRef.current && !userTouchedRef.current) return; // 恢复未完成且用户未操作: 等 restore
    const t = setTimeout(() => {
      if (hostedRef.current) {
        // 只传本页 key, 服务端 merge 保证其他页面不受影响
        hostingLayoutSave({ [pageKey]: zoomedId }).catch(() => { /* 写失败静默, 下次 toggle 再试 */ });
      } else {
        saveJson(`dash:zoom:${pageKey}`, zoomedId);
      }
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [zoomedId, pageKey]);

  const layout = useMemo<PanelLayout>(() => {
    const rowHeights = rows.map((r) => r.defaultH);
    const rowWidths = rows.map((r) => r.panels.map((p) => p.defaultW));

    if (!zoomedId) return { rowHeights, rowWidths };

    // 找到被放大面板
    let zRow = -1;
    let zIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const idx = rows[i].panels.findIndex((p) => p.id === zoomedId);
      if (idx >= 0) {
        zRow = i;
        zIdx = idx;
        break;
      }
    }
    if (zRow < 0) return { rowHeights, rowWidths };

    const w0 = rows[zRow].panels[zIdx].defaultW;
    const h0 = rows[zRow].defaultH;
    const targetArea = 4 * w0 * h0;
    // 放大宽度上限: 默认 50%, 面板可自定义收紧(宽图表面板)
    const wCap = rows[zRow].panels[zIdx].maxZoomW ?? 0.5;

    let w1: number;
    let h1: number;
    if (w0 >= 0.5) {
      // 原宽度已达/超过上限：保持原宽度，仅增加高度（上限 66%）
      w1 = w0;
      h1 = Math.min(targetArea / w0, 0.66);
    } else {
      // 中小面板：宽度可扩张至 2 倍但不超过上限，高度不超过 66%
      w1 = Math.min(w0 * 2, wCap);
      h1 = Math.min(targetArea / w1, 0.66);
    }

    // 更新行高
    const newRowHeights = [...rowHeights];
    newRowHeights[zRow] = h1;
    const remainH = 1 - h1;
    const otherRowsH0 = rowHeights.reduce((s, h, i) => (i === zRow ? s : s + h), 0);
    for (let i = 0; i < rows.length; i++) {
      if (i !== zRow) newRowHeights[i] = (remainH * rowHeights[i]) / otherRowsH0;
    }

    // 更新被放大行内的列宽
    const newRowWidths = rowWidths.map((ws) => [...ws]);
    const remainW = 1 - w1;
    const siblingsW0 = rowWidths[zRow].reduce((s, w, i) => (i === zIdx ? s : s + w), 0);
    newRowWidths[zRow][zIdx] = w1;
    for (let i = 0; i < rowWidths[zRow].length; i++) {
      if (i !== zIdx) newRowWidths[zRow][i] = (remainW * rowWidths[zRow][i]) / siblingsW0;
    }

    return { rowHeights: newRowHeights, rowWidths: newRowWidths };
  }, [rows, zoomedId]);

  return {
    zoomedId,
    isZoomed,
    toggle,
    reset,
    layout,
  };
}

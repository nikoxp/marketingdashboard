// 托管模式上下文(0819-a 起): HostingGate 探测结果(enabled) 经 React context 下发,
// 供 Dashboard 导航过滤 / 路由守卫 / AiDashboard 额度条等消费, 复用好同一次探测。
// 独立成文件避免 AiDashboard import App.tsx 造成循环依赖。
import { createContext, useContext } from "react";

export const HostingContext = createContext(false);

export function useHosting(): boolean {
  return useContext(HostingContext);
}

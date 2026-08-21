// UTM 引流埋点(0820-m2 庄子指令): 只读 utm_* 渠道参数, 同会话仅上报一次。
// 参照 leaderboard 成熟实现(company-site/leaderboard/index.html 0819-x Gavin 指令模式), 勿自创。
// 隐私红线: 不上报 IP/UA/referrer, 与 knock utm_visits 现有口径一致(server/knock/routes.cjs cleanUtm)。
// fire-and-forget, 失败静默绝不影响渲染/用户。SPA 路由切换不重复上报(模块仅执行一次 + sessionStorage 兜底)。
const UTM_STORAGE_KEY = 'mrd_utm_reported'

export function initUtmTracking(): void {
  try {
    const q = new URLSearchParams(window.location.search)
    const src = q.get('utm_source')
    const med = q.get('utm_medium')
    const cam = q.get('utm_campaign')
    if (!src && !med && !cam) return // 无 UTM 参数不上报(不污染统计)
    if (sessionStorage.getItem(UTM_STORAGE_KEY)) return // 同会话去重(30s 自动刷新 URL 仍带参, 防重复计数)
    sessionStorage.setItem(UTM_STORAGE_KEY, '1')
    const u =
      'https://hermes.cc.cd/api/v1/knock/track?utm_source=' + encodeURIComponent(src || '') +
      '&utm_medium=' + encodeURIComponent(med || '') +
      '&utm_campaign=' + encodeURIComponent(cam || '')
    fetch(u, { method: 'GET', cache: 'no-store', mode: 'cors', referrerPolicy: 'no-referrer' })
      .catch(() => {}) // 失败静默, 绝不影响渲染/用户
  } catch {
    /* 埋点异常不影响页面 */
  }
}

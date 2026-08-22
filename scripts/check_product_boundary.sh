#!/usr/bin/env bash
# ============================================================================
# check_product_boundary.sh — mrd 仓库产品边界红线检查（P0-3c）
#
# 防止 mrd 仓再次混入 OPC / 官网 / 营销 / 客服代码。CI 或提交前手动跑：
#     scripts/check_product_boundary.sh [--selftest]
#
# 检查范围：
#   A. server/index.cjs 不得出现非 mrd 产品 API 路由关键字
#      （opc / kanban / blog / visits / contact / assistant / feedback / acquisition，
#       含 /api/ 与 /api/v1/ 前缀形态）
#   B. server/lib/ + server/sources/ 不得出现非 mrd 模块文件
#   C. server/data/ 不得出现非 mrd 数据文件（visits/blog/contact/assistant/feedback/knock/demo 等）
#
# mrd 本体保留项（排除词，不得误报）：
#   - /api/rank、server/lib/qq-rank.cjs   → mrd 行情数据源（东财涨跌幅排行 / 腾讯板块榜）
#   - /api/leads + server/data/leads.json → mrd Pro 预注册
#   - /api/v1/knock/* 302 重定向          → knock 迁出过渡路径（P0-3a 保留，最终删除）
#   - /company/opc/status.json            → dist 静态服务（官网成员数 fetch 数据源，红线保留）
#   - server/hosting/、HOSTING=1          → mrd 托管版（mrd-pro 私有仓注入）
#
# 退出码：0 = PASS（边界干净）；1 = FAIL（发现混入）；2 = 用法/环境错误
# ============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# 默认仓库根 = 脚本所在目录的上一级；--selftest 时可用 CHECK_ROOT 指向夹具
REPO_ROOT="${CHECK_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
INDEX="$REPO_ROOT/server/index.cjs"

SELFTEST=0
[ "${1:-}" = "--selftest" ] && SELFTEST=1
[ $# -gt 0 ] && [ "${1:-}" != "--selftest" ] && {
  echo "用法: $0 [--selftest]" >&2
  exit 2
}

fail=0
ok()  { printf '  [PASS] %s\n' "$1"; }
bad() { printf '  [FAIL] %s\n' "$1"; fail=1; }

echo "== mrd 产品边界检查（repo: $REPO_ROOT）=="

# ---------- A. server/index.cjs 非 mrd API 路由关键字 ----------
ROUTE_RE='api/(v1/)?(opc|kanban|blog|visits|contact|assistant|feedback|acquisition)'
echo "-- A. server/index.cjs 非 mrd API 路由关键字 --"
if [ ! -f "$INDEX" ]; then
  bad "server/index.cjs 不存在（$INDEX）—— 脚本需位于仓库 scripts/ 下运行"
else
  hits=$(grep -nE "$ROUTE_RE" "$INDEX" || true)
  if [ -n "$hits" ]; then
    bad "发现非 mrd API 路由关键字（$ROUTE_RE）："
    printf '%s\n' "$hits" | sed 's/^/      /'
  else
    ok "无 $ROUTE_RE 命中（排除词：/api/rank、qq-rank、/api/leads、/api/v1/knock、/company/opc/status.json）"
  fi
fi

# ---------- B. server/lib/ + server/sources/ 非 mrd 模块 ----------
echo "-- B. server/lib/ + server/sources/ 非 mrd 模块 --"
for d in lib sources; do
  dir="$REPO_ROOT/server/$d"
  [ -d "$dir" ] || continue
  while IFS= read -r f; do
    base=$(basename "$f")
    case "$base" in
      blog.cjs|contact.cjs|assistant.cjs|feedback.cjs|workbench.cjs|demo-stream.cjs|acquisition.cjs|knock-standalone.cjs|knock.test.cjs|start_knock.sh)
        bad "非 mrd 模块残留：server/$d/$base" ;;
    esac
  done < <(find "$dir" -maxdepth 1 -type f 2>/dev/null)
done
[ "$fail" -eq 0 ] && ok "server/lib/ + server/sources/ 无非 mrd 模块"

# ---------- C. server/data/ 非 mrd 数据文件 ----------
echo "-- C. server/data/ 非 mrd 数据文件 --"
data_dir="$REPO_ROOT/server/data"
if [ -d "$data_dir" ]; then
  while IFS= read -r f; do
    base=$(basename "$f")
    case "$base" in
      visits.json|blog-comments.json|blog-views.json|contact.jsonl|assistant-leads.jsonl|assistant-leads.processed.json|feedback-messages.jsonl|token-stats.json|knock.db|knock.db-shm|knock.db-wal|knock.db-bak|demo*)
        bad "非 mrd 数据残留：server/data/$base" ;;
    esac
  done < <(find "$data_dir" -maxdepth 1 \( -type f -o -type d \) 2>/dev/null)
fi
[ "$fail" -eq 0 ] && ok "server/data/ 无非 mrd 数据文件"

# ---------- 自测（--selftest）----------
if [ "$SELFTEST" -eq 1 ]; then
  echo "-- 自测：注入违规路由的夹具必须被检出 --"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  mkdir -p "$tmp/server"
  cp "$INDEX" "$tmp/server/index.cjs"
  # 注入一条非 mrd 路由（模拟误混入）→ 期望 A 节检出 FAIL
  printf '\n  // selftest fixture\n  if (u.pathname.startsWith("/api/opc/stream")) return;\n' >> "$tmp/server/index.cjs"
  if CHECK_ROOT="$tmp" "$0" 2>/dev/null | grep -q 'FAIL'; then
    ok "自测：注入 /api/opc/stream 后脚本正确 FAIL"
  else
    bad "自测失败：注入违规路由未被检出"
  fi
  # 当前仓（已清理）必须 PASS —— 证明不误报 mrd 本体关键字
  if [ "$fail" -eq 0 ]; then
    ok "自测：当前仓（/api/rank、qq-rank、/api/leads、/api/v1/knock、/company/opc/status.json）无误报"
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "== 结果: PASS — mrd 仓库边界干净 =="
  exit 0
else
  echo "== 结果: FAIL — 发现非 mrd 产品代码混入，请移入对的产品仓（见 CLAUDE.md「产品边界」）=="
  exit 1
fi

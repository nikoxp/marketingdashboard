#!/bin/bash
# mrd 全端点回归冒烟测试 — 重构前后各跑一次对比
# 用法: bash scripts/smoke_test.sh [输出文件]
OUT="${1:-/tmp/mrd-smoke-$(date +%H%M%S).txt}"
BASE="${2:-http://localhost:3000}"
echo "=== mrd smoke test $(date '+%F %T') ===" > "$OUT"
echo "base: $BASE" >> "$OUT"
PASS=0; FAIL=0; FAILED=()

check() {
  local name="$1" url="$2"
  local code body
  body=$(curl -s --max-time 20 -o /tmp/smoke-body.json -w "%{http_code}" "$BASE$url" 2>/dev/null)
  code=$?
  if [ "$code" = "0" ] && [ "$body" = "200" ]; then
    # JSON 有效性
    if python3 -c "import json;json.load(open('/tmp/smoke-body.json'))" 2>/dev/null; then
      echo "PASS  $name  ($url)" >> "$OUT"
      PASS=$((PASS+1))
    else
      echo "FAIL  $name  ($url) — HTTP $body but invalid JSON" >> "$OUT"
      FAIL=$((FAIL+1)); FAILED+=("$name")
    fi
  else
    echo "FAIL  $name  ($url) — HTTP ${body:-timeout}" >> "$OUT"
    FAIL=$((FAIL+1)); FAILED+=("$name")
  fi
}

# futures 专用: 断言响应 data 必须包含请求的内盘(nf_)与全部 hf_ key;
# BTCUSDT 允许缺失(上游 Binance/OKX 不可达属基线常态)
check_futures() {
  local name="$1" url="$2" required="$3"
  local code body
  body=$(curl -s --max-time 25 -o /tmp/smoke-body.json -w "%{http_code}" "$BASE$url" 2>/dev/null)
  code=$?
  if [ "$code" = "0" ] && [ "$body" = "200" ]; then
    local missing
    missing=$(python3 -c "
import json
d = json.load(open('/tmp/smoke-body.json')).get('data', {})
req = [k for k in '$required'.split(',') if k]
miss = [k for k in req if k not in d]
print(','.join(miss))
" 2>/dev/null)
    if [ -z "$missing" ]; then
      echo "PASS  $name  ($url)" >> "$OUT"
      PASS=$((PASS+1))
    else
      echo "FAIL  $name  ($url) — 缺失: $missing" >> "$OUT"
      FAIL=$((FAIL+1)); FAILED+=("$name")
    fi
  else
    echo "FAIL  $name  ($url) — HTTP ${body:-timeout}" >> "$OUT"
    FAIL=$((FAIL+1)); FAILED+=("$name")
  fi
}

# 无参端点
check health /api/health
check stats /api/stats
check news /api/news
check rank /api/rank
check boards /api/boards
check spot-table /api/spot-table
check spend-index /api/spend-index
check treasuries /api/treasuries
check treasury-history /api/treasury-history
check moneyflow /api/moneyflow
check board-flow /api/board-flow
check aa-models /api/aa-models
check token-stats /api/token-stats

# 带参端点
check quotes "/api/quotes?codes=sh000001,sz399001,hf_GC"
check minute "/api/minute?code=sh000001"
check batch-minute "/api/batch-minute?codes=sh000001,sz399001"
check batch-fmin "/api/batch-fmin?codes=sh000001,sz399001"
check_futures futures-hf "/api/futures?list=hf_GC,hf_XAU" "hf_GC,hf_XAU"
check_futures futures-nf "/api/futures?list=nf_AU0,nf_AG0" "nf_AU0,nf_AG0"
check_futures futures-mixed "/api/futures?list=hf_GC,hf_SI,nf_AU0,nf_CU0" "hf_GC,hf_SI,nf_AU0,nf_CU0"

# ai-infra: 断言 series 14 年(2022-2035)且五字段齐全
check_ai_infra() {
  local name="$1" url="$2"
  local body
  body=$(curl -s --max-time 60 -o /tmp/smoke-body.json -w "%{http_code}" "$BASE$url" 2>/dev/null)
  if [ "$body" = "200" ]; then
    local ok
    ok=$(python3 -c "
import json
d = json.load(open('/tmp/smoke-body.json')).get('data', {})
s = d.get('series', [])
years = [p.get('year') for p in s]
fields = all(all(k in p for k in ('capexB','grid','costPerM','pricePerM','roiPct','actual')) for p in s)
print('OK' if len(s) == 14 and years == list(range(2022, 2036)) and fields else 'BAD')
" 2>/dev/null)
    if [ "$ok" = "OK" ]; then
      echo "PASS  $name  ($url) — 14年序列完整"
      PASS=$((PASS + 1))
    else
      echo "FAIL  $name  ($url) — 序列异常: $ok"
      FAIL=$((FAIL + 1))
    fi
  else
    echo "FAIL  $name  ($url) — HTTP $body"
    FAIL=$((FAIL + 1))
  fi
}
check_ai_infra ai-infra "/api/ai-infra"
check future-minute "/api/future-minute?code=hf_GC"
check future-daily "/api/future-daily?code=hf_GC"
check stock-boards "/api/stock-boards?code=sh600519"
check stock-flow "/api/stock-flow?code=sh600519"
check stock-flows "/api/stock-flows?codes=sh600519,sz000001"
check stock-search "/api/stock-search?kw=茅台"
check finance-main "/api/finance-main?code=sh600519"
check finance-board "/api/finance-board?code=sh600519"
check finance-forecast "/api/finance-forecast?code=sh600519"
check chem-spot "/api/chem-spot?code=1234"
check mystery-select "/api/mystery-select?q=贵州茅台"

# POST 端点
check chain-parse-post "/api/chain-parse" # POST 需带 body, 单独处理
body=$(curl -s --max-time 20 -X POST -H "Content-Type: application/json" -d '{"name":"测试链","content":"上游: 公司A,公司B\n中游: 公司C"}' -o /tmp/smoke-body.json -w "%{http_code}" "$BASE/api/chain-parse" 2>/dev/null)
if [ "$body" = "200" ] && python3 -c "import json;json.load(open('/tmp/smoke-body.json'))" 2>/dev/null; then
  echo "PASS  chain-parse-post  (/api/chain-parse)" >> "$OUT"; PASS=$((PASS+1))
else
  echo "FAIL  chain-parse-post  (/api/chain-parse) — HTTP $body" >> "$OUT"; FAIL=$((FAIL+1)); FAILED+=("chain-parse-post")
fi

# openrouter-usage (需 key, 可能 500 属预期)
code=$(curl -s --max-time 20 -o /dev/null -w "%{http_code}" "$BASE/api/openrouter-usage" 2>/dev/null)
if [ "$code" = "200" ] || [ "$code" = "500" ]; then
  echo "PASS  openrouter-usage  (/api/openrouter-usage) — HTTP $code (500=无key属预期)" >> "$OUT"; PASS=$((PASS+1))
else
  echo "FAIL  openrouter-usage  (/api/openrouter-usage) — HTTP $code" >> "$OUT"; FAIL=$((FAIL+1)); FAILED+=("openrouter-usage")
fi

echo "" >> "$OUT"
echo "=== 结果: $PASS 通过 / $FAIL 失败 ===" >> "$OUT"
echo "失败项: ${FAILED[*]:-无}" >> "$OUT"
cat "$OUT"
exit $FAIL

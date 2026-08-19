#!/usr/bin/env bash
# 手速排行榜独立进程启动脚本(0819-i): node server/knock-standalone.cjs 监听 :3032。
# 与 mrd 现状一致的裸 node 后台托管, 不引入新依赖; 留痕: PID 文件 + 日志文件。
# 用法: bash server/start_knock.sh {start|stop|restart|status}
#   start   — 后台启动(幂等: 已在跑则提示)
#   stop    — 按 PID 文件停止
#   restart — stop + start
#   status  — 查看进程/端口/最近日志
set -u
cd "$(dirname "$0")/.." || exit 1

PORT="${KNOCK_PORT:-3032}"
PIDFILE="server/data/knock.pid"
LOGFILE="server/data/knock.log"

ensure_dir() { mkdir -p "$(dirname "$PIDFILE")"; }

is_running() { [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; }

cmd_start() {
  if is_running; then
    echo "[knock] 已在运行 PID=$(cat "$PIDFILE") 端口=${PORT} (日志: $LOGFILE)"; exit 0
  fi
  ensure_dir
  # setsid 脱离会话 + nohup 免疫挂断; 输出重定向留痕, 失败退出码透传
  nohup setsid node server/knock-standalone.cjs >>"$LOGFILE" 2>&1 &
  echo $! >"$PIDFILE"
  sleep 1
  if is_running; then
    echo "[knock] 已启动 PID=$(cat "$PIDFILE") 端口=${PORT} (日志: $LOGFILE)"
  else
    echo "[knock] 启动失败, 最近日志:"; tail -20 "$LOGFILE" 2>/dev/null; rm -f "$PIDFILE"; exit 1
  fi
}

cmd_stop() {
  if is_running; then
    kill "$(cat "$PIDFILE")" && rm -f "$PIDFILE"
    echo "[knock] 已停止"
  else
    rm -f "$PIDFILE"; echo "[knock] 未在运行"
  fi
}

cmd_status() {
  if is_running; then
    echo "[knock] running PID=$(cat "$PIDFILE") 端口=${PORT} 日志=$LOGFILE"
    ss -tlnp 2>/dev/null | grep ":$PORT " || echo "[knock] 注意: 端口 ${PORT} 未监听(可能未就绪)"
    echo "--- 最近日志 ---"; tail -5 "$LOGFILE" 2>/dev/null
  else
    echo "[knock] not running"; exit 1
  fi
}

case "${1:-}" in
  start)   cmd_start ;;
  stop)    cmd_stop ;;
  restart) cmd_stop; cmd_start ;;
  status)  cmd_status ;;
  *) echo "用法: $0 {start|stop|restart|status}"; exit 2 ;;
esac

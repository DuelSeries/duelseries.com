#!/usr/bin/env bash
# The server split's one switch (spec section 13), run ON THE BOX from the app directory:
#
#   bash scripts/sl-split.sh off      one process (SL_SPLIT=0): the rollback
#   bash scripts/sl-split.sh on       free slither and the battle royale in their own process (SL_SPLIT=1)
#   bash scripts/sl-split.sh status   the mode, both processes, who answers /sl-io/, free memory, restarts
#
# on and off set SL_SPLIT in .env (never through pm2's environment: then .env and pm2 would disagree about the
# switch), restart the one pm2 app (the slither process is a fork inside it), wait up to 90 s for /api/live to answer
# twice in a row with no "unknown" (every game reporting, the slither process included), then check who answers the
# slither path locally and through nginx (x-ds-proc: main or sl). Each prints OK <mode> or FAILED <step>.
#
# A restart settles seated paid money to owed rows, as every deploy does, but do it when nobody has money on the table:
# this refuses while /api/live shows a paid seat, or cannot tell (it did not answer, or it could not read a game that
# holds money); pass --force to go anyway. nginx is never edited here: its
# location /sl-io/ (deploy/nginx-sl-io.conf) sends the path to SL_CHILD_PORT first and to PORT as the backup, and
# with the split off the main server answers both ports itself.
#
# PORT and SL_CHILD_PORT: pm2's environment for the app, else .env, else 3000 and PORT + 1.
# SL_SPLIT_PUBLIC (optional): the public origin to check (default by REGION: na duelseries.com, eu eu.duelseries.com).
set -euo pipefail

APP=duelseries
ENV_FILE=.env
CMD=${1:-}
FORCE=${2:-}

say() { printf '%s\n' "$*"; }
fail() { say "FAILED $*"; exit 1; }

[ -f server/index.js ] || fail "not in the app directory (no server/index.js here)"
command -v node >/dev/null || fail "node is not installed"
command -v curl >/dev/null || fail "curl is not installed"

# pm2's view of the app as JSON (empty when pm2 is missing or the app is not there).
pm2_json() {
  if command -v pm2 >/dev/null; then pm2 jlist 2>/dev/null || true; fi
}

# A field of the app's pm2 environment: pm2_env.env.<name>, then pm2_env.<name>.
pm2_env_value() {
  pm2_json | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let list = []; try { list = JSON.parse(s.slice(s.indexOf("["))); } catch (_) { list = []; }
      const app = Array.isArray(list) ? list.find((p) => p && p.name === process.argv[1]) : null;
      const e = app && app.pm2_env ? app.pm2_env : {};
      const v = e.env && e.env[process.argv[2]] !== undefined ? e.env[process.argv[2]] : e[process.argv[2]];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    });' "$APP" "$1"
}

pm2_field() {   # pid, pm_out_log_path, pm_err_log_path
  pm2_json | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let list = []; try { list = JSON.parse(s.slice(s.indexOf("["))); } catch (_) { list = []; }
      const app = Array.isArray(list) ? list.find((p) => p && p.name === process.argv[1]) : null;
      if (!app) return;
      const v = process.argv[2] === "pid" ? app.pid : (app.pm2_env || {})[process.argv[2]];
      if (v !== undefined && v !== null) process.stdout.write(String(v));
    });' "$APP" "$1"
}

env_file_value() {
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^["'"'"']//' -e 's/["'"'"']$//' || true
}

PORT=$(pm2_env_value PORT)
[ -n "$PORT" ] || PORT=$(env_file_value PORT)
[ -n "$PORT" ] || PORT=3000
CHILD_PORT=$(pm2_env_value SL_CHILD_PORT)
[ -n "$CHILD_PORT" ] || CHILD_PORT=$(env_file_value SL_CHILD_PORT)
[ -n "$CHILD_PORT" ] || CHILD_PORT=$((PORT + 1))
REGION=$(env_file_value REGION)
if [ -n "${SL_SPLIT_PUBLIC:-}" ]; then PUBLIC=$SL_SPLIT_PUBLIC
elif [ "$REGION" = "eu" ]; then PUBLIC=https://eu.duelseries.com
else PUBLIC=https://duelseries.com; fi
HANDSHAKE='/sl-io/?EIO=4&transport=polling'

# x-ds-proc of a GET of the slither path's handshake at $1 (a HEAD is refused by engine.io).
proc_at() {
  curl -s -m 5 -D - -o /dev/null "$1$HANDSHAKE" 2>/dev/null | tr -d '\r' \
    | awk -F': ' 'tolower($1) == "x-ds-proc" { print $2 }' | tail -n 1 || true
}

# Two /api/live answers in a row with no "unknown", within 90 s.
wait_live() {
  local good=0 body
  for _ in $(seq 1 90); do
    body=$(curl -s -m 4 "http://127.0.0.1:$PORT/api/live" 2>/dev/null || true)
    if [ -n "$body" ] && ! printf '%s' "$body" | grep -q '"unknown"'; then
      good=$((good + 1))
      [ "$good" -ge 2 ] && return 0
    else
      good=0
    fi
    sleep 1
  done
  return 1
}

# Paid seats /api/live shows (any row with a stake and someone or some parked money in it). "unknown" when it did not
# answer (a curl failure must reach that line, not end the script under set -e). "unread <games>" when its unknown
# list names a game it could not read: it lists no row for it, and cannot tell is never nobody (deploy rule 4b). sl
# and br are not counted there: they hold no money, and a slither process that is not reporting says them, which must
# not block the rollback.
paid_seated() {
  { curl -s -m 5 "http://127.0.0.1:$PORT/api/live" 2>/dev/null || true; } | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      let j = null; try { j = JSON.parse(s); } catch (_) { j = null; }
      if (!j || !Array.isArray(j.lobbies)) { process.stdout.write("unknown"); return; }
      const unread = [].concat(j.unknown === undefined ? [] : j.unknown).map(String).filter((u) => u !== "sl" && u !== "br");
      if (unread.length) { process.stdout.write("unread " + unread.join(",")); return; }
      let n = 0;
      for (const l of j.lobbies) if (l && Number(l.stake) > 0) n += (Number(l.players) || 0) + (Number(l.parked) || 0);
      process.stdout.write(String(n));
    });'
}

check_quiet() {
  [ "$FORCE" = "--force" ] && return 0
  local n
  n=$(paid_seated) || n=unknown
  [ "$n" = "0" ] && return 0
  if [ "$n" = "unknown" ]; then fail "drain: /api/live did not answer on 127.0.0.1:$PORT (pass --force to go anyway)"; fi
  case "$n" in
    unread*) fail "drain: /api/live could not read ${n#unread }, so it cannot tell whether paid seats are in play (pass --force to go anyway)" ;;
  esac
  fail "drain: $n paid seat(s) in play; wait for them or pass --force"
}

set_switch() {
  [ -f "$ENV_FILE" ] || fail "no $ENV_FILE here"
  if grep -qE '^[[:space:]]*SL_SPLIT=' "$ENV_FILE"; then
    sed -i -E "s/^[[:space:]]*SL_SPLIT=.*/SL_SPLIT=$1/" "$ENV_FILE"
  else
    [ -z "$(tail -c 1 "$ENV_FILE")" ] || printf '\n' >> "$ENV_FILE"
    printf 'SL_SPLIT=%s\n' "$1" >> "$ENV_FILE"
  fi
  [ "$(env_file_value SL_SPLIT)" = "$1" ] || fail "set SL_SPLIT=$1 in $ENV_FILE"
}

child_pid() { pgrep -f 'duelseries-sl|server/split/slChild.js' | head -n 1 || true; }   # its title replaces its command line on Linux

show_procs() {
  local main child
  main=$(pm2_field pid)
  child=$(child_pid)
  say "main  ${main:-none}   slither process ${child:-none}"
  if [ -n "$main$child" ]; then ps -o pid,rss,pcpu,args -p "$(printf '%s' "${main:-} ${child:-}" | xargs | tr ' ' ',')" || true; fi
  free -m || true
}

case "$CMD" in
  off)
    check_quiet
    set_switch 0
    pm2 restart "$APP" >/dev/null || fail "pm2 restart $APP"
    wait_live || fail "/api/live: still unknown after 90 s"
    [ "$(proc_at "http://127.0.0.1:$CHILD_PORT")" = "main" ] || fail "x-ds-proc on 127.0.0.1:$CHILD_PORT is not main"
    curl -s -m 8 "$PUBLIC$HANDSHAKE" | head -c 40 | grep -q '^0{"sid"' || fail "public handshake at $PUBLIC/sl-io/"
    say "OK off"
    ;;
  on)
    command -v sudo >/dev/null || fail "sudo is needed to read the nginx config"
    conf=$(sudo nginx -T 2>/dev/null || true)
    printf '%s' "$conf" | grep -q 'location /sl-io/' || fail "nginx: no location /sl-io/ (deploy/nginx-sl-io.conf)"
    printf '%s' "$conf" | tr '\n' ' ' | grep -qE 'upstream ds_sl[[:space:]]*\{[^}]*backup' \
      || fail "nginx: no upstream ds_sl with a backup (deploy/nginx-sl-io.conf)"
    [ -z "$(pm2_env_value SL_SPLIT)" ] || fail "pm2's environment holds SL_SPLIT; restart the app without it so .env decides"
    check_quiet
    set_switch 1
    pm2 restart "$APP" >/dev/null || fail "pm2 restart $APP"
    wait_live || fail "/api/live: still unknown after 90 s (the slither process is not reporting; run: bash scripts/sl-split.sh off)"
    [ "$(proc_at "http://127.0.0.1:$CHILD_PORT")" = "sl" ] || fail "x-ds-proc on 127.0.0.1:$CHILD_PORT is not sl"
    [ "$(proc_at "$PUBLIC")" = "sl" ] || fail "x-ds-proc through nginx at $PUBLIC is not sl"
    show_procs
    say "OK on"
    ;;
  status)
    mode=$(env_file_value SL_SPLIT)
    say "mode       $([ "$mode" = "1" ] && echo split || echo single) (SL_SPLIT=${mode:-unset})   PORT $PORT   SL_CHILD_PORT $CHILD_PORT"
    here=$(proc_at "http://127.0.0.1:$CHILD_PORT")
    there=$(proc_at "$PUBLIC")
    say "/sl-io/    127.0.0.1:$CHILD_PORT says ${here:-nothing}, $PUBLIC says ${there:-nothing}"
    show_procs
    say "available  $(awk '/MemAvailable/ { printf "%d MB", $2 / 1024 }' /proc/meminfo 2>/dev/null || echo unknown)"
    out=$(pm2_field pm_out_log_path)
    err=$(pm2_field pm_err_log_path)
    n=0
    last=''
    for f in $out $err; do
      [ -f "$f" ] || continue
      n=$((n + $(grep -c 'starting the slither process again' "$f" || true)))
      g=$(grep -h '\[SPLIT\] gave up' "$f" | tail -n 1 || true)
      [ -z "$g" ] || last=$g
    done
    say "restarts   $n in the current pm2 logs${last:+, and it gave up: $last}"
    ;;
  *)
    say "usage: bash scripts/sl-split.sh on | off | status [--force]"
    exit 2
    ;;
esac

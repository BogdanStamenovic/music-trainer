#!/usr/bin/env bash
# Full ownbox lifecycle for music-trainer: setup | update | remove | status.
#
# Layout (nothing user-owned lives in the checkout):
#   checkout (ownbox)                 source + build workspace; node_modules pruned after build
#   ~/.local/lib/music-trainer/app    deployed standalone server (swapped atomically on update)
#   ~/.config/music-trainer/env       runtime config, created once, never overwritten
#   $MT_DATA_DIR                      SQLite DB + backups (+ recordings later). Default
#                                     /mnt/windows/music-trainer-data when mounted, else
#                                     ~/.local/share/music-trainer: the root disk is ~97% full.
#   ~/.config/systemd/user/music-trainer.service, tailscale serve :8448 -> 127.0.0.1:3310
set -euo pipefail

NAME=music-trainer
SRC="$(cd "$(dirname "$0")/.." && pwd)"
LIB="$HOME/.local/lib/$NAME"
APP="$LIB/app"
CONF_DIR="$HOME/.config/$NAME"
ENV_FILE="$CONF_DIR/env"
UNIT="$HOME/.config/systemd/user/$NAME.service"
PORT=3310
TS_PORT=8448
# music21 worker venv (~270 MB): on the ext4 loop image on the big disk, never on the
# nearly full root by default.
OFFLOAD=/mnt/offload/music-trainer

log() { printf '[%s] %s\n' "$NAME" "$*"; }
die() { printf '[%s] ERROR: %s\n' "$NAME" "$*" >&2; exit 1; }
# Optional steps prompt only on a TTY; non-interactive runs (ownbox --yes) take the safe default.
ask() { # ask "question" default(y/n)
  if [ -t 0 ]; then
    local a; read -r -p "$1 [$2] " a || a=""; a="${a:-$2}"; [[ "$a" =~ ^[yY] ]]
  else
    [ "$2" = y ]
  fi
}

env_get() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }

check_node() {
  command -v node >/dev/null || die "node not found (need >= 20)"
  local major; major=$(node -p 'process.versions.node.split(".")[0]')
  [ "$major" -ge 20 ] || die "node $major too old (need >= 20)"
}

write_config() {
  mkdir -p "$CONF_DIR"
  local data
  data=$(env_get MT_DATA_DIR)
  if [ -z "$data" ]; then
    if mountpoint -q /mnt/windows; then data=/mnt/windows/music-trainer-data; else data="$HOME/.local/share/$NAME"; fi
  fi
  # Add only missing keys: user edits to the env file survive every update.
  touch "$ENV_FILE"
  add() { grep -qE "^$1=" "$ENV_FILE" || { echo "$1=$2" >>"$ENV_FILE"; log "config: $1=$2"; }; }
  add MT_DATA_DIR "$data"
  add PORT "$PORT"
  add HOSTNAME 127.0.0.1
  add MT_VOICE_SCORE_URL http://127.0.0.1:3311
  add MT_TZ Europe/Belgrade
  add MT_CURRICULUM_DIR "$APP/curriculum"
  add MT_WORKER_DIR "$APP/worker"
  if mountpoint -q /mnt/offload; then
    add MT_WORKER_VENV "$OFFLOAD/venv"
  elif [ -n "$(env_get MT_WORKER_VENV)" ]; then :
  elif ask "/mnt/offload is not mounted. Put the music21 worker venv (~270 MB) on the root disk?" n; then
    add MT_WORKER_VENV "$HOME/.local/share/$NAME/worker-venv"
  else
    log "music21 worker skipped (no /mnt/offload): composition rule checks will show as unavailable"
  fi
  data=$(env_get MT_DATA_DIR)
  case "$data" in
    /mnt/windows/*) mountpoint -q /mnt/windows || die "/mnt/windows is not mounted; refusing to create $data on the root disk" ;;
  esac
  mkdir -p "$data/backups"
  log "data dir: $data"
}

build() {
  cd "$SRC"
  local avail; avail=$(df -Pm "$SRC" | awk 'NR==2{print $4}')
  [ "$avail" -ge 900 ] || die "only ${avail} MB free where the checkout lives; the build needs ~900 MB temporarily"
  log "installing build dependencies"
  npm ci --no-audit --no-fund --loglevel=error
  log "validating curriculum + running tests"
  npx tsx scripts/validate-curriculum.ts
  npx vitest run --reporter=dot
  log "building"
  bash scripts/build.sh
}

backup_db() {
  local data; data=$(env_get MT_DATA_DIR)
  [ -f "$data/trainer.db" ] || return 0
  local f="$data/backups/pre-update-$(date +%Y%m%d-%H%M%S).db"
  # VACUUM INTO gives a consistent copy even while the server holds the DB open (WAL).
  node -e 'const D=require(process.argv[1]);const d=new D(process.argv[2],{readonly:true});d.exec(`VACUUM INTO '"'"'${process.argv[3]}'"'"'`)' \
    "$SRC/node_modules/better-sqlite3" "$data/trainer.db" "$f"
  log "DB backup: $f"
  ls -1t "$data/backups"/pre-update-*.db 2>/dev/null | tail -n +11 | xargs -r rm -f
}

deploy() {
  mkdir -p "$LIB"
  rm -rf "$APP.new"
  cp -a "$SRC/.next/standalone" "$APP.new"
  mkdir -p "$APP.new/worker"
  cp -a "$SRC/worker/pyproject.toml" "$SRC/worker/uv.lock" "$SRC/worker/src" "$APP.new/worker/"
  rm -rf "$APP.old"
  [ -d "$APP" ] && mv "$APP" "$APP.old"
  mv "$APP.new" "$APP"
  log "deployed to $APP"
}

# Sync the worker venv against the deployed worker copy (non-editable, no dev deps).
# A failure here only disables rule checks; it never blocks the app.
sync_worker() {
  local venv; venv=$(env_get MT_WORKER_VENV)
  [ -n "$venv" ] || return 0
  case "$venv" in /mnt/offload/*) mountpoint -q /mnt/offload || { log "WARNING: /mnt/offload not mounted; worker not synced"; return 0; } ;; esac
  command -v uv >/dev/null || { log "WARNING: uv not found; worker not synced"; return 0; }
  mkdir -p "$(dirname "$venv")"
  local cache=/tmp/$NAME-uv-cache
  mountpoint -q /mnt/offload && cache="$OFFLOAD/uv-cache"
  if UV_PROJECT_ENVIRONMENT="$venv" UV_CACHE_DIR="$cache" uv sync --project "$APP/worker" --frozen --no-dev --no-editable --quiet; then
    log "music21 worker synced ($venv, $(du -sh "$venv" | cut -f1))"
  else
    log "WARNING: worker sync failed; composition rule checks will show as unavailable"
  fi
}

write_unit() {
  mkdir -p "$(dirname "$UNIT")"
  cat >"$UNIT" <<EOF
[Unit]
Description=music-trainer: daily music course PWA (127.0.0.1:$PORT)
After=network.target
StartLimitIntervalSec=0

[Service]
Type=simple
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP
ExecStart=$(command -v node) $APP/server.js
# The server refuses to start while its data disk is not mounted; keep retrying.
Restart=always
RestartSec=20

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
}

healthy() {
  for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok":true'; then return 0; fi
    sleep 1
  done
  return 1
}

restart_checked() {
  systemctl --user enable "$NAME.service" >/dev/null 2>&1
  systemctl --user restart "$NAME.service"
  if healthy; then
    log "healthy on http://127.0.0.1:$PORT"
    return 0
  fi
  journalctl --user -u "$NAME.service" -n 30 --no-pager >&2 || true
  return 1
}

tailscale_serve() {
  command -v tailscale >/dev/null || { log "tailscale not installed; skipping serve"; return 0; }
  local cur
  cur=$(tailscale serve status --json 2>/dev/null | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s||"{}");
    for(const [k,v] of Object.entries(j.Web||{})) if(k.endsWith(":'"$TS_PORT"'")) {console.log(v.Handlers?.["/"]?.Proxy||"other");return}
    }catch{} console.log("")})')
  if [ "$cur" = "http://127.0.0.1:$PORT" ]; then
    log "tailscale serve :$TS_PORT already points here"
  elif [ -n "$cur" ]; then
    log "WARNING: tailscale :$TS_PORT is taken by $cur; not touching it (set it up by hand on a free port)"
  else
    tailscale serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT" >/dev/null
    log "tailscale serve :$TS_PORT -> 127.0.0.1:$PORT"
  fi
  local host; host=$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch{}})')
  [ -n "$host" ] && log "PWA: https://$host:$TS_PORT/"
}

prune() {
  rm -rf "$SRC/node_modules" "$SRC/.next"
  log "pruned build dependencies from the checkout (runtime lives in $APP)"
}

cmd_setup() {
  check_node
  write_config
  build
  deploy
  sync_worker
  write_unit
  restart_checked || die "service did not become healthy"
  tailscale_serve
  prune
}

cmd_update() {
  check_node
  write_config
  build
  backup_db
  deploy
  sync_worker
  write_unit
  if ! restart_checked; then
    if [ -d "$APP.old" ]; then
      log "new build unhealthy; rolling back to the previous deployment"
      rm -rf "$APP.bad" && mv "$APP" "$APP.bad" && mv "$APP.old" "$APP"
      restart_checked || die "rollback also unhealthy; see journalctl --user -u $NAME"
      die "update failed; previous version restored (failed build kept in $APP.bad)"
    fi
    die "service did not become healthy"
  fi
  tailscale_serve
  prune
}

cmd_remove() {
  systemctl --user disable --now "$NAME.service" 2>/dev/null || true
  systemctl --user reset-failed "$NAME.service" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload || true
  if command -v tailscale >/dev/null; then
    local cur; cur=$(tailscale serve status 2>/dev/null | grep -A1 ":$TS_PORT" | grep -c "127.0.0.1:$PORT" || true)
    if [ "$cur" -gt 0 ]; then tailscale serve --https="$TS_PORT" off >/dev/null 2>&1 && log "tailscale serve :$TS_PORT removed"; fi
  fi
  rm -rf "$LIB"
  local venv; venv=$(env_get MT_WORKER_VENV)
  if [ -n "$venv" ] && [ -d "$venv" ]; then rm -rf "$venv" && log "removed worker venv $venv"; fi
  local data; data=$(env_get MT_DATA_DIR)
  if [ -n "$data" ] && [ -d "$data" ]; then
    if ask "Delete ALL music-trainer data (progress DB, backups) in $data?" n; then
      rm -rf "$data"; log "deleted $data"
    else
      log "kept data: $data"
    fi
  fi
  if ask "Delete config $CONF_DIR?" n; then rm -rf "$CONF_DIR"; log "deleted $CONF_DIR"; else log "kept config: $CONF_DIR"; fi
}

cmd_status() {
  local data; data=$(env_get MT_DATA_DIR)
  echo "service:   $(systemctl --user is-active "$NAME.service" 2>/dev/null || true) ($(systemctl --user is-enabled "$NAME.service" 2>/dev/null || echo not-installed))"
  echo "deployed:  $APP $( [ -d "$APP" ] && echo present || echo missing)"
  echo "config:    $ENV_FILE"
  echo "data dir:  ${data:-unset} $( [ -n "$data" ] && [ -f "$data/trainer.db" ] && du -h "$data/trainer.db" | cut -f1)"
  echo "health:    $(curl -fsS -m 3 "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo unreachable)"
  echo "tailscale: $(tailscale serve status 2>/dev/null | grep -A1 ":$TS_PORT" | tr -s ' \n' ' ' || true)"
}

case "${1:-}" in
  setup) cmd_setup ;;
  update) cmd_update ;;
  remove) cmd_remove ;;
  status) cmd_status ;;
  *) echo "usage: $0 setup|update|remove|status" >&2; exit 2 ;;
esac

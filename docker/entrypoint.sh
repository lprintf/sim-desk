#!/usr/bin/env bash
set -euo pipefail

umask 077

required_dirs=(
  "$CODEX_HOME"
  "/home/codex/.config/sim-desk-browser"
  "/var/lib/sim-desk"
  "/workspace/output"
)

for directory in "${required_dirs[@]}"; do
  if ! mkdir -p "$directory"; then
    echo "Sim Desk cannot create $directory; check the mounted directory permissions." >&2
    exit 1
  fi
done

if [[ ! -f "$CODEX_HOME/config.toml" ]]; then
  cp /opt/sim-desk/defaults/config.toml "$CODEX_HOME/config.toml"
fi

exec "$@"


#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
capacity_project="reimbursements-capacity-$(date +%s)-$$"
export CAPACITY_IMAGE="reimbursements-capacity:$capacity_project"
capacity_compose=(docker compose --env-file /dev/null --project-name "$capacity_project" --file compose.capacity.yaml)
capacity_output="${CAPACITY_OUTPUT_DIR:-$(mktemp -d /tmp/reimbursements-capacity.XXXXXX)}"
mkdir -p "$capacity_output"
trap '"${capacity_compose[@]}" unpause worker >/dev/null 2>&1 || true; "${capacity_compose[@]}" down --volumes --remove-orphans' EXIT
"${capacity_compose[@]}" build web
"${capacity_compose[@]}" up -d database
"${capacity_compose[@]}" run --rm web python manage.py migrate --noinput
"${capacity_compose[@]}" run --rm web python manage.py seed_demo
"${capacity_compose[@]}" up -d web worker
"${capacity_compose[@]}" run --rm load python scripts/capacity_check.py "${1:-250}" > "$capacity_output/capacity.json" &
capacity_load_pid=$!
if (( ${CAPACITY_PAUSE_SECONDS:-0} > 0 )); then
  sleep 5
  "${capacity_compose[@]}" pause worker
  sleep "$CAPACITY_PAUSE_SECONDS"
  "${capacity_compose[@]}" unpause worker
fi
wait "$capacity_load_pid"
"${capacity_compose[@]}" exec -T worker python manage.py verify_storage > "$capacity_output/storage.json"
"${capacity_compose[@]}" exec -T worker python -c 'import json; from pathlib import Path; print(json.dumps({name:Path("/sys/fs/cgroup",name).read_text().strip() if Path("/sys/fs/cgroup",name).exists() else None for name in ["memory.peak","cpu.stat","memory.events"]}))' > "$capacity_output/resources.json"
"${capacity_compose[@]}" logs --no-color > "$capacity_output/services.log"
docker image inspect "$CAPACITY_IMAGE" --format '{{.Id}}' > "$capacity_output/image-id.txt"
uname -srmo > "$capacity_output/kernel.txt"
./scripts/restore_check.sh "$capacity_project" "$capacity_output"
cat "$capacity_output/capacity.json"
printf 'Evidence directory: %s\n' "$capacity_output"

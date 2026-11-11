#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
restore_project="${1:?Supply the disposable capacity project name}"
restore_output="${2:?Supply the private evidence directory}"
if [[ ! "$restore_project" =~ ^reimbursements-capacity-[0-9-]+$ ]]; then
  printf 'Only disposable capacity projects are accepted.\n' >&2
  exit 1
fi
restore_compose=(docker compose --env-file /dev/null --project-name "$restore_project" --file compose.capacity.yaml)
"${restore_compose[@]}" stop web worker
"${restore_compose[@]}" exec -T database pg_dump -U capacity -Fc capacity > "$restore_output/database.dump"
"${restore_compose[@]}" run --rm -T --no-deps web tar -C /app/var/private --exclude=work -cf - . > "$restore_output/private.tar"
"${restore_compose[@]}" exec -T database createdb -U capacity capacity_restore
"${restore_compose[@]}" exec -T database pg_restore -U capacity -d capacity_restore < "$restore_output/database.dump"
"${restore_compose[@]}" run --rm -T --no-deps restore tar -C /app/var/private -xf - < "$restore_output/private.tar"
"${restore_compose[@]}" run --rm -T --no-deps restore python scripts/restore_probe.py > "$restore_output/restore.json"
cat "$restore_output/restore.json"

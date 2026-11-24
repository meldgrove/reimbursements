#!/bin/sh
# Installed as `cli`: the operator commands in a terminal of a running container, such as
# `docker compose exec web cli settings list` or Coolify's terminal. The same as
# `docker compose run --rm -T migrate cli settings list` (docs/deployment.md).
exec docker-entrypoint.sh cli "$@"

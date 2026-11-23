#!/bin/sh
# Installed as `python`: runs what the compose files of the Django version
# (0.1 to 0.4: compose.yaml, compose.coolify.yaml, compose.dev.yaml and
# compose.ci.yaml) ask of the image. The updater installs images, not files,
# so a server it upgrades starts this image with the Django compose.yaml
# until the operator replaces it (docs/deployment.md, Upgrade from the Django
# version). Only those files' exact commands run: anything else is refused,
# since `manage.py migrate --plan`, for example, would migrate.
set -e
# compose.yaml and compose.coolify.yaml: the web app's readiness with the health token.
web_check="import os,urllib.request; r=urllib.request.Request('http://127.0.0.1:8000/-/readyz',headers={'X-Health-Token':os.environ['HEALTHCHECK_TOKEN'],'X-Forwarded-Proto':'https'}); urllib.request.urlopen(r,timeout=3)"
# compose.dev.yaml: the same with os.getenv.
dev_web_check="import os,urllib.request; r=urllib.request.Request('http://127.0.0.1:8000/-/readyz',headers={'X-Health-Token':os.getenv('HEALTHCHECK_TOKEN',''),'X-Forwarded-Proto':'https'}); urllib.request.urlopen(r,timeout=3)"
# compose.ci.yaml: the web app runs.
ci_web_check="import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/-/healthz', timeout=3)"
# compose.yaml and compose.coolify.yaml: the worker wrote its heartbeat within 7 minutes.
worker_check="from pathlib import Path; import time; assert 0 <= time.time()-Path('/app/var/private/worker-heartbeat').stat().st_mtime < 420"
# compose.dev.yaml: the same under PRIVATE_STORAGE_ROOT.
dev_worker_check="from pathlib import Path; import os,time; assert time.time()-(Path(os.environ.get('PRIVATE_STORAGE_ROOT','/app/var/private'))/'worker-heartbeat').stat().st_mtime < 420"

readyz='fetch("http://127.0.0.1:8000/-/readyz",{headers:{"X-Health-Token":process.env.HEALTHCHECK_TOKEN||"","X-Forwarded-Proto":"https"},signal:AbortSignal.timeout(3000)}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))'
heartbeat='const p=(process.env.PRIVATE_STORAGE_ROOT||"/app/var/private")+"/worker-heartbeat";let a;try{a=Date.now()-require("fs").statSync(p).mtimeMs}catch{process.exit(1)}process.exit(a>=-1000&&a<420000?0:1)'

if [ "$#" -eq 3 ] && [ "$1" = manage.py ] && [ "$2" = migrate ] && [ "$3" = --noinput ]; then
  exec docker-entrypoint.sh migrate
elif [ "$#" -eq 2 ] && [ "$1" = manage.py ] && [ "$2" = run_jobs ]; then
  exec docker-entrypoint.sh worker
elif [ "$#" -eq 2 ] && [ "$1" = -c ] && { [ "$2" = "$web_check" ] || [ "$2" = "$dev_web_check" ]; }; then
  exec node -e "$readyz"
elif [ "$#" -eq 2 ] && [ "$1" = -c ] && [ "$2" = "$ci_web_check" ]; then
  exec node -e 'fetch("http://127.0.0.1:8000/-/healthz",{signal:AbortSignal.timeout(3000)}).then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))'
elif [ "$#" -eq 2 ] && [ "$1" = -c ] && { [ "$2" = "$worker_check" ] || [ "$2" = "$dev_worker_check" ]; }; then
  exec node -e "$heartbeat"
fi
echo "python: Reimbursements runs on Node.js since 0.5 and has no Python. Replace compose.yaml with the one of this version (docs/deployment.md, Upgrade from the Django version)." >&2
exit 127

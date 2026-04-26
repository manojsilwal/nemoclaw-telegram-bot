#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Run on the GCP VM (after: gcloud compute ssh dreamrise-gcp ...), or pipe via SSH:
#
#   gcloud compute ssh dreamrise-gcp --zone=us-central1-a --project=tradetalkapp-492904 \
#     --command 'bash -s' < scripts/gcp-telegram-vm.sh
#
# Or copy this file to the VM and: bash gcp-telegram-vm.sh list
#
# Commands: status | list | logs | restart
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail
CMD="${1:-status}"
cd "${HOME}/nemoclaw-telegram-bot"
C="$(sudo docker compose -f docker-compose.openclaw.yml ps -q openclaw | head -1)"
if [ -z "$C" ]; then
  echo "No openclaw container. On the VM run: cd ~/nemoclaw-telegram-bot && sudo docker compose -f docker-compose.openclaw.yml up -d"
  exit 1
fi

case "$CMD" in
  status)
    sudo docker compose -f docker-compose.openclaw.yml ps
    curl -sS -o /dev/null -w "healthz: %{http_code}\n" http://127.0.0.1:8080/healthz || true
    ;;
  list)
    # Use docker exec (not compose exec) to avoid compose TTY/socket hangs over some SSH paths.
    sudo docker exec -i "$C" openclaw pairing list telegram
    ;;
  approve)
    if [ -z "${2:-}" ]; then
      echo "Usage: $0 approve <CODE>" >&2
      exit 1
    fi
    sudo docker exec -i "$C" openclaw pairing approve telegram "$2"
    ;;
  logs)
    sudo docker logs "$C" --tail "${2:-80}"
    ;;
  restart)
    sudo docker compose -f docker-compose.openclaw.yml restart openclaw
    ;;
  *)
    echo "Usage: $0 status|list|approve CODE|logs [N]|restart" >&2
    exit 1
    ;;
esac

#!/bin/sh
# Pull latest and rebuild on this box. Replaces the NAS git-hang workflow.
set -e
cd "$(dirname "$0")"
git pull --ff-only
docker compose -f compose.box.yml up -d --build
docker image prune -f >/dev/null 2>&1 || true
echo "GaLib updated -> https://galib.razerblade.dev"

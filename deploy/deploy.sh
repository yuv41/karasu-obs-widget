#!/usr/bin/env bash
# Publish public/ to the web root served by nginx for widget.karasu.live.
set -euo pipefail

ROOT="/www/wwwroot/widget.karasu.live"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

mkdir -p "$ROOT"
# Keep the ACME challenge directory: certbot renewals write into it.
rsync -a --delete --exclude ".well-known/" "$HERE/public/" "$ROOT/"
chown -R www:www "$ROOT" 2>/dev/null || true
echo "Deployed to $ROOT"

#!/usr/bin/env bash
# Startet das Dashboard und öffnet den Browser. Beenden mit Strg+C.
cd "$(dirname "$0")" || exit 1
[ -f .env ] || cp .env.example .env
command -v node >/dev/null || { echo "Node.js (>=20) fehlt: https://nodejs.org"; exit 1; }
exec node server.js --open

#!/usr/bin/env bash
# Production build: Next standalone server + its static assets.
set -euo pipefail
cd "$(dirname "$0")/.."
npx next build
cp -r public .next/standalone/
mkdir -p .next/standalone/.next
rm -rf .next/standalone/.next/static
cp -r .next/static .next/standalone/.next/static
rm -rf .next/cache   # 40+ MB of build cache; the root disk is tight
echo "built: .next/standalone/server.js"

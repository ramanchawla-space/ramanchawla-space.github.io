#!/usr/bin/env bash
# Rebuilds and publishes the site to the gh-pages branch.
#
# Why a script instead of GitHub Actions: the `gh` token on this machine lacks
# the `workflow` scope, so .github/workflows/ cannot be pushed. If you ever add
# it (`gh auth refresh -s workflow`), move .ci-backup/deploy.yml into
# .github/workflows/ and pushes to main will deploy automatically instead.
set -euo pipefail

REPO="https://github.com/ramanchawla-space/ramanchawla-space.github.io.git"
STAGE="$(mktemp -d)"

echo "Building…"
npm run build

echo "Publishing to gh-pages…"
cp -R dist/. "$STAGE/"
touch "$STAGE/.nojekyll"          # stop Jekyll eating files that start with _

cd "$STAGE"
git init -q
git config user.email "ramanfromoz@gmail.com"
git config user.name "Raman Chawla"
git add -A
git commit -q -m "Deploy $(date -u +%Y-%m-%dT%H:%M:%SZ)"
git branch -M gh-pages
git remote add origin "$REPO"
git push -qf origin gh-pages

rm -rf "$STAGE"
echo "Done — https://ramanchawla-space.github.io/ (allow ~1 min for the CDN)"

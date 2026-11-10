#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [major|minor|patch] [notes-file]
# Defaults to "patch" if no argument is given. Without a notes file, the
# GitHub release lists the commit subjects since the previous tag.

BUMP="${1:-patch}"
NOTES_FILE="${2:-}"

if [[ "$BUMP" != "major" && "$BUMP" != "minor" && "$BUMP" != "patch" ]]; then
  echo "Usage: $0 [major|minor|patch] [notes-file]" >&2
  exit 1
fi

# Ensure clean working tree
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean. Commit or stash changes first." >&2
  exit 1
fi

# Ensure we're on main
BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main branch (currently on $BRANCH)." >&2
  exit 1
fi

if [[ -n "$NOTES_FILE" && ! -f "$NOTES_FILE" ]]; then
  echo "Error: notes file $NOTES_FILE not found." >&2
  exit 1
fi

if ! npm whoami &>/dev/null; then
  echo "Error: not logged in to npm. Run npm login first." >&2
  exit 1
fi

git fetch --quiet
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse @{u})" ]]; then
  echo "Error: main is not the same as its upstream. Pull or push first." >&2
  exit 1
fi

CI="$(gh run list --commit "$(git rev-parse HEAD)" --json status,conclusion -q '.[] | "\(.status) \(.conclusion)"')"
if [[ -z "$CI" ]] || grep -qv '^completed success$' <<<"$CI"; then
  echo "Error: CI for $(git rev-parse --short HEAD) has not passed:" >&2
  echo "${CI:-no runs}" >&2
  exit 1
fi

# Bump version (creates commit + tag, server.json included)
npm version "$BUMP" --no-git-tag-version
SEMVER="$(node -p 'require("./package.json").version')"
VERSION="v$SEMVER"
node -e "
  const fs = require('fs');
  const s = JSON.parse(fs.readFileSync('server.json', 'utf-8'));
  s.version = '$SEMVER';
  for (const p of s.packages || []) p.version = '$SEMVER';
  fs.writeFileSync('server.json', JSON.stringify(s, null, 2) + '\n');
"
git add package.json package-lock.json .claude-plugin/plugin.json server.json
git commit -m "$SEMVER"
git tag -a "$VERSION" -m "$SEMVER"

echo "Publishing $VERSION..."

# Publish to npm before anything leaves this machine
npm publish

# Push commit and tag
git push
git push origin "$VERSION"

# Create GitHub release
if [[ -n "$NOTES_FILE" ]]; then
  gh release create "$VERSION" --title "$VERSION" --notes-file "$NOTES_FILE"
else
  NOTES="$(git log --oneline "$(git describe --tags --abbrev=0 HEAD~1 2>/dev/null || git rev-list --max-parents=0 HEAD)"..HEAD~1 --format='- %s')"
  gh release create "$VERSION" --title "$VERSION" --notes "$NOTES"
fi

# Publish to MCP registry
if command -v mcp-publisher &>/dev/null && [[ -f server.json ]]; then
  mcp-publisher publish
  echo "Published $VERSION to MCP registry."
else
  echo "Skipped MCP registry (mcp-publisher not installed or server.json missing)."
fi

echo "Done: $VERSION published to npm and GitHub."

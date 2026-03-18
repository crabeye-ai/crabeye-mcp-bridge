#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [major|minor|patch]
# Defaults to "patch" if no argument is given.

BUMP="${1:-patch}"

if [[ "$BUMP" != "major" && "$BUMP" != "minor" && "$BUMP" != "patch" ]]; then
  echo "Usage: $0 [major|minor|patch]" >&2
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

# Bump version (creates commit + tag)
npm version "$BUMP"
SEMVER="$(node -p 'require("./package.json").version')"
VERSION="v$SEMVER"

echo "Publishing $VERSION..."

# Push commit and tag
git push
git push --tags

# Publish to npm
npm publish

# Create GitHub release
NOTES="$(git log --oneline "$(git describe --tags --abbrev=0 HEAD~1 2>/dev/null || git rev-list --max-parents=0 HEAD)"..HEAD~1 --format='- %s')"
gh release create "$VERSION" --title "$VERSION" --notes "$NOTES"

# Update server.json and publish to MCP registry
if command -v mcp-publisher &>/dev/null && [[ -f server.json ]]; then
  node -e "
    const fs = require('fs');
    const s = JSON.parse(fs.readFileSync('server.json', 'utf-8'));
    s.version = '$SEMVER';
    for (const p of s.packages || []) p.version = '$SEMVER';
    fs.writeFileSync('server.json', JSON.stringify(s, null, 2) + '\n');
  "
  mcp-publisher publish
  echo "Published $VERSION to MCP registry."
else
  echo "Skipped MCP registry (mcp-publisher not installed or server.json missing)."
fi

echo "Done: $VERSION published to npm and GitHub."

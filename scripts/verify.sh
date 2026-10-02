#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"

cd "$repo_root"
npm ci --ignore-scripts
npm run check

# Pi Black holds no credentials, so any match here is a leak.
if command -v rg >/dev/null 2>&1; then
    search=(rg -n --hidden --glob '!.git/**' --glob '!node_modules/**')
else
    search=(grep -rn --exclude-dir=.git --exclude-dir=node_modules)
fi

if "${search[@]}" \
    'sk-ant-oat-[A-Za-z0-9_-]{20,}|CLAUDE_CODE_DEVICE_ID=[0-9a-f]{64}|CLAUDE_CODE_ACCOUNT_UUID=[0-9a-fA-F-]{36}|CLAUDE_CODE_ATIS=[A-Za-z0-9._-]{8,}' \
    "$repo_root"; then
    echo "Potential credential or private identifier found" >&2
    exit 1
fi

echo "Package verification passed"
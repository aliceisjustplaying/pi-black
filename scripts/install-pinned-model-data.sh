#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../config/pi.env
source "$repo_root/config/pi.env"

source_dir="${1:-}"
if [[ -z "$source_dir" ]]; then
    echo "Usage: $0 <prepared-pi-source-directory>" >&2
    exit 2
fi
if [[ ! -d "$source_dir/packages/ai/src/providers" ]]; then
    echo "Prepared Pi source is missing providers: $source_dir" >&2
    exit 1
fi

package_dir="$(mktemp -d)"
cleanup() {
    rm -rf "$package_dir"
}
trap cleanup EXIT

npm pack --silent --pack-destination "$package_dir" "@earendil-works/pi-ai@$PI_VERSION" >/dev/null
archives=("$package_dir"/*.tgz)
if [[ "${#archives[@]}" -ne 1 || ! -f "${archives[0]}" ]]; then
    echo "Expected one @earendil-works/pi-ai@$PI_VERSION package archive" >&2
    exit 1
fi

data_dir="$source_dir/packages/ai/src/providers/data"
rm -rf "$data_dir"
mkdir -p "$data_dir"
tar -xzf "${archives[0]}" --strip-components=4 -C "$data_dir" package/dist/providers/data

if [[ ! -f "$data_dir/.manifest.json" || ! -f "$data_dir/anthropic.json" ]]; then
    echo "Published @earendil-works/pi-ai@$PI_VERSION package has incomplete model data" >&2
    exit 1
fi

printf 'Installed model data from @earendil-works/pi-ai@%s\n' "$PI_VERSION"

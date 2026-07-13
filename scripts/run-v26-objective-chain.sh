#!/usr/bin/env bash
# Run a V26 league one crash-safe generation at a time and compress completed raw pools.
set -euo pipefail

root="${1:?usage: scripts/run-v26-objective-chain.sh ml/league_v26_* [GENERATIONS]}"
generations="${2:-5}"
case "$root" in
	ml/league_v26_*) ;;
	*) echo "refusing non-V26 root: $root" >&2; exit 2 ;;
esac
if ! [[ "$generations" =~ ^[1-9][0-9]*$ ]]; then
	echo "GENERATIONS must be a positive integer" >&2
	exit 2
fi
if [[ ! -f "$root/config.json" || ! -f "$root/state.json" ]]; then
	echo "league must be initialized before chain run: $root" >&2
	exit 2
fi
if [[ -f "$root/INVALID" ]]; then
	echo "refusing invalidated root: $root" >&2
	exit 4
fi
read -r catalog_path catalog_hash < <(
	node -e 'const c=require("./'"$root"'/config.json"); console.log(c.catalogPath ?? "", c.catalogSha256 ?? "")'
)
if [[ -z "$catalog_path" || -z "$catalog_hash" || ! -f "$catalog_path" ]]; then
	echo "missing pinned catalogPath/catalogSha256 in $root/config.json" >&2
	exit 4
fi
actual_catalog_hash="$(sha256sum "$catalog_path" | cut -d ' ' -f1)"
if [[ "$actual_catalog_hash" != "$catalog_hash" ]]; then
	echo "catalog hash mismatch: expected $catalog_hash got $actual_catalog_hash" >&2
	exit 4
fi

for ((step = 1; step <= generations; step += 1)); do
	available_kb="$(df --output=avail -k "$root" | tail -1 | tr -d ' ')"
	if (( available_kb < 5 * 1024 * 1024 )); then
		echo "disk guard: fewer than 5 GiB available before step $step" >&2
		exit 3
	fi
	node scripts/run-league.mjs run --root "$root" --gens 1
	gen="$(node -e 'const s=require("./'"$root"'/state.json"); process.stdout.write(String(s.gen))')"
	data_dir="$root/data/gen$gen"
	if [[ -d "$data_dir" ]]; then
		find "$data_dir" -maxdepth 1 -type f -name '*.jsonl' -print0 \
			| sort -z \
			| xargs -0 -r sha256sum > "$data_dir/SHA256SUMS.uncompressed"
		find "$data_dir" -maxdepth 1 -type f -name '*.jsonl' -print0 \
			| xargs -0 -r -n1 zstd -T1 -5 --rm --quiet
	fi
done

#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 1 || ! -f "$1" ]]; then
  echo 'usage: bash run-probe.sh /absolute/path/to/font.ttf' >&2
  exit 2
fi
font=$(realpath -- "$1")
issue_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$issue_dir/../../.." && pwd)
upstream="$repo_root/_scratch/pathfinder-upstream"
probe="$repo_root/_scratch/pathfinder-spike"
pin=6c3c0466f451c5bd2007087728cd168798cd64e8

if [[ ! -d "$upstream" ]]; then
  git clone --no-checkout https://github.com/servo/pathfinder.git "$upstream"
  git -C "$upstream" checkout --detach "$pin"
fi
if [[ $(git -C "$upstream" rev-parse HEAD) != "$pin" ]]; then
  echo "Reference checkout must be at $pin; leaving the existing checkout untouched." >&2
  exit 1
fi
if [[ -n $(git -C "$upstream" status --porcelain) ]]; then
  echo 'Reference checkout has local changes; leaving it untouched.' >&2
  exit 1
fi
mkdir -p -- "$probe/src"
cp -- "$issue_dir/probe.rs" "$probe/src/main.rs"
cp -- "$issue_dir/probe.Cargo.toml" "$probe/Cargo.toml"
cp -- "$issue_dir/probe.Cargo.lock" "$probe/Cargo.lock"
export CARGO_HOME="$repo_root/_scratch/pathfinder-cargo"
cargo build --locked --release --manifest-path "$probe/Cargo.toml"
"$probe/target/release/petplay-pathfinder-spike" "$font" "$probe/front.ppm"
"$probe/target/release/petplay-pathfinder-spike" "$font" "$probe/tilted.ppm" --perspective

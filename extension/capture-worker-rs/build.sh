#!/usr/bin/env bash
set -euo pipefail

crate_dir="$(cd "$(dirname "$0")" && pwd)"
extension_dir="$(cd "${crate_dir}/.." && pwd)"

cargo build \
  --manifest-path "${crate_dir}/Cargo.toml" \
  --release \
  --target wasm32-unknown-unknown

mkdir -p "${extension_dir}/wasm"
cp \
  "${crate_dir}/target/wasm32-unknown-unknown/release/capture_worker.wasm" \
  "${extension_dir}/wasm/capture-worker.wasm"
chmod 0644 "${extension_dir}/wasm/capture-worker.wasm"

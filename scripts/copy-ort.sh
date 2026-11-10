#!/usr/bin/env bash
# Copy ONLY the onnxruntime-web WASM build the voice fallback needs into public/ort/
# (served as-is, imported at runtime). The package ships ~145 MB of variants
# (WebGPU, JSEP, JSPI, asyncify, webgl); we need ~15 MB of it.
set -euo pipefail
cd "$(dirname "$0")/.."
src=node_modules/onnxruntime-web/dist
mkdir -p public/ort
for f in ort.wasm.min.mjs ort-wasm-simd-threaded.mjs ort-wasm-simd-threaded.wasm; do cp "$src/$f" public/ort/; done

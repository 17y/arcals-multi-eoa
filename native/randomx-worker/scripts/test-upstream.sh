#!/usr/bin/env bash
set -euo pipefail

worker_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
vendor_dir="$worker_root/vendor/randomx"
build_dir="$worker_root/build/upstream-unmodified"
expected_commit=aaafe71322df6602c21a5c72937ac284724ae561
actual_commit=$(git -C "$vendor_dir" rev-parse HEAD)

if [[ "$actual_commit" != "$expected_commit" ]]; then
  echo "RandomX source mismatch: $actual_commit" >&2
  exit 1
fi

cmake -S "$vendor_dir" -B "$build_dir" -DCMAKE_BUILD_TYPE=Release
cmake --build "$build_dir" --target randomx-tests --parallel "${ARCALS_BUILD_JOBS:-4}"
"$build_dir/randomx-tests"

"${CXX:-c++}" \
  -std=c++17 \
  -I"$vendor_dir/src" \
  "$worker_root/src/upstream_vector_probe.cpp" \
  "$build_dir/librandomx.a" \
  -pthread \
  -o "$build_dir/arcals-upstream-vector-probe"
upstream_vector=$("$build_dir/arcals-upstream-vector-probe")
expected_vector=0xc9038e72c2929b586bde58289ba56db83d550e861b70aa77f01e1812872f9247
if [[ "$upstream_vector" != "$expected_vector" ]]; then
  echo "unmodified upstream vector mismatch: $upstream_vector" >&2
  exit 1
fi
echo "unmodified upstream vector: $upstream_vector"

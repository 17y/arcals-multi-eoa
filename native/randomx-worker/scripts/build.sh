#!/usr/bin/env bash
set -euo pipefail

worker_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
vendor_dir="$worker_root/vendor/randomx"
build_dir="$worker_root/build"
prepared_dir="$build_dir/randomx-arcals"
expected_commit=aaafe71322df6602c21a5c72937ac284724ae561
actual_commit=$(git -C "$vendor_dir" rev-parse HEAD)

if [[ "$actual_commit" != "$expected_commit" ]]; then
  echo "RandomX source mismatch: $actual_commit" >&2
  exit 1
fi

cmake -E remove_directory "$prepared_dir"
cmake -E make_directory "$prepared_dir"
cmake -E copy_directory "$vendor_dir" "$prepared_dir"
cmake -E remove -f "$prepared_dir/.git"
git -C "$prepared_dir" init -q
git -C "$prepared_dir" apply "$worker_root/patches/0001-arcals-argon-salt.patch"

cmake \
  -S "$worker_root" \
  -B "$build_dir" \
  -DCMAKE_BUILD_TYPE=Release \
  -DRANDOMX_SOURCE_DIR="$prepared_dir"
# --config is what multi-configuration generators (Visual Studio) read; they
# ignore CMAKE_BUILD_TYPE and would otherwise produce a Debug binary.
cmake --build "$build_dir" --target arcals-randomx-worker --config Release \
  --parallel "${ARCALS_BUILD_JOBS:-4}"

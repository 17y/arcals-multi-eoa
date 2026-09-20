#!/bin/zsh

script_dir=${0:A:h}
cd -- "$script_dir" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 22.22 或更高版本："
  echo "https://nodejs.org/"
  echo
  read "reply?按回车关闭……"
  exit 1
fi

node apps/cli/wizard.mjs
exit_code=$?
echo
read "reply?按回车关闭……"
exit "$exit_code"

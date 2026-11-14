#!/usr/bin/env bash
# 安装 feige 命令（默认 ~/.local/bin/feige -> dist/src/main.js 符号链接）
# 用法：bash scripts/install-cli.sh [安装目录]   （默认 $HOME/.local/bin）
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PREFIX="${1:-$HOME/.local/bin}"
MAIN="$ROOT/dist/src/main.js"
if [ ! -f "$MAIN" ]; then
  echo "✖ 未找到构建产物：$MAIN" >&2
  echo "  请先在项目根目录运行：npm install && npm run build" >&2
  exit 1
fi
chmod 755 "$MAIN"
mkdir -p "$PREFIX"
ln -sfn "$MAIN" "$PREFIX/feige"
echo "✔ 已安装：$PREFIX/feige -> $MAIN"
case ":$PATH:" in
  *":$PREFIX:"*) ;;
  *) echo "⚠ $PREFIX 不在 PATH 中，请把它加入 PATH（如 export PATH=\"$PREFIX:\$PATH\"）" >&2 ;;
esac
"$PREFIX/feige" --version

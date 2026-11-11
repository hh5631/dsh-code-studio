#!/usr/bin/env bash
# dsh-code-studio 一键安装脚本（DeepSeek Harness）
#
# 用法：
#   本地开发形态：  bash install.sh
#   远端：          bash <(curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/main/install.sh)
#
# 支持：优先 dsh CLI（自动注册 bundle）；无 dsh 时回退 pnpm 并兜底注册 bundles。
# 幂等：重复执行不会重复注册或破坏已有配置。
set -euo pipefail

PKG="dsh-code-studio"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PJ="$PROFILE_DIR/package.json"

echo "==> 目标 profile: $PROFILE_DIR"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "错误：profile 不存在：$PROFILE_DIR"
  echo "请确认 DSH_HOME 与 DSH_PROFILE（默认 ~/.dsh 与 web）。"
  exit 1
fi

# ── 卸载旧版 dsh-vscode-mode ─────────────────────────────────────
# 新插件接管同样的能力（文件编辑、差异审查、LSP、命令面板…），
# 两个插件同时挂载会争抢官方 Sidebar 的「文件编辑」Tab 与文件打开认领，
# 导致双份编辑器实例与相互干扰的路由。故安装新插件时移除旧插件。
OLD_PKG="dsh-vscode-mode"
if [ -f "$PJ" ] && grep -q "\"$OLD_PKG\"" "$PJ" 2>/dev/null; then
  echo "==> 检测到旧插件 $OLD_PKG，开始卸载"
  if command -v dsh >/dev/null 2>&1; then
    dsh plugin --profile "$PROFILE" remove "$OLD_PKG" || true
  elif command -v pnpm >/dev/null 2>&1; then
    (cd "$PROFILE_DIR" && pnpm remove "$OLD_PKG") || true
  fi
  # 兜底：确保 dependencies 与 bundles 列表里都不再出现旧包
  python3 - "$PJ" "$OLD_PKG" <<'PY' 2>/dev/null || true
import json, sys
p, old = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d.get("dependencies", {}).pop(old, None)
bundles = d.get("dsh", {}).get("profile", {}).get("bundles", [])
if old in bundles:
    bundles.remove(old)
json.dump(d, open(p, "w"), indent=2)
print("已从 profile 移除", old)
PY
fi

# ── 安装新插件 ───────────────────────────────────────────────────
if command -v dsh >/dev/null 2>&1; then
  echo "==> dsh plugin --profile $PROFILE add $PKG"
  dsh plugin --profile "$PROFILE" add "$PKG"
else
  if command -v pnpm >/dev/null 2>&1; then
    echo "==> 未找到 dsh CLI，回退 pnpm 安装（需自行确保 bundle 注册，见下）"
    (cd "$PROFILE_DIR" && pnpm add "$PKG")
  else
    echo "错误：未找到 dsh 或 pnpm，无法安装。请先安装 DeepSeek Harness。"
    exit 1
  fi
fi

if [ -f "$PJ" ]; then
  NEED=$(python3 - "$PJ" "$PKG" <<'PY' 2>/dev/null || echo "1"
import json, sys
d = json.load(open(sys.argv[1]))
print("0" if sys.argv[2] in d.get("dsh", {}).get("profile", {}).get("bundles", []) else "1")
PY
)
  if [ "$NEED" = "1" ]; then
    echo "==> 注册 bundle：$PKG"
    python3 - "$PJ" "$PKG" <<'PY'
import json, sys
p, pkg = sys.argv[1], sys.argv[2]
d = json.load(open(p))
d.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", []).append(pkg)
json.dump(d, open(p, "w"), indent=2)
print("已添加", pkg)
PY
  else
    echo "==> bundle 已注册"
  fi
else
  echo "警告：未找到 $PJ，请确认 profile 完整。"
fi

echo
echo "✅ 安装完成！最后一步：重启 DeepSeek Harness（停止后重新运行 dsh web）。"
echo "   重启后右侧 Sidebar 会出现「代码工作台」页签，"
echo "   设置 →「代码工作台」→「通用」→「外观」可切换皮肤与密度。"

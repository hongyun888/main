#!/usr/bin/env bash
set -e

echo "🚀 开始构建安全版本..."

# 确保输出目录存在
mkdir -p dist

# 检查依赖工具
check_tool() {
  if command -v $1 &> /dev/null; then
    echo "✅ $1 已安装"
    return 0
  else
    echo "❌ $1 未安装"
    return 1
  fi
}

echo "🔍 检查构建工具..."

# 检查是否有esbuild
if check_tool "esbuild" || check_tool "npx esbuild"; then
  # 1) 压缩 & 去掉 sourcemap
  echo "📦 正在压缩脚本..."
  if command -v esbuild &> /dev/null; then
    esbuild js/app/script.js --bundle --minify --outfile=dist/script.min.js
  else
    npx esbuild js/app/script.js --bundle --minify --outfile=dist/script.min.js
  fi
else
  echo "⚠️  esbuild 不可用，使用简单复制方案..."
  cp js/app/script.js dist/script.min.js
fi

# 检查是否有javascript-obfuscator
if command -v javascript-obfuscator &> /dev/null || [ -f "node_modules/.bin/javascript-obfuscator" ]; then
  # 2) 轻量混淆
  echo "🔐 正在混淆代码..."
  if command -v javascript-obfuscator &> /dev/null; then
    javascript-obfuscator dist/script.min.js \
      --control-flow-flattening true \
      --string-array true \
      --string-array-encoding rc4 \
      --output dist/script.sec.js
  else
    npx javascript-obfuscator dist/script.min.js \
      --control-flow-flattening true \
      --string-array true \
      --string-array-encoding rc4 \
      --output dist/script.sec.js
  fi
else
  echo "⚠️  javascript-obfuscator 不可用，跳过混淆步骤..."
  cp dist/script.min.js dist/script.sec.js
fi

# 3) 清理临时文件
rm -f dist/script.min.js

echo "✅ 构建完成！"
echo "📂 输出文件: dist/script.sec.js"
echo ""
echo "🚀 部署说明："
echo "   1. 上传 index.html + css/style.css + dist/script.sec.js"
echo "   2. 其他业务脚本保持不变: js/features/audioRecognition.js, js/utils/util.js, js/features/omniModel.js, js/features/upload.js"
echo ""
echo "🔧 开发调试："
echo "   - 本地测试会自动检测开发环境并放宽防护"
echo "   - 或在 js/app/script.js 中设置 const __PROD__ = false" 

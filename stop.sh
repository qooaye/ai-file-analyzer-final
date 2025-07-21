#!/bin/bash

echo "🛑 停止 AI 文件分析系統..."

# 停止伺服器
pkill -f "server.js"

# 釋放端口
if lsof -ti:8080 > /dev/null 2>&1; then
    kill $(lsof -ti:8080) 2>/dev/null
fi

sleep 2
echo "✅ 伺服器已停止"
#!/bin/bash

echo "🚀 啟動 AI 文件分析系統..."

# 檢查是否安裝了依賴
if [ ! -d "node_modules" ]; then
    echo "📦 安裝依賴包..."
    npm install
fi

# 停止現有的伺服器
echo "🔄 停止現有伺服器..."
pkill -f "server.js" 2>/dev/null

# 檢查端口是否被佔用
if lsof -ti:8080 > /dev/null 2>&1; then
    echo "⚠️  端口 8080 被佔用，正在釋放..."
    kill $(lsof -ti:8080) 2>/dev/null
    sleep 2
fi

# 創建必要的目錄
mkdir -p temp_uploads

# 啟動伺服器
echo "🚀 啟動伺服器..."
nohup node server.js > server.log 2>&1 &

# 等待啟動
sleep 3

# 檢查狀態
if curl -s http://localhost:8080 > /dev/null; then
    echo "✅ 伺服器成功啟動"
    echo "🌐 訪問地址: http://localhost:8080"
    echo "📋 日誌文件: server.log"
    echo ""
    echo "🎉 AI文件分析系統已就緒！"
else
    echo "❌ 伺服器啟動失敗，請檢查 server.log"
fi
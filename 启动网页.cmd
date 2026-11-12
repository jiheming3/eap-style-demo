@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "DEMO_NODE=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
    set "DEMO_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
  ) else (
    echo 没有找到 Node.js，请安装 Node.js 20.9 或以上版本。
    pause
    exit /b 1
  )
)
if not exist "node_modules\next\dist\bin\next" (
  echo 请先在本目录安装网页依赖：pnpm install
  pause
  exit /b 1
)
echo.
echo EAP 回答风格 Demo 正在启动
echo 启动完成后，请打开 http://127.0.0.1:3000
echo 请保持这个窗口打开，关闭窗口将停止网页服务。
echo.
"%DEMO_NODE%" "node_modules\next\dist\bin\next" dev --hostname 127.0.0.1 --port 3000
pause

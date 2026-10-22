@echo off
chcp 65001 >nul
rem 節點畫布：把 .excalidraw 檔拖到這個檔案上，或雙擊後輸入畫布檔的路徑
rem 第二個參數可以指定埠號（預設 5180），同時開好幾張畫布時每張用不同的埠
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js。請先到 https://nodejs.org 安裝 LTS 版，再重新開啟這個檔案。
  pause
  exit /b 1
)

if not exist "node_modules\elkjs" (
  echo 第一次使用，安裝排版套件中…
  call npm install
  if errorlevel 1 (
    echo 安裝失敗，請確認網路連線後再試一次。
    pause
    exit /b 1
  )
)

set "CANVAS=%~1"
if "%CANVAS%"=="" (
  echo 請把畫布檔（.excalidraw）拖進這個視窗後按 Enter。
  echo 輸入一個還不存在的檔名，會建立新的空白畫布。
  set /p "CANVAS=畫布檔："
)
set "CANVAS=%CANVAS:"=%"
if "%CANVAS%"=="" exit /b 1

set "PORT=%~2"
if "%PORT%"=="" set "PORT=5180"

echo.
echo 畫布開在 http://localhost:%PORT%
echo 這個視窗開著時畫布才能用，用完直接關掉這個視窗。
echo.
node server.mjs "%CANVAS%" %PORT% --open
pause

@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 22.13 or newer and try again.
  pause
  exit /b 1
)
if not exist "node_modules\three\build\three.module.js" (
  call npm ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not defined PORT set "PORT=4317"
node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/health').then(r=>r.json()).then(v=>process.exit(v.app==='atlas-local-studio'?0:1)).catch(()=>process.exit(1))"
if not errorlevel 1 (
  start "" "http://127.0.0.1:%PORT%/"
  exit /b 0
)
start "" powershell.exe -NoProfile -WindowStyle Hidden -Command "for ($i=0; $i -lt 25; $i++) { try { $u='http://127.0.0.1:'+$env:PORT; if ((Invoke-RestMethod ($u+'/api/health')).app -eq 'atlas-local-studio') { Start-Process $u; break } } catch {}; Start-Sleep -Milliseconds 400 }"
node --env-file-if-exists=.env server.mjs
if errorlevel 1 pause


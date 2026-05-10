@echo off
title JARVIS - Shutting Down
color 0E
echo.
echo   =========================================
echo     J A R V I S   -   Desligando...
echo   =========================================
echo.

:: Mata apenas processo com estado LISTENING (ignora TIME_WAIT / SYN_SENT / ESTABLISHED)
set "KILLED=0"
for /f "delims=" %%P in ('powershell -NoProfile -Command "$c=Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue;$u=@{};foreach($x in $c){if($x.OwningProcess -gt 0){$u[$x.OwningProcess]=1}};$u.Keys"') do (
    if not "%%P"=="" (
        echo   Encerrando processo PID: %%P
        taskkill /F /T /PID %%P >nul 2>&1
        set "KILLED=1"
    )
)

if "%KILLED%"=="0" (
    echo   Nenhum processo JARVIS encontrado na porta 3000.
) else (
    timeout /t 2 /nobreak >nul
)

echo.

:: Verificar somente LISTENING — TIME_WAIT/SYN_SENT nao contam como erro
powershell -NoProfile -Command "if(Get-NetTCPConnection -LocalPort 3000 -State Listen -EA SilentlyContinue){exit 1}else{exit 0}" >nul 2>&1
if errorlevel 1 (
    color 0C
    echo   [AVISO] Porta 3000 ainda com LISTENING ativo.
    echo   Tente fechar a janela do servidor manualmente.
) else (
    color 0A
    echo   =========================================
    echo     JARVIS desligado. Porta 3000 livre.
    echo   =========================================
)

echo.
pause

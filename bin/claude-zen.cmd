@echo off
REM zen-claude for Windows: shim so the command works from cmd and PowerShell.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0claude-zen.ps1" %*
exit /b %ERRORLEVEL%
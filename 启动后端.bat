@echo off
setlocal EnableExtensions
rem ---------------------------------------------------------------
rem Keep this file ASCII-only, CRLF line endings.
rem cmd.exe parses .bat in the OEM code page (GBK on zh-CN Windows).
rem UTF-8 Chinese comments here corrupt the parser: stray
rem "is not recognized as an internal command" errors appear
rem before the server starts. All user-facing Chinese text is
rem printed by backend.mjs instead, which is safe.
rem ---------------------------------------------------------------
chcp 65001 >nul 2>&1
cd /d "%~dp0"
title CGH Toolbox - Local Server

rem Optional 1st argument: Python interpreter to use.
if not "%~1"=="" set "CGH_PYTHON=%~1"

where node.exe >nul 2>&1
if errorlevel 1 goto node_missing

node.exe --no-warnings "%~dp0backend.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo [launcher] Backend exited with code %EXIT_CODE%. See the messages above.
echo [launcher] Press any key to close this window.
pause >nul
exit /b %EXIT_CODE%

:node_missing
echo.
echo [launcher] Node.js was not found on PATH.
echo [launcher] Install Node.js 20 or newer from https://nodejs.org, then run this file again.
echo.
pause
exit /b 1

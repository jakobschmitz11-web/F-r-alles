@echo off
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
where node >nul 2>nul || (echo Node.js (>=20) fehlt: https://nodejs.org & pause & exit /b 1)
node server.js --open

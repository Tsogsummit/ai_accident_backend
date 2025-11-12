@echo off
REM AI Accident Detection System - Docker Startup Script for Windows
REM ==================================================================

echo.
echo 🚀 Starting AI Accident Detection System...
echo.

REM Check if Docker is running
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Docker is not running. Please start Docker Desktop first.
    pause
    exit /b 1
)

REM Check if docker-compose is available
docker-compose version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ docker-compose is not installed.
    pause
    exit /b 1
)

echo ✅ Docker is running
echo.

REM Stop any running containers
echo 🛑 Stopping any existing containers...
docker-compose down

REM Remove old volumes (optional - uncomment if needed)
REM docker volume prune -f

echo.
echo 🔧 Building and starting services...
docker-compose up -d --build

echo.
echo ⏳ Waiting for services to be ready...
timeout /t 10 /nobreak >nul

REM Check service health
echo.
echo 🏥 Checking service health...
echo.

REM Check PostgreSQL
docker-compose ps | findstr /C:"postgres" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ postgres ^(port 5432^) - Running
) else (
    echo ❌ postgres ^(port 5432^) - Not running
)

REM Check Redis
docker-compose ps | findstr /C:"redis" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ redis ^(port 6379^) - Running
) else (
    echo ❌ redis ^(port 6379^) - Not running
)

REM Check API Gateway
docker-compose ps | findstr /C:"api-gateway" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ api-gateway ^(port 3000^) - Running
) else (
    echo ❌ api-gateway ^(port 3000^) - Not running
)

REM Check User Service
docker-compose ps | findstr /C:"user-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ user-service ^(port 3001^) - Running
) else (
    echo ❌ user-service ^(port 3001^) - Not running
)

REM Check Accident Service
docker-compose ps | findstr /C:"accident-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ accident-service ^(port 3002^) - Running
) else (
    echo ❌ accident-service ^(port 3002^) - Not running
)

REM Check Video Service
docker-compose ps | findstr /C:"video-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ video-service ^(port 3003^) - Running
) else (
    echo ❌ video-service ^(port 3003^) - Not running
)

REM Check AI Detection Service
docker-compose ps | findstr /C:"ai-detection-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ ai-detection-service ^(port 3004^) - Running
) else (
    echo ❌ ai-detection-service ^(port 3004^) - Not running
)

REM Check Notification Service
docker-compose ps | findstr /C:"notification-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ notification-service ^(port 3005^) - Running
) else (
    echo ❌ notification-service ^(port 3005^) - Not running
)

REM Check Map Service
docker-compose ps | findstr /C:"map-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ map-service ^(port 3006^) - Running
) else (
    echo ❌ map-service ^(port 3006^) - Not running
)

REM Check Report Service
docker-compose ps | findstr /C:"report-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ report-service ^(port 3007^) - Running
) else (
    echo ❌ report-service ^(port 3007^) - Not running
)

REM Check Camera Service
docker-compose ps | findstr /C:"camera-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ camera-service ^(port 3008^) - Running
) else (
    echo ❌ camera-service ^(port 3008^) - Not running
)

REM Check Admin Service
docker-compose ps | findstr /C:"admin-service" | findstr /C:"Up" >nul
if %errorlevel% equ 0 (
    echo ✅ admin-service ^(port 3009^) - Running
) else (
    echo ❌ admin-service ^(port 3009^) - Not running
)

echo.
echo 📋 Service URLs:
echo    🌐 API Gateway:        http://localhost:3000
echo    👥 User Service:       http://localhost:3001
echo    🚨 Accident Service:   http://localhost:3002
echo    📹 Video Service:      http://localhost:3003
echo    🤖 AI Service:         http://localhost:3004
echo    🔔 Notification:       http://localhost:3005
echo    🗺️  Map Service:        http://localhost:3006
echo    📊 Report Service:     http://localhost:3007
echo    📷 Camera Service:     http://localhost:3008
echo    👨‍💼 Admin Dashboard:   http://localhost:3009
echo.
echo 📝 Default Admin Login:
echo    Username: admin
echo    Password: admin123
echo    URL: http://localhost:3009/login.html
echo.
echo ✅ System startup complete!
echo.
echo 📖 View logs with: docker-compose logs -f [service-name]
echo 🛑 Stop system with: docker-compose down
echo.
pause
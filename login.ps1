# Login script
$uri = "http://localhost:3000/api/auth/login"
$body = @{
    phone = "+97699966446"
    password = "Password123"
} | ConvertTo-Json

try {
    $response = Invoke-RestMethod -Uri $uri -Method POST -Body $body -ContentType "application/json"
    Write-Host "Login successful!" -ForegroundColor Green
    Write-Host "Token: $($response.token)" -ForegroundColor Cyan
    Write-Host "User: $($response.user.name) ($($response.user.phone))" -ForegroundColor Yellow
    
    # Save token to file for later use
    $response.token | Out-File -FilePath "token.txt" -Encoding utf8
    Write-Host "`nToken saved to token.txt" -ForegroundColor Green
} catch {
    Write-Host "Login failed: $($_.Exception.Message)" -ForegroundColor Red
    if ($_.ErrorDetails.Message) {
        Write-Host "Details: $($_.ErrorDetails.Message)" -ForegroundColor Red
    }
}


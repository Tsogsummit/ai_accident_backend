$path = "database\init.sql"
if (Test-Path $path) {
    $content = Get-Content $path -Raw
    # Remove the broken index for cameras
    $content = $content -replace "CREATE INDEX IF NOT EXISTS idx_cameras_status ON cameras\(status\) WHERE status = 'active';", ""
    
    Set-Content $path $content -NoNewline
    Write-Host "Successfully patched init.sql"
} else {
    Write-Error "init.sql not found"
}

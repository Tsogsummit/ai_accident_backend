$path = "database\init.sql"
if (Test-Path $path) {
    $content = Get-Content $path -Raw
    # Remove c.status from SELECT
    $content = $content -replace "    c.status,", ""
    # Remove c.status from GROUP BY
    $content = $content -replace "GROUP BY c.id, c.name, c.status, c.is_online;", "GROUP BY c.id, c.name, c.is_online;"
    
    Set-Content $path $content -NoNewline
    Write-Host "Successfully patched init.sql view"
} else {
    Write-Error "init.sql not found"
}

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    # 1. Limpar artefatos anteriores em dist/ para evitar resíduos de builds antigos
    if (Test-Path 'dist') {
        Remove-Item -Recurse -Force -Path 'dist'
    }
    New-Item -ItemType Directory -Force -Path 'dist/StreamGrid' | Out-Null

    # 2. Localizar diretório target do Cargo/Tauri (respeitando CARGO_TARGET_DIR se definido)
    $targetRoot = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { 'src-tauri/target' }
    $releaseDir = Join-Path $targetRoot 'release'

    $exeCandidates = @(
        (Join-Path $releaseDir 'StreamGrid.exe'),
        (Join-Path $releaseDir 'streamgrid.exe')
    )
    $exe = $exeCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $exe) {
        throw "Executável compilado não encontrado em '$releaseDir'. Execute 'npx tauri build' antes de empacotar."
    }

    Copy-Item -Path $exe -Destination 'dist/StreamGrid/StreamGrid.exe' -Force

    # 3. Copiar instaladores gerados pelo Tauri v2 (NSIS / MSI), se presentes
    $bundleDir = Join-Path $releaseDir 'bundle'
    if (Test-Path $bundleDir) {
        Get-ChildItem -Path $bundleDir -Include *.exe, *.msi -Recurse -ErrorAction SilentlyContinue |
            ForEach-Object { Copy-Item -Path $_.FullName -Destination 'dist/' -Force }
    }

    # 4. Compactar pacote portátil com estrutura padronizada (StreamGrid/StreamGrid.exe)
    Compress-Archive -Path 'dist/StreamGrid' -DestinationPath 'dist/StreamGrid-Windows.zip' -Force

    # 5. Gerar hashes SHA-256 individuais e SHA256SUMS.txt
    $checksumLines = @()
    Get-ChildItem -Path 'dist' -File | Where-Object { $_.Extension -in '.zip', '.exe', '.msi' } | Sort-Object Name | ForEach-Object {
        $hash = (Get-FileHash -Path $_.FullName -Algorithm SHA256).Hash
        $checksumLines += "$hash  $($_.Name)"
        "$hash  $($_.Name)" | Out-File -FilePath "$($_.FullName).sha256" -Encoding ascii
    }
    if ($checksumLines.Count -gt 0) {
        $checksumLines | Out-File -FilePath 'dist/SHA256SUMS.txt' -Encoding ascii
        Write-Host ($checksumLines -join "`n")
    }
} finally {
    Pop-Location
}

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$cargo = if (Get-Command cargo -ErrorAction SilentlyContinue) {
    'cargo'
} else {
    Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
}

# Se o projeto estiver em uma pasta sincronizada pelo OneDrive e CARGO_TARGET_DIR não estiver definido,
# tenta redirecionar o cache de compilação para fora do OneDrive (onde hard links NTFS funcionam sem warnings).
if (-not $env:CARGO_TARGET_DIR -and $repoRoot -match '[\\/]OneDrive(?:[^\\/]*)[\\/]') {
    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'streamgrid-cargo-target')
    }
    if ($env:TEMP) {
        $candidates += (Join-Path $env:TEMP 'streamgrid-cargo-target')
    }

    foreach ($dir in $candidates) {
        try {
            New-Item -ItemType Directory -Force -Path $dir -ErrorAction Stop | Out-Null
            $probeSrc = Join-Path $dir ".hl_probe_$PID"
            $probeDst = Join-Path $dir ".hl_probe_link_$PID"
            Set-Content -Path $probeSrc -Value 'ok' -NoNewline -ErrorAction Stop
            New-Item -ItemType HardLink -Path $probeDst -Target $probeSrc -Force -ErrorAction Stop | Out-Null
            Remove-Item -Force -Path $probeDst, $probeSrc -ErrorAction SilentlyContinue
            $env:CARGO_TARGET_DIR = $dir
            break
        } catch {
            if ($probeDst) { Remove-Item -Force -Path $probeDst -ErrorAction SilentlyContinue }
            if ($probeSrc) { Remove-Item -Force -Path $probeSrc -ErrorAction SilentlyContinue }
        }
    }
}

& $cargo test --manifest-path (Join-Path $repoRoot 'src-tauri\Cargo.toml') @args
exit $LASTEXITCODE

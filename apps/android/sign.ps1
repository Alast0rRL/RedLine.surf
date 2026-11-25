# Подпись release APK ключом redline-chat.jks. Пароль спросит apksigner.
$ErrorActionPreference = 'Stop'
$java = Join-Path $env:LOCALAPPDATA 'Programs\jdk-17.0.21.1+2\bin\java.exe'
$signer = Join-Path $PSScriptRoot 'tools\apksigner.jar'
$ks = Join-Path $env:USERPROFILE 'keys\redline-chat.jks'
$in = Join-Path $PSScriptRoot 'app-release-aligned.apk'
$out = Join-Path $PSScriptRoot 'Redline.apk'
foreach ($p in $java, $signer, $ks, $in) { '{0}  {1}' -f (Test-Path -LiteralPath $p), $p }
& $java -jar $signer sign --ks $ks --ks-key-alias redline --out $out $in
if ($LASTEXITCODE -eq 0) { & $java -jar $signer verify --print-certs $out | Select-String 'SHA-256' }

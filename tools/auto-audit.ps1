<#
  auto-audit.ps1, audit autonome Nadelio, économe et prudent.

  Format de la file (audit-queue.txt), une par ligne : "Marque | hint optionnel"
   - '#' en début de ligne = commentaire ignoré.
   - 'DONE ' en début de ligne = déjà auditée, ignorée.
   - Le hint (après le '|') désambiguïse l'entité (nom ambigu -> bonne boîte).

  À chaque exécution :
   1. Lit la file, prend jusqu'à MAX_PER_DAY marques non cochées.
   2. Pour chacune : POST /api/infer (GRATUIT, zéro quota) avec le hint pour
      obtenir sector + competitors + queries validés.
   3. POST /api/analyze avec ces competitors/queries validés (1 slot quota),
      ce qui garantit la bonne entité et évite une ré-inférence.
   4. Sauve le JSON dans tools/audit-results/<marque>-<date>.json.
   5. Coche la marque (DONE) dans la file, journalise dans auto-audit.log.

  Zéro token de modèle : pur HTTP + fichiers. S'arrête proprement sur file
  vide, 429 (quota), ou erreur serveur. Aucun appel gaspillé.

  Test (aucun appel réel) : powershell -ExecutionPolicy Bypass -File auto-audit.ps1 -WhatIf
  Réel                    : powershell -ExecutionPolicy Bypass -File auto-audit.ps1
#>

param(
  [int]$MaxPerDay = 3,
  [string]$ApiBase = "https://nadelio.com",
  [switch]$WhatIf
)

$ErrorActionPreference = "Stop"
$root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$queueFile  = Join-Path $root "audit-queue.txt"
$resultsDir = Join-Path $root "audit-results"
$logFile    = Join-Path $root "auto-audit.log"
$today      = (Get-Date).ToString("yyyy-MM-dd")

function Write-Log([string]$msg) {
  $line = "$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))  $msg"
  Add-Content -Path $logFile -Value $line -Encoding utf8
  Write-Host $line
}

# Parse une ligne de file -> objet {Raw, Brand, Hint} ou $null si à ignorer.
function Parse-QueueLine([string]$line) {
  $t = $line.Trim()
  if ($t -eq "" -or $t.StartsWith("#") -or $t.StartsWith("DONE")) { return $null }
  $parts = $t -split "\|", 2
  $brand = $parts[0].Trim()
  $hint  = if ($parts.Count -gt 1) { $parts[1].Trim() } else { "" }
  if ($brand -eq "") { return $null }
  return [pscustomobject]@{ Raw = $line; Brand = $brand; Hint = $hint }
}

if (-not (Test-Path $queueFile)) { Write-Log "Queue introuvable: $queueFile"; exit 1 }
if (-not (Test-Path $resultsDir)) { New-Item -ItemType Directory -Path $resultsDir | Out-Null }

$lines = Get-Content -Path $queueFile -Encoding utf8
$pending = @()
foreach ($l in $lines) { $p = Parse-QueueLine $l; if ($p) { $pending += $p } }

if ($pending.Count -eq 0) { Write-Log "File vide, rien a auditer. Fin."; exit 0 }

$batch = $pending | Select-Object -First $MaxPerDay
Write-Log "File: $($pending.Count) en attente. Ce run: $(( $batch | ForEach-Object { $_.Brand }) -join ', ') (max $MaxPerDay/jour)."

if ($WhatIf) {
  foreach ($item in $batch) {
    Write-Log "[WhatIf] '$($item.Brand)' hint='$($item.Hint)' -> /api/infer puis /api/analyze (aucun appel reel)."
  }
  exit 0
}

foreach ($item in $batch) {
  $brand = $item.Brand
  try {
    # --- Étape A : inférence (gratuite) pour valider l'entité ---
    $inferBody = @{ brand = $brand; hint = $item.Hint } | ConvertTo-Json -Compress
    $inferResp = Invoke-WebRequest -Uri "$ApiBase/api/infer" -Method Post `
                   -ContentType "application/json" -Body $inferBody `
                   -TimeoutSec 120 -UseBasicParsing
    $infer = $inferResp.Content | ConvertFrom-Json
    if ($infer.error) {
      Write-Log "INFER echec '$brand': $($infer.error) $($infer.message). Non coche, sera retente."
      continue
    }
    $sector = $infer.sector
    Write-Log "INFER '$brand' -> secteur '$sector', concurrents: $(( $infer.competitors) -join ', ')."

    # --- Étape B : analyse (1 slot quota) avec l'entité validée ---
    $analyzeBody = @{
      live        = $true
      brand       = $brand
      sector      = $sector
      competitors = $infer.competitors
      queries     = $infer.queries
    } | ConvertTo-Json -Compress
    $resp = Invoke-WebRequest -Uri "$ApiBase/api/analyze" -Method Post `
              -ContentType "application/json" -Body $analyzeBody `
              -TimeoutSec 120 -UseBasicParsing
    $data = $resp.Content | ConvertFrom-Json

    if ($data.error -eq "quota_ip" -or $data.error -eq "quota_global") {
      Write-Log "QUOTA atteint sur '$brand' ($($data.error)). Arret, reste en file pour demain."
      break
    }

    $outFile = Join-Path $resultsDir "$($brand.ToLower())-$today.json"
    $resp.Content | Out-File -FilePath $outFile -Encoding utf8

    if ($data.mode -eq "live") {
      Write-Log "OK '$brand' -> live, cout $($data.cost). Sauve: $outFile"
    } elseif ($data.cached) {
      Write-Log "OK '$brand' -> deja en cache (0 quota). Sauve: $outFile"
    } else {
      Write-Log "ATTENTION '$brand' -> mode '$($data.mode)' (fallback: $($data.notice)). Non coche, sera retente."
      continue
    }

    # Coche la marque : préfixe la 1re ligne matchante par 'DONE '.
    $lines = Get-Content -Path $queueFile -Encoding utf8
    $done = $false
    $lines = $lines | ForEach-Object {
      $p = Parse-QueueLine $_
      if (-not $done -and $p -and $p.Brand -eq $brand) { $done = $true; "DONE $_" } else { $_ }
    }
    Set-Content -Path $queueFile -Value $lines -Encoding utf8

    Start-Sleep -Seconds 5
  }
  catch {
    Write-Log "ERREUR sur '$brand': $($_.Exception.Message). Arret, reste en file."
    break
  }
}

Write-Log "Run termine."

# Reconstruit la branche deploy-hostinger : sa racine contient les fichiers
# de hostinger-php/ (jamais config.php ni le contenu de data/).
# Usage : powershell -File hostinger-php/deploy/build-deploy.ps1
# Puis :   git push deploy deploy-hostinger:deploy-hostinger

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$wt = Join-Path $env:TEMP 'spinecho-deploy-tree'

git -C $repo worktree remove $wt --force 2>$null
if (Test-Path $wt) { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }

git -C $repo worktree add --detach $wt HEAD | Out-Null
Get-ChildItem -Force $wt | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force

$src = Join-Path $repo 'hostinger-php'
@('api.php','inc.php','cron.php','config.sample.php','.htaccess','index.html','tech.html','style.css','user.js','tech.js','README.md','DEPLOYMENT.md') | ForEach-Object {
  Copy-Item (Join-Path $src $_) (Join-Path $wt $_) 
}
New-Item -ItemType Directory -Force -Path (Join-Path $wt 'data') | Out-Null
Copy-Item (Join-Path $src 'data\.htaccess') (Join-Path $wt 'data\.htaccess')

git -C $wt add -A
git -C $wt commit -q --allow-empty -m "Déploiement $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
git -C $wt branch -f deploy-hostinger
git -C $repo worktree remove $wt --force

Write-Host "Branche deploy-hostinger reconstruite."
Write-Host "Pour déployer : git push deploy deploy-hostinger:deploy-hostinger"

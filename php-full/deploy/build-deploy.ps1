# Reconstruit la branche deploy-hostinger : sa racine contient les fichiers
# de php-full/ (jamais config.php ni le contenu de data/).
# Usage : powershell -ExecutionPolicy Bypass -File php-full/deploy/build-deploy.ps1
# Puis :   git push deploy deploy-hostinger:deploy-hostinger

$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$wt = Join-Path $env:TEMP 'easyhelper-deploy-tree'

# Nettoyage tolérant : suppression du dossier puis purge des worktrees orphelins
if (Test-Path $wt) { Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue }
git -C $repo worktree prune | Out-Null

git -C $repo worktree add --detach $wt HEAD | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'git worktree add a échoué' }

# On vide le worktree (on garde le fichier .git) puis on copie les fichiers de l'app
Get-ChildItem -Force $wt | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force

$src = Join-Path $repo 'php-full'
@('api.php','inc.php','cron.php','config.sample.php','.htaccess','index.html','tech.html','style.css','crypto.js','user.js','tech.js','README.md','DEPLOYMENT.md') | ForEach-Object {
  Copy-Item (Join-Path $src $_) (Join-Path $wt $_)
}
New-Item -ItemType Directory -Force -Path (Join-Path $wt 'data') | Out-Null
Copy-Item (Join-Path $src 'data\.htaccess') (Join-Path $wt 'data\.htaccess')

git -C $wt add -A | Out-Null
git -C $wt commit -q --allow-empty -m "Déploiement $(Get-Date -Format 'yyyy-MM-dd HH:mm')" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'commit de déploiement échoué' }

git -C $wt branch -f deploy-hostinger | Out-Null
git -C $repo worktree remove $wt --force | Out-Null
if ($LASTEXITCODE -ne 0) {
  git -C $repo worktree prune | Out-Null
  Remove-Item $wt -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'Branche deploy-hostinger reconstruite.'
Write-Host 'Pour déployer : git push deploy deploy-hostinger:deploy-hostinger'

/**
 * Restart the desktop application from outside itself, pruning stale auth cookies.
 *
 * The Host is a child of the desktop shell, so a launcher spawned from here belongs
 * to that process tree and would die with the app. The helpers are written next to
 * the plugin data and started by Explorer instead.
 *
 * Each start opens a random local port and stores a `dsh-auth-<hash>` cookie for
 * 127.0.0.1; cookies are not port-scoped, so they pile up until the request header
 * exceeds the server limit (HTTP 431) and the app cannot finish its handshake. The
 * helper removes those rows while the cookie database is unlocked.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PS1 = 'restart-dsh.ps1';
const VBS = 'restart-dsh.vbs';
const CLEAN = 'clean-dsh-cookies.mjs';

/** Removes only the auth rows; prints how many were deleted. */
export function cleanScript() {
  return `import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined || !existsSync(file)) {
  console.log('cookies: missing');
  process.exit(0);
}
try {
  copyFileSync(file, \`\${file}.bak\`);
} catch {
  // A failed backup must not block the cleanup.
}
try {
  const db = new DatabaseSync(file);
  const info = db.prepare("delete from cookies where name like 'dsh-auth-%'").run();
  db.close();
  console.log(\`cookies: removed \${String(info.changes)}\`);
} catch (error) {
  console.log(\`cookies: failed \${String(error?.message ?? error)}\`);
  process.exit(1);
}
`;
}

/** The restart helper; falls back to deleting the whole store when Node is absent. */
export function ps1Body(exe, cleanPath) {
  const quotedExe = exe.replace(/'/gu, "''");
  const quotedClean = cleanPath.replace(/'/gu, "''");
  return `param([string]$ExePath = '${quotedExe}')
Start-Sleep -Milliseconds 300
& taskkill.exe /IM 'DeepSeek Harness.exe' /T /F | Out-Null
Start-Sleep -Milliseconds 500

$cookies = Join-Path $env:APPDATA '@deepseek-ai\\dsh-desktop\\Network\\Cookies'
$stamp = Join-Path (Join-Path $env:LOCALAPPDATA 'dsh-enhanced') 'cookie-clean.week'
$now = Get-Date
$week = '{0}-W{1:D2}' -f $now.Year, ([math]::Floor(($now.DayOfYear - 1) / 7) + 1)
$lastClean = ''
if (Test-Path -LiteralPath $stamp) {
  try { $lastClean = (Get-Content -LiteralPath $stamp -Raw).Trim() } catch { $lastClean = '' }
}
$node = Get-ChildItem (Join-Path $env:USERPROFILE '.dsh\\dsh-runtimes') -Recurse -Filter node.exe -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1
$cleaned = $false
if ($lastClean -eq $week) {
  $cleaned = $true
} elseif ($null -ne $node -and (Test-Path -LiteralPath $cookies)) {
  try {
    & $node.FullName '${quotedClean}' $cookies | Out-Null
    $cleaned = $LASTEXITCODE -eq 0
    if ($cleaned) {
      try { Set-Content -LiteralPath $stamp -Value $week -Encoding ascii } catch { }
    }
  } catch {
    $cleaned = $false
  }
}
if (-not $cleaned -and (Test-Path -LiteralPath $cookies)) {
  try {
    Copy-Item -LiteralPath $cookies -Destination ($cookies + '.bak') -Force
    Remove-Item -LiteralPath $cookies, ($cookies + '-journal') -Force -ErrorAction SilentlyContinue
    try { Set-Content -LiteralPath $stamp -Value $week -Encoding ascii } catch { }
  } catch {
    # A locked store simply keeps its old cookies.
  }
}

$pendingRoot = Join-Path (Join-Path $env:USERPROFILE '.dsh\dsh-enhanced') 'pending\profiles'
if (Test-Path -LiteralPath $pendingRoot) {
  Get-ChildItem -LiteralPath $pendingRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $src = Join-Path $_.FullName 'cordis.patch.yml'
    if (Test-Path -LiteralPath $src) {
      $dst = Join-Path (Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $_.Name) 'cordis.patch.yml'
      try {
        if (Test-Path -LiteralPath $dst) { Copy-Item -LiteralPath $dst -Destination ($dst + '.bak') -Force }
        Copy-Item -LiteralPath $src -Destination $dst -Force
        Remove-Item -LiteralPath $src -Force
      } catch {
        # A failed patch swap leaves the old file in place.
      }
    }
  }
}

Start-Process -FilePath explorer.exe -ArgumentList $ExePath
`;
}

/** A silent launcher; Explorer runs this one, so it is not in the app tree. */
function vbsBody(ps1Path) {
  const target = ps1Path.replace(/"/gu, '""');
  return `Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${target}""", 0, False
`;
}

/** Best-effort diagnostic line. */
async function trace(paths, line) {
  try {
    await fsp.appendFile(path.join(paths.base, 'restart.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // Diagnostics never block a restart.
  }
}

/**
 * Schedule one restart and return immediately.
 * @param paths - plugin data paths (`base` receives the helpers and the log).
 * @returns `{ ok: true }` once Explorer accepted the launch.
 */
export async function restartApplication(paths) {
  const exe = process.execPath;
  if (!/(^|[\\/])DeepSeek Harness\.exe$/iu.test(exe)) {
    await trace(paths, `refused: execPath is not the desktop app (${exe})`);
    throw Object.assign(new Error(`重启已拒绝：当前进程不是桌面应用（${exe}）`), { code: 'restart-path' });
  }

  const scriptPath = path.join(paths.base, PS1);
  const cleanPath = path.join(paths.base, CLEAN);
  const launcherPath = path.join(paths.base, VBS);

  await fsp.mkdir(paths.base, { recursive: true }).catch(() => {});
  await fsp.writeFile(cleanPath, cleanScript(), 'utf8');
  await fsp.writeFile(scriptPath, `\ufeff${ps1Body(exe, cleanPath)}`, 'utf8');
  await fsp.writeFile(launcherPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbsBody(scriptPath), 'utf16le')]));
  await trace(paths, `scheduling restart; exe=${exe}; launcher=${launcherPath}`);

  try {
    spawn('explorer.exe', [launcherPath], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await trace(paths, 'launcher handed to explorer');
    return { ok: true };
  } catch (error) {
    await trace(paths, `launch failed: ${String(error?.message ?? error)}`);
    throw Object.assign(new Error(`无法启动重启脚本：${String(error?.message ?? error)}`), { code: 'restart-spawn' });
  }
}

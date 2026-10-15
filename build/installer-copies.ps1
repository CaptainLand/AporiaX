# Runs only from the new installer. No old uninstaller is ever executed here.
[CmdletBinding()]
param(
  [ValidateSet('Plan','Validate','Complete','Library')][string]$Mode = 'Plan',
  [string]$Version, [string]$ProductGuid, [string]$InputDirectory,
  [string]$PlanHash, [long]$OwnerHwnd = 0
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:BackupRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'AporiaX\installation-backups'
$script:PathComparison = [StringComparison]::OrdinalIgnoreCase

function Test-Within([string]$Path, [string]$Root) {
  return $Path.Equals($Root, $script:PathComparison) -or $Path.StartsWith($Root.TrimEnd('\') + '\', $script:PathComparison)
}
function Assert-NoReparse([string]$Path) {
  $part = $Path
  while ($part) {
    if (Test-Path -LiteralPath $part) {
      if ((Get-Item -LiteralPath $part -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '目录或文件包含链接，已跳过。' }
    }
    $parent = [IO.Path]::GetDirectoryName($part.TrimEnd('\'))
    if ($parent -eq $part) { break }; $part = $parent
  }
}
function Get-SafeDirectory([string]$Path) {
  if (!$Path -or $Path -notmatch '^[a-zA-Z]:[\\/]' -or $Path -match '[\x00-\x1f"<>|?*]' -or $Path.Substring(2).Contains(':')) { throw '不是可整理的本机绝对目录。' }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full -eq [IO.Path]::GetPathRoot($full).TrimEnd('\')) { throw '不能整理磁盘根目录。' }
  foreach ($special in @([Environment]::GetFolderPath('Windows'), [Environment]::GetFolderPath('UserProfile'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('MyDocuments'), [Environment]::GetFolderPath('ApplicationData'), [Environment]::GetFolderPath('LocalApplicationData'), [Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86'))) {
    if (!$special) { continue }
    if ($full.Equals($special.TrimEnd('\'), $script:PathComparison)) { throw '不能整理系统、用户资料或通用程序根目录。' }
  }
  foreach ($protected in @([Environment]::GetFolderPath('Windows'), [Environment]::GetFolderPath('ApplicationData'), $script:BackupRoot)) {
    if ($protected -and (Test-Within $full $protected)) { throw '受保护的数据或恢复备份目录。' }
  }
  $local = [Environment]::GetFolderPath('LocalApplicationData')
  if ($local -and (Test-Within $full $local) -and !(Test-Within $full (Join-Path $local 'Programs'))) { throw '不是本机用户程序目录，保留数据不整理。' }
  Assert-NoReparse $full
  return $full
}
function Get-InstallDirectory([string]$Parent) {
  if (!$Parent -or $Parent -notmatch '^[a-zA-Z]:[\\/]' -or $Parent -match '[\x00-\x1f"<>|?*]') { throw '请选择本机父目录。' }
  $directory = [IO.Path]::GetFullPath($Parent).TrimEnd('\')
  if ($directory -match '^[a-zA-Z]:$') { $directory += '\' }
  if ([IO.Path]::GetFileName($directory) -ine 'AporiaX') { $directory = Join-Path $directory 'AporiaX' }
  return Get-SafeDirectory $directory
}
function Assert-InstallTarget([string]$Directory, [string]$TargetVersion) {
  $directory = Get-SafeDirectory $Directory
  if (Test-Path -LiteralPath $directory) {
    if (!(Test-Path -LiteralPath $directory -PathType Container)) { throw '目标位置不是目录。' }
    if (@(Get-ChildItem -LiteralPath $directory -Force | Select-Object -First 1).Count) {
      $identity = Get-CopyIdentity $directory
      if ((Compare-AppVersion $identity.Version $TargetVersion) -gt 0) { throw '目标目录已有更高版本，请选择其他目录。' }
    }
  }
  return $directory
}
function Get-Property($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -ne $property) { return $property.Value }; return $null
}
function Read-Exact($Reader, [int]$Length) {
  $bytes = $Reader.ReadBytes($Length)
  if ($bytes.Length -ne $Length) { throw '安装文件不完整。' }
  return ,$bytes
}
function Get-FileDigest([string]$Path) {
  $stream = [IO.File]::Open($Path, 'Open', 'Read', 'Read')
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '') }
  finally { $sha.Dispose(); $stream.Dispose() }
}
function Get-AsarIdentity([string]$Directory) {
  $archive = Join-Path $Directory 'resources\app.asar'
  Assert-NoReparse $archive
  $stream = [IO.File]::Open($archive, 'Open', 'Read', 'Read')
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($reader.ReadUInt32() -ne 4) { throw '不是有效的应用归档。' }
    $length = $reader.ReadUInt32()
    if ($length -lt 8 -or $length -gt 16777216 -or $length + 8 -gt $stream.Length) { throw '应用归档头不正确。' }
    $headerBytes = Read-Exact $reader $length
    $jsonLength = [BitConverter]::ToUInt32($headerBytes, 4)
    if ($jsonLength -lt 2 -or $jsonLength + 8 -gt $length) { throw '应用归档索引不正确。' }
    $header = [Text.Encoding]::UTF8.GetString($headerBytes, 8, $jsonLength) | ConvertFrom-Json
    $package = Get-Property (Get-Property $header 'files') 'package.json'
    $size = Get-Property $package 'size'; $offset = Get-Property $package 'offset'
    if ((Get-Property $package 'unpacked') -or (Get-Property $package 'link') -or $null -eq $size -or $size -gt 262144 -or $size -lt 2 -or "$offset" -notmatch '^\d+$') { throw '没有可信的产品元信息。' }
    $position = [long]8 + $length + [long]$offset
    if ($position + [long]$size -gt $stream.Length) { throw '产品元信息超出归档。' }
    $null = $stream.Seek($position, 'Begin')
    $pkg = [Text.Encoding]::UTF8.GetString((Read-Exact $reader $size)) | ConvertFrom-Json
    if ((Get-Property $pkg 'name') -ne 'aporiax-desktop' -or (Get-Property $pkg 'productName') -ne 'AporiaX' -or (Get-Property $pkg 'version') -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') { throw '不是可确认的 AporiaX 程序。' }
    foreach ($required in @('dist/index.html', [string](Get-Property $pkg 'main'))) {
      if (!$required -or $required -match '(^/|\\|(^|/)\.\.(/|$))') { throw '应用入口不正确。' }
      $entry = $header
      foreach ($component in $required.Split('/')) { $entry = Get-Property (Get-Property $entry 'files') $component }
      if ($null -eq $entry -or !(Get-Property $entry 'size') -or (Get-Property $entry 'link') -or (Get-Property $entry 'unpacked')) { throw '应用入口缺失。' }
      $entryOffset = Get-Property $entry 'offset'
      if ("$entryOffset" -notmatch '^\d+$' -or [long]8 + $length + [long]$entryOffset + [long](Get-Property $entry 'size') -gt $stream.Length) { throw '应用入口不完整。' }
    }
    return @{ Package = $pkg; Header = $header }
  } finally { $reader.Dispose(); $stream.Dispose() }
}
function Compare-AppVersion([string]$Left, [string]$Right) {
  $a = $Left.Split('+')[0].Split('-', 2); $b = $Right.Split('+')[0].Split('-', 2)
  $core = ([version]$a[0]).CompareTo([version]$b[0])
  if ($core -ne 0) { return $core }
  if ($a.Length -eq 1 -and $b.Length -eq 1) { return 0 }
  if ($a.Length -eq 1) { return 1 }; if ($b.Length -eq 1) { return -1 }
  $aa = $a[1].Split('.'); $bb = $b[1].Split('.')
  for ($i = 0; $i -lt [Math]::Max($aa.Length, $bb.Length); $i++) {
    if ($i -ge $aa.Length) { return -1 }; if ($i -ge $bb.Length) { return 1 }
    if ($aa[$i] -eq $bb[$i]) { continue }
    $an = $aa[$i] -match '^\d+$'; $bn = $bb[$i] -match '^\d+$'
    if ($an -and $bn) { return ([decimal]$aa[$i]).CompareTo([decimal]$bb[$i]) }
    if ($an -ne $bn) { if ($an) { return -1 }; return 1 }
    return [string]::CompareOrdinal($aa[$i], $bb[$i])
  }; return 0
}
function Get-CopyIdentity([string]$Directory) {
  $directory = Get-SafeDirectory $Directory
  $exe = Join-Path $directory 'AporiaX.exe'; Assert-NoReparse $exe
  if (!(Test-Path -LiteralPath $exe -PathType Leaf)) { throw '没有 AporiaX.exe。' }
  $info = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
  if ($info.ProductName -ne 'AporiaX') { throw '程序产品名不匹配。' }
  $identity = Get-AsarIdentity $directory
  $identity.Directory = $directory
  $identity.Version = [string]$identity.Package.version
  $core = [version]$identity.Version.Split('-')[0].Split('+')[0]
  if ($info.FileMajorPart -ne $core.Major -or $info.FileMinorPart -ne $core.Minor -or $info.FileBuildPart -ne $core.Build) { throw '程序与应用归档版本不一致。' }
  $identity.ExeHash = Get-FileDigest $exe
  $identity.AsarHash = Get-FileDigest (Join-Path $directory 'resources\app.asar')
  return $identity
}
function Get-ShortcutFiles {
  $roots = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'), [Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu')) | Where-Object { $_ } | Select-Object -Unique
  $queue = [Collections.Generic.Queue[object]]::new(); foreach ($root in $roots) { $queue.Enqueue(@{ Path = $root; Depth = 0 }) }
  $seen = 0
  while ($queue.Count -and $seen -lt 3000) {
    $item = $queue.Dequeue()
    try { Assert-NoReparse $item.Path; $entries = @(Get-ChildItem -LiteralPath $item.Path -Force -ErrorAction Stop) } catch { continue }
    foreach ($entry in $entries) {
      $seen++; if ($seen -gt 3000) { break }
      if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      if ($entry.PSIsContainer -and $item.Depth -lt 6) { $queue.Enqueue(@{ Path = $entry.FullName; Depth = $item.Depth + 1 }) }
      elseif (!$entry.PSIsContainer -and $entry.Extension -ieq '.lnk') { $entry.FullName }
    }
  }
}
function Get-DiscoveryPaths([string]$Guid, [string[]]$Seeds = @()) {
  $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($seed in $Seeds) { if ($seed) { $null = $paths.Add($seed) } }
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = $null; $direct = $null; $uninstall = $null
      try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $direct = $base.OpenSubKey("Software\$Guid")
        if ($direct) { $null = $paths.Add([string]$direct.GetValue('InstallLocation', '')) }
        $uninstall = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
        if ($uninstall) { foreach ($name in @($uninstall.GetSubKeyNames() | Select-Object -First 5000)) {
          $key = $uninstall.OpenSubKey($name)
          try { if ($key -and ($name -eq $Guid -or [string]$key.GetValue('DisplayName', '') -match '^AporiaX(?:\s|$)')) {
            $null = $paths.Add([string]$key.GetValue('InstallLocation', ''))
            $command = [string]$key.GetValue('UninstallString', '')
            if ($command -match '^"([^"\r\n]+\\Uninstall AporiaX\.exe)"(?:\s|$)') { $null = $paths.Add([IO.Path]::GetDirectoryName($Matches[1])) }
          } } finally { if ($key) { $key.Dispose() } }
        } }
      } catch { } finally { if ($direct) { $direct.Dispose() }; if ($uninstall) { $uninstall.Dispose() }; if ($base) { $base.Dispose() } }
    }
  }
  $shell = New-Object -ComObject WScript.Shell
  foreach ($link in Get-ShortcutFiles) { try { $target = $shell.CreateShortcut($link).TargetPath; if ([IO.Path]::GetFileName($target) -ieq 'AporiaX.exe') { $null = $paths.Add([IO.Path]::GetDirectoryName($target)) } } catch { } }
  foreach ($root in @((Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Programs'), [Environment]::GetFolderPath('ProgramFiles'), [Environment]::GetFolderPath('ProgramFilesX86'))) {
    if ($root) { $null = $paths.Add((Join-Path $root 'AporiaX')) }
  }
  return @($paths | Where-Object { $_ } | Select-Object -First 128)
}
function Get-CopyChoice([string]$Path, [string]$Keep, [string]$TargetVersion) {
  try {
    $id = Get-CopyIdentity $Path
    if ((Test-Within $id.Directory $Keep) -or (Test-Within $Keep $id.Directory)) { throw '保留目录或与其重叠，不整理。' }
    if ((Compare-AppVersion $id.Version $TargetVersion) -gt 0) { throw '版本高于本次安装，保留。' }
    Assert-CopyNotRunning $id.Directory
    return @{ Directory = $id.Directory; Version = $id.Version; ExeHash = $id.ExeHash; AsarHash = $id.AsarHash; Eligible = $true; Reason = '可整理，程序文件将保留恢复备份' }
  } catch { return @{ Directory = $Path; Version = ''; Eligible = $false; Reason = $_.Exception.Message } }
}
function Get-OwnedProgramFiles($Identity) {
  $owned = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  # Exact Electron/AporiaX program filenames, never arbitrary user files or directories.
  foreach ($path in @('AporiaX.exe','Uninstall AporiaX.exe','chrome_100_percent.pak','chrome_200_percent.pak','d3dcompiler_47.dll','dxcompiler.dll','dxil.dll','ffmpeg.dll','icudtl.dat','libEGL.dll','libGLESv2.dll','resources.pak','snapshot_blob.bin','v8_context_snapshot.bin','vk_swiftshader.dll','vk_swiftshader_icd.json','vulkan-1.dll','LICENSE.electron.txt','LICENSES.chromium.html','uninstallerIcon.ico','resources\app.asar','resources\app-update.yml','resources\elevate.exe','resources\control-bridge.cjs')) { $null = $owned.Add($path) }
  $locales = Join-Path $Identity.Directory 'locales'
  if (Test-Path -LiteralPath $locales) { Assert-NoReparse $locales; foreach ($file in Get-ChildItem -LiteralPath $locales -File) { if ($file.Name -match '^[A-Za-z0-9_-]+\.pak$') { $null = $owned.Add('locales\' + $file.Name) } } }
  $queue = [Collections.Generic.Queue[object]]::new(); $queue.Enqueue(@{ Node = $Identity.Header; Prefix = '' }); $count = 0
  while ($queue.Count) {
    $entry = $queue.Dequeue(); $files = Get-Property $entry.Node 'files'
    if ($null -eq $files) { continue }
    foreach ($property in $files.PSObject.Properties) {
      if (++$count -gt 100000 -or $property.Name -in @('.', '..') -or $property.Name -match '[\\/:\x00-\x1f"<>|?*]') { throw '归档路径不安全。' }
      $relative = $entry.Prefix + $property.Name; $node = $property.Value
      if (Get-Property $node 'files') { $queue.Enqueue(@{ Node = $node; Prefix = $relative + '\' }) }
      elseif ((Get-Property $node 'unpacked') -and !(Get-Property $node 'link')) { $null = $owned.Add('resources\app.asar.unpacked\' + $relative) }
    }
  }
  $result = [Collections.Generic.List[string]]::new()
  foreach ($relative in $owned) {
    $full = [IO.Path]::GetFullPath((Join-Path $Identity.Directory $relative))
    if (!(Test-Within $full $Identity.Directory)) { throw '程序文件超出目录。' }
    if (Test-Path -LiteralPath $full) { Assert-NoReparse $full; if (!(Test-Path -LiteralPath $full -PathType Leaf)) { throw '程序文件被目录替代，已跳过。' }; $result.Add($relative) }
  }; return $result.ToArray()
}
function Assert-CopyNotRunning([string]$Directory) {
  foreach ($process in [Diagnostics.Process]::GetProcessesByName('AporiaX')) {
    try {
      $path = $process.MainModule.FileName
      if (!$path) { throw '无法核对运行中的 AporiaX 路径，暂不整理。' }
      if (Test-Within $path $Directory) { throw '此副本仍在运行，已跳过，请退出后再整理。' }
    } finally { $process.Dispose() }
  }
}
function Write-Json([string]$Path, $Value) {
  Assert-NoReparse $Path
  $temporary = $Path + '.pending-' + [guid]::NewGuid().ToString()
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 30), [Text.UTF8Encoding]::new($false))
  if ([IO.File]::Exists($Path)) { [IO.File]::Replace($temporary, $Path, $Path + '.previous') } else { [IO.File]::Move($temporary, $Path) }
}
function Move-OldProgramCopy($Choice, [string]$Keep, [string]$TargetVersion, [string]$SessionBackup) {
  $identity = Get-CopyIdentity $Choice.Directory
  if ((Test-Within $identity.Directory $Keep) -or (Test-Within $Keep $identity.Directory) -or (Compare-AppVersion $identity.Version $TargetVersion) -gt 0) { throw '保留目录、重叠目录或更新版本，拒绝整理。' }
  if ($identity.ExeHash -ne $Choice.ExeHash -or $identity.AsarHash -ne $Choice.AsarHash -or $identity.Version -ne $Choice.Version) { throw '确认后程序发生变化，已跳过。' }
  Assert-CopyNotRunning $identity.Directory
  $files = @(Get-OwnedProgramFiles $identity)
  Assert-NoReparse $SessionBackup
  if ((Test-Within $SessionBackup $identity.Directory) -or (Test-Within $identity.Directory $SessionBackup) -or (Test-Within $SessionBackup $Keep)) { throw '备份目录与安装目录重叠。' }
  $backup = Join-Path $SessionBackup ([guid]::NewGuid().ToString())
  $null = [IO.Directory]::CreateDirectory($backup); Assert-NoReparse $backup
  $journal = @{ OriginalDirectory = $identity.Directory; Version = $identity.Version; KeptDirectory = $Keep; Files = $files; Moved = @(); State = 'moving'; CreatedAt = [DateTime]::UtcNow.ToString('o') }
  $journalPath = Join-Path $backup 'restore-manifest.json'; Write-Json $journalPath $journal
  $moved = [Collections.Generic.List[string]]::new()
  try {
    foreach ($relative in $files) {
      $source = [IO.Path]::GetFullPath((Join-Path $identity.Directory $relative)); $destination = [IO.Path]::GetFullPath((Join-Path $backup $relative))
      if (!(Test-Within $source $identity.Directory) -or !(Test-Within $destination $backup)) { throw '文件移动范围不正确。' }
      Assert-NoReparse $source; Assert-NoReparse $destination
      $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
      Move-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
      $moved.Add($relative)
      if ($moved.Count % 32 -eq 0) { $journal.Moved = $moved.ToArray(); Write-Json $journalPath $journal }
    }
    $journal.Moved = $moved.ToArray(); $journal.State = 'complete'; Write-Json $journalPath $journal
  } catch {
    $failure = $_.Exception.Message
    foreach ($relative in @($moved.ToArray()) | Sort-Object Length -Descending) {
      try {
        $source = Join-Path $backup $relative; $destination = Join-Path $identity.Directory $relative
        Assert-NoReparse $source; Assert-NoReparse $destination
        if (!(Test-Path -LiteralPath $destination)) { $null = [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)); Move-Item -LiteralPath $source -Destination $destination -ErrorAction Stop }
      } catch { }
    }
    $journal.State = 'interrupted-recovery-retained'; $journal.Error = $failure; Write-Json $journalPath $journal
    throw "整理未完成，已尝试恢复；备份和记录位于 $backup"
  }
  # Delete ONLY verified empty directories, never recurse into user material.
  $empty = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($relative in $files) { $parent = [IO.Path]::GetDirectoryName((Join-Path $identity.Directory $relative)); while ($parent -and (Test-Within $parent $identity.Directory)) { $null = $empty.Add($parent); if ($parent -eq $identity.Directory) { break }; $parent = [IO.Path]::GetDirectoryName($parent) } }
  foreach ($directory in $empty | Sort-Object Length -Descending) { try { Assert-NoReparse $directory; [IO.Directory]::Delete($directory, $false) } catch { } }
  return @{ Directory = $identity.Directory; Backup = $backup; Version = $identity.Version; PreservedExtraFiles = (Test-Path -LiteralPath $identity.Directory) }
}
function Repair-OldShortcuts([string[]]$OldDirectories, [string]$Keep) {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($path in Get-ShortcutFiles) {
    try {
      Assert-NoReparse $path; $shortcut = $shell.CreateShortcut($path)
      foreach ($old in $OldDirectories) { if ($shortcut.TargetPath -ieq (Join-Path $old 'AporiaX.exe')) { $shortcut.TargetPath = Join-Path $Keep 'AporiaX.exe'; $shortcut.WorkingDirectory = $Keep; $shortcut.IconLocation = (Join-Path $Keep 'AporiaX.exe') + ',0'; $shortcut.Save(); break } }
    } catch { Write-Warning "未能修正快捷方式：$path" }
  }
}
function Remove-OldRegistration([string]$Guid, [string[]]$OldDirectories) {
  if ($Guid -notmatch '^[a-fA-F0-9-]{36}$') { throw '产品注册标识不正确。' }
  foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
      $base = $null
      try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        foreach ($keyPath in @("Software\$Guid", "Software\Microsoft\Windows\CurrentVersion\Uninstall\$Guid")) {
          $key = $base.OpenSubKey($keyPath); $remove = $false
          try {
            if (!$key) { continue }
            $location = [string]$key.GetValue('InstallLocation', '')
            $uninstall = [string]$key.GetValue('UninstallString', '')
            foreach ($old in $OldDirectories) {
              if ($location -and $location.TrimEnd('\') -ieq $old) { $remove = $true }
              elseif (!$location -and $uninstall -match '^"([^"\r\n]+\\Uninstall AporiaX\.exe)"' -and [IO.Path]::GetDirectoryName($Matches[1]) -ieq $old) { $remove = $true }
            }
          } finally { if ($key) { $key.Dispose() } }
          # Exact product GUID keys only; never touch another application or
          # a registration which now points at the kept/new installation.
          if ($remove) { $base.DeleteSubKeyTree($keyPath, $false) }
        }
      } catch { Write-Warning '部分旧安装登记没有权限整理，已保留。' } finally { if ($base) { $base.Dispose() } }
    }
  }
}
function Show-OrganizePlan([string]$Keep, [string]$TargetVersion, [string[]]$Paths, [long]$Owner, [scriptblock]$ConfigureWindow = $null) {
  Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing
  [Windows.Forms.Application]::EnableVisualStyles()
  $form = [Windows.Forms.Form]::new(); $form.Text = 'AporiaX 正式版 · 整理安装副本'; $form.ClientSize = [Drawing.Size]::new(790, 475); $form.StartPosition = 'CenterScreen'; $form.MinimumSize = $form.Size; $form.MaximizeBox = $false; $form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 9)
  $state = @{ Keep = $Keep; Paths = [Collections.Generic.List[string]]::new() }
  foreach ($path in @($Paths) + @($Keep)) { if ($path -and !$state.Paths.Contains($path)) { $state.Paths.Add($path) } }
  $label = [Windows.Forms.Label]::new(); $label.SetBounds(22, 18, 574, 74); $label.Text = "安装 $TargetVersion 到：$Keep`r`n只整理已确认的旧程序文件并保留恢复备份；对话、账户配置、项目及额外资料不动。"; $form.Controls.Add($label)
  $destination = [Windows.Forms.Button]::new(); $destination.SetBounds(612, 23, 154, 34); $destination.Text = '更改安装目录…'; $form.Controls.Add($destination)
  $list = [Windows.Forms.ListView]::new(); $list.SetBounds(22, 100, 744, 246); $list.View = 'Details'; $list.CheckBoxes = $true; $list.FullRowSelect = $true; $list.HideSelection = $false
  $null = $list.Columns.Add('安装目录', 330); $null = $list.Columns.Add('版本', 110); $null = $list.Columns.Add('处理说明', 278); $form.Controls.Add($list)
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $add = { param([string]$Path)
    if (!$seen.Add($Path)) { return }
    $choice = Get-CopyChoice $Path $state.Keep $TargetVersion
    $row = [Windows.Forms.ListViewItem]::new($choice.Directory); $null = $row.SubItems.Add($choice.Version); $null = $row.SubItems.Add($choice.Reason); $row.Tag = $choice
    if ($choice.Eligible) { $row.Checked = $true } else { $row.ForeColor = [Drawing.Color]::Gray }
    $null = $list.Items.Add($row)
  }
  $refresh = { $list.Items.Clear(); $seen.Clear(); foreach ($path in $state.Paths) { if (Test-Path -LiteralPath $path -PathType Container) { & $add $path } } }
  & $refresh
  $destination.add_Click({
    $dialog = [Windows.Forms.FolderBrowserDialog]::new(); $dialog.Description = '选择父目录，安装器会自动创建 AporiaX 文件夹；选择已有 AporiaX 文件夹时不会重复创建'; $dialog.SelectedPath = [IO.Path]::GetDirectoryName($state.Keep)
    try { if ($dialog.ShowDialog($form) -eq 'OK') {
      try { $next = Get-InstallDirectory $dialog.SelectedPath; $state.Keep = Assert-InstallTarget $next $TargetVersion; $label.Text = "安装 $TargetVersion 到：$($state.Keep)`r`n已自动补齐 AporiaX 文件夹。只整理旧程序并保留恢复备份，不动用户数据及额外资料。"; & $refresh }
      catch { $null = [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '请选择安全的安装目录', 'OK', 'Warning') }
    } } finally { $dialog.Dispose() }
  })
  $list.add_ItemCheck({ param($sender, $event) if (!$sender.Items[$event.Index].Tag.Eligible) { $event.NewValue = [Windows.Forms.CheckState]::Unchecked } })
  $browse = [Windows.Forms.Button]::new(); $browse.SetBounds(22, 360, 150, 32); $browse.Text = '添加安装目录…'; $form.Controls.Add($browse)
  $browse.add_Click({ $dialog = [Windows.Forms.FolderBrowserDialog]::new(); $dialog.Description = '选择另一份 AporiaX.exe 所在的程序目录，不是项目目录'; try { if ($dialog.ShowDialog($form) -eq 'OK') { $state.Paths.Add($dialog.SelectedPath); & $add $dialog.SelectedPath } } finally { $dialog.Dispose() } })
  $rescan = [Windows.Forms.Button]::new(); $rescan.SetBounds(184, 360, 116, 32); $rescan.Text = '重新检查'; $form.Controls.Add($rescan); $rescan.add_Click({ & $refresh })
  $note = [Windows.Forms.Label]::new(); $note.SetBounds(316, 356, 450, 50); $note.Text = '未登记的副本可手动添加。运行中的旧版请先从托盘退出，再点重新检查；无法确认的副本保留。'; $form.Controls.Add($note)
  $skip = [Windows.Forms.Button]::new(); $skip.SetBounds(418, 420, 158, 34); $skip.Text = '仅安装，不整理'; $form.Controls.Add($skip)
  $continue = [Windows.Forms.Button]::new(); $continue.SetBounds(590, 420, 176, 34); $continue.Text = '继续安装并整理'; $form.Controls.Add($continue)
  $form.Tag = $null
  $skip.add_Click({ try { $target = Assert-InstallTarget $state.Keep $TargetVersion; $form.Tag = @{ KeepDirectory = $target; Selected = @() }; $form.DialogResult = 'OK'; $form.Close() } catch { $null = [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '安装目录不可用', 'OK', 'Warning') } })
  $continue.add_Click({
    if (@($list.Items | Where-Object { $_.Tag.Reason -match '仍在运行' }).Count -gt 0) {
      $null = [Windows.Forms.MessageBox]::Show($form, '请先从托盘退出运行中的旧副本，再点击重新检查。否则启动新版可能只是唤醒旧进程。如果暂时不退出，可选择“仅安装，不整理”。', '旧版本仍在运行', 'OK', 'Warning'); return
    }
    try { $target = Assert-InstallTarget $state.Keep $TargetVersion } catch { $null = [Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, '安装目录不可用', 'OK', 'Warning'); return }
    $selected = @($list.CheckedItems | ForEach-Object { $_.Tag } | Where-Object { $_.Eligible })
    if ($selected.Count -gt 128) { $null = [Windows.Forms.MessageBox]::Show($form, '一次最多整理 128 份，请减少选择。', '副本过多', 'OK', 'Warning'); return }
    if ($selected.Count -gt 0) {
      $text = "将安装/保留：$target`r`n`r`n安装并校验新版后，整理以下程序副本：`r`n" + (($selected | ForEach-Object { $_.Directory + '  [' + $_.Version + ']' }) -join "`r`n") + "`r`n`r`n程序文件会移到恢复备份，不会调用旧版卸载器，不删除项目或用户数据。是否确认？"
      if ([Windows.Forms.MessageBox]::Show($form, $text, '确认整理安装副本', 'YesNo', 'Question', 'Button2') -ne 'Yes') { return }
    }
    $form.Tag = @{ KeepDirectory = $target; Selected = $selected }; $form.DialogResult = 'OK'; $form.Close()
  })
  # Trusted in-process host configuration only, never a command-line option.
  # It also lets the native form be exercised invisibly in isolated UI tests.
  if ($ConfigureWindow) { & $ConfigureWindow $form }
  try {
    $result = $form.ShowDialog()
    if ($result -ne 'OK') { throw [OperationCanceledException]::new('已取消安装副本整理。') }
    return $form.Tag
  } finally { $form.Dispose() }
}
function Assert-PlanIdentity($Plan, [string]$TargetVersion, [string]$Guid, [string]$Keep) {
  if ($Plan.Schema -ne 1 -or $Plan.Version -ne $TargetVersion -or $Plan.ProductGuid -ne $Guid -or !$Plan.Confirmed -or $Plan.KeepDirectory -ine $Keep -or @($Plan.Selected).Count -gt 128) { throw '整理计划不匹配，未清理旧版本。' }
}
function Complete-OrganizePlan($Plan, [string]$TargetVersion, [string]$Guid, [string]$Keep) {
  Assert-PlanIdentity $Plan $TargetVersion $Guid $Keep
  $keepIdentity = Get-CopyIdentity $Keep
  if ($keepIdentity.Version -ne $TargetVersion) { throw '新版安装文件未通过版本校验，未清理旧版本。' }
  $report = @{ KeptDirectory = $Keep; Version = $TargetVersion; Completed = @(); Skipped = @(); CreatedAt = [DateTime]::UtcNow.ToString('o') }
  if (@($Plan.Selected).Count -eq 0) { return $report }
  Assert-NoReparse $script:BackupRoot
  $session = Join-Path $script:BackupRoot ([DateTime]::Now.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString())
  foreach ($choice in @($Plan.Selected)) {
    try { $report.Completed += Move-OldProgramCopy $choice $Keep $TargetVersion $session }
    catch { $report.Skipped += @{ Directory = $choice.Directory; Reason = $_.Exception.Message } }
  }
  $null = [IO.Directory]::CreateDirectory($session); Assert-NoReparse $session
  Write-Json (Join-Path $session 'report.json') $report
  [IO.File]::WriteAllText((Join-Path $session 'README.txt'), "AporiaX 旧程序恢复备份。`r`n保留的新版本目录：$Keep`r`n每个子目录的 restore-manifest.json 记录原位置；如需恢复，请先退出 AporiaX，再将对应程序文件复制回原位置。不要覆盖仍在运行的新版。用户数据和额外文件未清理。", [Text.UTF8Encoding]::new($true))
  if ($report.Completed.Count -gt 0) { $old = @($report.Completed | ForEach-Object { $_.Directory }); Repair-OldShortcuts $old $Keep; Remove-OldRegistration $Guid $old }
  $report.BackupDirectory = $session
  return $report
}

if ($Mode -eq 'Library') { return }
try {
  if ($Version -notmatch '^\d+\.\d+\.\d+$' -or $ProductGuid -notmatch '^[a-fA-F0-9-]{36}$') { throw '仅正式版安装器支持整理。' }
  Assert-NoReparse $InputDirectory
  $keep = Get-SafeDirectory ([IO.File]::ReadAllText((Join-Path $InputDirectory 'target.txt'), [Text.Encoding]::Unicode).Trim())
  $planFile = Join-Path $InputDirectory 'plan.json'
  if ($Mode -eq 'Plan') {
    $seeds = @([IO.File]::ReadAllLines((Join-Path $InputDirectory 'seeds.txt'), [Text.Encoding]::Unicode) | ForEach-Object { if ($_ -match '^"([^"\r\n]+\\Uninstall AporiaX\.exe)"') { [IO.Path]::GetDirectoryName($Matches[1]) } else { $_ } })
    $selection = Show-OrganizePlan $keep $Version (Get-DiscoveryPaths $ProductGuid $seeds) $OwnerHwnd
    Write-Json $planFile @{ Schema = 1; Version = $Version; ProductGuid = $ProductGuid; KeepDirectory = $selection.KeepDirectory; Confirmed = $true; Selected = @($selection.Selected); CreatedAt = [DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText((Join-Path $InputDirectory 'result.ini'), "[result]`r`ntarget=$($selection.KeepDirectory)`r`n", [Text.Encoding]::Unicode)
  } else {
    if ($PlanHash -notmatch '^[a-fA-F0-9]{64}$') { throw '缺少已确认计划的校验值。' }
    $stream = [IO.File]::Open($planFile, 'Open', 'Read', 'Read')
    try {
      if ($stream.Length -gt 524288) { throw '整理计划过大。' }
      $reader = [IO.BinaryReader]::new($stream); $bytes = Read-Exact $reader $stream.Length
      $sha = [Security.Cryptography.SHA256]::Create(); try { $hash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '') } finally { $sha.Dispose() }
      if ($hash -ine $PlanHash) { throw '确认后整理计划发生变化，未清理旧版本。' }
      $plan = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
      Assert-PlanIdentity $plan $Version $ProductGuid $keep
      if ($Mode -eq 'Validate') { $null = Assert-InstallTarget $keep $Version }
      else { $report = Complete-OrganizePlan $plan $Version $ProductGuid $keep }
    } finally { $stream.Dispose() }
    if ($Mode -eq 'Validate') { exit 0 }
    $backup = if ($report.ContainsKey('BackupDirectory')) { $report.BackupDirectory } else { '无旧副本需要整理' }
    [IO.File]::WriteAllText((Join-Path $InputDirectory 'result.ini'), "[result]`r`nmessage=已整理 $($report.Completed.Count) 份程序；跳过 $($report.Skipped.Count) 份。恢复备份：$backup`r`n", [Text.Encoding]::Unicode)
  }
  exit 0
} catch [OperationCanceledException] { exit 2 }
catch {
  if ($InputDirectory -and (Test-Path -LiteralPath $InputDirectory -PathType Container)) { [IO.File]::WriteAllText((Join-Path $InputDirectory 'result.ini'), "[result]`r`nmessage=未整理旧副本：$($_.Exception.Message -replace '[\r\n]', ' ')`r`n", [Text.Encoding]::Unicode) }
  exit 3
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, copyFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPackageWithOptions, statFile } from '@electron/asar';

const root = resolve('.'), helper = join(root, 'build/installer-copies.ps1');
const source = await readFile(helper, 'utf8');
assert.equal(source.charCodeAt(0), 0xfeff, 'Windows PowerShell 5 needs a UTF-8 BOM for Chinese UI');
assert.doesNotMatch(source, /Remove-Item|Stop-Process|\bInvoke-Expression\b|\bStart-Process\b|&\s*\$.*[Uu]ninstall/);
assert.match(source, /Directory\]::Delete\(\$directory, \$false\)/, 'Only empty directories can be deleted');
if (process.platform !== 'win32') { console.log('Installer copies static checks PASS; native tests require Windows'); process.exit(0); }
await mkdir('.tmp', { recursive: true });
const temp = await mkdtemp(join(root, '.tmp/installer-copies-'));
const q = value => "'" + value.replaceAll("'", "''") + "'";
const ps = (file, args = []) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
const compiler = join(temp, 'compile.ps1');
await writeFile(compiler, '\ufeff' + `param([string]$Root)
$ErrorActionPreference='Stop'
foreach($entry in @(@('base','1.0.0.0','AporiaX'),@('future','1.1.0.0','AporiaX'),@('wrong','1.0.0.0','NotAporiaX'))){
  $code='using System; using System.Reflection; [assembly:AssemblyProduct("'+$entry[2]+'")] [assembly:AssemblyVersion("'+$entry[1]+'")] [assembly:AssemblyFileVersion("'+$entry[1]+'")] public class Fixture'+$entry[0]+' { public static void Main(){System.Threading.Thread.Sleep(60000);} }'
  Add-Type -TypeDefinition $code -OutputAssembly (Join-Path $Root ($entry[0]+'.exe')) -OutputType ConsoleApplication
}
`);
ps(compiler, ['-Root', temp]);
const versions = { keep: '1.0.0', old: '1.0.0-rc.5.2', locked: '1.0.0-rc.4', running: '1.0.0-rc.3', changed: '1.0.0-rc.2', future: '1.1.0', fake: '1.0.0-rc.1', denied: '1.0.0-rc.1' };
for (const [name, version] of Object.entries(versions)) {
  const directory = join(temp, name), input = join(temp, 'sources-' + name);
  await mkdir(join(directory, 'resources'), { recursive: true });
  await mkdir(join(input, 'electron'), { recursive: true }); await mkdir(join(input, 'dist'), { recursive: true }); await mkdir(join(input, 'native'), { recursive: true });
  await writeFile(join(input, 'package.json'), JSON.stringify({ name: 'aporiax-desktop', productName: 'AporiaX', version, main: 'electron/main-v2.js' }));
  await writeFile(join(input, 'electron/main-v2.js'), '// fixture only; never execute\n');
  await writeFile(join(input, 'dist/index.html'), '<html>fixture only</html>'); await writeFile(join(input, 'native/demo.node'), 'fixture-native');
  await createPackageWithOptions(input, join(directory, 'resources/app.asar'), { unpack: '*.node' });
  assert.equal(statFile(join(directory, 'resources/app.asar'), 'native/demo.node').unpacked, true);
  await copyFile(join(temp, name === 'future' ? 'future.exe' : name === 'fake' ? 'wrong.exe' : 'base.exe'), join(directory, 'AporiaX.exe'));
  await writeFile(join(directory, 'Uninstall AporiaX.exe'), 'SENTINEL: MUST NEVER EXECUTE');
  await writeFile(join(directory, 'ffmpeg.dll'), 'fixture-dll');
  await writeFile(join(directory, 'resources/app-update.yml'), 'fixture-updater');
  await mkdir(join(directory, 'resources/app.asar.unpacked'), { recursive: true });
  await writeFile(join(directory, 'resources/app.asar.unpacked/notes.txt'), 'EXTRA DATA - PRESERVE');
  await mkdir(join(directory, 'projects'), { recursive: true }); await writeFile(join(directory, 'projects/user-work.md'), 'USER WORK - PRESERVE');
  await writeFile(join(directory, 'personal.txt'), 'PERSONAL FILE - PRESERVE');
}
const guid = randomUUID(), suite = join(temp, 'suite.ps1');
await writeFile(suite, '\ufeff' + `param([string]$Root,[string]$Helper,[string]$Guid)
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. $Helper -Mode Library
$script:BackupRoot=Join-Path $Root 'backups'
function Check($Condition,[string]$Message){if(!$Condition){throw $Message}}
function Folder([string]$Name){return Join-Path $Root $Name}
function Hash([string]$Path){return Get-FileDigest $Path}
function Choice([string]$Name){return Get-CopyChoice (Folder $Name) (Folder 'keep') '1.0.0'}
function Snapshot([string]$Name){$id=Get-CopyIdentity (Folder $Name);$map=@{};foreach($file in Get-OwnedProgramFiles $id){$map[$file]=Hash (Join-Path $id.Directory $file)};return $map}
function CheckSnapshot([string]$Name,$Before){foreach($file in $Before.Keys){Check ((Hash (Join-Path (Folder $Name) $file)) -eq $Before[$file]) ('Changed protected fixture: '+$Name+' '+$file)}}
Check ((Get-InstallDirectory 'D:\\') -eq 'D:\\AporiaX') 'Drive-root parent must append AporiaX'
Check ((Get-InstallDirectory (Folder 'parent')) -eq (Folder 'parent\\AporiaX')) 'Append directory basename'
Check ((Get-InstallDirectory (Folder 'parent\\AporiaX\\')) -eq (Folder 'parent\\AporiaX')) 'Do not append twice'
Check ((Get-InstallDirectory (Folder 'AporiaXTools')) -eq (Folder 'AporiaXTools\\AporiaX')) 'Substring is not a basename'
foreach($path in @('C:\\',[Environment]::GetFolderPath('Windows'),[Environment]::GetFolderPath('UserProfile'),'relative\\app','\\\\server\\app')){$denied=$false;try{Get-SafeDirectory $path|Out-Null}catch{$denied=$true};Check $denied ('Unsafe root accepted: '+$path)}
$initialChoice=Choice 'old';Check $initialChoice.Eligible ('Old RC copy must be eligible: '+$initialChoice.Reason+' '+$initialChoice.Directory)
Check (!(Choice 'keep').Eligible) 'Kept copy must not be eligible'
Check (!(Choice 'future').Eligible) 'Newer copy must not be eligible'
Check (!(Choice 'fake').Eligible) 'Fake exe must not be eligible'
$configure={param($window)
  $window.Opacity=0;$window.ShowInTaskbar=$false;$window.StartPosition='Manual';$window.Location=[Drawing.Point]::new(-20000,-20000)
  $window.add_Shown({param($sender,$event)
    try{
      $rows=@($sender.Controls|Where-Object{$_ -is [Windows.Forms.ListView]})[0]
      if($rows.CheckedItems.Count -ne 1){throw 'Only the verified old copy should be checked by default'}
      if($rows.CheckedItems[0].Tag.Version -ne '1.0.0-rc.5.2'){throw 'Wrong default selection'}
      foreach($row in $rows.Items){if(!$row.Tag.Eligible){$row.Checked=$true}}
      if($rows.CheckedItems.Count -ne 1){throw 'Unsafe/newer/kept rows must not become checked'}
      $refreshButton=@($sender.Controls|Where-Object{$_ -is [Windows.Forms.Button] -and $_.Text -eq '重新检查'})[0];$refreshButton.PerformClick()
      if($rows.CheckedItems.Count -ne 1){throw 'Refresh lost eligible default selection'}
      $skip=@($sender.Controls|Where-Object{$_ -is [Windows.Forms.Button] -and $_.Text -eq '仅安装，不整理'})[0]
      $skip.PerformClick()
    }catch{$script:FormFailure=$_.Exception.Message;$sender.DialogResult='Cancel';$sender.Close()}
  })
}
$script:FormFailure=''
try{$selection=Show-OrganizePlan (Folder 'keep') '1.0.0' @((Folder 'old'),(Folder 'future'),(Folder 'fake')) 0 $configure}catch{if($script:FormFailure){throw $script:FormFailure};throw}
Check (!$script:FormFailure) ('Native form failed: '+$script:FormFailure)
Check ($selection.KeepDirectory -eq (Folder 'keep') -and $selection.Selected.Count -eq 0) 'Install-only button must not authorize cleanup'
$link=Join-Path $Root 'linked';New-Item -ItemType Junction -Path $link -Target (Folder 'old')|Out-Null
Check (!(Get-CopyChoice $link (Folder 'keep') '1.0.0').Eligible) 'Junction must not be eligible'
$keep=Snapshot 'keep';$future=Snapshot 'future'
$changed=Choice 'changed';[IO.File]::AppendAllText((Join-Path $changed.Directory 'ffmpeg.dll'),'unrelated-extra')
# Identity changes after confirmation are rejected before any file moves.
[IO.File]::AppendAllText((Join-Path $changed.Directory 'AporiaX.exe'),'changed')
$rejected=$false;try{Move-OldProgramCopy $changed (Folder 'keep') '1.0.0' (Folder 'backups\\changed')|Out-Null}catch{$rejected=$true};Check $rejected 'Changed program identity must be skipped'
$locked=Choice 'locked';$before=Snapshot 'locked';$lock=[IO.File]::Open((Join-Path $locked.Directory 'ffmpeg.dll'),'Open','Read','Read')
try{$rejected=$false;try{Move-OldProgramCopy $locked (Folder 'keep') '1.0.0' (Folder 'backups\\locked')|Out-Null}catch{$rejected=$true};Check $rejected 'Locked program file must not be forced'}finally{$lock.Dispose()}
CheckSnapshot 'locked' $before
$process=[Diagnostics.Process]::new();$process.StartInfo.FileName=Join-Path (Folder 'running') 'AporiaX.exe';$process.StartInfo.UseShellExecute=$false;$process.StartInfo.CreateNoWindow=$true
try{Check ($process.Start()) 'Start isolated process';Start-Sleep -Milliseconds 250;$rejected=$false;try{Move-OldProgramCopy (Choice 'running') (Folder 'keep') '1.0.0' (Folder 'backups\\running')|Out-Null}catch{$rejected=$true};Check $rejected 'Running copy must be skipped'}finally{if(!$process.HasExited){$process.Kill();$process.WaitForExit()};$process.Dispose()}
$old=Choice 'old';$oldExe=Hash (Join-Path $old.Directory 'AporiaX.exe')
$plan=@{Schema=1;Version='1.0.0';ProductGuid=$Guid;KeepDirectory=(Folder 'keep');Confirmed=$true;Selected=@($old)}
$bad=$plan.Clone();$bad.Version='1.0.1';$rejected=$false;try{Complete-OrganizePlan $bad '1.0.0' $Guid (Folder 'keep')|Out-Null}catch{$rejected=$true};Check $rejected 'Mismatched target must not clean'
# Exact throwaway GUID keys only. Nothing in the real product registration is changed.
$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey('CurrentUser','Registry64')
try{
  $key=$base.CreateSubKey('Software\\'+$Guid);$key.SetValue('InstallLocation',$old.Directory);$key.Dispose()
  $key=$base.CreateSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$Guid);$key.SetValue('InstallLocation',$old.Directory);$key.SetValue('DisplayName','AporiaX fixture');$key.Dispose()
  $report=Complete-OrganizePlan $plan '1.0.0' $Guid (Folder 'keep')
  Check ($report.Completed.Count -eq 1 -and $report.Skipped.Count -eq 0) 'Verified old copy must move'
  Check (!(Test-Path -LiteralPath (Join-Path $old.Directory 'AporiaX.exe'))) 'Old executable must no longer remain in place'
  Check ((Hash (Join-Path $report.Completed[0].Backup 'AporiaX.exe')) -eq $oldExe) 'Recoverable backup must retain exact executable'
  Check (Test-Path -LiteralPath (Join-Path $report.Completed[0].Backup 'resources/app.asar.unpacked/native/demo.node')) 'Only indexed native resources must move'
  Check (([IO.File]::ReadAllText((Join-Path $old.Directory 'personal.txt'))) -eq 'PERSONAL FILE - PRESERVE') 'Personal file changed'
  Check (([IO.File]::ReadAllText((Join-Path $old.Directory 'projects/user-work.md'))) -eq 'USER WORK - PRESERVE') 'Workspace changed'
  Check (([IO.File]::ReadAllText((Join-Path $old.Directory 'resources/app.asar.unpacked/notes.txt'))) -eq 'EXTRA DATA - PRESERVE') 'Unknown resource data changed'
  Check ($null -eq $base.OpenSubKey('Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$Guid)) 'Retired test registration remains'
  $key=$base.CreateSubKey('Software\\'+$Guid);$key.SetValue('InstallLocation',(Folder 'keep'));$key.Dispose()
  Remove-OldRegistration $Guid @($old.Directory)
  $key=$base.OpenSubKey('Software\\'+$Guid);Check ($null -ne $key) 'Kept registration was removed';$key.Dispose()
}finally{
  foreach($path in @('Software\\'+$Guid,'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\'+$Guid)){$base.DeleteSubKeyTree($path,$false)}
  $base.Dispose()
}
CheckSnapshot 'keep' $keep;CheckSnapshot 'future' $future
$cli=Folder 'cli';$null=[IO.Directory]::CreateDirectory($cli);[IO.File]::WriteAllText((Join-Path $cli 'target.txt'),(Folder 'keep'),[Text.Encoding]::Unicode)
Write-Json (Join-Path $cli 'plan.json') @{Schema=1;Version='1.0.0';ProductGuid=$Guid;KeepDirectory=(Folder 'keep');Confirmed=$true;Selected=@()}
Write-Output 'PASS installer copies: parent suffix, identity/version, protected paths, junctions, tampering, file-lock rollback, running process, post-install-only cleanup, recoverable program files, preserved personal/workspace data, exact registrations.'
`);
textResult(ps(suite, ['-Root', temp, '-Helper', helper, '-Guid', guid]));
function textResult(value) { process.stdout.write(value); }
const input = join(temp, 'cli'), plan = join(input, 'plan.json');
const hash = createHash('sha256').update(await readFile(plan)).digest('hex');
ps(helper, ['-Mode', 'Complete', '-Version', '1.0.0', '-ProductGuid', guid, '-InputDirectory', input, '-PlanHash', hash]);
let code = 0;
try { ps(helper, ['-Mode', 'Complete', '-Version', '1.0.0', '-ProductGuid', guid, '-InputDirectory', input, '-PlanHash', '0'.repeat(64)]); } catch (error) { code = error.status; }
assert.equal(code, 3, 'A changed plan must fail closed');
await access(join(temp, 'keep/AporiaX.exe'));
await access(join(temp, 'denied/AporiaX.exe'));
console.log('PASS exact confirmed-plan SHA256 binding (real helper CLI); no production installations or user data were changed. Fixture:', temp);

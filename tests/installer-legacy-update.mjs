import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const helper = await readFile(join(root, 'build/installer-legacy-update.nsh'), 'utf8');
const hook = await readFile(join(root, 'build/installer.nsh'), 'utf8');
assert.match(hook, /installer-legacy-update\.nsh/);
assert.match(helper, /customPageAfterChangeDir/);
assert.match(helper, /GetDParameter \$ApLegacyExplicit/);
assert.match(helper, /AporiaLegacyRestoreRegistry/);
assert.match(helper, /WriteRegStr SHELL_CONTEXT.*UninstallString/);
assert.match(helper, /No default selection/);
if (process.platform !== 'win32') {
  console.log('legacy installer static checks PASS; native fixture requires Windows');
  process.exit(0);
}

const cache = join(process.env.LOCALAPPDATA, 'electron-builder/Cache');
const cacheEntries = await readdir(cache).catch(error => {
  if (error.code === 'ENOENT') return [];
  throw error;
});
let nsis;
for (const version of cacheEntries.filter(v => /^nsis-\d/.test(v))) {
  for (const folder of await readdir(join(cache, version))) {
    const candidate = join(cache, version, folder, 'makensis.exe');
    try { execFileSync(candidate, ['/VERSION'], {stdio:'pipe'}); nsis = candidate; break; } catch {}
  }
  if (nsis) break;
}
if (!nsis && !process.argv.includes('--native')) {
  console.log('legacy installer static checks PASS; native fixture skipped (NSIS not cached)');
  process.exit(0);
}
assert(nsis, 'A cached Windows NSIS compiler is required for the native fixture');
let plugins;
for (const version of cacheEntries.filter(v => /^nsis-resources-/.test(v))) {
  for (const folder of await readdir(join(cache, version))) {
    const candidate = join(cache, version, folder, 'plugins/x86-unicode');
    try { await access(join(candidate, 'UAC.dll')); await access(join(candidate, 'StdUtils.dll')); plugins = candidate; break; } catch {}
  }
  if (plugins) break;
}
if (!plugins && !process.argv.includes('--native')) {
  console.log('legacy installer static checks PASS; native fixture skipped (NSIS resources not cached)');
  process.exit(0);
}
assert(plugins, 'Cached NSIS resources are required');
await mkdir(join(root, '.tmp'), {recursive:true});
const temp = await mkdtemp(join(root, '.tmp/legacy-installer-test-'));
const id = randomUUID();
const registryRoot = `Software\\AporiaXInstallerTests\\${id}`;
const installKey = registryRoot + '\\Install';
const uninstallKey = registryRoot + '\\Uninstall';
const template = join(root, 'node_modules/app-builder-lib/templates/nsis');
const originalUtil = await readFile(join(template, 'include/installUtil.nsh'), 'utf8');
const quotes = originalUtil.slice(originalUtil.indexOf('Function GetInQuotes'), originalUtil.indexOf('Function GetFileParent'));
const assisted = await readFile(join(template, 'assistedInstaller.nsh'), 'utf8');
const directoryPre = assisted.match(/Function instFilesPre[\s\S]*?FunctionEnd/)[0];
const results = join(temp, 'result.ini');
const fixture = join(temp, 'fixture.nsi');
const exe = join(temp, 'fixture.exe');
const n = value => value.replaceAll('/', '\\').replaceAll('$', '$$').replaceAll('"', '$\\"');
await writeFile(fixture, '\ufeff' + `Unicode true
RequestExecutionLevel user
Name "AporiaX installer compatibility test"
OutFile "${n(exe)}"
!include MUI2.nsh
!include FileFunc.nsh
!include LogicLib.nsh
!addplugindir /x86-unicode "${n(plugins)}"
!define APP_GUID "${id}"
!define UNINSTALL_APP_KEY "${id}"
!include "${n(join(template, 'include/StdUtils.nsh'))}"
!addincludedir "${n(join(template, 'include'))}"
!include "${n(join(template, 'multiUser.nsh'))}"
!define APP_EXECUTABLE_FILENAME "AporiaX.exe"
!define UNINSTALL_FILENAME "Uninstall AporiaX.exe"
!define APP_FILENAME "AporiaX"
!define allowToChangeInstallationDirectory
!include "${n(join(template, 'include/StrContains.nsh'))}"
${directoryPre}
!undef INSTALL_REGISTRY_KEY
!undef UNINSTALL_REGISTRY_KEY
!define INSTALL_REGISTRY_KEY "${installKey}"
!define UNINSTALL_REGISTRY_KEY "${uninstallKey}"
${quotes}
!include "${n(join(root, 'build/installer-legacy-update.nsh'))}"
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE English
!insertmacro customHeader
Function .onInit
  SetRegView 64
  SetShellVarContext current
  StrCpy $installMode CurrentUser
  $\{GetParameters} $0
  ClearErrors
  $\{GetOptions} $0 "--select=" $1
  $\{If} $\{Errors}
    !insertmacro customInit
  $\{Else}
    ; Exercise the exact candidate-to-directory mapping used by the GUI page.
    StrCpy $9 $1
    StrCpy $ApLegacyUpdate 1
    Call AporiaLegacyReadCandidates
    StrCpy $0 $9
    !insertmacro ApLegacySelectChoice 1 0
    !insertmacro ApLegacySelectChoice 2 1
    !insertmacro ApLegacySelectChoice 3 2
    !insertmacro ApLegacySelectChoice 4 3
    Call AporiaLegacyPrepareTarget
  $\{EndIf}
  ; Simulate the legacy assisted directory sanitizer before our final gate.
  $\{If} $ApLegacyUpdate == 1
    StrCpy $INSTDIR "$ApLegacyTarget\\AporiaX"
  $\{Else}
    StrCpy $INSTDIR "$EXEDIR\\fresh"
  $\{EndIf}
  Call AporiaLegacyInstFilesPre
  WriteINIStr "${n(results)}" "result" "target" "$ApLegacyTarget"
  WriteINIStr "${n(results)}" "result" "installDirectory" "$INSTDIR"
  WriteINIStr "${n(results)}" "result" "prepared" "$ApLegacyPrepared"
  WriteINIStr "${n(results)}" "result" "count" "$ApLegacyCount"
  ReadRegStr $0 SHCTX "${installKey}" InstallLocation
  WriteINIStr "${n(results)}" "result" "alignedDir" "$0"
  ReadRegStr $0 SHCTX "${uninstallKey}" UninstallString
  WriteINIStr "${n(results)}" "result" "alignedUninstall" "$0"
  Call AporiaLegacyRestoreRegistry
  ReadRegStr $0 SHCTX "${installKey}" InstallLocation
  WriteINIStr "${n(results)}" "result" "restoredDir" "$0"
  ReadRegStr $0 SHCTX "${uninstallKey}" UninstallString
  WriteINIStr "${n(results)}" "result" "restoredUninstall" "$0"
  SetErrorLevel 0
  Quit
FunctionEnd
Section
SectionEnd
`, 'utf8');
execFileSync(nsis, ['/V2', fixture], {stdio:'pipe', timeout:60000});

const folders = [join(temp, 'D copy'), join(temp, 'C copy'), join(temp, '中文 软件')];
for (const folder of folders) {
  await mkdir(join(folder, 'resources'), {recursive:true});
  // These are sentinel files, not an app or an executable uninstaller.
  for (const file of ['AporiaX.exe', 'Uninstall AporiaX.exe', 'resources/app.asar']) {
    await writeFile(join(folder, file), 'fixture only; never execute');
  }
}
const q = value => "'" + value.replaceAll("'", "''") + "'";
function ps(script) { return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {encoding:'utf8'}).trim(); }
const regPath = 'HKCU:\\' + registryRoot;
function seed(directory, uninstallDirectory) {
  ps(`$ErrorActionPreference='Stop';New-Item -Path ${q(regPath + '\\Install')} -Force | Out-Null;New-Item -Path ${q(regPath + '\\Uninstall')} -Force | Out-Null;Set-ItemProperty -LiteralPath ${q(regPath + '\\Install')} -Name InstallLocation -Value ${q(directory)};Set-ItemProperty -LiteralPath ${q(regPath + '\\Uninstall')} -Name UninstallString -Value ${q('"' + join(uninstallDirectory, 'Uninstall AporiaX.exe') + '" /currentuser')}`);
}
function inspectSeed() {
  return JSON.parse(ps(`$a=Get-ItemProperty -LiteralPath ${q(regPath + '\\Install')};$b=Get-ItemProperty -LiteralPath ${q(regPath + '\\Uninstall')};@{directory=$a.InstallLocation;uninstall=$b.UninstallString}|ConvertTo-Json -Compress`));
}
async function run(args) {
  // Windows INI APIs otherwise create an ANSI file and lose Unicode paths.
  await writeFile(results, '\ufeff', 'utf16le');
  let status = 0;
try { execFileSync(exe, ['/S', ...args], {stdio:'pipe', timeout:15000, windowsHide:true}); } catch (error) { status = error.status; }
  if (status) return {status};
  const ini = await readFile(results, 'utf16le');
  const values = Object.fromEntries([...ini.matchAll(/^([^=\r\n]+)=(.*)$/gm)].map(m => [m[1], m[2].trim()]));
  return {status, ...values};
}
let checks = 0;
try {
  for (const folder of folders) {
    seed(folder, folder);
    const result = await run(['--updated']);
    assert.equal(result.status, 0);
    assert.equal(result.target.toLowerCase(), folder.toLowerCase());
    assert.equal(result.installDirectory.toLowerCase(), folder.toLowerCase());
    assert.equal(result.prepared, '1');
    assert.equal(result.count, '1');
    assert.equal(result.alignedDir.toLowerCase(), folder.toLowerCase());
    assert.equal(result.restoredDir.toLowerCase(), folder.toLowerCase());
    checks++;
  }
  seed(folders[1], folders[0]);
  const ambiguous = await run(['--updated']);
  assert.equal(ambiguous.status, 51041, 'Silent ambiguity must abort, not choose C:');
  assert.equal(inspectSeed().directory, folders[1]);
  checks++;
  for (const [index, folder] of [[0, folders[1]], [1, folders[0]]]) {
    seed(folders[1], folders[0]);
    const choice = await run(['--updated', '--select=' + index]);
    assert.equal(choice.status, 0);
    assert.equal(choice.installDirectory.toLowerCase(), folder.toLowerCase());
    assert.equal(choice.alignedUninstall, '"' + join(folder, 'Uninstall AporiaX.exe') + '"');
    assert.equal(choice.restoredDir, folders[1]);
    checks++;
  }
  for (const folder of [folders[0], folders[2]]) {
    seed(folders[1], folders[0]);
    const chosen = await run(['--updated', '/D=' + folder]);
    assert.equal(chosen.status, 0);
    assert.equal(chosen.target.toLowerCase(), folder.toLowerCase());
    assert.equal(chosen.installDirectory.toLowerCase(), folder.toLowerCase());
    assert.equal(chosen.alignedDir.toLowerCase(), folder.toLowerCase());
    assert.equal(chosen.alignedUninstall, '"' + join(folder, 'Uninstall AporiaX.exe') + '"');
    assert.equal(chosen.restoredDir, folders[1]);
    assert.equal(chosen.restoredUninstall, '"' + join(folders[0], 'Uninstall AporiaX.exe') + '" /currentuser');
    checks++;
  }
  for (const invalid of [resolve('/'), temp, 'relative\\AporiaX', join(temp, 'missing')]) {
    seed(folders[0], folders[0]);
    const result = await run(['--updated', '/D=' + invalid]);
    assert.equal(result.status, 51041);
    assert.equal(inspectSeed().directory, folders[0]);
    checks++;
  }
  seed(folders[1], folders[0]);
  const fresh = await run([]);
  assert.equal(fresh.status, 0);
  assert.equal(fresh.prepared, '');
  assert.equal(fresh.alignedDir, folders[1], 'Fresh installs must retain normal installer behavior');
  assert.equal(fresh.installDirectory, join(temp, 'fresh', 'AporiaX'));
  checks++;
  for (const folder of folders) for (const file of ['AporiaX.exe', 'Uninstall AporiaX.exe', 'resources/app.asar']) {
    assert.equal(await readFile(join(folder, file), 'utf8'), 'fixture only; never execute');
  }
  console.log(`legacy installer native checks PASS (${checks}); real app directories untouched; fixture ${temp}`);
} finally {
  // Only the unique test namespace is eligible for removal, never real keys.
  assert(registryRoot.startsWith('Software\\AporiaXInstallerTests\\') && registryRoot.endsWith(id));
  ps(`Remove-Item -LiteralPath ${q(regPath)} -Recurse -Force -ErrorAction SilentlyContinue`);
}

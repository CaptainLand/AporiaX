// Real installer-template acceptance with disposable product identity/payload.
// Never execute a production AporiaX installer against the user's registry.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, cp, access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

assert.equal(process.platform, 'win32');
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(join(root, '.tmp'), {recursive:true});
const temp = await mkdtemp(join(root, '.tmp/legacy-upgrade-e2e-'));
const guid = randomUUID();
const product = 'AporiaXInstallerQA' + guid.slice(0, 8);
const name = 'aporiax-installer-qa-' + guid;
const nsisKey = 'HKCU:\\Software\\' + guid;
const uninstallKey = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + guid;
const exeName = product + '.exe';
const uninstallerName = 'Uninstall ' + product + '.exe';
const project = join(temp, 'project');
const payload = join(temp, 'payload');
const originalDir = join(temp, '中文 原工作目录');
const otherDir = join(temp, 'other installation');
const source = resolve(process.argv[2] || '.tmp/cloud-parity-preview5');
const payloadFlag = process.argv.indexOf('--full-payload');
const fullPayload = payloadFlag >= 0 ? resolve(process.argv[payloadFlag + 1]) : null;
const hookOld = execFileSync('git', ['-C', source, 'show', 'v1.0.0-rc.5.1:build/installer.nsh'], {encoding:'utf8'});
const hookNew = await readFile(join(source, 'build/installer.nsh'), 'utf8');
const helper = await readFile(join(source, 'build/installer-legacy-update.nsh'), 'utf8');
const q = value => "'" + value.replaceAll("'", "''") + "'";
function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-Command', '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);'+script], {encoding:'utf8',windowsHide:true}).trim();
}
await mkdir(join(project, 'build'), {recursive:true});
await mkdir(join(payload, 'resources'), {recursive:true});
await writeFile(join(payload, exeName), 'inert fixture payload; never execute');
await writeFile(join(project, 'build/installer-legacy-update.nsh'), helper);
const electronVersion = JSON.parse(await readFile(join(root, 'node_modules/electron/package.json'), 'utf8')).version;
async function build(version, hook, marker) {
  await writeFile(join(project, 'package.json'), JSON.stringify({name,version,description:'Disposable installer acceptance fixture',author:'AporiaX QA',main:'unused.js',build:{
    appId:'com.aporiax.installerqa.'+guid, productName:product, electronVersion,
    electronDist:join(root,'node_modules/electron/dist'), npmRebuild:false,
    directories:{buildResources:'build'}, win:{signAndEditExecutable:false},
    nsis:{guid, include:'build/installer.nsh',oneClick:false,allowToChangeInstallationDirectory:true,
      createDesktopShortcut:false,createStartMenuShortcut:false,runAfterFinish:false,packElevateHelper:false},
  }},null,2));
  await writeFile(join(project,'build/installer.nsh'),hook);
  if (fullPayload && marker === 'NEW') {
    // Same installer hooks and actual Electron/ASAR/native payload, but a
    // disposable product identity so no real registration is overwritten.
    await cp(fullPayload, payload, { recursive: true, filter: file => resolve(file) !== join(fullPayload, 'AporiaX.exe') });
    await cp(join(fullPayload, 'AporiaX.exe'), join(payload, exeName));
  } else await writeFile(join(payload,'resources/app.asar'),marker);
  const output=join(temp,'installer-'+version);
  execFileSync(process.execPath,[join(root,'node_modules/electron-builder/cli.js'),'--projectDir',project,
    '--win','nsis','--x64','--prepackaged',payload,'--config.directories.output='+output,'--publish','never'],
    {stdio:'pipe',timeout:120000,windowsHide:true});
  const file=join(output,product+' Setup '+version+'.exe');
  await access(file);
  return file;
}
const oldInstaller=await build('0.1.0',hookOld,'OLD');
const newInstaller=await build('0.2.0',hookNew,'NEW');
const flags=['/currentuser','--no-desktop-shortcut','--no-start-menu-shortcut'];
function install(file,args) {
  try {execFileSync(file,['/S',...flags,...args],{stdio:'pipe',timeout:45000,windowsHide:true});return 0;}
  catch(error) {if(error.status==null)throw error;return error.status;}
}
const hash=buffer=>createHash('sha256').update(buffer).digest('hex');
async function marker(directory) {const bytes = await readFile(join(directory,'resources/app.asar')); return fullPayload ? hash(bytes) : bytes.toString('utf8');}
const oldMarker = fullPayload ? hash(Buffer.from('OLD')) : 'OLD';
const newMarker = fullPayload ? hash(await readFile(join(fullPayload,'resources/app.asar'))) : 'NEW';
function registered() {
  return JSON.parse(ps(`$a=Get-ItemProperty -LiteralPath ${q(nsisKey)};$b=Get-ItemProperty -LiteralPath ${q(uninstallKey)};@{directory=$a.InstallLocation;uninstall=$b.UninstallString;version=$b.DisplayVersion}|ConvertTo-Json -Compress`));
}
const userData=join(process.env.APPDATA,product);
const cache=join(process.env.LOCALAPPDATA,name+'-updater');
assert(!ps(`Test-Path -LiteralPath ${q(nsisKey)}`).includes('True'));
try {
  assert.equal(install(oldInstaller,['/D='+originalDir]),0);
  assert.equal(await marker(originalDir),oldMarker);
  await mkdir(userData,{recursive:true});
  await writeFile(join(userData,'preserve.txt'),'QA user data must survive');
  // The old updater supplies --updated, but no /D. Real old uninstaller runs.
  assert.equal(install(newInstaller,['--updated']),0);
  assert.equal(await marker(originalDir),newMarker);
  assert.equal(registered().directory.toLowerCase(),originalDir.toLowerCase());
  assert.equal(await readFile(join(userData,'preserve.txt'),'utf8'),'QA user data must survive');
  assert.equal(ps(`Test-Path -LiteralPath ${q(join(originalDir,product))}`),'False');
  console.log('PASS actual old-to-new install: no /D, original custom directory, no appended subfolder, user data retained');

  assert.equal(install(oldInstaller,['/D='+originalDir]),0);
  await cp(originalDir,otherDir,{recursive:true});
  const otherBefore=hash(await readFile(join(otherDir,uninstallerName)));
  ps(`Set-ItemProperty -LiteralPath ${q(nsisKey)} -Name InstallLocation -Value ${q(otherDir)}`);
  const mismatch=registered();
  assert.equal(install(newInstaller,['--updated']),51041);
  assert.deepEqual(registered(),mismatch);
  assert.equal(await marker(originalDir),oldMarker);assert.equal(await marker(otherDir),oldMarker);
  console.log('PASS actual silent ambiguous update: aborts before uninstall or payload overwrite');
  assert.equal(install(newInstaller,['--updated','/D='+originalDir]),0);
  assert.equal(await marker(originalDir),newMarker);assert.equal(await marker(otherDir),oldMarker);
  assert.equal(hash(await readFile(join(otherDir,uninstallerName))),otherBefore);
  assert.equal(registered().directory.toLowerCase(),originalDir.toLowerCase());
  assert.equal(await readFile(join(userData,'preserve.txt'),'utf8'),'QA user data must survive');
  console.log('PASS actual explicit destination repair: target upgraded, separate copy unchanged, aligned uninstall record');
  if (fullPayload) {
    let foreignArchitectureFilesAbsent = 0;
    async function compareInstalled(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = join(directory, entry.name);
        if (entry.isDirectory()) await compareInstalled(file);
        else {
          const relative = file.slice(fullPayload.length + 1);
          const installed = join(originalDir, relative === 'AporiaX.exe' ? exeName : relative);
          let bytes;
          try { bytes = await readFile(installed); } catch (error) {
            // This suite validates a Windows x64 installation. NSIS may omit
            // the bundled foreign-architecture PE files; never exempt x64,
            // application archives, or any other required runtime resource.
            if (error.code === 'ENOENT' && /[\\/](?:win32-arm64|win10-arm64)[\\/]/.test(file)) { foreignArchitectureFilesAbsent++; continue; }
            throw error;
          }
          assert.equal(hash(bytes), hash(await readFile(file)), 'Installed payload mismatch: ' + file);
        }
      }
    }
    await compareInstalled(fullPayload);
    const { _electron } = await import('playwright-core');
    const env = { ...process.env, APPDATA: join(temp, 'launch-roaming'), LOCALAPPDATA: join(temp, 'launch-local') };
    for (const key of Object.keys(env)) if (/^(APORIAX_|ELECTRON_RUN_AS_NODE|PORTABLE_EXECUTABLE)/.test(key)) delete env[key];
    const desktop = await _electron.launch({ executablePath: join(originalDir, exeName), args: ['--user-data-dir=' + join(temp, 'launch-profile')], env, timeout: 45000 });
    try {
      const info = await desktop.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion() }));
      assert.equal(info.packaged, true);
      assert.equal(info.version, JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version);
      const page = await desktop.firstWindow();
      await page.locator('.ax-welcome__enter').waitFor({ timeout: 45000 });
      console.log('PASS real installed Electron/ASAR/x64-native payload and AporiaX welcome (not Electron default app); absent non-x64 files: ' + foreignArchitectureFilesAbsent);
    } finally { await desktop.close(); }
  }
  await writeFile(join(temp,'acceptance.json'),JSON.stringify({guid,product,passed:3,actualUninstallerExecuted:true,
    productionIdentityUsed:false,fullPayloadUsed:!!fullPayload,fixtureDirectory:temp},null,2));
} finally {
  // Cleanup only our unique fixture keys; leave installed fixture files for audit.
  assert(/^[0-9a-f-]{36}$/.test(guid));
  ps(`Remove-Item -LiteralPath ${q(nsisKey)} -Recurse -Force -ErrorAction SilentlyContinue;Remove-Item -LiteralPath ${q(uninstallKey)} -Recurse -Force -ErrorAction SilentlyContinue`);
  for (const directory of [userData,cache]) {
    assert(directory.endsWith(product)||directory.endsWith(name+'-updater'));
    ps(`if(Test-Path -LiteralPath ${q(directory)}){Remove-Item -LiteralPath ${q(directory)} -Recurse -Force}`);
  }
}
console.log('Installer end-to-end acceptance PASS; production app and its registry/cache were not touched; '+temp);

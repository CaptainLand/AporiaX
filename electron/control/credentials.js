import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
// A fresh, protected DACL is used on Windows: chmod(0600) alone does not protect NTFS files.
const WINDOWS_ACL_SCRIPT = `$ErrorActionPreference='Stop';
$p=$env:APORIAX_PRIVATE_PATH;
$item=Get-Item -LiteralPath $p -Force;
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
$system=New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18');
if($item.PSIsContainer){
  $acl=New-Object System.Security.AccessControl.DirectorySecurity;
  $inherit=[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit';
}else{
  $acl=New-Object System.Security.AccessControl.FileSecurity;
  $inherit=[System.Security.AccessControl.InheritanceFlags]::None;
}
$acl.SetAccessRuleProtection($true,$false);
foreach($who in @($sid,$system)){
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($who,[System.Security.AccessControl.FileSystemRights]::FullControl,$inherit,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow);
  $acl.AddAccessRule($rule);
}
# Apply only the DACL, never SACL/owner: re-protecting a directory must not
# require SeSecurityPrivilege (ordinary desktop users do not have it).
$access=[System.Security.AccessControl.AccessControlSections]::Access;
$existing=$item.GetAccessControl($access);
$existing.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm($access),$access);
$item.SetAccessControl($existing);`;

export async function protectPrivatePath(path, { directory = false, platform = process.platform, exec = execFileAsync } = {}) {
  if (platform === "win32") {
    // Node inherits PowerShell 7's module path verbatim. Windows PowerShell 5
    // must discover its own built-in Security module (Set-Acl), not PS7's.
    const env = { ...process.env, APORIAX_PRIVATE_PATH: resolve(path) };
    for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
    await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_SCRIPT], {
      windowsHide: true, timeout: 15000, maxBuffer: 65536,
      env,
    });
  } else {
    await chmod(path, directory ? 0o700 : 0o600);
    const mode = (await stat(path)).mode & 0o777;
    if (mode !== (directory ? 0o700 : 0o600)) throw new Error("Unable to protect local control credentials.");
  }
}
export async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await protectPrivatePath(path, { directory: true });
  return path;
}
export async function writePrivateJson(path, value) {
  await privateDirectory(dirname(path));
  const temporary = join(dirname(path), `.private-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await protectPrivatePath(temporary);
    await rename(temporary, path);
    await protectPrivatePath(path);
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
export async function readPrivateJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

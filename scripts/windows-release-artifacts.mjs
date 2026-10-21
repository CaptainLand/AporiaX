// Public distribution is installer-only. Portable validation is an explicit
// compatibility option for historical/private builds, never a public default.
export const PUBLIC_WINDOWS_TARGETS = Object.freeze(['nsis']);

export function windowsReleaseArtifacts(version, { includePortable = false, updateFile = 'latest.yml' } = {}) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
  if (!/^[a-z][a-z0-9-]*\.yml$/.test(updateFile)) throw new Error('Invalid update channel filename');
  const setup = `AporiaX-Setup-${version}-x64.exe`;
  const payloadKinds = includePortable ? ['Setup', 'Portable'] : ['Setup'];
  const payloads = payloadKinds.map(kind => `AporiaX-${kind}-${version}-x64.exe`);
  const checksumFiles = [...new Set([...payloads, setup + '.blockmap', updateFile, 'latest.yml'])];
  const checksumName = `SHA256SUMS-${version}.txt`;
  return { setup, payloadKinds, payloads, checksumFiles, checksumName, assets: [...checksumFiles, checksumName] };
}

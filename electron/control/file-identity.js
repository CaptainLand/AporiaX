/** Compare path/handle stats without dropping identity checks on old libuv. */
export function sameSnapshotIdentity(a, b, { pathVsHandle = false, platform = process.platform,
  fields = ["size", "ino", "mtimeNs", "ctimeNs"] } = {}) {
  // Older Windows Node 22 reports dev=0 for path stats, but a volume id for
  // handle stats. Only an unknown PATH device is exempt; handle/handle checks
  // and every inode/size/time check stay strict. Callers use BigInt stats.
  const unknownPathDevice = pathVsHandle && platform === "win32" && (b.dev === 0 || b.dev === 0n);
  return fields.every(key => a[key] === b[key]) && (unknownPathDevice || a.dev === b.dev);
}

export function serializeFileIdentity(stat) {
  return Object.fromEntries(["size", "ino", "dev", "mtimeNs", "ctimeNs"].map(key => [key, String(stat[key])]));
}
export function restoreFileIdentity(value) {
  return Object.fromEntries(["size", "ino", "dev", "mtimeNs", "ctimeNs"].map(key => [key, BigInt(value[key])]));
}

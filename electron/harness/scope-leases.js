import { resolve } from "node:path";

function namespace(options = {}) {
  if (!options.workspaceRoot) return "";
  const root = resolve(options.workspaceRoot);
  return process.platform === "win32" ? root.toLowerCase() : root;
}

function normalizePath(value) {
  const path = String(value || ".")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "") || ".";
  if (
    path.startsWith("/") ||
    /^[a-zA-Z]:\//.test(path) ||
    path.split("/").includes("..") ||
    path.includes("\0")
  ) {
    throw new Error(`Invalid workspace scope: ${value}`);
  }
  return path;
}

export function normalizeBuilderScopes(values, { allowRoot = false } = {}) {
  const scopes = [...new Set((Array.isArray(values) ? values : [values]).map(normalizePath))];
  if (!scopes.length) throw new Error("Builder requires at least one explicit write scope.");
  if (!allowRoot && scopes.includes(".")) {
    throw new Error("Builder write scope cannot be the workspace root. Delegate explicit non-overlapping paths.");
  }
  for (const scope of scopes) {
    if (
      scope === ".git" ||
      scope.startsWith(".git/") ||
      scope === ".aporiax/worktrees" ||
      scope.startsWith(".aporiax/worktrees/")
    ) {
      throw new Error(`Builder write scope is reserved: ${scope}`);
    }
  }
  return scopes.sort();
}

export function scopesOverlap(left, right) {
  const a = process.platform === "win32" ? normalizePath(left).toLowerCase() : normalizePath(left);
  const b = process.platform === "win32" ? normalizePath(right).toLowerCase() : normalizePath(right);
  return a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function pathInsideScopes(path, scopes) {
  const value = normalizePath(path);
  return (scopes || []).some((scope) => {
    const allowed = normalizePath(scope);
    return allowed === "." || value === allowed || value.startsWith(`${allowed}/`);
  });
}

export class ScopeLeaseManager {
  #leases = new Map();

  acquire(owner, values, options = {}) {
    const id = String(owner || "").trim();
    if (!id) throw new Error("Scope lease owner is required.");
    const workspace = namespace(options);
    const key = JSON.stringify([workspace, id]);
    if (this.#leases.has(key)) throw new Error(`Scope lease already exists: ${id}`);
    const scopes = normalizeBuilderScopes(values, options);
    const conflicts = [];
    for (const lease of this.#leases.values()) {
      if ((lease.workspace || "") !== workspace) continue;
      for (const scope of scopes) {
        const collision = lease.scopes.find((existing) => scopesOverlap(scope, existing));
        if (collision) conflicts.push({ owner: lease.owner, requested: scope, existing: collision });
      }
    }
    if (conflicts.length) {
      const detail = conflicts
        .map((item) => `${item.requested} ↔ ${item.existing} (${item.owner})`)
        .join(", ");
      throw new Error(`Builder scope conflicts with an active worker: ${detail}`);
    }
    const lease = Object.freeze({ owner: id, ...(workspace ? { workspace } : {}), scopes: Object.freeze([...scopes]) });
    this.#leases.set(key, lease);
    return { ...lease, release: () => this.#leases.delete(key) };
  }

  release(owner, options = {}) {
    return this.#leases.delete(JSON.stringify([namespace(options), String(owner || "")]));
  }

  conflicts(values, options = {}) {
    const scopes = normalizeBuilderScopes(values, options);
    return [...this.#leases.values()].filter(lease => (lease.workspace || "") === namespace(options)).flatMap((lease) =>
      scopes.flatMap((scope) =>
        lease.scopes
          .filter((existing) => scopesOverlap(scope, existing))
          .map((existing) => ({ owner: lease.owner, requested: scope, existing })),
      ),
    );
  }

  list() {
    return [...this.#leases.values()].map((lease) => ({ ...lease, scopes: [...lease.scopes] }));
  }
}

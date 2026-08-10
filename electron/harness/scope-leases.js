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
  const a = normalizePath(left);
  const b = normalizePath(right);
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
    if (this.#leases.has(id)) throw new Error(`Scope lease already exists: ${id}`);
    const scopes = normalizeBuilderScopes(values, options);
    const conflicts = [];
    for (const lease of this.#leases.values()) {
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
    const lease = Object.freeze({ owner: id, scopes: Object.freeze([...scopes]) });
    this.#leases.set(id, lease);
    return { ...lease, release: () => this.release(id) };
  }

  release(owner) {
    return this.#leases.delete(String(owner || ""));
  }

  conflicts(values, options = {}) {
    const scopes = normalizeBuilderScopes(values, options);
    return [...this.#leases.values()].flatMap((lease) =>
      scopes.flatMap((scope) =>
        lease.scopes
          .filter((existing) => scopesOverlap(scope, existing))
          .map((existing) => ({ owner: lease.owner, requested: scope, existing })),
      ),
    );
  }

  list() {
    return [...this.#leases.values()].map((lease) => ({ owner: lease.owner, scopes: [...lease.scopes] }));
  }
}
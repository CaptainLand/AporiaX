import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';

export function dependencyFingerprint(files) {
  const selected = [...files].filter(([path]) => /(^|[/\\])(?:package\.json|package-lock\.json|pnpm-lock\.yaml|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|\.npmrc|\.node-version)$/.test(path));
  return createHash('sha256').update(JSON.stringify(selected.sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
}
/** One task owns these private snapshots. They are never shared with another
 * task or hard-linked to host dependencies. Changed manifests invalidate reuse. */
export function createSafeDependencySession() {
  const states = new Map();
  return {
    source(root, files) {
      const state = states.get(root);
      return state?.fingerprint === dependencyFingerprint(files) ? state.workspace : null;
    },
    async accept(root, state, files) {
      const previous = states.get(root);
      states.set(root, { ...state, fingerprint: dependencyFingerprint(files) });
      if (previous && previous.directory !== state.directory)
        await rm(previous.directory, { recursive: true, force: true }).catch(() => {});
    },
    async close() {
      const pending = [...states.values()]; states.clear();
      await Promise.all(pending.map((state) => rm(state.directory, { recursive: true, force: true }).catch(() => {})));
    },
  };
}

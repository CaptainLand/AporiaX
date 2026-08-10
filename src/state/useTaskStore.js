import { useCallback, useRef, useSyncExternalStore } from "react";
import { createTaskStore } from "./task-store-core.js";

function resolveInitialTasks(initializer) {
  return typeof initializer === "function" ? initializer() : initializer;
}

/**
 * React adapter for the v0.6 TaskStore.
 *
 * It intentionally returns a useState-compatible `[tasks, setTasks]` pair so
 * the existing renderer can migrate incrementally without rewriting every task
 * mutation in the same PR. All live mutations still pass through one external
 * store and one subscription boundary.
 */
export function useTaskStore(initializer = []) {
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = createTaskStore(resolveInitialTasks(initializer));
  }
  const store = storeRef.current;
  const tasks = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );

  const setTasks = useCallback(
    (nextOrUpdater, metadata = {}) => {
      if (typeof nextOrUpdater === "function") {
        return store.update(nextOrUpdater, metadata);
      }
      return store.replace(nextOrUpdater, metadata);
    },
    [store],
  );

  return [tasks, setTasks, store];
}

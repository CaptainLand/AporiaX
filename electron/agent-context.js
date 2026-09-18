export * from "./agent-context-core.js";

import { AsyncLocalStorage } from "node:async_hooks";
import {
  loadProjectInstructionContext as loadProjectInstructionContextCore,
} from "./agent-context-core.js";
import { collaborationContextText } from "./harness/collaboration.js";

const collaborationContextStorage = new AsyncLocalStorage();

export function runWithCollaborationContext(context, callback) {
  if (typeof callback !== "function") {
    throw new TypeError("Collaboration context requires a callback.");
  }
  if (!context?.contract) return callback();
  return collaborationContextStorage.run(Object.freeze({ ...context }), callback);
}

export function currentCollaborationContext() {
  return collaborationContextStorage.getStore() || null;
}

export async function loadProjectInstructionContext(...args) {
  const base = await loadProjectInstructionContextCore(...args);
  const collaboration = currentCollaborationContext();
  const sharedText = collaborationContextText(collaboration || {});
  if (!sharedText) return base;
  const root = base?.root || { file: null, content: "" };
  return {
    ...base,
    root: {
      ...root,
      content: [root.content, sharedText].filter(Boolean).join("\n\n"),
    },
  };
}

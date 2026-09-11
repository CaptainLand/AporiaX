import { ScopeLeaseManager } from "./scope-leases.js";

// All Kernel and orchestration workspaces in this process share write leases.
// Callers must namespace leases by canonical workspace root.
export const sharedScopeLeases = new ScopeLeaseManager();

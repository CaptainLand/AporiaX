import { APPROVE_ALL_MODE } from '../../shared/approval-modes.js';

// Legacy sandbox-auto tasks stay on the existing Automatic default.
export function taskApprovalMode(value) {
  return value === "manual" || value === "smart-auto" || value === APPROVE_ALL_MODE ? value : "full-auto";
}

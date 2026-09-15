// Shared by HTTP and the task service: a truthy value is not consent.
export function validateApprovalResponse(runId, approvalId, response) {
  const invalid = (field) => {
    throw Object.assign(new TypeError(`invalid_approval_${field}`), { statusCode: 400 });
  };
  for (const [field, value] of [["run_id", runId], ["id", approvalId]]) {
    if (typeof value !== "string" || !value.trim() || value.length > 100 || /[\x00-\x1f\x7f]/.test(value)) invalid(field);
  }
  if (!response || typeof response !== "object" || Array.isArray(response)) invalid("response");
  if (typeof response.approved !== "boolean") invalid("approved");
  const scope = response.scope === undefined ? "once" : response.scope;
  if (scope !== "once" && scope !== "run") invalid("scope");
  const clientId = response.clientId === undefined ? "" : response.clientId;
  if (typeof clientId !== "string") invalid("client_id");
  return { approved: response.approved, scope, clientId };
}

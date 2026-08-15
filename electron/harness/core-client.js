export function createHarnessCoreClient({ baseUrl, token, fetchImpl = fetch } = {}) {
  if (!baseUrl || !token) throw new Error("Core client requires baseUrl and token.");
  const request = async (path, { method = "GET", body = null } = {}) => {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || `Core request failed: HTTP ${response.status}`);
    }
    return payload;
  };
  return Object.freeze({
    health: () => request("/v1/health"),
    snapshot: () => request("/v1/snapshot"),
    agents: () => request("/v1/agents"),
    plugins: () => request("/v1/plugins"),
    skills: () => request("/v1/skills"),
    sessions: () => request("/v1/sessions"),
    events: ({ since = 0, type = "*", limit = 200 } = {}) =>
      request(`/v1/events?since=${encodeURIComponent(since)}&type=${encodeURIComponent(type)}&limit=${encodeURIComponent(limit)}`),
    tasks: () => request("/v1/tasks"),
    task: (runId) => request(`/v1/tasks/${encodeURIComponent(runId)}`),
    startTask: (input) => request("/v1/tasks", { method: "POST", body: input }),
    pauseTask: (runId) => request(`/v1/tasks/${encodeURIComponent(runId)}/pause`, { method: "POST" }),
    resumeTask: (runId) => request(`/v1/tasks/${encodeURIComponent(runId)}/resume`, { method: "POST" }),
    interruptTask: (runId) => request(`/v1/tasks/${encodeURIComponent(runId)}/interrupt`, { method: "POST" }),
    steerTask: (runId, message) => request(`/v1/tasks/${encodeURIComponent(runId)}/steer`, { method: "POST", body: { message } }),
    respondApproval: (runId, approvalId, response) =>
      request(`/v1/tasks/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(approvalId)}`, {
        method: "POST",
        body: response,
      }),
    acknowledgeRecovery: (runId) =>
      request(`/v1/tasks/${encodeURIComponent(runId)}/acknowledge-recovery`, { method: "POST" }),
  });
}

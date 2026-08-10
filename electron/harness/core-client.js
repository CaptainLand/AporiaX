export function createHarnessCoreClient({ baseUrl, token, fetchImpl = fetch } = {}) {
  if (!baseUrl || !token) throw new Error("Core client requires baseUrl and token.");
  const request = async (path) => {
    const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, "")}${path}`, {
      headers: { authorization: `Bearer ${token}` },
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
  });
}

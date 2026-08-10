const SINGLE_ROLES = Object.freeze({
  explore: 0,
  review: 0,
  verify: 0,
  curator: 0,
  builder: 0,
  other: 0,
});

export function normalizeDesktopAgentMode(value) {
  return String(value || "").toLowerCase() === "multi" ? "multi" : "single";
}

export function desktopAgentModeBudget(mode) {
  const normalized = normalizeDesktopAgentMode(mode);
  if (normalized === "multi") {
    // Multi means the existing Adaptive Agent Budget is allowed to choose the
    // right topology for this task. It does not force the large profile or two
    // Builders. Simple tasks can still stay Main-only; larger tasks may grow to
    // Explore/Review/Verify and, when safe, up to two isolated Builders.
    return null;
  }
  return {
    profile: "direct",
    locked: true,
    maxTotalSubagents: 0,
    maxActiveSubagents: 0,
    roles: { ...SINGLE_ROLES },
  };
}

export function applyDesktopAgentMode(request = {}, mode = "single") {
  const normalized = normalizeDesktopAgentMode(mode);
  if (normalized === "multi") {
    return {
      ...request,
      desktopAgentMode: "multi",
      // Keep Builder orchestration available, but the adaptive budget still
      // decides whether this run has Builder capacity at all.
      builderOrchestration: request.builderOrchestration !== false,
    };
  }
  return {
    ...request,
    desktopAgentMode: "single",
    builderOrchestration: false,
    agentBudget: desktopAgentModeBudget("single"),
  };
}

export function desktopAgentModeDescription(mode) {
  return normalizeDesktopAgentMode(mode) === "multi"
    ? {
        mode: "multi",
        label: "Multi-Agent",
        detail:
          "Adaptive multi-Agent mode. AporiaX automatically chooses Main-only or the useful Explore/Builder/Review/Verify topology for each task, with up to 2 isolated Builders when safe.",
      }
    : {
        mode: "single",
        label: "Single Agent",
        detail:
          "Main only. Builder, Review, Verify, Explore, and Curator subagents are disabled for the run.",
      };
}

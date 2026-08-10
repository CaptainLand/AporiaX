const SINGLE_ROLES = Object.freeze({
  explore: 0,
  review: 0,
  verify: 0,
  curator: 0,
  builder: 0,
  other: 0,
});

const MULTI_ROLES = Object.freeze({
  explore: 2,
  review: 2,
  verify: 1,
  curator: 1,
  builder: 2,
  other: 2,
});

export function normalizeDesktopAgentMode(value) {
  return String(value || "").toLowerCase() === "multi" ? "multi" : "single";
}

export function desktopAgentModeBudget(mode) {
  const normalized = normalizeDesktopAgentMode(mode);
  if (normalized === "multi") {
    return {
      profile: "large",
      locked: true,
      maxTotalSubagents: 7,
      maxActiveSubagents: 4,
      roles: { ...MULTI_ROLES },
    };
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
  return {
    ...request,
    desktopAgentMode: normalized,
    builderOrchestration: normalized === "multi",
    agentBudget: desktopAgentModeBudget(normalized),
  };
}

export function desktopAgentModeDescription(mode) {
  return normalizeDesktopAgentMode(mode) === "multi"
    ? {
        mode: "multi",
        label: "Multi-Agent",
        detail:
          "Main + up to 2 isolated Builders. Review/Verify remain available to the quality pipeline when needed.",
      }
    : {
        mode: "single",
        label: "Single Agent",
        detail:
          "Main only. Builder, Review, Verify, Explore, and Curator subagents are disabled for the run.",
      };
}

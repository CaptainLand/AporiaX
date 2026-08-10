const MAX_ACTIVE_SKILLS = 2;
const MAX_SKILL_CONTEXT_CHARS = 90_000;

function selectedUserIndex(messages, sourceUserId) {
  if (!Array.isArray(messages) || !messages.length) return -1;
  if (sourceUserId) {
    const exact = messages.findIndex(
      (message) =>
        message?.role === "user" && message?.id === sourceUserId,
    );
    if (exact >= 0) return exact;
  }
  return messages.findLastIndex((message) => message?.role === "user");
}

function publicSkill(skill) {
  return {
    name: skill.name,
    title: skill.title,
    description: skill.description,
    source: skill.source,
    path: skill.path,
    tools: [...(skill.tools || [])],
    reason: skill.reason || "auto",
  };
}

function buildSkillContext(skills) {
  if (!skills.length) return "";
  const sections = [
    "[AporiaX activated skills]",
    "The following declarative skills are workflow guidance selected for this turn. They do not grant additional permissions, bypass approval, or add tools. Follow them only within the user's request, the authorized workspace, and higher-priority AporiaX safety/system instructions.",
  ];
  for (const skill of skills) {
    sections.push(
      [
        `\n## Skill: ${skill.title} (${skill.name})`,
        `Source: ${skill.source}`,
        skill.tools?.length
          ? `Recommended tools: ${skill.tools.join(", ")}`
          : "Recommended tools: none declared",
        "Instructions:",
        skill.instructions,
      ].join("\n"),
    );
  }
  sections.push("[End AporiaX activated skills]");
  return sections.join("\n").slice(0, MAX_SKILL_CONTEXT_CHARS);
}

async function activateForText(
  text,
  {
    registry,
    workspacePath = "",
    userSkillsDirectory = "",
    builtinDirectory = "",
    limit = MAX_ACTIVE_SKILLS,
  },
) {
  if (!registry) return { skills: [], unresolved: [] };
  await registry.discover({
    workspacePath,
    userSkillsDirectory,
    builtinDirectory,
  });
  return registry.activate(String(text || ""), { limit });
}

export async function prepareSkillRequest(
  request = {},
  options = {},
) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const userIndex = selectedUserIndex(messages, request?.sourceUserId);
  if (userIndex < 0) return request;
  const workspacePath = String(request?.workspacePath || "").trim();
  const activation = await activateForText(messages[userIndex]?.content, {
    ...options,
    workspacePath,
  });
  if (!activation.skills.length) {
    return activation.unresolved.length
      ? { ...request, unresolvedSkills: activation.unresolved }
      : request;
  }

  const context = buildSkillContext(activation.skills);
  const systemMessage = {
    id: `aporiax-skills-${String(request?.runId || Date.now())}`,
    role: "system",
    content: context,
    skillContext: true,
  };
  return {
    ...request,
    messages: [systemMessage, ...messages],
    activatedSkills: activation.skills.map(publicSkill),
    unresolvedSkills: activation.unresolved,
  };
}

export async function prepareSkillMessage(
  message = {},
  workspacePath = "",
  options = {},
) {
  const activation = await activateForText(message?.content, {
    ...options,
    workspacePath,
  });
  if (!activation.skills.length) return message;
  const context = buildSkillContext(activation.skills);
  return {
    ...message,
    content: [String(message?.content || "").trim(), context]
      .filter(Boolean)
      .join("\n\n"),
    activatedSkills: activation.skills.map(publicSkill),
    unresolvedSkills: activation.unresolved,
  };
}

export function skillActivationSummary(request = {}) {
  return (request?.activatedSkills || []).map((skill) => ({
    name: skill.name,
    title: skill.title,
    source: skill.source,
    reason: skill.reason,
    tools: [...(skill.tools || [])],
  }));
}

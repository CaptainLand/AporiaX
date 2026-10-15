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
    packageRoot: skill.packageRoot || "",
    license: skill.license || "",
    runtime: skill.runtime || null,
    compatibilityWarnings: [...(skill.compatibilityWarnings || [])],
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
        skill.compatibilityWarnings?.length ? `Compatibility limits: ${skill.compatibilityWarnings.join("; ")}` : "",
        skill.runtime?.executable ? `Configured Python interpreter: ${skill.runtime.executable}. File detected only; verify imports before use. It is outside the versioned package so updates do not replace it.` : "",
        skill.packageRoot ? `Package root: ${skill.packageRoot}\nRead package resources with read_skill_resource(skill="${skill.name}", path="relative/path"). This root is read-only; write outputs to the task workspace. Upstream Bash/terminal commands must use AporiaX run_command and current task permissions, never setup scripts during discovery.` : "",
        skill.tools?.length
          ? `Recommended tools: ${skill.tools.join(", ")}`
          : "Recommended tools: none declared",
        "Instructions:",
        skill.instructions,
      ].join("\n"),
    );
  }
  sections.push("[End AporiaX activated skills]");
  return sections.join("\n");
}

function baseSkillMessage(message) {
  const content = String(message?.content || "");
  const previous = message?.aporiaSkillContext;
  return previous && content.endsWith(`\n\n${previous}`)
    ? content.slice(0, -(previous.length + 2)) : content;
}

async function activateForText(
  text,
  {
    registry,
    workspacePath = "",
    userSkillsDirectory = "",
    builtinDirectory,
    limit = MAX_ACTIVE_SKILLS,
  },
) {
  if (!registry) return { skills: [], unresolved: [] };
  const catalog = await registry.catalog({
    workspacePath,
    userSkillsDirectory,
    builtinDirectory,
  });
  const activation = registry.activate(String(text || ""), { limit, catalog });
  const selected = activation.skills.filter((skill) => skill.reason === "explicit");
  if (buildSkillContext(selected).length > MAX_SKILL_CONTEXT_CHARS) {
    throw new Error(`SKILL_CONTEXT_BUDGET_EXCEEDED: 明确选择的 Skills 超出上下文预算，请减少选择或拆分指令文件：${selected.map((skill) => skill.name).join(", ")}`);
  }
  const unresolved = [...activation.unresolved];
  for (const skill of activation.skills.filter((item) => item.reason !== "explicit")) {
    if (buildSkillContext([...selected, skill]).length <= MAX_SKILL_CONTEXT_CHARS) selected.push(skill);
    else unresolved.push(`${skill.name} (context budget exceeded)`);
  }
  return { skills: selected, unresolved };
}

export async function prepareSkillRequest(
  request = {},
  options = {},
) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const userIndex = selectedUserIndex(messages, request?.sourceUserId);
  if (userIndex < 0) return request;
  const workspacePath = String(request?.workspacePath || "").trim();
  const originalContent = String(
    messages[userIndex]?.skillOriginalContent || messages[userIndex]?.content || "",
  );
  const activation = await activateForText(originalContent, {
    ...options,
    workspacePath,
  });
  if (!activation.skills.length) {
    const nextMessages = [...messages];
    nextMessages[userIndex] = { ...messages[userIndex], content: baseSkillMessage(messages[userIndex]), aporiaSkillContext: "", activatedSkills: [] };
    return { ...request, messages: nextMessages, activatedSkills: [], unresolvedSkills: activation.unresolved };
  }

  const context = buildSkillContext(activation.skills);
  const nextMessages = [...messages];
  nextMessages[userIndex] = {
    ...messages[userIndex],
    skillOriginalContent: originalContent,
    aporiaSkillContext: context,
    content: baseSkillMessage(messages[userIndex]),
    activatedSkills: activation.skills.map(publicSkill),
  };
  return {
    ...request,
    messages: nextMessages,
    activatedSkills: activation.skills.map(publicSkill),
    unresolvedSkills: activation.unresolved,
  };
}

export async function prepareSkillMessage(
  message = {},
  workspacePath = "",
  options = {},
) {
  const activationSource = String(
    message?.workspaceMentionOriginalContent ||
      message?.skillOriginalContent ||
      message?.content ||
      "",
  );
  const activation = await activateForText(activationSource, {
    ...options,
    workspacePath,
  });
  if (!activation.skills.length) return { ...message, content: baseSkillMessage(message), aporiaSkillContext: "", activatedSkills: [], unresolvedSkills: activation.unresolved };
  const context = buildSkillContext(activation.skills);
  return {
    ...message,
    skillOriginalContent: activationSource,
    aporiaSkillContext: context,
    content: baseSkillMessage(message),
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

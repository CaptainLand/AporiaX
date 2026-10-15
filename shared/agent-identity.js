// Display identities only. Runtime IDs, templates, permissions and persisted
// custom names are independent of the language chosen for the interface.
export const AGENT_IDENTITIES = Object.freeze({
  main: { zh: '阿珀', en: 'AporiaX', duty: ['主管', 'Supervisor'], aliases: ['主 Agent', 'Main Agent', 'Main agent', '主管', 'Supervisor', 'AporiaX · 主管', 'AporiaX · Supervisor'] },
  explore: { zh: '探奇', en: 'Scout', duty: ['探索、发现线索', 'Explore and discover leads'], aliases: ['探索', 'Explore', 'Explorer', '探索 Agent', 'Explore agent'] },
  review: { zh: '察微', en: 'Sentry', duty: ['审查、识别风险', 'Review and identify risks'], aliases: ['审查', 'Review', 'Reviewer', '审查 Agent', 'Review agent'] },
  verify: { zh: '验准', en: 'Checko', duty: ['验证、检查结果', 'Verify and check results'], aliases: ['验证', 'Verify', 'Verifier', '验证 Agent', 'Verify agent'] },
  builder: { zh: '搭匠', en: 'Forge', duty: ['构建、实现功能', 'Build and implement features'], aliases: ['Builder', '开发', '构建', '构建 Agent', 'Builder agent'] },
  curator: { zh: '知序', en: 'Index', duty: ['整理知识、沉淀记忆', 'Organize knowledge and preserve memory'], aliases: ['知识整理', 'Curator', '知识整理 Agent', 'Curator agent'] },
});
const english = language => String(language || '').startsWith('en');
export function agentName(id, language = 'zh-CN') {
  const identity = AGENT_IDENTITIES[id];
  return identity ? identity[english(language) ? 'en' : 'zh'] : id || 'Agent';
}
export function agentDuty(id, language = 'zh-CN') {
  const identity = AGENT_IDENTITIES[id];
  return identity ? identity.duty[english(language) ? 1 : 0] : id || 'Agent';
}
function identityId(profile) {
  return profile?.profileId || profile?.roleId || (profile?.template ? profile.id : null) || profile?.role || profile?.id;
}
export function agentAliases(profile) {
  const id = identityId(profile), identity = AGENT_IDENTITIES[id];
  return [...new Set([profile?.name, profile?.profileName, id, ...(identity ? [identity.zh, identity.en, ...identity.aliases] : [])].filter(Boolean))];
}
export function agentDisplayName(profile, language = 'zh-CN') {
  const id = identityId(profile), identity = AGENT_IDENTITIES[id];
  const name = profile?.profileName || profile?.name;
  // A user-renamed built-in and every custom profile retain their explicit name.
  if (!identity) return name || id || 'Agent';
  if (name && ![id, identity.zh, identity.en, ...identity.aliases].includes(name)) return name;
  return agentName(id, language);
}
// Chat uses the product name; the office/character identity remains localized.
export function agentChatDisplayName(profile, language = 'zh-CN') {
  return agentDisplayName(profile, identityId(profile) === 'main' ? 'en' : language);
}
const DEFAULT_DESCRIPTIONS = {
  explore: ['读取项目，定位实现与证据。', 'Read the project and locate implementations and evidence.'],
  review: ['检查正确性、安全与回归风险，不修改文件。', 'Check correctness, security and regression risks without changing files.'],
  verify: ['运行必要检查，报告命令、证据与未验证项。', 'Run necessary checks and report commands, evidence and unverified items.'],
  curator: ['从已验证成果整理可复用的项目知识。', 'Organize reusable project knowledge from verified results.'],
  builder: ['在明确的写入范围和隔离工作区中实现改动。', 'Implement changes within the assigned write scope and isolated workspace.'],
};
export function agentDescription(profile, language = 'zh-CN') {
  const pair = DEFAULT_DESCRIPTIONS[identityId(profile)];
  return pair?.includes(profile?.description) ? pair[english(language) ? 1 : 0] : profile?.description || '';
}

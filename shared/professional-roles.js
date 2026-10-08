const READ_TOOLS = ['task_brief', 'replan_strategy', 'list_directory', 'read_file', 'search_text', 'git_status', 'git_diff', 'inspect_office_file'];
export const NATIVE_ROLE_TOOLS = Object.freeze({
  explore: READ_TOOLS, review: READ_TOOLS, curator: READ_TOOLS,
  verify: [...READ_TOOLS, 'run_command'],
  builder: [...READ_TOOLS.filter(tool => tool !== 'inspect_office_file'), 'write_file', 'cleanup_temporary_check', 'apply_patch'],
});
export const ROLE_TEMPLATES = Object.freeze({
  explore: { name: '探索', description: '读取项目，定位实现与证据。', maxRounds: 8, thinking: 'off' },
  review: { name: '审查', description: '检查正确性、安全与回归风险，不修改文件。', maxRounds: 6, thinking: 'inherit' },
  verify: { name: '验证', description: '运行必要检查，报告命令、证据与未验证项。', maxRounds: 4, thinking: 'off' },
  curator: { name: '知识整理', description: '从已验证成果整理可复用的项目知识。', maxRounds: 6, thinking: 'off' },
  builder: { name: 'Builder', description: '在明确的写入范围和隔离工作区中实现改动。', maxRounds: 8, thinking: 'inherit' },
});
const text = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max) throw new Error(`${label}格式不正确或过长。`);
  return value.trim();
};
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${label}必须为 ${min}–${max} 的整数。`);
  return value;
};
const strings = (value, label) => {
  if (!Array.isArray(value) || value.length > 64) throw new Error(`${label}列表无效。`);
  return [...new Set(value.map(item => text(item, 200, label)).filter(Boolean))];
};
export function defaultRole(id = 'explore') {
  const template = ROLE_TEMPLATES[id];
  if (!template) throw new Error('未知角色模板。');
  return { id, name: template.name, description: template.description, instructions: '', template: id, enabled: true,
    model: 'inherit', thinking: 'default', tools: null, skills: [], mcpTools: [], knowledge: 'off',
    maxRounds: template.maxRounds, maxRequests: 24, maxTokens: null, maxSeconds: null, concurrency: id === 'builder' ? 6 : 2 };
}
export function defaultRoleSettings() {
  return { version: 1, revision: 0, builderLimit: 2, maxActive: 4, maxRequests: 120,
    profiles: Object.keys(ROLE_TEMPLATES).map(defaultRole) };
}
export function normalizeRole(input) {
  if (!input || typeof input !== 'object') throw new Error('角色配置无效。');
  const id = text(input.id, 64, '角色 ID');
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id) || ['__proto__', 'constructor', 'prototype', 'main'].includes(id)) throw new Error('角色 ID 无效。');
  if (!Object.hasOwn(ROLE_TEMPLATES, input.template)) throw new Error('未知角色模板。');
  if (Object.hasOwn(ROLE_TEMPLATES, id) && id !== input.template) throw new Error('内置角色不能更改执行类别，请复制为新角色。');
  if (typeof input.enabled !== 'boolean') throw new Error('角色启用状态无效。');
  if (!['default', 'inherit', 'off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinking)) throw new Error('思考档位无效。');
  if (!['off', 'read', 'write'].includes(input.knowledge)) throw new Error('知识权限无效。');
  const name = text(input.name, 80, '角色名称');
  if (!name) throw new Error('角色名称不能为空。');
  const tools = input.tools == null ? null : strings(input.tools, '内置工具');
  if (tools?.some(tool => !NATIVE_ROLE_TOOLS[input.template].includes(tool))) throw new Error('工具不属于此角色的执行模板。');
  return { id, name, template: input.template, enabled: input.enabled,
    description: text(input.description, 2000, '职责'), instructions: text(input.instructions, 16000, '指令'),
    model: text(input.model, 256, '模型') || 'inherit', thinking: input.thinking,
    tools, skills: strings(input.skills, 'Skills'), mcpTools: strings(input.mcpTools, 'MCP'), knowledge: input.knowledge,
    maxRounds: integer(input.maxRounds, 2, 20, '轮次'), maxRequests: integer(input.maxRequests, 1, 200, '请求上限'),
    maxTokens: input.maxTokens == null ? null : integer(input.maxTokens, 1024, 100000000, 'Token 上限'),
    maxSeconds: input.maxSeconds == null ? null : integer(input.maxSeconds, 10, 86400, '执行秒数'),
    concurrency: integer(input.concurrency, 1, 6, '角色并发') };
}
export function normalizeRoleSettings(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.profiles) || value.profiles.length > 64) throw new Error('专业角色配置格式无效。');
  const profiles = value.profiles.map(normalizeRole);
  if (new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('角色 ID 重复。');
  for (const id of Object.keys(ROLE_TEMPLATES)) if (!profiles.some(p => p.id === id)) throw new Error('内置角色只能禁用，不能删除。');
  return { version: 1, revision: integer(value.revision, 0, Number.MAX_SAFE_INTEGER, '配置版本'),
    builderLimit: integer(value.builderLimit, 0, 6, 'Builder 并发'), maxActive: integer(value.maxActive, 1, 12, '总并发'),
    maxRequests: integer(value.maxRequests, 1, 1000, '本轮委派请求上限'), profiles };
}
export function effectiveRoleSettings(globalSettings, overrides) {
  const settings = normalizeRoleSettings(globalSettings);
  if (!overrides) return settings;
  // Task overrides cannot insert a new profile or grant capabilities.
  const profiles = settings.profiles.map(profile => {
    const override = overrides.profiles?.[profile.id];
    if (!override) return profile;
    const allowed = Object.fromEntries(['model', 'thinking', 'maxRounds', 'maxRequests', 'maxTokens', 'maxSeconds', 'concurrency']
      .filter(key => Object.hasOwn(override, key)).map(key => [key, override[key]]));
    return normalizeRole({ ...profile, ...allowed });
  });
  return normalizeRoleSettings({ ...settings, profiles,
    builderLimit: overrides.builderLimit ?? settings.builderLimit, maxActive: overrides.maxActive ?? settings.maxActive,
    maxRequests: overrides.maxRequests ?? settings.maxRequests });
}

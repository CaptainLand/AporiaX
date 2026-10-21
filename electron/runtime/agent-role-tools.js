import { defaultRole, normalizeRole, normalizeRoleSettings, ROLE_TEMPLATES } from '../../shared/professional-roles.js';

const fields = {
  name: { type: 'string', minLength: 1, maxLength: 80 },
  description: { type: 'string', maxLength: 2000 }, instructions: { type: 'string', maxLength: 16000 },
  template: { type: 'string', enum: Object.keys(ROLE_TEMPLATES) }, enabled: { type: 'boolean' },
  model: { type: 'string', description: 'inherit, or a configured [providerId, modelId] JSON string.' },
  thinking: { type: 'string', enum: ['default', 'inherit', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] },
  tools: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 64 },
  skills: { type: 'array', items: { type: 'string' }, maxItems: 64 },
  mcpTools: { type: 'array', items: { type: 'string' }, maxItems: 64 },
  knowledge: { type: 'string', enum: ['off', 'read', 'write'] },
  maxRequests: { type: ['integer', 'null'], minimum: 1, maximum: 1000000, description: 'Optional explicit request budget; null is unlimited. Rounds and lifetime starts are not capped.' },
  maxTokens: { type: ['integer', 'null'], minimum: 1024, maximum: 100000000 },
  maxSeconds: { type: ['integer', 'null'], minimum: 10, maximum: 86400 },
  concurrency: { type: 'integer', minimum: 1, maximum: 6 },
};
export const AGENT_ROLE_TOOL_NAMES = new Set(['list_agent_roles', 'manage_agent_role']);
export const AGENT_ROLE_TOOLS = [
  { type: 'function', function: { name: 'list_agent_roles',
    description: 'Main Agent only: inspect saved professional roles and their revision. Returns compact summaries by default; pass role_id for one full configuration. These are reusable Settings profiles, not running workers. No changes or model requests.',
    parameters: { type: 'object', properties: { role_id: { type: 'string', description: 'Optional role ID to read its complete configuration.' } }, additionalProperties: false } } },
  { type: 'function', function: { name: 'manage_agent_role',
    description: 'Main Agent only: propose one persistent custom role create/update/delete when the user requests it. Always requires explicit human confirmation, even in full-auto. First list_agent_roles and pass its revision. Built-in roles are protected. Does not raise parent permissions or total budgets; running workers keep their original configuration. Never retry a rejected proposal without new user direction.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['create', 'update', 'delete'] },
      role_id: { type: 'string', pattern: '^[a-z][a-z0-9_-]{1,63}$' },
      expected_revision: { type: 'integer', minimum: 0 },
      changes: { type: 'object', properties: fields, additionalProperties: false, description: 'Create: name and template required, other fields use template defaults. Update: changed fields only. Delete: omit.' },
      reason: { type: 'string', minLength: 1, maxLength: 1000 },
    }, required: ['action', 'role_id', 'expected_revision', 'reason'], additionalProperties: false } } },
];

export function proposeRoleChange(snapshot, input) {
  if (snapshot.error) throw new Error(snapshot.error);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['action', 'role_id', 'expected_revision', 'changes', 'reason'].includes(key))) throw new Error('角色变更参数无效。');
  if (!['create', 'update', 'delete'].includes(input.action)) throw new Error('未知角色管理操作。');
  if (input.expected_revision !== snapshot.revision) throw new Error('ROLE_SETTINGS_CHANGED: 请重新读取角色配置，再提交新的确认。');
  if (typeof input.role_id !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(input.role_id)) throw new Error('角色 ID 无效。');
  if (Object.hasOwn(ROLE_TEMPLATES, input.role_id)) throw new Error('内置角色不能由 Agent 创建、修改或删除；请创建自定义副本。');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 1000) throw new Error('请提供角色变更原因。');
  const changes = input.changes ?? {};
  if (typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).some(key => !Object.hasOwn(fields, key))) throw new Error('角色字段无效，不能改变全局权限或总预算。');
  const before = snapshot.profiles.find(profile => profile.id === input.role_id) || null;
  if (input.action === 'create' ? before : !before) throw new Error(input.action === 'create' ? '角色已存在。' : '角色不存在。');
  if (input.action === 'delete' && Object.keys(changes).length) throw new Error('删除角色不能同时更改字段。');
  if (input.action === 'create' && (!changes.name || !Object.hasOwn(ROLE_TEMPLATES, changes.template))) throw new Error('创建角色需要名称和执行模板。');
  const after = input.action === 'delete' ? null : normalizeRole({ ...(before || defaultRole(changes.template)), ...changes, id: input.role_id });
  if (JSON.stringify(before) === JSON.stringify(after)) throw new Error('角色配置没有变化。');
  const next = normalizeRoleSettings({ ...snapshot, profiles: input.action === 'create' ? [...snapshot.profiles, after]
    : snapshot.profiles.flatMap(profile => profile.id === input.role_id ? (after ? [after] : []) : [profile]) });
  const changedFields = Object.keys(after || before).filter(key => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
  const diff = Object.fromEntries(changedFields.map(key => [key, { before: before?.[key] ?? null, after: after?.[key] ?? null }]));
  const description = JSON.stringify(diff, null, 2);
  // Reconnect snapshots must contain the entire proposal, never a truncated approval.
  if (description.length > 16000 || Buffer.byteLength(JSON.stringify({ description }), 'utf8') > 24000) throw new Error('变更内容过长，无法完整展示审批；请缩小本次修改范围。');
  return { next, before, after, description };
}

export function createAgentRoleTools({ store, requestApproval, signal, onChanged = () => {} }) {
  return async (name, input = {}) => {
    signal?.throwIfAborted();
    if (!AGENT_ROLE_TOOL_NAMES.has(name)) throw new Error('未知角色工具。');
    const snapshot = store.snapshot();
    if (name === 'list_agent_roles') {
      const { profiles, ...limits } = snapshot;
      if (input.role_id !== undefined) {
        const profile = profiles.find(item => item.id === input.role_id);
        if (!profile) throw new Error('角色不存在。');
        return { ...limits, profile, builtInIds: Object.keys(ROLE_TEMPLATES) };
      }
      return { ...limits, builtInIds: Object.keys(ROLE_TEMPLATES), profiles: profiles.map(({ id, name, template, enabled, description }) => ({ id, name, template, enabled, description: description.slice(0, 500) })) };
    }
    const { next, before, after, description } = proposeRoleChange(snapshot, input);
    const verb = { create: '创建', update: '修改', delete: '删除' }[input.action];
    const approval = await requestApproval({
      kind: 'agent-role-change', tool: name, toolName: name, canRememberForRun: false,
      title: `${verb}自定义角色：${after?.name || before.name}`,
      command: `${input.action} ${input.role_id} · revision ${snapshot.revision}`,
      reason: input.reason, description,
    });
    signal?.throwIfAborted();
    if (!approval?.approved || approval.automatic || approval.remembered) return { status: 'rejected', changed: false, roleId: input.role_id, message: '未获得本次用户确认，未更改任何角色。不要自动重试。' };
    // Store serialization checks the revision again inside its write queue.
    const saved = await store.save(next, { signal });
    onChanged(saved, { action: input.action, roleId: input.role_id });
    return { status: 'saved', changed: true, roleId: input.role_id, revision: saved.revision, profile: after,
      message: '已保存；本轮后续新委派可使用，已有工作者保持原配置。父任务权限与总预算不变。' };
  };
}

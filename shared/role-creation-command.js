export const ROLE_CREATION_COMMAND = '@新建专业角色';
export const ROLE_CREATION_SKILL = 'create-professional-role';

// Only selects guidance. The Skill and the mutation tool still check intent
// and require per-operation approval before writing any persistent profile.
export function suggestsProfessionalRoleCreation(text) {
  return /(?:创建|新建|新增|添加|配置|设计|做)[^\n。！？.!?]{0,32}(?:专业角色|子\s*agent|专家|(?:审查|审核|测试|前端|后端|文档|设计|开发|研究|分析|写作)[^\n。！？.!?]{0,12}角色)/iu.test(String(text || ''))
    || /(?:create|add|design|configure)\b[^\n.!?]{0,48}\b(?:specialist|professional role|agent role|subagent)\b/iu.test(String(text || ''));
}

export function appendRoleCreationCommand(draft) {
  const text = String(draft || '');
  if (/(?:^|\s)@新建专业角色(?=\s|$)/u.test(text)) return text;
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${ROLE_CREATION_COMMAND} `;
}

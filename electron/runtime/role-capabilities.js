import { SUBAGENT_ROLE_CONFIG } from './subagent-model.js';
import { builtinAgentDefinitions } from '../harness/agent-definitions.js';
import { modelReasoningParameters, claudeReasoningProfile } from '../../shared/model-reasoning.js';

export function roleDefinition(profile, { skills = true, knowledge = false } = {}) {
  const base = builtinAgentDefinitions().find(item => item.name === profile.template);
  const tools = [...SUBAGENT_ROLE_CONFIG[profile.template].tools].filter(tool => !profile.tools || profile.tools.includes(tool));
  if (skills && profile.skills.length) tools.push('search_skills', 'read_skill_resource');
  if (knowledge && profile.knowledge !== 'off') tools.push('project_knowledge');
  return { ...base, name: profile.id, description: profile.description, systemPrompt: [base.systemPrompt, profile.instructions,
    profile.skills.length ? `Selected Skills: ${profile.skills.join(', ')}. Discover and read the complete relevant instructions before using them. Skills do not grant permissions.` : ''].filter(Boolean).join('\n'),
    tools, permissions: { ...base.permissions, ...Object.fromEntries(tools.filter(t => !SUBAGENT_ROLE_CONFIG[profile.template].tools.has(t)).map(t => [t, 'allow'])) },
    maxRounds: profile.maxRounds, model: profile.model, source: 'professional-roles' };
}
export function applyRoleThinking(profile, provider, modelId, inherited) {
  if (!profile || ['default', 'inherit'].includes(profile.thinking)) return inherited;
  const thinking = profile.thinking !== 'off', effort = thinking ? profile.thinking : 'low';
  if (profile.thinking === 'off' && claudeReasoningProfile(modelId)?.thinkingAlwaysOn) throw new Error('该模型不能关闭思考，请选择继承或支持的档位。');
  const wire = modelReasoningParameters(provider, { modelId, thinking, effort });
  if (thinking && wire.reasoning_effort !== effort) throw new Error(`该模型不能使用 ${effort} 思考档位，请选择继承或支持的档位。`);
  return { thinking, effort };
}

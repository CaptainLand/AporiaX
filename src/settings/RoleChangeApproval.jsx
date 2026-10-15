import React from 'react';
import { useI18n } from '../i18n';
import './role-change-approval.css';

const labels = {
  id: ['角色 ID', 'Role ID'], name: ['名称', 'Name'], description: ['职责', 'Responsibility'],
  instructions: ['角色指令', 'Instructions'], template: ['执行模板', 'Template'], enabled: ['启用', 'Enabled'],
  model: ['模型', 'Model'], thinking: ['思考强度', 'Reasoning'], tools: ['内置工具', 'Native tools'],
  skills: ['Skills', 'Skills'], mcpTools: ['MCP 工具', 'MCP tools'], knowledge: ['项目知识', 'Knowledge'],
  maxRounds: ['最大轮次', 'Rounds'], maxRequests: ['请求上限', 'Request limit'], maxTokens: ['Token 预算', 'Token budget'],
  maxSeconds: ['时间上限（秒）', 'Time limit (seconds)'], concurrency: ['角色并发', 'Role concurrency'],
};
export function RoleChangeApproval({ description }) {
  const { tr } = useI18n();
  let diff;
  try { diff = JSON.parse(description); } catch { diff = null; }
  if (!diff || typeof diff !== 'object') return <pre className="role-change-raw">{description}</pre>;
  const display = value => value === null ? '—' : typeof value === 'string' ? value || '—' : JSON.stringify(value, null, 2);
  return <div className="role-change-details" aria-label={tr('角色变更明细', 'Role change details')}>
    {Object.entries(diff).map(([key, value]) => <section key={key}>
      <strong>{labels[key] ? tr(...labels[key]) : key}</strong>
      <div className="role-change-values">
        <div><small>{tr('修改前', 'Before')}</small><pre>{display(value?.before ?? null)}</pre></div>
        <div><small>{tr('修改后', 'After')}</small><pre>{display(value?.after ?? null)}</pre></div>
      </div>
    </section>)}
  </div>;
}

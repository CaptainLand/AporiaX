import React, { useEffect, useState } from 'react';
import { Plus, Copy, RotateCcw, Trash2 } from 'lucide-react';
import { ROLE_TEMPLATES, NATIVE_ROLE_TOOLS, defaultRole, effectiveRoleSettings, normalizeRoleSettings } from '../../shared/professional-roles.js';
import { useI18n } from '../i18n';
import './professional-roles.css';

const taskOverrides = task => ({ ...task?.professionalRoles,
  ...(task?.builderLimit != null && task?.professionalRoles?.builderLimit == null ? { builderLimit: task.builderLimit } : {}) });
export function ProfessionalRolesSettings({ task, providers = [], onUpdateTask }) {
  const { tr } = useI18n();
  const [global, setGlobal] = useState(null), [savedGlobal, setSavedGlobal] = useState(null), [overrides, setOverrides] = useState(() => taskOverrides(task));
  const [scope, setScope] = useState('global'), [selected, setSelected] = useState('explore');
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [skills, setSkills] = useState([]), [mcpTools, setMcpTools] = useState([]);
  useEffect(() => {
    let live = true;
    setOverrides(taskOverrides(task));
    if (!window.desktop?.agentProfiles) { setError(tr('专业角色设置需要桌面版本支持。', 'This desktop version does not support professional roles.')); return; }
    window.desktop.agentProfiles.get().then(value => { if (live) { setGlobal(value); setSavedGlobal(value); setError(value.error || ''); } }, cause => { if (live) setError(cause.message); });
    Promise.resolve(window.desktop.core?.skills?.({ workspacePath: task?.workspacePath || '' })).then(value => { if (live) setSkills(value?.enabled === false ? [] : value?.skills || []); }, cause => { if (live) setNotice(cause.message); });
    Promise.resolve(window.desktop.core?.capabilities?.({ workspacePath: task?.workspacePath || '', source: 'mcp', kind: 'tool' })).then(value => {
      if (live) setMcpTools([...new Map((value?.capabilities || []).map(tool => [tool.name, tool])).values()]);
    }, cause => { if (live) setNotice(cause.message); });
    return () => { live = false; };
  }, [task?.id]);
  // Drafts may contain temporarily empty/invalid fields; validate only on save.
  const effective = savedGlobal && scope === 'task' ? { ...savedGlobal, ...overrides,
    profiles: savedGlobal.profiles.map(profile => ({ ...profile, ...overrides.profiles?.[profile.id] })) } : global;
  const role = effective?.profiles.find(item => item.id === selected) || effective?.profiles[0];
  const patchGlobal = patch => { setNotice(''); if (scope === 'global') setGlobal(value => ({ ...value, ...patch })); else setOverrides(value => ({ ...value, ...patch })); };
  const patchRole = patch => {
    setNotice('');
    if (scope === 'global') setGlobal(value => ({ ...value, profiles: value.profiles.map(item => item.id === role.id ? { ...item, ...patch } : item) }));
    else setOverrides(value => ({ ...value, profiles: { ...value.profiles, [role.id]: { ...value.profiles?.[role.id], ...patch } } }));
  };
  const add = copy => {
    const id = `role-${crypto.randomUUID().slice(0, 8)}`;
    const next = { ...(copy ? role : defaultRole('explore')), id, name: copy ? `${role.name} ${tr('副本', 'copy')}` : tr('新角色', 'New role') };
    setGlobal(value => ({ ...value, profiles: [...value.profiles, next] })); setSelected(id); setNotice('');
  };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      if (scope === 'global') { const saved = await window.desktop.agentProfiles.save(normalizeRoleSettings(global)); setGlobal(saved); setSavedGlobal(saved); }
      else { effectiveRoleSettings(savedGlobal, overrides); await onUpdateTask?.({ professionalRoles: overrides, builderLimit: null }); }
      setNotice(tr('已保存，下次运行生效。', 'Saved for the next run.'));
    } catch (cause) { setError(cause.message); } finally { setBusy(false); }
  };
  const numeric = (label, value, min, max, change, optional = false) => <label className="pr-field"><span>{label}</span><input type="number" min={min} max={max} value={value ?? ''} placeholder={tr('沿用系统限制', 'System limit')} onChange={event => change(optional && !event.target.value ? null : Number(event.target.value))} /></label>;
  return <section className="professional-roles" aria-label={tr('专业角色配置', 'Professional role settings')}>
    <header className="pr-heading"><h3>{tr('专业角色', 'Professional roles')}</h3><select aria-label={tr('配置范围', 'Configuration scope')} value={scope} onChange={event => { setScope(event.target.value); setError(''); }}><option value="global">{tr('全局默认', 'Global defaults')}</option>{task && <option value="task">{tr('当前任务', 'Current task')}</option>}</select></header>
    {error && <p role="alert">{error}</p>}
    {!global ? <p>{tr('正在读取配置…', 'Loading…')}</p> : <>
      <div className="pr-limits">
        {numeric(tr('Builder 并发上限', 'Builder concurrency'), effective.builderLimit, 0, 6, builderLimit => patchGlobal({ builderLimit }))}
        {numeric(tr('总并发上限', 'Total concurrency'), effective.maxActive, 1, 12, maxActive => patchGlobal({ maxActive }))}
        {numeric(tr('本轮委派请求上限', 'Delegated requests per run'), effective.maxRequests, 1, 1000, maxRequests => patchGlobal({ maxRequests }))}
      </div>
      <p className="pr-note">{tr('按需委派，不会自动填满并发；Builder 设为 0 即关闭。', 'Delegation is on demand; 0 disables Builders.')}{scope === 'task' && tr(' 当前任务未覆盖的项目继承全局设置。', ' Unchanged fields inherit global defaults.')}</p>
      {scope === 'task' && <button type="button" onClick={() => { setOverrides({}); setNotice(tr('已恢复继承，保存后生效。', 'Inheritance restored; save to apply.')); }}><RotateCcw size={14} />{tr('恢复当前任务继承', 'Reset task overrides')}</button>}
      <div className="pr-layout"><nav aria-label={tr('角色列表', 'Roles')}>
        {effective.profiles.map(item => <button type="button" aria-pressed={item.id === role?.id} className={item.id === role?.id ? 'selected' : ''} key={item.id} onClick={() => setSelected(item.id)}><span>{item.name}</span>{!item.enabled && <small>{tr('已禁用', 'Disabled')}</small>}</button>)}
        {scope === 'global' && <button type="button" onClick={() => add(false)} disabled={global.profiles.length >= 64}><Plus size={14} />{tr('新增角色', 'New role')}</button>}
      </nav>{role && <div className="pr-editor">
        <div className="pr-role-heading"><strong>{role.name}</strong>{scope === 'global' && <div><button type="button" title={tr('复制角色', 'Duplicate role')} aria-label={tr('复制角色', 'Duplicate role')} onClick={() => add(true)}><Copy size={14} /></button>{Object.hasOwn(ROLE_TEMPLATES, role.id) ? <button type="button" title={tr('恢复角色默认', 'Restore default role')} aria-label={tr('恢复角色默认', 'Restore default role')} onClick={() => patchRole(defaultRole(role.id))}><RotateCcw size={14} /></button> : <button type="button" title={tr('删除角色', 'Delete role')} aria-label={tr('删除角色', 'Delete role')} onClick={() => { setGlobal(value => ({ ...value, profiles: value.profiles.filter(item => item.id !== role.id) })); setSelected('explore'); }}><Trash2 size={14} /></button>}</div>}</div>
        {scope === 'global' && <>
          <label className="pr-check"><input type="checkbox" checked={role.enabled} onChange={event => patchRole({ enabled: event.target.checked })} />{tr('启用角色', 'Enable role')}</label>
          <label className="pr-field"><span>{tr('名称', 'Name')}</span><input value={role.name} maxLength={80} onChange={event => patchRole({ name: event.target.value })} /></label>
          <label className="pr-field"><span>{tr('职责', 'Responsibility')}</span><textarea rows={2} value={role.description} maxLength={2000} onChange={event => patchRole({ description: event.target.value })} /></label>
          <label className="pr-field"><span>{tr('执行模板', 'Execution template')}</span><select value={role.template} disabled={Object.hasOwn(ROLE_TEMPLATES, role.id)} onChange={event => patchRole({ template: event.target.value, tools: null })}>{Object.entries(ROLE_TEMPLATES).map(([id, item]) => <option key={id} value={id}>{item.name}</option>)}</select></label>
          <label className="pr-field"><span>{tr('角色指令', 'Role instructions')}</span><textarea rows={4} value={role.instructions} maxLength={16000} onChange={event => patchRole({ instructions: event.target.value })} /></label>
        </>}
        <label className="pr-field"><span>{tr('模型', 'Model')}</span><select value={role.model} onChange={event => patchRole({ model: event.target.value })}><option value="inherit">{tr('继承主 Agent', 'Inherit Main')}</option>{role.model !== 'inherit' && !providers.some(p => p.models?.some(m => JSON.stringify([p.id, m.id]) === role.model)) && <option value={role.model}>{tr('已配置模型当前不可用', 'Configured model unavailable')}</option>}{providers.flatMap(provider => (provider.models || []).map(model => <option key={`${provider.id}/${model.id}`} value={JSON.stringify([provider.id, model.id])}>{provider.name} · {model.name || model.id}</option>))}</select></label>
        <label className="pr-field"><span>{tr('思考强度', 'Reasoning')}</span><select value={role.thinking} onChange={event => patchRole({ thinking: event.target.value })}>{[['default', tr('角色默认', 'Role default')], ['inherit', tr('继承主 Agent', 'Inherit Main')], ['off', tr('关闭', 'Off')], ...['low', 'medium', 'high', 'xhigh', 'max'].map(value => [value, value.toUpperCase()])].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><small>{tr('不支持的档位会在调用前报错，不静默切换。', 'Unsupported settings are rejected before inference.')}</small></label>
        <div className="pr-limits">
          {numeric(tr('最大轮次', 'Rounds'), role.maxRounds, 2, 20, maxRounds => patchRole({ maxRounds }))}
          {numeric(tr('请求上限（含重试）', 'Requests incl. retries'), role.maxRequests, 1, 200, maxRequests => patchRole({ maxRequests }))}
          {numeric(tr('角色并发', 'Role concurrency'), role.concurrency, 1, 6, concurrency => patchRole({ concurrency }))}
          {numeric(tr('Token 预算', 'Token budget'), role.maxTokens, 1024, 100000000, maxTokens => patchRole({ maxTokens }), true)}
          {numeric(tr('执行时间上限（秒）', 'Execution limit (seconds)'), role.maxSeconds, 10, 86400, maxSeconds => patchRole({ maxSeconds }), true)}
        </div>
        {scope === 'global' && <details className="pr-capabilities"><summary>{tr('能力组合', 'Capabilities')} · Skills {role.skills.length} · MCP {role.mcpTools.length}</summary>
          <fieldset><legend>{tr('内置工具 / 验证工具', 'Native / verification tools')}</legend>{NATIVE_ROLE_TOOLS[role.template].map(name => <label className="pr-check" key={name}><input type="checkbox" checked={!role.tools || role.tools.includes(name)} onChange={event => patchRole({ tools: event.target.checked ? [...(role.tools || NATIVE_ROLE_TOOLS[role.template]), name] : (role.tools || NATIVE_ROLE_TOOLS[role.template]).filter(item => item !== name) })} />{name}</label>)}<small>{tr('取消勾选可进一步收窄；父任务权限、文件范围和审批仍是上限。', 'Uncheck to narrow access; parent permissions, scopes and approvals still apply.')}</small></fieldset>
          <fieldset><legend>Skills</legend>{skills.length ? skills.map(skill => <label className="pr-check" key={skill.name}><input type="checkbox" checked={role.skills.includes(skill.name)} onChange={event => patchRole({ skills: event.target.checked ? [...role.skills, skill.name] : role.skills.filter(name => name !== skill.name) })} />{skill.title || skill.name}</label>) : <p>{tr('当前没有可用 Skills，请先在扩展中配置。', 'Configure Skills in Extensions first.')}</p>}{role.skills.filter(name => !skills.some(skill => skill.name === name)).map(name => <label className="pr-check" key={name}><input type="checkbox" checked onChange={() => patchRole({ skills: role.skills.filter(item => item !== name) })} />{name} · {tr('当前不可用', 'Unavailable')}</label>)}</fieldset>
          {!!mcpTools.length && <fieldset><legend>{tr('已发现的 MCP 工具', 'Discovered MCP tools')}</legend>{mcpTools.map(tool => <label className="pr-check" key={tool.name}><input type="checkbox" checked={role.mcpTools.includes(tool.name)} onChange={event => patchRole({ mcpTools: event.target.checked ? [...role.mcpTools, tool.name] : role.mcpTools.filter(name => name !== tool.name) })} />{tool.metadata?.serverName || tool.serverId} · {tool.title || tool.name}</label>)}</fieldset>}
          <label className="pr-field"><span>{tr('MCP 工具名（每行一个）', 'MCP tool names (one per line)')}</span><textarea rows={3} value={role.mcpTools.join('\n')} onChange={event => patchRole({ mcpTools: event.target.value.split('\n') })} /><small>{tr('只调用父任务已连接的指定工具；仅验证角色、完整工作区范围可用，调用仍需批准。Builder 不开放 MCP。', 'Only explicitly selected, connected parent tools. Verification roles with whole-workspace scope only; approval required. No MCP for Builders.')}</small></label>
          <label className="pr-field"><span>{tr('项目知识', 'Project knowledge')}</span><select value={role.knowledge} onChange={event => patchRole({ knowledge: event.target.value })}><option value="off">{tr('关闭', 'Off')}</option><option value="read">{tr('只读', 'Read')}</option><option value="write">{tr('读写（受父任务限制）', 'Read/write within parent permissions')}</option></select><small>{tr('仅访问父任务已开启并绑定的项目；不会替任务开启知识。', 'Uses only the enabled, bound parent project; does not enable knowledge.')}</small></label>
        </details>}
      </div>}</div>
      <footer className="pr-footer"><span role="status">{notice || tr('设置只影响后续运行。费用无可靠计价时显示未知。', 'Applies to future runs. Unknown prices remain unknown.')}</span><button type="button" disabled={busy} onClick={() => void save()}>{busy ? tr('保存中…', 'Saving…') : tr('保存', 'Save')}</button></footer>
    </>}
  </section>;
}

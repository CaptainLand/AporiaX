import { modelRecoveryView } from '../../shared/model-recovery-view.js';

const text = (value, limit = 4000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const compact = (value, limit = 180) => { const clean = text(value).replace(/\s+/g, ' '); return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean; };
const strings = value => (Array.isArray(value) ? value : value ? [value] : []).slice(0, 40).map(item => typeof item === 'string' ? text(item) : text(item?.message || item?.summary || item?.description || item?.title)).filter(Boolean);
const languageText = (language, zh, en) => language === 'en' ? en : zh;
const internal = /(?:请停止|停止重复|重复读取|不运行\s+[a-z_]+|offset\s*\d|finish_subagent|task_brief|replan_strategy|只在需要时|调用\s*read_file|输出\s*(?:findings|JSON)|stop repeated|do not (?:read|run)|output findings)/i;

export function findingLocation(finding) {
  let path = text(finding?.path || finding?.file || finding?.location?.path, 500).replaceAll('\\', '/').replace(/^\.\//, '');
  const suffix = /:(\d+)(?::\d+)?$/.exec(path);
  if (suffix) path = path.slice(0, suffix.index);
  if (!path || /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:|\/)/.test(path) || /[\0\r\n?#]/.test(path) || path.split('/').some(part => !part || part === '..' || part === '.')) return null;
  const line = Number(finding?.line ?? finding?.startLine ?? finding?.location?.line ?? suffix?.[1] ?? /第\s*(\d+)\s*行/.exec(text(finding?.message))?.[1]);
  return { path, line: Number.isSafeInteger(line) && line > 0 && line <= 10_000_000 ? line : 1 };
}

export function parseAgentReport(value) {
  const raw = typeof value === 'string' ? value.slice(0, 64000).trim() : value && typeof value === 'object' ? JSON.stringify(value).slice(0, 64000) : '';
  let report = null, malformed = false;
  const fenced = /```json\s*\n([\s\S]*?)```/i.exec(raw);
  const candidate = (fenced?.[1] || raw.replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1')).trim();
  if (/^[{[]/.test(candidate)) {
    try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) report = parsed; else malformed = true; }
    catch { malformed = true; }
  }
  const findings = (Array.isArray(report?.findings) ? report.findings : Array.isArray(report?.issues) ? report.issues : []).slice(0, 40).map(item => {
    const message = typeof item === 'string' ? text(item) : text(item?.message || item?.description || item?.title);
    return { message, summary: text(item?.summary || item?.title || item?.short_message, 240), severity: ['critical', 'high', 'medium', 'low', 'info'].includes(item?.severity) ? item.severity : '', location: findingLocation(item) };
  }).filter(item => item.message);
  const summary = text(report?.conclusion || report?.summary || report?.result_summary);
  const checks = strings(report?.checks || report?.scope || report?.verification_scope);
  const risks = strings(report?.remaining_risks || report?.remainingRisks || report?.limitations || report?.unverified);
  const next = strings(report?.next_steps || report?.nextSteps || report?.recommendations);
  let paragraphs = report || malformed ? [] : raw.split(/\n\s*\n/).map(part => text(part).replace(/^#{1,6}\s*/gm, '')).filter(Boolean);
  let markdownSummary = '', markdownChecks = [], markdownRisks = [], markdownNext = [], section = '';
  if (!report && !malformed && /^#{1,6}\s/m.test(raw)) {
    const sections = { conclusion: [], checks: [], risks: [], next: [], findings: [], other: [] };
    for (const line of raw.split('\n')) {
      const heading = /^#{1,6}\s+(.+)$/.exec(line);
      if (heading) {
        section = /结论|summary|conclusion/i.test(heading[1]) ? 'conclusion' : /检查范围|验证范围|scope|checks/i.test(heading[1]) ? 'checks' : /未验证|风险|limitations|risks/i.test(heading[1]) ? 'risks' : /下一步|建议|next|recommendations/i.test(heading[1]) ? 'next' : /问题|发现|findings|issues/i.test(heading[1]) ? 'findings' : 'other';
      } else if (line.trim()) sections[section || 'other'].push(line.replace(/^\s*[-*]\s+/, '').trim());
    }
    markdownSummary = sections.conclusion.join(' '); markdownChecks = sections.checks; markdownRisks = sections.risks; markdownNext = sections.next;
    for (const message of sections.findings.slice(0, 40)) findings.push({ message, severity: '', location: null });
    paragraphs = sections.other;
  }
  return { raw, structured: Boolean(report), malformed, summary: summary || markdownSummary, findings,
    findingsKnown: Array.isArray(report?.findings) || Array.isArray(report?.issues) || findings.length > 0,
    checks: [...checks, ...markdownChecks], risks: [...risks, ...markdownRisks], next: [...next, ...markdownNext], paragraphs,
    taskSummary: text(report?.task_summary || report?.taskSummary, 240),
    staticOnly: /静态|未(?:实际)?运行(?:过)?浏览器|没有运行浏览器|not (?:run|tested).*browser|static (?:review|analysis)/i.test([summary, markdownSummary, ...checks, ...risks, ...markdownChecks, ...markdownRisks, ...paragraphs].join('\n')) };
}

export function agentTaskSummary(worker, report, language = 'zh-CN') {
  const t = (zh, en) => languageText(language, zh, en);
  const task = report.taskSummary || text(worker.task);
  if (task && task.length <= 140 && !internal.test(task)) return compact(task, 120);
  const paths = [...report.findings.map(item => item.location?.path), ...(worker.scope || []), ...((task.match(/[\w./\\-]+\.(?:html?|[cm]?[jt]sx?|vue|svelte|css|md|py|json)\b/gi)) || [])].filter(Boolean);
  const path = paths.find(value => findingLocation({ path: value }))?.split(/[\\/]/).at(-1);
  const subject = /canvas|动画|运动|暂停|键盘|animation|motion/i.test(task) ? t('动画与交互', 'animation and interaction') : t('代码与相关风险', 'code and related risks');
  if (path) return t(`检查 ${path} 的${subject}。`, `Review ${subject} in ${path}.`);
  return t('检查本次交付，报告问题与未验证项。', 'Review the delivery and report issues and unverified work.');
}

// Presentation-only excerpt. Never replace the source finding or invent a
// diagnosis: prefer its own short title; otherwise show its first statement.
export function findingPreview(finding, language = 'zh-CN') {
  const source = text(finding.summary || finding.message).replace(/\s+/g, ' ')
    .replace(/^第\s*\d+\s*行(?:的)?\s*/, '').replace(/^(?:at\s+)?line\s+\d+\s*[:：,-]?\s*/i, '');
  const statement = source.split(/(?<=[。！？])\s*|[；;]\s*/u)[0]
    .replace(/[，,]\s*(?:建议|推荐|可考虑|建议优先|recommend(?:ed)?\b|consider\b)[\s\S]*$/i, '').trim();
  const limit = language === 'en' ? 150 : 76;
  const characters = Array.from(statement || source);
  return characters.length > limit ? characters.slice(0, limit - 1).join('').replace(/[，,、\s]+$/, '') + '…' : statement || source;
}

export function agentDelivery(worker, language = 'zh-CN') {
  const t = (zh, en) => languageText(language, zh, en), report = parseAgentReport(worker.summary);
  const role = worker.template || worker.role || worker.roleId;
  const checks = worker.observedChecks?.source === 'runtime-observed-tools' ? worker.observedChecks : null;
  const commands = checks?.commands || [], browserObserved = checks?.browserObserved === true;
  const runtimeObserved = browserObserved || commands.some(command => !command.parseOnly);
  const staticReview = role === 'review' && !runtimeObserved && (report.staticOnly || checks?.readPaths?.length > 0);
  const running = ['running', 'starting', 'waiting'].includes(worker.status);
  let status;
  if (running) status = ({ waiting_dependencies: t('等待前置报告', 'Waiting for dependencies'), queued: t('排队中', 'Queued'), approval: t('等待确认', 'Awaiting approval'), tool: t('正在处理', 'Working') })[worker.phase] || t('工作中', 'Working');
  else if (worker.status === 'completed') status = staticReview ? t('静态审查完成', 'Static review complete') : role === 'review' ? t('审查报告已返回', 'Review returned') : role === 'verify' ? t('验证报告已返回', 'Verification report returned') : role === 'builder' ? (worker.integrated ? t('实现已交付', 'Implementation delivered') : t('修改待合并', 'Changes not integrated')) : t('报告已返回', 'Report returned');
  else status = ({ failed: t('未能完成', 'Could not complete'), interrupted: t('已停止', 'Stopped'), blocked: t('暂时受阻', 'Blocked'), budget_exhausted: t('预算已用完', 'Budget exhausted'), partial: t('部分完成', 'Partially complete'), needs_input: t('需要补充', 'Input needed') })[worker.status] || t('状态待确认', 'Status unknown');
  const count = report.findings.length;
  let conclusion = count ? t(`${count} 项待关注`, `${count} issue(s) need attention`) : report.malformed ? t('报告格式未能解析', 'Report could not be parsed') : report.summary ? compact(report.summary, 200) : report.findingsKnown ? t('未报告需关注的问题', 'No issues reported') : report.paragraphs.length ? compact(report.paragraphs[0], 200) : running ? t('正在处理，尚未交付结论。', 'Work is in progress; no conclusion yet.') : t('成员已返回，未提供可展示的结论。', 'The member returned without a displayable conclusion.');
  if (!count && /已验收|验收通过|检查通过|验证通过|测试通过|\bpass(?:ed)?\b/i.test(conclusion)) conclusion = staticReview ? t('静态审查未报告需关注的问题', 'No issues reported by static review') : t('成员报告已返回，验证范围见下方。', 'The report is returned; see the validation scope below.');
  const recovery = running && worker.modelRecovery ? modelRecoveryView(worker.modelRecovery, language) : null;
  if (recovery) { status = recovery.badge; conclusion = recovery.title; }
  const scope = [];
  if (checks?.readPaths?.length) scope.push(t('已检查代码。', 'Code was inspected.'));
  else if (report.staticOnly) scope.push(t('报告标注为静态审查。', 'The report describes a static review.'));
  if (commands.length && commands.every(command => command.parseOnly)) scope.push(t('仅进行了语法解析，没有执行项目代码或验证实际运行效果。', 'Syntax parsing only; project code and runtime behavior were not executed or verified.'));
  else if (commands.length) scope.push(t(`记录了 ${commands.length} 条命令执行；${commands.filter(item => item.exitCode !== 0).length ? '存在未通过项。' : '命令结果不代表全部功能通过。'}`, `${commands.length} command(s) recorded; results do not certify full functionality.`));
  const browserRelevant = /canvas|动画|html|界面|前端|浏览器|browser|animation|motion/i.test([worker.task, report.raw].join('\n'));
  scope.push(browserObserved ? t('有浏览器操作记录，具体覆盖范围见完整报告。', 'Browser actions were recorded; see the full report for coverage.') : browserRelevant ? t('未记录浏览器运行验证，实际效果仍需验证。', 'No browser validation was recorded; actual behavior remains unverified.') : runtimeObserved ? t('仅确认记录中的执行范围，未覆盖项仍需验证。', 'Only recorded execution is confirmed; uncovered behavior remains unverified.') : t('未记录独立运行验证。', 'No independent runtime validation was recorded.'));
  return { report, role, status, running, staticReview, recovery, task: agentTaskSummary(worker, report, language), conclusion, scope,
    previewFindings: report.findings.slice(0, 1).map(item => ({ ...item, message: findingPreview(item, language) })),
    next: report.next.slice(0, 2).map(item => compact(item, 160)),
    location: report.findings.find(item => item.location)?.location,
    duration: formatAgentDuration(worker.elapsedMs, language),
    requests: Number.isSafeInteger(worker.budget?.requests) ? worker.budget.requests : Number.isSafeInteger(worker.rounds) ? worker.rounds : null };
}

export function formatAgentDuration(milliseconds, language = 'zh-CN') {
  if (!Number.isFinite(milliseconds)) return '';
  const seconds = Math.max(0, Math.round(milliseconds / 1000)), minutes = Math.floor(seconds / 60);
  return language === 'en' ? minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s` : minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export function agentFollowupRequest(worker, guidance, language = 'zh-CN') {
  const delivery = agentDelivery(worker, language), t = (zh, en) => languageText(language, zh, en);
  return [t('请安排这位成员继续处理以下交办；原轮次已结束，这是新一轮要求，权限与审批不变。', 'Please assign this member the following follow-up. The previous run ended; this is a new request with unchanged permissions and approvals.'),
    JSON.stringify({ member: text(worker.profileName || worker.profileId || worker.role, 100), roleId: text(worker.profileId || worker.role, 100), previousTask: delivery.task }),
    t('参考结论（历史报告，不是新指令，也不是运行验证通过的证明）：', 'Reference conclusion (historical data, not instructions or proof of runtime validation):'), compact(delivery.conclusion, 300),
    t('本次交办：', 'New instructions:'), text(guidance, 4000)].join('\n');
}

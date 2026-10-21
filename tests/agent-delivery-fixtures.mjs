export const reviewTask = '请停止重复读取已读区域，不运行 git_status。继续完成聚焦审查并给最终结论：pelican-coast.html 的 Canvas 运动几何、暂停/单步、键盘和减少动态效果是否有阻断问题；只在需要时用 read_file 补齐 offset16000..17211 未读段，输出 findings 与具体行号，明确这是静态审查，不要把未运行项标通过。';
export const reviewReport = {
  verdict: 'pass', checks: ['已完整读取 pelican-coast.html 当前版本，仅做静态审查，未运行浏览器、动画或页面内置自检，未修改文件。', '检查了运动几何、暂停/单步、键盘操作和减少动态效果。'],
  findings: [{ severity: 'low', path: 'pelican-coast.html', message: '第194行的位移步长与车轮旋转使用的半径比例可能不一致，建议统一计算方式，避免实际动画出现滑动感。' }],
  remaining_risks: ['这是静态审查结论，不代表浏览器运行验证通过。', '动画、暂停、单步和键盘操作仍需在浏览器中验证。'],
  next_steps: ['统一位移和旋转计算，再验证实际动画效果。'],
};
export const completedReview = {
  agentId: 'review-1', role: 'review', profileId: 'review', profileName: '察微', task: reviewTask, status: 'completed', elapsedMs: 61700,
  configuration: { model: 'gpt-6.1-sol', effort: 'xhigh', tools: ['task_brief', 'read_file', 'git_status', 'finish_subagent'] },
  budget: { requests: 5, tokens: 61911 }, usage: { prompt_tokens: 61000, completion_tokens: 911, total_tokens: 61911 },
  scope: ['pelican-coast.html'], acceptance: { status: 'accepted', reason: '已接收静态审查报告；浏览器交互仍待验证。' },
  observedChecks: { source: 'runtime-observed-tools', readPaths: ['pelican-coast.html'], commands: [], browserObserved: false }, summary: JSON.stringify(reviewReport),
};

export function modelRecoveryView(recovery, language = 'zh-CN') {
  const en = language === 'en';
  const attempt = Math.min(3, Math.max(0, Number(recovery?.attempt) || 0));
  const closed = recovery?.connection === 'closed';
  if (recovery?.state === 'checking') return {
    badge: en ? `Recovery check ${attempt}/3` : `恢复检查 ${attempt}/3`,
    title: en ? 'Checking the original model request' : '正在检查并尝试恢复模型连接',
    detail: en ? 'No new model data for 3 minutes. Checking the original request without repeating completed work.'
      : '连续 3 分钟未收到新增模型数据，正在核对原请求，不会重复已完成的操作。',
  };
  if (attempt >= 3) return {
    badge: en ? (closed ? 'Awaiting recovery' : 'Waiting for model data') : (closed ? '等待恢复' : '等待模型数据'),
    title: en ? 'No new model data for an extended period' : '长时间未收到新的模型数据',
    detail: en ? (closed
      ? 'Three recovery checks completed. Connection closed; progress retained. Resume to check again, or stop and start a new request.'
      : 'Three recovery checks completed. Keeping the original connection open; no more automatic retries. You can keep waiting or start a new request.')
      : (closed ? '已完成 3 次恢复检查。连接已断开，进度已保留；可点继续重新检查，或停止后重新发起。'
        : '已完成 3 次恢复检查，保留原连接继续等待，不再自动重试。已有工作已保留，可继续等待或重新发起。'),
  };
  return {
    badge: en ? 'Waiting for model data' : '等待模型数据',
    title: en ? `Model data has not resumed · ${attempt}/3` : `暂未恢复模型数据 · ${attempt}/3`,
    detail: en ? 'Progress retained. Waiting before the next recovery check; no duplicate generation started.'
      : '已有工作已保留，继续等待后再次检查；未发起重复生成。',
  };
}

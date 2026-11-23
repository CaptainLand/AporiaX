export function approvalSimilarityText(scope, language = 'zh-CN') {
  const en = String(language).toLowerCase().startsWith('en');
  if (scope?.kind === 'delete-file' && scope.extension && scope.directory) {
    const directory = scope.directory === '.' ? (en ? 'the workspace root' : '工作区根目录') : scope.directory;
    return en
      ? `For this run: delete ${scope.extension} text files directly in ${directory} (not subfolders).`
      : `仅本轮：允许删除${directory}下的 ${scope.extension} 文本文件（不含子目录）。`;
  }
  if (scope?.kind === 'browser-control') return en ? 'For this run: browser clicks, form fills and key presses. This does not grant uploads.' : '仅本轮：允许浏览器点击、填表和按键，不包含文件上传。';
  if (scope?.kind === 'project-script') return en ? 'For this run: project scripts with the same trusted project configuration.' : '仅本轮：允许同项目的脚本；脚本、锁文件或相关配置变化后会再问。';
  return '';
}

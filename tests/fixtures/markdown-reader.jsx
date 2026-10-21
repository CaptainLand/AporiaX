import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { MarkdownPreview } from '../../src/workbench/MarkdownPreview.jsx';
import '../../src/styles.css';

localStorage.setItem('aporiax.language.v1', 'zh-CN');
const fence = '`'.repeat(3);
const content = [
  '# 工作区使用说明', '',
  '> 阅读、编辑和预览，在同一个工作区里衔接。', '',
  '这是一份轻量的项目说明。先看清楚需要的内容，再选择下一步；文件保存在工作区中，不会因为切换阅读模式而改变。', '',
  '---', '', '## 一、从这里开始', '',
  '| 模块 | 说明 |', '| --- | --- |',
  '| 阅读视图 | 展示标题、列表、表格和代码 |',
  '| 源码视图 | 查看 Markdown 原文 |',
  '| 编辑视图 | 修改文件，保留当前草稿 |', '',
  '在 `README.md` 中补充项目说明。需要时可以查看[使用说明](#二日常操作)，或打开[另一份文档](other.md)。', '',
  '## 二、日常操作', '',
  '- 先确认目标文件，避免覆盖原来的内容。',
  '- 条目换行时，文字应继续对齐文本起点，而不是挤到圆点下面，让窄侧栏也能读得清楚。',
  '  - 子条目保留清晰的缩进。',
  '- [x] 保留 Markdown 结构', '- [ ] 按需补充项目内容', '',
  '### 一段代码', '', fence + 'js', '// 示例代码，不会在阅读视图执行', 'const message = "Hello, AporiaX";', 'console.log(message);', fence, '',
  '#### 文件组织', '', '相关资料放在同一目录，链接使用相对路径。', '',
  '##### 补充说明', '', '标题保留层级，不需要额外的背景或装饰线。', '',
  '###### 最后检查', '', '确认内容后再保存即可。', '',
  '---', '', '## 长表格', '',
  '| 路径 | 文件类型 | 模式 | 说明 | 记录 | 状态 |', '| --- | --- | --- | --- | --- | --- |',
  '| docs/a-long-file-name.md | Markdown | 阅读 | 较宽表格在内部横向滚动 | 当前版本 | 保留 |', '',
  fence + 'txt', 'a_very_long_code_line_'.repeat(30), fence, '',
  '<script>window.MARKDOWN_SCRIPT_RAN = true</script>',
].join('\n');
const workbench = { key: 'reader-style', openHref: async href => { window.readerOpenedHref = href; return true; } };
createRoot(document.getElementById('root')).render(<I18nProvider>
  <style>{'html,body,#root{margin:0;height:100%}.reader-fixture{display:flex;flex-direction:column;width:min(100%,560px);height:100%;margin:0 auto;background:var(--bg-app)}.reader-fixture>header{flex:none;padding:12px 24px;border-bottom:1px solid var(--gray-6);color:var(--text-2);font:13px var(--font-sans)}'}</style>
  <main className="reader-fixture"><header>AporiaX　/　README.md</header><MarkdownPreview content={content} path="docs/README.md" workbench={workbench} onError={error => { window.readerError = String(error); }} /></main>
</I18nProvider>);

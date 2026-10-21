import React from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '../../src/i18n.jsx';
import { Conversation } from '../../src/conversation/ConversationViews.jsx';
import '../../src/styles.css';

localStorage.setItem('aporiax.language.v1', 'zh-CN');
document.documentElement.dataset.theme = 'light';
const content = `已完成代码检查，发现两处需要关注的问题。当前尚未进行浏览器运行验证。

这是第二段正文，文件名和函数名保留原样，例如 \`calculator-pro.html\` 和 \`isFinite\`。

# 检查结果

## 已确认的问题

- **异常值保护不足**：积分运算在部分输入下可能无法结束，需要补上边界检查。这是一条较长的说明，用于检查列表自动换行后是否与文字起点对齐，而不是退回项目符号的位置。
- **结果回填格式不兼容**：科学计数法和无穷值需要在再次计算前统一处理。
  - 嵌套条目也沿用相同的缩进规则。

### 验证范围

已检查代码；实际运行效果仍需验证。

#### 后续处理

1. 补充输入边界检查。
2. 验证异常输入和结果回填。

##### 补充信息

保留完整内容，不改变模型输出。

###### 参考

这是分隔前的普通段落。

| 检查项 | 状态 |
| --- | --- |
| 浏览器运行 | 未执行 |

\`\`\`js
const result = Number.isFinite(value);
\`\`\`
`;
const task = { id: 'typography', workspacePath: 'D:/Fixture', messages: [
  { id: 'user', role: 'user', content: '请检查计算器的异常输入处理。' },
  { id: 'answer', role: 'assistant', status: 'completed', content, progressUpdates: [
    { id: 'progress', kind: 'progress', title: '阶段进展', content: '正在检查工作区中的 `scope`。\n\n### 当前发现\n\n- 需要补充异常输入检查。\n- 正在核对结果回填逻辑。' },
  ] },
] };
createRoot(document.getElementById('root')).render(<I18nProvider>
  <main style={{ height: '100%', overflow: 'auto', padding: '28px 24px' }}>
    <div style={{ maxWidth: 820, margin: '0 auto' }}>
      <Conversation task={task} isRunning={false} />
    </div>
  </main>
</I18nProvider>);

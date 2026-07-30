# Contributing to AporiaX

感谢你愿意改进 AporiaX。项目目前处于早期开发阶段，欢迎提交聚焦、可验证的改动。

## 开始之前

1. 在 Issue 中描述问题、使用场景或设计提案。
2. Fork 仓库并从 `main` 创建功能分支。
3. 不要提交 API Key、用户任务数据、构建产物或本机路径。

## 本地开发

需要 Node.js 20 或更高版本。

```powershell
npm install
npm run dev
```

## 提交前验证

```powershell
npm run test:runtime
npm run test:p0
npm run build
```

涉及 Electron IPC、文件写入、命令执行或凭据存储的改动，请在 Pull Request 中说明：

- 新增了哪些权限或数据边界；
- 哪些输入在主进程中校验；
- 是否存在不可回退的操作；
- 使用了哪些测试验证行为。

## Pull Request

- 一次 PR 只解决一个清晰问题。
- 保留现有中文界面文案风格与 AporiaX 视觉语言。
- 修复应包含回归测试；新工具应包含参数校验、权限策略和失败路径。
- 不要把 `release/`、`dist/` 或 `node_modules/` 提交到仓库。

提交代码即表示你同意以项目的 MIT License 发布你的贡献。

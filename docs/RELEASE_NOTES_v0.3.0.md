# AporiaX v0.3.0 — Bilingual Preview

## 中文

这一版把中英双语做成了应用级语言系统，而不是只替换开屏文案。

- 开屏右下角新增中文 / English 切换，选择会持久保存。
- 任务设置中可以随时切换界面语言。
- Dialogue、Route、Workspace、任务创建、Provider 管理、审核、自检和审批界面均跟随语言。
- 新发起的 Harness 请求会明确要求模型使用当前界面语言回复。
- 已有消息、文件内容、代码、路径和 API 标识不会被自动翻译。
- GitHub 提供完整的中文与英文 README。

## English

This release turns Chinese and English into an application-wide language
system instead of translating only the welcome copy.

- A persistent Chinese / English switch now appears at the bottom-right of the welcome screen.
- Interface language can be changed at any time from Task settings.
- Dialogue, Route, Workspace, task creation, provider management, review, self-check, and approval surfaces follow the selected language.
- New Harness requests explicitly ask the model to reply in the active interface language.
- Existing messages, file contents, code, paths, and API identifiers are never translated automatically.
- GitHub now includes complete Chinese and English READMEs.

## Verification

- `npm run test:runtime`
- `npm run test:p0`
- `npm run build`
- Windows x64 installer and portable packaging

## SHA-256

```text
2E6A5C4C2F490FB4302A66B83E04C79AA2AEF2C52948781E998FF5F13076D3E3  AporiaX-Setup-0.3.0-x64.exe
B4409CDBE85CD6940B43082F454E2226279C10C1AFD63150B0B5027AA3C11839  AporiaX-Portable-0.3.0-x64.exe
```

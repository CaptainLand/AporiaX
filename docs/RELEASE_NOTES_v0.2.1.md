# AporiaX v0.2.1 — Preview

AporiaX 的第一个可下载预览版本。

## 亮点

- Dialogue、Route、Workspace 三种任务视图
- 本地文件树、搜索、代码预览与 `Ctrl+S` 编辑
- 多个 OpenAI-compatible Provider、多 API Key 与多模型选择
- `/models` 自动发现，也支持手动填写模型 ID
- Word、PowerPoint、Excel 真实文件生成与结构复核
- PDF、Office、Markdown、代码与图片附件
- 文件 Diff、检查点、撤销与强制自检
- Docker OS 级命令沙箱
- Docker 不可用时的本机审批模式

## 命令执行边界

Docker 沙箱可用时，命令默认断网，根文件系统只读，仅当前工作区可写，并受到 CPU、
内存和进程数限制。

Docker 不可用时，每条命令都会强制请求批准，然后以当前用户权限在本机运行。该模式
可以访问网络且不具备 OS 级隔离，但会移除常见 API Key、Token、Cookie、Password
等敏感环境变量。

## 当前限制

- 当前仅提供 Windows x64 构建
- 处于 Preview 阶段，建议先在非关键工作区试用
- 原生支持 OpenAI-compatible Chat Completions；其他协议需要兼容网关
- 扫描 PDF 能识别为需要 OCR，但尚未内置 OCR 引擎
- Office 文件已进行结构检查，最终字体、分页和渲染效果仍建议在对应应用中确认

## 校验

- `npm run test:runtime`
- `npm run test:p0`
- `npm run build`
- Windows 安装版和便携版构建通过

### SHA-256

```text
160B3473A2E57ACA5E22A752EFBDFD01822C65774531EA12C11727EFBB8D3CCE  AporiaX-Setup-0.2.1-x64.exe
8D28FC9CE7D08C66B0EACBB8CC27732FECAAA2D5249C837B3F8E4D1BD2C2AE66  AporiaX-Portable-0.2.1-x64.exe
```

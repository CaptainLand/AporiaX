# 教程维护与 Aporia Web 接入

## 内容源与发布位置

- 权威内容源：桌面仓库 `docs/USER_GUIDE.zh-CN.md`。
- 网页样式：`docs/guide/site.css`；生成器：`scripts/build-user-guide.mjs`。
- 公开位置：`https://captainland.github.io/AporiaX_web/guide/`。
- API 章节固定链接：`https://captainland.github.io/AporiaX_web/guide/#api-key`。
- Aporia Web 仓库的 `public/guide/` 保存生成后的静态快照，现有 Vite 构建和 Pages 工作流原样发布。
- 网页首页导航、页脚，桌面模型配置/选择区和设置「关于」共用该入口。现有安装包不会因网页上线自动新增按钮，桌面按钮需要后续客户端构建。

## 更新步骤

1. 先根据当前实现修改 Markdown，避免把开发计划写成已支持功能。
2. 在桌面仓库运行：

```powershell
node scripts/build-user-guide.mjs
```

默认产物在 `output/user-guide/`。也可将第二个参数指定为 Aporia Web 检出的 `public/guide` 目录，例如：

```powershell
node scripts/build-user-guide.mjs .tmp/aporiax-web-guide/public/guide
```

3. 检查两份仓库的 diff，只提交本次教程相关文件。不要上传整个桌面 `docs`、`.tmp` 或输出目录。
4. 在 Aporia Web 使用 `VITE_BASE_PATH=/AporiaX_web/` 构建，测试首页入口、章节锚点、配图和 Markdown 下载。发布到其 `main` 后，由已有 `deploy-pages` 工作流部署。
5. 验证公开 URL、刷新与图片状态码，再确认发布完成。桌面入口 URL 不随客户端版本更改。

## 技术边界

页面是独立静态 HTML，不经过网站账户 Router、AuthProvider 或模型 API；不新增登录要求、表单、第三方脚本、分析服务或鉴权配置。目录和下载不依赖 JavaScript。配图仅从生成器白名单复制，已在桌面项目 README 中公开。

此实现只增加教程内容与链接，沿用网站导航及桌面现有组件风格，不改账号、任务循环、安装包、模型配置与更新通道。使用 Segoe UI / Microsoft YaHei，灰白 `#f7f9fc`、正文 `#1c2833`、链接 `#246f91`；宽屏为目录加正文，窄屏为顶部目录加单栏正文，支持浏览器打印。

GitHub Pages 沿用 Aporia Web 既有默认 HTTPS 域名和工作流，不创建新的桌面项目站点，不改 CloudBase 站点。相关部署机制参见 [GitHub 官方文档](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## 首次发布与验证（2026-09-22）

- Aporia Web 已推送提交 `acea3f8302fd6b69d5778ffc8f1e16ba920750af`；[Pages 部署](https://github.com/CaptainLand/AporiaX_web/actions/runs/35674204597)与网站 CI 均成功。
- 公网教程 HTML、CSS、Markdown 下载和全部 6 个图片资源（含图标）返回 HTTP 200；真实浏览器打开 API 章节，无控制台错误。
- `node tests/user-guide-browser.mjs` 通过：首页/页脚入口、12 个锚点、深链接刷新、5 张正文图、文档下载、390px 布局；桌面生产构建的模型设置与关于入口、打开失败提示、草稿保留、URL 不携带配置数据。
- `ONBOARDING_PRODUCTION=1 node tests/model-onboarding-browser.mjs` 通过：原有匿名/登录/自有 API/侧聊新手流程未回归。测试采用替身，不调用真实模型。
- 桌面与网站 `npm run build` 通过。桌面仍有既有大 chunk 警告，未在教程任务中改造。
- 浏览器工具无可用 agent-browser，采用项目现有 Playwright + Edge 进行自动化，并使用浏览器截图复核宽屏、窄屏和公网页面。
- 只发布网站；桌面端源码和 `dist` 已更新，未重新打安装包、未改版本号、未发布新 Release，桌面源文件暂保留在本地工作区。

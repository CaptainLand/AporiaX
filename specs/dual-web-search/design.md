# OpenCode 式联网工具接入设计

2026-10-22。用户明确要求直接开始，按 spec-workflow 的直接实施分支推进，不重复设置阶段确认。本地实现，不发布。

## 职责与边界

- `web-tools.js`：两个内置工具的精简模型接口、只读风险与自主调度指引。
- `web-runtime.js`：复用现有 MCP SDK，按需连接 Exa 官方托管服务；结果归一化、脱敏错误、整次超时/取消、每轮缓存。搜索用当前实测参数 query/objective/numResults，而非照抄旧版 Exa schema。
- `web-fetch.js`：Node 内置 HTTP(S)/DNS 请求；htmlparser2 容错解析，不运行脚本。优先 main/article 正文，去掉导航、脚本和隐藏内容。每响应最多 1.5 MB，每轮最多缓存 8 页、每页提取最多 160000 字符，3 分钟过期。
- 普通网络直接读取；只有域名全部解析到 198.18/15 虚拟 IP 时，改走 Exa `web_fetch_exa` 提取。仍先拒绝私网字面 IP、内网域名、凭据 URL 和非标准端口，不把虚拟 IP 当公网放行。远端提取单独标记 provider_text，不声称本机执行或视觉验证。
- 不复制 OpenCode 代码，不安装它的程序；保留 AporiaX 既有工具生态和浏览器。

## 生态与权限

注册到 native-tool-catalog/executor、Harness capability/presentation、原生 dispatcher 与 durable read-only 分类。工具记录显示“联网搜索”“读取网页”和来源摘要。

管理分类归入既有 browser 来源，设置文案为“浏览器与联网”，共用既有 Extension Policy，不新增隐藏开关或绕过总开关。外部控制调用必须拥有既有 browser 网络授权。

主 Agent 和默认 Explore/Review/Verify 可在父权限和角色工具白名单内使用。Builder/Curator 不新增网络能力。网页工具无工作区路径，不把远端 URL 误判为本地文件；原有文件范围限制保持。网页提取不作为浏览器运行证据。

## 安全与限制

只发送搜索词/目标或公开 URL。服务端点固定，模型不能传入 provider URL、请求头或密钥。EXA_API_KEY 只在主机启动环境读取，仅传给固定 Exa 服务；工具结果及错误不回显密钥。

直接读取固定已校验 DNS 地址，逐跳校验重定向、最多 3 跳，不发送 Cookie/Authorization，不接收二进制，不进行 OS/网络权限提升。网页及搜索摘录标记 untrusted，模型应忽略其中的越权指令并引用真实链接。

匿名搜索/提取有上游限流及可达性限制。无盲目重试或跨提供商暗切；错误进入现有工具结果，Agent 可自主改查询或使用已授权浏览器。

## 验证与体积

离线模块与真实 Harness 对话测试，不消耗真实模型额度；再以公开通用查询验证真实搜索/提取。回归角色、外部授权、工具目录、执行记录和浏览器路径，并生产构建。

新增生产依赖 htmlparser2 及其 6 个依赖目录；复用既有 MCP SDK和 Node，不新增 Chromium、Python、SearXNG、OpenCode 或本地模型。统计新增目录与核心源代码字节，并做压缩样本；不把样本压缩大小冒充真实 NSIS 安装包差值。

参考：[OpenCode 工具](https://docs.opencode.ai/docs/tools/)、[Exa 官方 MCP](https://github.com/exa-labs/exa-mcp-server)、[htmlparser2](https://github.com/fb55/htmlparser2)。

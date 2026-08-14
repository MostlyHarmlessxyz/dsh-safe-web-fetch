# dsh-safe-web-fetch

`dsh-safe-web-fetch` 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 `web_fetch` 能力提供一个更稳妥的网络 provider。它接入 DSH 原有的 `ctx.web` 和 profile 机制，不另起一套搜索 API，也不改模型侧工具。

它做的事情很明确：域名必须先解析到公共地址，确认安全后才建立连接；每一跳请求都固定到已经检查过的 IP；重定向只允许留在同一个 origin；响应大小、耗时和并发量都有上限。

## 快速开始

包里带有 DSH bundle，所以一条命令就能安装并加入 profile：

```sh
dsh plugin --profile safe add dsh-safe-web-fetch@next
dsh --profile safe --dump-config
```

bundle 会注册 `safe-http` provider，打开 DSH 原有的 `web_fetch` 工具，搜索仍沿用基础 profile 的 provider。部署时建议固定已经测试过的版本：

```sh
dsh plugin --profile production add dsh-safe-web-fetch@0.1.0-next.0
```

也可以固定一个经过审核的 Git commit：

```sh
dsh plugin --profile safe add github:MostlyHarmlessxyz/dsh-safe-web-fetch#<commit-sha>
```

Git 安装会在本地构建。如果 pnpm 要求批准构建脚本，按 profile 输出的提示操作；如果希望直接使用预构建文件，安装 npm 包或 tarball 会更简单。

## 它会做什么

每次 fetch 都会：

- 只接受 HTTP、HTTPS，并拒绝 URL 中的用户名和密码；
- 支持 host allow/deny（默认是精确匹配；需要子域名时写 `*.example.com`）；
- 检查全部 DNS 答案，包括 IPv4-mapped IPv6 和各种特殊地址段；
- 通过隔离的 Undici dispatcher 连接，并固定到已经检查的地址；
- 每次同源重定向都重新检查，跨 origin 重定向直接拒绝；
- 限制响应字节数、解码字符数、重定向次数、并发请求数和总耗时；
- 只返回文本类响应（text、HTML、JSON、XML），格式与 DSH 原生结果一致。

插件不会自行添加 Cookie、Authorization、浏览器状态或请求体。公共 IP 也不等于可信内容：prompt injection、恶意文件和 HTML 清洗仍然需要由应用层处理。

## 配置

默认值刻意保持保守：

| 选项 | 默认值 | 最大值 |
| --- | ---: | ---: |
| `maxUrlLength` | `2048` | `16384` |
| `maxResponseBytes` | `5000000` | `100000000` |
| `maxBodyChars` | `100000` | `10000000` |
| `timeoutMs` | `30000` | Node 定时器上限 |
| `maxRedirects` | `5` | `20` |
| `maxConcurrentRequests` | `16` | `128` |

还可以配置 `allowHosts`、`denyHosts` 和 `userAgent`。DSH patch 命中一行时会整体替换 config，因此覆盖时请把需要保留的值一起写上：

```yaml
- id: safe-web-fetch
  name: dsh-safe-web-fetch
  config:
    maxUrlLength: 4096
    maxResponseBytes: 10000000
    maxBodyChars: 200000
    timeoutMs: 30000
    maxRedirects: 3
    maxConcurrentRequests: 8
    allowHosts:
      - '*.docs.example.com'
    denyHosts: []
    userAgent: my-company-fetch/1.0
```

如果不使用 bundle 而是手动挂载 function plugin，需要在 `web` 行设置 `fetchProvider: safe-http`。同时存在多个 provider 时请明确指定 id；否则 DSH 会返回 `WEB_PROVIDER_AMBIGUOUS`，不会替你猜一个。

## 安全边界

内置 resolver 会和请求 deadline 竞争，但第三方 resolver 在操作系统层面不一定能被立即停止。自定义 resolver 或 transport 是给测试和受信任集成使用的扩展点，不应拿来承载不受信任的网络客户端。

插件只跟随同源重定向并处理文本响应。它不是出口防火墙、内容扫描器、审批界面或代理策略。需要组织级零信任网络时，仍应在网络边界部署这些控制，并把本插件作为额外检查。

## 兼容性与开发

发布包的 peer 范围覆盖 DSH `0.1.0-rc.5` 到 `0.1.x`，以及 Cordis `4.x`。DSH 仍是 developer preview，请在实际 profile 使用的精确版本上测试。

需要 Node `^22.19.0` 或 `>=24.0.0`、pnpm 11：

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
npm pack --dry-run
```

测试包含地址段和异常 DNS、重定向复检、取消、响应上限、生命周期销毁，以及一个本地 HTTP server，用来确认 socket 连接到固定 IP 的同时仍保留原始 `Host` header。

发布说明和维护清单见 [RELEASE.md](RELEASE.md)。项目采用 MIT 许可证。

# dsh-safe-web-fetch

`dsh-safe-web-fetch` 是 DeepSeek Harness 的公共网络 HTTP(S) `WebFetchProvider`。它接入 DSH 已有的 `ctx.web` 能力，不重复实现模型侧的 `web_fetch` 工具。

这个插件默认采取 fail-closed 策略：建立 socket 前拒绝非全球可路由地址；把每一跳实际连接固定到已检查的 IP；只跟随同源重定向；限制超时、响应大小和并发数。

发布包的 peer 范围支持 DSH `0.1.0-rc.5` 到 `0.1.x`，以及 Cordis `4.x`。
请在目标部署环境中测试精确版本；DSH 仍是 developer preview，不同版本之间可能改变 seam。

## 安装到 DSH profile

包内带有 `dsh.bundle`，因此 CLI 会同时安装依赖并加入配置层：

```sh
dsh plugin --profile safe add dsh-safe-web-fetch@next
dsh --profile safe --dump-config
```

bundle 注册 `safe-http` provider，选择它作为 `web` seam 的 fetch provider，并打开已有的 `dsh-tool-web` fetch 能力。搜索仍使用 base bundle 的 `deepseek-official` provider。

生产环境建议在审核 changelog 后固定版本：

```sh
dsh plugin --profile production add dsh-safe-web-fetch@0.1.0-next.0
```

也可以固定 Git commit 安装：

```sh
dsh plugin --profile safe add github:MostlyHarmlessxyz/dsh-safe-web-fetch#<commit-sha>
```

Git 安装会执行 `prepare` 构建源码；pnpm 10+ 可能要求 profile 的 `allowBuilds` 显式批准。那代表允许安装阶段执行代码，请只对信任的 commit 使用。若不想执行源码构建，可直接安装 npm tarball。

## 安全检查

请求建立前会检查：

- 仅允许 `http:` / `https:`，禁止 URL 用户名密码，并限制 URL 长度；
- host allow/deny 策略（默认精确匹配，`*.example.com` 才表示子域名）；
- URL 字面量 IP 以及 DNS 返回的全部 A/AAAA 地址；
- 任一答案不安全时整体拒绝（mixed answers fail closed）；
- 私网、回环、链路本地、组播、基准测试、文档、映射/过渡地址及其它非 unicast 特殊网段；
- 使用 Undici DNS interceptor 把 socket 目标重写为已验证 IP，同时保留原始 `Host` 与 TLS SNI。

每次重定向都会重新解析并检查。跨 origin 重定向一律拒绝，调用方需要重新发起一次有新策略决策的 fetch。每一跳使用新的 dispatcher；默认 transport 不读取环境代理变量。

响应只接受文本类媒体类型（`text/*`、HTML、JSON、XML），限制字节数与解码字符数，并返回 DSH 标准结果。插件不会添加 Cookie、Authorization、浏览器存储或请求体。

## 配置

| 选项 | 默认值 | 硬上限/含义 |
| --- | ---: | --- |
| `maxUrlLength` | `2048` | `16384` 字符 |
| `maxResponseBytes` | `5000000` | `100000000` 字节 |
| `maxBodyChars` | `100000` | `10000000` 解码字符 |
| `timeoutMs` | `30000` | Node 定时器上限 |
| `maxRedirects` | `5` | 最多 20 跳同源重定向 |
| `maxConcurrentRequests` | `16` | 每个 provider 最多 128 个并发请求 |
| `allowHosts` | `[]` | 精确 host；子域名写 `*.name` |
| `denyHosts` | `[]` | deny 优先 |
| `userAgent` | 插件 UA | 禁止 CR/LF |

DSH patch 会整体替换 config，覆盖时请写完整对象：

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
    allowHosts: ['*.docs.example.com']
    denyHosts: []
    userAgent: my-company-dsh-fetch/1.0
```

如果手写 patch 而不使用 bundle，需要自行挂载插件，并在 `web` 行设置 `fetchProvider: safe-http`。不要同时注册官方 `http` 和 `safe-http` 却省略 provider id，否则 DSH 会正确返回 `WEB_PROVIDER_AMBIGUOUS`。

## 威胁模型与限制

这是部署策略层，不是“任意网络代码都安全”的证明：

- 默认 transport 使用隔离的 Undici dispatcher；主动传入自定义 resolver/TransportFactory 可以绕过保证，这些接口只用于测试/扩展；
- provider 会等待 resolver 的 deadline，但第三方 resolver 不一定能被操作系统取消，超时后可能短暂继续工作；并发上限用于限制资源放大；
- 每跳都会重新解析，但不跟随跨 origin，也不处理 PDF 等非文本资源；
- 公网地址仍可能提供恶意内容，插件不做恶意软件扫描、HTML 清洗、prompt injection 检测或审批 UI；
- HTTPS 证书校验由 Node/Undici 负责，插件保留 hostname/SNI/Host 语义；
- 地址表由 `ipaddr.js` 提供，升级时应配套回归测试，不能随意删减阻断网段。

需要组织级 egress 网关、审计、审批或 allowlist 时，应在网络边界增加独立控制，并把本插件作为额外本地检查。

## 开发

要求 Node `^22.19.0` 或 `>=24.0.0`、pnpm 11 和兼容的 DSH 包：

```sh
pnpm install
./node_modules/.bin/tsc -p tsconfig.json
node --test --import=tsx tests/*.test.ts
npm pack --dry-run
```

测试覆盖地址网段、异常 DNS、resolver 取消、重定向、响应上限、生命周期销毁，以及真实本地 HTTP server 下的“连接到指定 IP 但保留 Host”行为。

## 发布

插件使用独立的 semver，不加入 DSH 内部共享版本发布族。canary 使用 `next` dist-tag；packed tarball 与 DSH profile smoke 全部通过后才移动到 `latest`。GitHub workflow 面向 npm Trusted Publishing（OIDC），不保存长期 npm token。

## 许可证

MIT，见 [LICENSE](LICENSE)。

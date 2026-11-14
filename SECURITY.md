# Security Policy

## 报告漏洞

请**不要**在公开 Issue 中披露安全问题。请通过 GitHub Security Advisories（仓库 Security → Report a vulnerability）
或直接联系仓库维护者私下报告，我们会尽快确认与修复。

## 安全模型（摘要）

- 服务默认仅监听 `127.0.0.1`，业务接口需要本地 Bearer token（`~/.config/feige-outbound/api-token`）；
- OpenAPI/Swagger 文档端点（`/api/v1/openapi.*`、`/api/v1/docs`）公开，但服务不暴露公网；
- 密钥/账号凭证存放于 `~/.config/feige-outbound/`（0600），日志与 API 输出对手机号/JWT/API key 脱敏；
- 浏览器自动化仅用于账号登录；请遵守上游服务条款与当地法规（个人信息保护、录音告知等）。

## 已知限制（v1）

- JWT 当前明文存储于本地 SQLite（0600，`jwt_key_id=plain-v1`），后续版本支持加密；
- 单本地 token，无多用户/RBAC；若需远程访问请自行加 TLS/反向代理并限制来源。

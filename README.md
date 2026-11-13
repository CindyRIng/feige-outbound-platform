# feige-outbound-platform

本地飞鸽外呼平台（FOP）：把飞鸽外呼（feige.duofangtongxin.com）封装成本地可编程平台。

- **北向**：REST v1（默认 `http://127.0.0.1:8710/api/v1`）、CLI（`feige`）、MCP server（stdio）、SKILL 包
- **南向**：飞鸽多账号（浏览器自动登录/滑块/7 天 JWT 保活）、100% 本地 ASR 转写（MiniMax `asr-1.0`）、内置 AI 后处理（DeepSeek）
- **存储**：SQLite（15 张表，WAL）+ 本地 WAV 归档 + ASR 分块结果
- **文档契约**：[docs/README.md](docs/README.md)（含 00–13 全套设计与 [spec/openapi.yaml](spec/openapi.yaml)）

## 快速开始

### 1. 环境

- Node.js ≥ 22.5（含 `node:sqlite`；建议 22 LTS）
- 浏览器自动化环境（仅登录使用）：Chromium/CloakBrowser + 可选 Xvfb（无 DISPLAY 时）
- 网络可达：`feige.duofangtongxin.com`、`api.minimax.io`（或 `api.minimax.cn`）、`api.deepseek.com`

```bash
npm install
npm run build
```

### 2. 配置密钥

```bash
mkdir -p ~/.config/feige-outbound && chmod 700 ~/.config/feige-outbound
cp deploy/env.example ~/.config/feige-outbound/env   # 编辑填写 MINIMAX/DEEPSEEK key
chmod 600 ~/.config/feige-outbound/env
```

或写入 `~/.config/feige-outbound/secrets.json`（0600）：

```json
{ "minimaxApiKey": "sk-api-...", "deepseekApiKey": "sk-..." }
```

### 3. 启动服务

```bash
npm start                 # 等价于 node dist/src/main.js serve（默认 127.0.0.1:8710）
./dist/src/main.js serve --port 8710
```

首次启动会自动：建目录、初始化 SQLite 迁移、生成 API token（`~/.config/feige-outbound/api-token`）。
日志输出到 stdout（JSON lines）与 `~/.local/share/feige-outbound/logs/fop.log`。

### 4. 接入账号并登录

```bash
export TOKEN=$(cat ~/.config/feige-outbound/api-token)
curl -s -X POST http://127.0.0.1:8710/api/v1/accounts \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"accountId":"main","displayName":"主账号","username":"<上游手机号>","password":"<上游密码>"}'

curl -s -X POST http://127.0.0.1:8710/api/v1/accounts/main/login \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"wait":true}'
```

或使用 CLI：

```bash
node dist/src/main.js account add main --name 主账号 --username <手机号> --password <密码>
node dist/src/main.js account login main
node dist/src/main.js status
```

### 5. 同步话单与后处理

```bash
node dist/src/main.js sync --full --wait          # 全量同步历史话单（入队 ASR/分析）
node dist/src/main.js calls list --size 5
node dist/src/main.js calls detail <callId>
node dist/src/main.js calls transcript <callId> --include-analysis
node dist/src/main.js calls audio <callId> --out /tmp/call.wav
```

### 6. 呼出（回拨模式，07:50–22:00 可用）

```bash
node dist/src/main.js dial 138xxxxxxxx --account main --yes
```

### 7. MCP / SKILL

```bash
node dist/src/main.js mcp        # stdio MCP server（工具名 feige_*）
```

SKILL 包位于 [skills/feige/SKILL.md](skills/feige/SKILL.md)。

## 测试

```bash
npm test                     # 构建 + node:test（dist/tests）
```

## 部署（systemd user service）

```bash
mkdir -p ~/.config/systemd/user
cp deploy/feige-outbound.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now feige-outbound.service
journalctl --user -u feige-outbound.service -f
```

无显示环境（headless 登录）时启用 Xvfb：`cp deploy/feige-outbound-xvfb.service ~/.config/systemd/user/ && systemctl --user enable --now feige-outbound-xvfb.service`。

## 目录布局

```
~/.config/feige-outbound/        config.json / secrets.json / api-token / env（0600）
~/.local/share/feige-outbound/   fop.db（SQLite WAL）、audio/、asr/、tmp/、logs/、profiles/（浏览器 profile）
```

## 文档

设计与契约以 [docs/](docs/) 为准：`01-决策与约定`（单一事实源）、`04-数据模型`、`05-对外API契约`、`13-后处理规格`、`spec/openapi.yaml`。实现验收记录见 `docs/14-实现验收报告.md`（M5 产出）。

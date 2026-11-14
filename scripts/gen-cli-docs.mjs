#!/usr/bin/env node
/** 生成 docs/16-CLI参考手册.md：从 CLI 命令树（commander）自动导出，保证帮助文档与实现一致。 */
import { writeFileSync } from 'node:fs';
import { buildProgram } from '../dist/src/cli/index.js';

const state = { exitCode: 0, interrupted: false, abort: new AbortController() };
const program = buildProgram(state);
const VERSION = program.version();
const commonFlags = new Set(['--api <url>', '--token <token>', '--token-file <path>', '-j, --json', '-q, --quiet', '-v, --verbose', '--timeout <dur>', '-y, --yes']);
const md = [];
md.push('# 16 CLI 参考手册（`feige`）', '');
md.push(`> 版本：v${VERSION}｜自动生成：\`npm run docs:cli\`（来源：CLI 命令树；与 \`feige --help-all\` 一致）`, '');
md.push('`feige` 是 REST v1 的薄封装：所有命令通过 HTTP 调用本地服务（默认 `http://127.0.0.1:8710/api/v1`），不直接访问数据库或上游。', '');
md.push('## 安装', '');
md.push('```bash', 'npm install && npm run build', 'npm run install:cli      # 安装到 ~/.local/bin/feige', 'feige --version', '```', '');
md.push('## 帮助', '');
md.push('```bash', 'feige --help            # 顶层命令与全局选项', 'feige help <command>    # 某个命令（含子命令）的帮助', 'feige --help-all        # 完整命令树（全部命令/子命令/参数/选项）', '```', '');
md.push('## 全局选项（所有命令通用）', '');
md.push('| 选项 | 说明 |', '| --- | --- |');
const optDesc = (o) => `\`${o.flags}\`| ${o.description ?? ''}${o.defaultValue !== undefined ? `（默认 ${JSON.stringify(o.defaultValue)}）` : ''}`;
for (const o of program.options) md.push(`| ${optDesc(o)} |`);
md.push('');
md.push('## 命令树', '');
const walk = (cmd, breadcrumb, depth) => {
  if (cmd.name() === 'help') return;
  const args = (cmd.registeredArguments ?? []).map(a => a.required ? `<${a.name()}>` : `[${a.name()}]`).join(' ');
  const usage = `feige ${breadcrumb}${args ? ' ' + args : ''}`;
  md.push(`${'#'.repeat(Math.min(6, depth + 3))} \`${usage}\``, '');
  if (cmd.description()) md.push(cmd.description(), '');
  md.push('```text', `Usage: ${usage} [options]`, '```', '');
  const own = cmd.options.filter(o => !commonFlags.has(String(o.flags)));
  if (own.length) {
    md.push('| 选项 | 说明 |', '| --- | --- |');
    for (const o of own) md.push(`| ${optDesc(o)} |`);
    md.push('');
  }
  for (const child of cmd.commands) walk(child, `${breadcrumb} ${child.name()}`, depth + 1);
};
for (const cmd of program.commands) walk(cmd, cmd.name(), 0);
md.push('## 通用约定', '');
md.push('- 默认人类可读输出；`--json` 输出与 REST 同构的 JSON 封套（`{ok,data,meta}`），便于脚本处理。');
md.push('- 退出码：`0` 成功、`2` 参数/用法、`3` 未找到、`4` 业务拒绝、`5` 上游/服务端、`6` 鉴权、`8` 网络不可达、`9` 超时、`130` Ctrl-C。');
md.push('- 危险操作（`dial`、`account remove`、`reprocess` 等）默认需交互确认；非交互必须 `--yes` 或先 `--dry-run`。');
md.push('- Token 读取顺序：`--token` → `FOP_API_TOKEN` → `~/.config/feige-outbound/api-token`；也可 `--token-file` 指定。');
md.push('- REST 基址：`--api` → `FOP_API_URL` → 默认 `http://127.0.0.1:8710/api/v1`。');
md.push('');
writeFileSync('docs/16-CLI参考手册.md', md.join('\n'));
console.log(`docs/16-CLI参考手册.md 已生成：${program.commands.length} 个顶层命令`);

#!/usr/bin/env node
// 入口：serve / CLI / MCP 路由（Lead 实现 serve；surface-writer 实现 cli/mcp 文件）
const argv = process.argv.slice(2);
async function main(): Promise<number> {
  const cmd = argv[0] ?? 'help';
  const wantsHelp = argv.includes('--help') || argv.includes('-h') || argv.includes('--help-all');
  if (cmd === 'serve' && !wantsHelp) {
    const { startServer } = await import('./serve.js');
    await startServer(argv.slice(1));
    return 0;
  }
  if (cmd === 'mcp' && !wantsHelp) {
    const { runMcp } = await import('./cli/mcp.js');
    await runMcp(argv.slice(1));
    return 0;
  }
  const { runCli } = await import('./cli/index.js');
  return runCli(argv);
}
main().then(code => { if (code) process.exit(code); }).catch(err => { console.error(JSON.stringify({ level: 'error', msg: err?.message ?? String(err), code: err?.code ?? 'INTERNAL_ERROR' })); process.exit(1); });

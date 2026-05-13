// Rewrite MCP server entries that wrap their real command with `xvfb-run`
// so they can run on macOS, which has no virtual framebuffer. The Linux
// baseline `mcp-config.json` uses `xvfb-run` + `--no-sandbox` flags so
// puppeteer / chrome-devtools work headlessly under systemd. On macOS
// the wrapper is missing entirely (`xvfb-run` is Linux-only) and the
// sandbox flags are unnecessary, so we unwrap to the real command.
//
// Pure / side-effect free so it can be unit tested without faking
// process.platform.

const LINUX_CHROME_SANDBOX_FLAGS = new Set([
  '--no-sandbox',
  '--disable-setuid-sandbox',
]);

const LINUX_CHROME_SANDBOX_ARGS = new Set([
  '--chromeArg=--no-sandbox',
  '--chromeArg=--disable-setuid-sandbox',
]);

function macifyServer(server) {
  if (!server || server.command !== 'xvfb-run') return server;

  const wrappedArgs = Array.isArray(server.args) ? server.args : [];
  // xvfb-run invocation shape: [--auto-servernum, --server-args=..., realCommand, ...realArgs]
  // The first arg that doesn't start with `--` is the real command.
  let i = 0;
  while (i < wrappedArgs.length && wrappedArgs[i].startsWith('--')) i++;
  if (i >= wrappedArgs.length) return server;

  const newCommand = wrappedArgs[i];
  const newArgs = wrappedArgs
    .slice(i + 1)
    .filter((a) => !LINUX_CHROME_SANDBOX_ARGS.has(a));

  const newEnv = { ...(server.env || {}) };
  if (typeof newEnv.PUPPETEER_LAUNCH_OPTIONS === 'string') {
    try {
      const opts = JSON.parse(newEnv.PUPPETEER_LAUNCH_OPTIONS);
      if (Array.isArray(opts.args)) {
        opts.args = opts.args.filter((a) => !LINUX_CHROME_SANDBOX_FLAGS.has(a));
        if (opts.args.length === 0) delete opts.args;
      }
      newEnv.PUPPETEER_LAUNCH_OPTIONS = JSON.stringify(opts);
    } catch {
      // Leave the env var alone if it isn't valid JSON; we'd rather pass
      // through unchanged than silently mangle an operator override.
    }
  }

  const out = { ...server, command: newCommand, args: newArgs };
  if (Object.keys(newEnv).length > 0) out.env = newEnv;
  else delete out.env;
  return out;
}

export function macifyMcpServers(config) {
  if (!config || typeof config !== 'object' || !config.mcpServers) return config;
  const next = { ...config, mcpServers: { ...config.mcpServers } };
  for (const name of Object.keys(next.mcpServers)) {
    next.mcpServers[name] = macifyServer(next.mcpServers[name]);
  }
  return next;
}

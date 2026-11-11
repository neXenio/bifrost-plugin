'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const gateway = path.resolve(__dirname, '../hooks/lib/gateway.cjs');

test('authenticated discovery respects credential configuration scope and precedence', async t => {
  let requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers['x-bf-vk']);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const message = JSON.parse(body);
      if (message.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
        : { tools: [{ name: 'fixture-memory_search' }] };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const entry = key => ({ bifrost: { url, headers: { 'x-bf-vk': key } } });
  const cases = [
    { name: 'foreign-only config makes no authenticated request', expected: null },
    { name: 'current project beats user and foreign scopes', current: 'current', user: 'user', expected: 'current' },
    { name: 'user scope works without current-project config', user: 'user', expected: 'user' },
    { name: 'unexpanded current project falls back to user scope', current: '${MISSING_KEY}', user: 'user', expected: 'user' },
    { name: 'plugin options beat current-project config', current: 'current', plugin: 'plugin', expected: 'plugin' },
    { name: 'explicit environment beats plugin and current-project config', current: 'current', plugin: 'plugin', explicit: 'explicit', expected: 'explicit' },
  ];
  for (const c of cases) await t.test(c.name, async () => {
    requests = [];
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-credential-scope-'));
    const project = path.join(home, 'current-project');
    const config = { projects: { '/foreign-project': { mcpServers: entry('foreign') } } };
    if (c.current) config.projects[project] = { mcpServers: entry(c.current) };
    if (c.user) config.mcpServers = entry(c.user);
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify(config));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BIFROST_') && !key.startsWith('CLAUDE_PLUGIN_OPTION_')));
    Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_PROJECT_DIR: project, CLAUDE_CONFIG_DIR: path.join(home, '.claude') });
    if (c.plugin) Object.assign(env, { CLAUDE_PLUGIN_OPTION_GATEWAY_URL: url, CLAUDE_PLUGIN_OPTION_VIRTUAL_KEY: c.plugin });
    if (c.explicit) Object.assign(env, { BIFROST_URL: url, BIFROST_VK: c.explicit });
    try {
      const result = await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(gateway)}).discover(1000).then(c => process.stdout.write(JSON.stringify({ available: !!c })))`], { env });
        let stdout = '', stderr = '';
        child.stdout.on('data', d => { stdout += d; }); child.stderr.on('data', d => { stderr += d; });
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.on('error', reject);
        child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      assert.equal(result.code, 0);
      assert.equal(result.stderr, '');
      assert.equal(JSON.parse(result.stdout).available, !!c.expected);
      if (!c.expected) assert.equal(requests.length, 0);
      else { assert.ok(requests.length >= 3); assert.ok(requests.every(key => key === c.expected)); }
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

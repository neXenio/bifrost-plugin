'use strict';
// Contract tests for the plugin.json <-> .mcp.json userConfig wiring, added in 1.5.0.
//
// .mcp.json's mcpServers.bifrost entry authenticates with ${user_config.KEY}
// placeholders (see hooks/lib/gateway.cjs's env(), which reads the expanded values
// back from CLAUDE_PLUGIN_OPTION_<KEY>). Claude Code only fills in a placeholder when
// plugin.json declares a matching userConfig key — a typo in either file does not
// error, it silently ships an unauthenticated server (the placeholder is left
// unexpanded instead of becoming a key). That failure mode is what the cross-file
// test below exists to catch, and it walks .mcp.json instead of assuming where a
// placeholder might appear.
//
// 1.8.0 removed the oauth block and its oauth_client_id option. Verified on Claude Code
// 2.1.293: ${user_config.*} is never substituted inside `oauth`, even with the option
// saved, so Keycloak always received the literal placeholder as client_id. The test
// at the bottom keeps it from coming back in that broken form.
//
// Run: npm test  (node --test test/)

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const mcp = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8'));
const pluginManifest = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
const bifrostEntry = mcp.mcpServers && mcp.mcpServers.bifrost;

// Recursively collect every KEY referenced as ${user_config.KEY} anywhere in a parsed
// .mcp.json, not just the fields known about today — a placeholder can appear at any
// depth (url, headers.x-bf-vk, ...), and a future field should not need
// this test updated to be covered.
function collectUserConfigKeys(value, out) {
  if (typeof value === 'string') {
    const re = /\$\{user_config\.([A-Za-z0-9_]+)\}/g;
    let m;
    while ((m = re.exec(value))) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectUserConfigKeys(v, out);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectUserConfigKeys(v, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// plugin.json userConfig options
// ---------------------------------------------------------------------------

test('plugin.json declares the gateway_url userConfig option exactly', () => {
  const opt = pluginManifest.userConfig && pluginManifest.userConfig.gateway_url;
  assert.ok(opt, 'plugin.json userConfig is missing gateway_url');
  assert.strictEqual(opt.type, 'string');
  assert.strictEqual(opt.title, 'Bifrost gateway URL');
  assert.match(
    opt.default,
    /^https:\/\/.*\/mcp$/,
    `gateway_url.default must be an https:// URL ending in /mcp, got: ${opt.default}`
  );
});

test('plugin.json declares the virtual_key userConfig option exactly, with no default', () => {
  const opt = pluginManifest.userConfig && pluginManifest.userConfig.virtual_key;
  assert.ok(opt, 'plugin.json userConfig is missing virtual_key');
  assert.strictEqual(opt.type, 'string');
  assert.strictEqual(opt.title, 'Virtual key (optional)');
  assert.strictEqual(opt.sensitive, true);
  assert.ok(
    !Object.prototype.hasOwnProperty.call(opt, 'default'),
    'virtual_key must carry no default: an empty key is what lets the cached sign-in key take over, and a default would defeat it'
  );
});

// ---------------------------------------------------------------------------
// Cross-file link: every placeholder .mcp.json uses must be a real userConfig key
// ---------------------------------------------------------------------------

test('every ${user_config.*} placeholder in .mcp.json is declared in plugin.json userConfig', () => {
  const referenced = collectUserConfigKeys(mcp, new Set());
  assert.ok(referenced.size > 0, 'expected .mcp.json to reference at least one ${user_config.*} placeholder');

  const declared = new Set(Object.keys(pluginManifest.userConfig || {}));
  const undeclared = [...referenced].filter((key) => !declared.has(key));
  assert.deepStrictEqual(
    undeclared,
    [],
    `.mcp.json references \${user_config.KEY} for key(s) not declared in plugin.json userConfig: ${undeclared.join(', ')}. ` +
      'A typo in either file silently produces an unauthenticated server.'
  );
});

test('no ${user_config.*} placeholder inside an oauth block (Claude Code never substitutes it there)', () => {
  // Verified on 2.1.293 with the option saved via pluginConfigs: the saved virtual_key
  // reached the header, while oauth.clientId reached Keycloak as the literal
  // `${user_config.oauth_client_id}`. Only url, headers and headersHelper expand.
  const oauth = bifrostEntry && bifrostEntry.oauth;
  if (oauth) assert.strictEqual(collectUserConfigKeys(oauth, new Set()).size, 0);
  assert.ok(!('oauth_client_id' in (pluginManifest.userConfig || {})), 'oauth_client_id was removed in 1.8.0');
});

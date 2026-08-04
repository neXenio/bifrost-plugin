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
// placeholder might appear, so it also covers the OAuth client-id placeholder nested
// under mcpServers.bifrost.oauth, not just url/headers.
//
// The oauth block itself exists because a request with no virtual key gets a 401 and
// Claude starts OAuth discovery; the gateway's own
// /.well-known/oauth-authorization-server omits registration_endpoint, so discovery
// fails unless authServerMetadataUrl redirects it to an IdP (Keycloak) that advertises
// dynamic client registration. That makes authServerMetadataUrl and callbackPort part
// of the deployment contract, not incidental config — see the tests below for why
// each is pinned.
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
// depth (url, headers.x-bf-vk, oauth.clientId, ...), and a future field should not need
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
    'virtual_key must carry no default: an empty key is the supported OAuth sign-in path, and a default would defeat it'
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

test('the placeholder scan reaches the nested oauth.clientId field, not just url/headers', () => {
  // Guards the walk itself: a version of the scan that only checked url and
  // headers['x-bf-vk'] would pass the test above vacuously (both of those still
  // resolve) while missing a typo'd oauth.clientId entirely.
  const referenced = collectUserConfigKeys(mcp, new Set());
  assert.ok(referenced.has('oauth_client_id'),
    'the ${user_config.*} scan must walk into mcpServers.bifrost.oauth, not just url/headers');
});

// ---------------------------------------------------------------------------
// OAuth discovery block
// ---------------------------------------------------------------------------
// With no virtual key configured, the gateway answers 401 and Claude starts OAuth
// discovery. The gateway's own /.well-known/oauth-authorization-server omits
// registration_endpoint, so discovery fails ("Incompatible auth server: does not
// support dynamic client registration") unless authServerMetadataUrl points Claude at
// an IdP that advertises one. These fields are load-bearing for that fallback, not
// decorative — hence the exact pins below rather than a presence check.

test('oauth.authServerMetadataUrl is https (Claude rejects a non-https auth server metadata URL)', () => {
  assert.ok(bifrostEntry && bifrostEntry.oauth, 'expected mcpServers.bifrost.oauth to be present');
  const url = bifrostEntry.oauth.authServerMetadataUrl;
  assert.match(url, /^https:\/\//, `authServerMetadataUrl must be https://, got: ${url}`);
});

test('oauth.callbackPort is pinned — changing it breaks every operator\'s IdP redirect whitelist', () => {
  // The loopback redirect URI (http://localhost:<port>/callback) has to match what
  // each operator's identity provider has whitelisted. A silent port change here is
  // not a local implementation detail: every operator's IdP registration breaks with
  // no error on our side to point at why.
  assert.ok(bifrostEntry && bifrostEntry.oauth, 'expected mcpServers.bifrost.oauth to be present');
  const port = bifrostEntry.oauth.callbackPort;
  assert.strictEqual(typeof port, 'number');
  assert.ok(Number.isInteger(port), `callbackPort must be an integer, got: ${port}`);
  assert.strictEqual(
    port,
    51789,
    'callbackPort changed value — this is an operator-visible break, not a safe refactor: ' +
      'the redirect URI must keep matching what operators already whitelisted in their IdP'
  );
});

test('oauth.scopes, if ever added, is not shipped as an array', () => {
  // Empirically confirmed against Claude Code's own MCP config validator, not the
  // gateway: an array-valued scopes is rejected before any request is made, with
  // "oauth.scopes: expected string, received array". RFC 6749 wants one
  // space-separated string.
  // Nothing sets scopes today — this only guards against that regression later.
  assert.ok(bifrostEntry && bifrostEntry.oauth, 'expected mcpServers.bifrost.oauth to be present');
  if (Object.prototype.hasOwnProperty.call(bifrostEntry.oauth, 'scopes')) {
    assert.ok(
      !Array.isArray(bifrostEntry.oauth.scopes),
      'oauth.scopes must be a string, not an array — Claude rejects an array with ' +
        '"oauth.scopes: expected string, received array"'
    );
  }
});

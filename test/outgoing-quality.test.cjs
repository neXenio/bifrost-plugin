'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

for (const configured of [false, true]) {
  test(`SessionStart delivers outgoing-copy guidance with gateway configured=${configured}`, () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-outgoing-'));
    try {
      const result = spawnSync(process.execPath, [path.join(ROOT, 'hooks/session-start.cjs')], {
        cwd: home,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          USERPROFILE: home,
          CI: '1',
          CLAUDE_PROJECT_DIR: home,
          BIFROST_REFRESH: '0',
          BIFROST_AUTO_LOGIN: '0',
          BIFROST_PLUGIN_CONFIG: '0',
          CLAUDE_PLUGIN_OPTION_AUTO_LOGIN: 'false',
          CLAUDE_PLUGIN_OPTION_MIGRATE_LEGACY: 'false',
          BIFROST_URL: configured ? 'https://gateway.example.invalid/mcp' : '',
          BIFROST_VK: configured ? 'test-only-key' : '',
        },
        input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }),
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.match(result.stdout, /Outgoing company communications — final quality pass/);
      assert.match(result.stdout, /load\s+`anti-ai-slop-docs-marketing` through the advertised skill catalog/);
      assert.match(result.stdout, /customer responses, proposals, website copy or social posts/);
      assert.match(result.stdout, /short outgoing copy/);
      assert.match(result.stdout, /facts, names, numbers, links, quotations, legal disclosures/);
      assert.match(result.stdout, /review-only\s+requests and exact approved copy/);
      assert.match(result.stdout, /If the skill is unavailable, say so briefly/);
      assert.match(result.stdout, /never claim the skill was loaded or applied/);
      assert.match(result.stdout, /does not\s+activate watermark or metadata removal, backend setup, uploads, sending or\s+publishing/);
      assert.doesNotMatch(result.stdout, /test-only-key/);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

test('release versions stay aligned across package and marketplace manifests', () => {
  const versions = ['package.json', '.claude-plugin/plugin.json', '.claude-plugin/marketplace.json']
    .map(file => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8')).version);
  assert.equal(new Set(versions).size, 1);
  assert.equal(versions[0], '1.10.2');
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bifrost-route-'));
const rh = require('../hooks/route-hint.cjs');

const ROSTER = { gitlab: ['get_project', 'list_issues'], jira: ['search_jira_tickets'], hubspot: [] };

test('direct service calls map to the roster server', () => {
  const bash = (command) => rh.target({ tool_name: 'Bash', tool_input: { command } });
  assert.equal(rh.matchServer(bash('curl -s https://gitlab.com/api/v4/projects/1'), ROSTER), 'gitlab');
  assert.equal(rh.matchServer(bash('glab mr list'), ROSTER), 'gitlab');
  assert.equal(rh.matchServer(rh.target({ tool_name: 'WebFetch', tool_input: { url: 'https://x.atlassian.net/browse/A-1' } }), ROSTER), 'jira');
});

test('no hint for plain git, unknown hosts, or servers the key cannot reach', () => {
  const bash = (command) => rh.target({ tool_name: 'Bash', tool_input: { command } });
  assert.equal(rh.matchServer(bash('git push origin main'), ROSTER), null);
  assert.equal(rh.matchServer(bash('curl https://example.com'), ROSTER), null);
  assert.equal(rh.matchServer(bash('curl https://api.hubapi.com/crm/v3'), ROSTER), null); // empty tool list
  assert.equal(rh.matchServer(bash('curl https://sentry.io/api/'), ROSTER), null); // not in roster
});

test('hint names the server file and code-mode call', () => {
  const h = rh.hint('gitlab', ROSTER.gitlab);
  assert.match(h, /servers\/gitlab\.pyi/);
  assert.match(h, /result = gitlab\.<tool>/);
});

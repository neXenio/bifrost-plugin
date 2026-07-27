// Test-discovery manifest guard.
//
// Regression context: package.json once carried two "scripts" keys. JSON's
// last-key-wins semantics silently narrowed `npm test` to a single file, so
// test/plugin-config.test.js never ran in CI while the suite still reported
// green. JSON.parse() drops the duplicate without complaint, so the only way to
// catch that class of bug is to inspect the raw text.
//
// This file asserts two things:
//   1. package.json declares each top-level key exactly once.
//   2. every test/*.test.* file on disk is matched by the `test` script's
//      patterns, so adding a test file cannot silently skip it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const raw = fs.readFileSync(PKG_PATH, 'utf8');
const pkg = JSON.parse(raw);

const TEST_FILE_RE = /\.test\.(js|cjs|mjs)$/;

// Top-level keys are indented exactly two spaces in this file's formatting.
function topLevelKeys(text) {
  return text
    .split('\n')
    .map((line) => /^ {2}"([^"]+)":/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`);
}

// Pull the path patterns out of e.g. "node --test test/*.test.js test/*.test.cjs".
function testScriptPatterns(script) {
  const tokens = script.trim().split(/\s+/);
  const at = tokens.indexOf('--test');
  assert.ok(at !== -1, `test script must invoke node --test, got: ${script}`);
  return tokens.slice(at + 1).filter((t) => !t.startsWith('-'));
}

test('package.json declares no duplicate top-level keys', () => {
  const keys = topLevelKeys(raw);
  const seen = new Set();
  const duplicates = [];
  for (const key of keys) {
    if (seen.has(key)) duplicates.push(key);
    seen.add(key);
  }
  assert.deepStrictEqual(
    duplicates,
    [],
    `duplicate top-level key(s) in package.json: ${duplicates.join(', ')}. ` +
      'A later duplicate silently overrides the earlier one.'
  );
});

test('every test file on disk is covered by the test script', () => {
  const patterns = testScriptPatterns(pkg.scripts.test).map((p) => ({
    glob: p,
    re: globToRegExp(p),
  }));

  const onDisk = fs
    .readdirSync(__dirname)
    .filter((f) => TEST_FILE_RE.test(f))
    .map((f) => `test/${f}`);

  assert.ok(onDisk.length > 0, 'expected to find test files on disk');

  const uncovered = onDisk.filter((f) => !patterns.some((p) => p.re.test(f)));
  assert.deepStrictEqual(
    uncovered,
    [],
    `test file(s) exist but are not matched by scripts.test ` +
      `(${pkg.scripts.test}): ${uncovered.join(', ')}`
  );
});

test('test script patterns each match at least one file', () => {
  // A pattern matching nothing means the shell passes it through literally and
  // node exits non-zero on a missing module, so this fails loudly and early.
  const onDisk = fs
    .readdirSync(__dirname)
    .filter((f) => TEST_FILE_RE.test(f))
    .map((f) => `test/${f}`);

  for (const pattern of testScriptPatterns(pkg.scripts.test)) {
    const re = globToRegExp(pattern);
    assert.ok(
      onDisk.some((f) => re.test(f)),
      `pattern ${pattern} in scripts.test matches no file on disk`
    );
  }
});

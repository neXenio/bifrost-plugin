'use strict';
// Builds the session-start recall query from project signal (git remote, toplevel,
// branch, ticket key). Used by refresh.cjs, which runs detached, so the git calls here
// never count against the SessionStart hook's own time limit.

const path = require('path');
const { execFileSync } = require('child_process');

// Basenames that say nothing about the work. A session started in one of these has
// no project signal unless git or a ticket key supplies one.
const GENERIC_DIRS = new Set([
  'desktop', 'downloads', 'documents', 'tmp', 'temp', 'full_context', 'screenpipe',
  'src', 'code', 'projects', 'workspace', 'workspaces', 'repos', 'dev', 'git', 'home',
]);
// Branch tokens that carry no topic.
const GENERIC_BRANCH_WORDS = new Set(['main', 'master', 'develop', 'head', 'wip', 'tmp']);
const BRANCH_PREFIX = /^(feature|feat|fix|bugfix|hotfix|chore|task|release|refactor)[/_-]/i;

// Exact case only: a case-insensitive pass reads fix-login-2, hotfix-1234, bump-node-18
// and utf-8 as tickets. The trailing guard (not \b) lets "LUCA-123_foo" match.
function ticketKey(...sources) {
  for (const src of sources) {
    const m = /\b([A-Z][A-Z0-9]{1,5}-\d+)(?![A-Za-z0-9])/.exec(src || '');
    if (m) return m[1];
  }
  return '';
}

// Separators and, for drive-letter paths, case, so C:\Users\x equals c:/users/x.
function norm(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s;
}

// Pure query builder, split from the git lookups so it can be tested without git.
// Returns '' when there is no repo name and no topic word: a bare ticket key pulls
// short company facts that only match the product word, so it is not a signal.
function buildQuery({ dir, home, remoteUrl, toplevel, branch } = {}) {
  const d = (dir || '').replace(/[\\/]+$/, '');
  const base = path.basename(d);
  const atHome = (p) => !!home && norm(p) === norm(home);
  // A repo rooted at $HOME (dotfiles) says nothing about the project, remote included.
  const homeRepo = !!toplevel && atHome(toplevel);
  const top = toplevel && !homeRepo ? toplevel : '';
  const remote = homeRepo ? '' : (remoteUrl || '').trim().replace(/[\\/]+$/, '').replace(/\.git$/, '');
  const lastSeg = remote ? remote.split(/[\\/:]/).pop() : '';
  const remoteName = /^\d*$/.test(lastSeg) ? '' : lastSeg; // ssh://git@host:2222/ -> 2222
  const ticket = ticketKey(branch, base);

  const generic = !d || atHome(d) || d === path.parse(d).root || base.startsWith('.')
    || GENERIC_DIRS.has(base.toLowerCase());
  let repo = remoteName || (top ? path.basename(top) : (generic ? '' : base));
  let ticketDir = '';
  if (ticket && repo.toLowerCase().includes(ticket.toLowerCase())) [ticketDir, repo] = [repo, ''];

  const topicWords = (s) => String(s || '')
    .replace(BRANCH_PREFIX, '')
    .replace(ticket ? new RegExp(ticket.replace(/-/g, '[-_ ]'), 'ig') : /$^/, ' ')
    .split(/[/\-_\s]+/)
    .filter((w) => w.length > 1 && !/^\d+$/.test(w) && !GENERIC_BRANCH_WORDS.has(w.toLowerCase()));
  // A ticket-named directory (Orca worktree) usually describes the work after the key;
  // use that when the branch says nothing, e.g. a detached HEAD.
  let words = topicWords(branch);
  if (!words.length) words = topicWords(ticketDir);
  if (!repo && !words.length) return '';

  const seen = new Set();
  const unique = (t) => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase());
  return [repo, ticket].filter(unique).concat(words.filter(unique).slice(0, 5)).join(' ');
}

// Run git and tell "nothing there" from "could not ask". A timeout or an odd failure
// (dubious ownership, git missing) must not read as "no repo", or the caller would
// wipe a good cache over a transient error.
function git(cwd, args, timeout) {
  try {
    const out = execFileSync('git', args, {
      cwd, timeout, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    }).trim();
    return { out, error: false };
  } catch (e) {
    const stderr = String((e && e.stderr) || '');
    if (/not a git repository/i.test(stderr)) return { out: '', error: false, noRepo: true };
    // `config --get` exits 1 for an unset key; an unborn branch has no HEAD to name.
    if (e && e.status === 1 && !stderr.trim()) return { out: '', error: false };
    if (/unknown revision|ambiguous argument|bad revision/i.test(stderr)) return { out: '', error: false };
    return { out: '', error: true };
  }
}

// -> { query, gitError }. gitError is true when any git call timed out or failed for a
// reason other than "not a git repository".
function projectQuery(dir, home, timeout = 2000) {
  const top = git(dir, ['rev-parse', '--show-toplevel'], timeout);
  if (top.noRepo) return { query: buildQuery({ dir, home }), gitError: false };
  const remote = git(dir, ['config', '--get', 'remote.origin.url'], timeout);
  const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], timeout);
  return {
    query: buildQuery({ dir, home, remoteUrl: remote.out, toplevel: top.out, branch: branch.out }),
    gitError: top.error || remote.error || branch.error,
  };
}

module.exports = { buildQuery, ticketKey, projectQuery };

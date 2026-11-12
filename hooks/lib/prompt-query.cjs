'use strict';

const MAX_PROMPT_CHARS = 16384;
const MAX_QUERY_CHARS = 600;

// Heuristics, not a guarantee: withhold the entire query instead of attempting to
// redact values whose boundaries may be ambiguous. Scan before truncation.
const SECRET_PATTERNS = [
  /-----BEGIN[ A-Z0-9]*PRIVATE KEY-----/i,
  /\b(?:authorization|proxy-authorization)["']?\s*[:=]/i,
  /\b(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{8,}/i,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b(?:password|passwd|pwd|passphrase|secret|(?:api|access|refresh|auth|session|private|client|virtual)[_ -]?(?:key|token|secret)|token|auth|BIFROST_VK|x-bf-vk)\b["']?\s*(?::|=|\bis\b)\s*\S+/i,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|(?:AKIA|ASIA)[A-Z0-9]{16})\b/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i,
];

function preparePromptQuery(prompt, { enabled = true } = {}) {
  if (!enabled || typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) return null;
  if (SECRET_PATTERNS.some(pattern => pattern.test(prompt))) return null;
  const query = prompt.trim().replace(/\s+/g, ' ').slice(0, MAX_QUERY_CHARS).trim();
  return query || null;
}

module.exports = { preparePromptQuery, MAX_PROMPT_CHARS, MAX_QUERY_CHARS };

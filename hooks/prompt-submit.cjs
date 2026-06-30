'use strict';
// UserPromptSubmit hook — skill-discovery nudge. When the prompt contains a real
// task verb, emit a hint to search the gateway's skill library before starting.
//
// The exact invocation depends on how this gateway exposes the skills server
// (flat mcp__bifrost__<server>-skill_search vs code-mode executeToolCode). That
// is resolved once by the SessionStart hook and cached; here we only READ the
// cache — never the network — so prompt submission is never delayed. Suppressed
// when BIFROST_VK is unset. Silent-fail; always exits 0.

const gw = require('./lib/gateway.cjs');

const TASK_VERB_RE = /\b(fix|test|build|create|implement|debug|deploy|migrate|review|refactor|integrate|scaffold|optimize)\b/i;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 500);
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

// How to phrase the skill-search call, from cached discovery. Falls back to the
// configured/default flat name if discovery hasn't run yet.
function invocation(caps, snippet) {
  if (caps && caps.skills) {
    const s = caps.skills.server;
    if (caps.skills.mode === 'code') {
      return `\`executeToolCode\` with \`result = ${s}.skill_search(query="${snippet}")\``;
    }
    return `\`mcp__bifrost__${s}-skill_search\` with \`query="${snippet}"\``;
  }
  const s = (process.env.BIFROST_SKILLS_SERVER || 'skills').trim() || 'skills';
  return `\`mcp__bifrost__${s}-skill_search\` with: "${snippet}"`;
}

async function main() {
  const raw = await readStdin();
  let event = {};
  try { event = JSON.parse(raw); } catch (_) { /* silent */ }
  const promptText = (event.prompt || event.user_prompt || event.message || '').trim();

  try {
    const { vk } = gw.env();
    if (vk && promptText && TASK_VERB_RE.test(promptText)) {
      const snippet = promptText.slice(0, 120).replace(/\n+/g, ' ').trim();
      const caps = await gw.getCapabilities(0, { cacheOnly: true });
      process.stdout.write(
        `> **Skill discovery:** before starting, search the gateway skill library — call ${invocation(caps, snippet)}. A matching skill may handle this task or provide a specialized workflow.\n`
      );
    }
  } catch (_) { /* silent-fail */ }

  process.exit(0);
}

main().catch(() => process.exit(0));

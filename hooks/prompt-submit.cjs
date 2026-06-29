'use strict';
// UserPromptSubmit hook — skill-discovery hint only.
// Detects task verbs in the prompt and emits a hint to call the gateway's
// skill-search tool (mcp__bifrost__<skills-server>-skill_search).
// Suppressed when BIFROST_VK is unset. Silent-fail; always exits 0.
//
// Memory is agent-driven via the gateway's memory MCP tools — not injected
// here. See AGENTS.md for the memory recall/save workflow.

// CC-namespaced tool name: server "bifrost" (from .mcp.json) + the gateway's
// skill-search tool. The skill server name is configurable via
// BIFROST_SKILLS_SERVER (default "skills"), since gateways may name it
// differently → mcp__bifrost__<skills-server>-skill_search.
const SKILLS_SERVER = (process.env.BIFROST_SKILLS_SERVER || 'skills').trim() || 'skills';
const SKILL_SEARCH_TOOL = 'mcp__bifrost__' + SKILLS_SERVER + '-skill_search';

// Real task verbs only — word-boundary matched so "latest"/"prefix"/"tested"
// do not fire. Require an actual actionable verb in the prompt.
const TASK_VERB_RE = /\b(fix|test|build|create|implement|debug|deploy|migrate|review|refactor|integrate|scaffold|optimize)\b/i;

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    const timer = setTimeout(() => resolve(Buffer.concat(chunks).toString('utf8')), 500);
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

async function main() {
  const raw = await readStdin();

  let event = {};
  try { event = JSON.parse(raw); } catch { /* silent */ }

  const promptText = (event.prompt || event.user_prompt || event.message || '').trim();

  try {
    const vkSet = !!(process.env.BIFROST_VK && process.env.BIFROST_VK.trim());
    if (vkSet && promptText && TASK_VERB_RE.test(promptText)) {
      const snippet = promptText.slice(0, 120).replace(/\n+/g, ' ').trim();
      process.stdout.write(
        `> **Skill Discovery:** Before starting, call \`${SKILL_SEARCH_TOOL}\` with: "${snippet}" — a matching skill from your gateway may handle this task entirely or provide a specialized workflow.\n`
      );
    }
  } catch { /* silent-fail */ }

  process.exit(0);
}

main().catch(() => process.exit(0));

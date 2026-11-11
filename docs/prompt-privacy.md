# Automatic prompt searches

The `UserPromptSubmit` hook can search the configured skill library and team memory
automatically when a prompt appears to contain a task. With a configured virtual key
and cached capability discovery, it sends the same query to the enabled search tools
through your gateway. The query contains up to 600 characters of your prompt after
whitespace normalization. Returned skill names and memory excerpts can be added to
the assistant's context. This happens before the assistant decides whether to call
a tool itself.

## Turn off automatic searches

Set `BIFROST_PROMPT_RECALL=0` in the environment inherited by Claude Code, then start
a new session. `false` also disables it. This local privacy override takes precedence
over server policy and prevents this hook from transmitting prompt text to either
search tool or producing a prompt-derived search suggestion.

The existing `BIFROST_PROMPT_SKILLS=0` and `BIFROST_PROMPT_MEMORY=0` options control the
individual automatic searches under the existing server policy rules. A locked
server setting can override these individual options; use `BIFROST_PROMPT_RECALL=0`
for an unconditional local opt-out. This setting does not disable tools the assistant
calls explicitly, other hooks, or the Claude provider's normal receipt of your prompt.

## What the filter does

The hook checks the entire prompt before truncating the outgoing query. It skips
automatic searches and prompt-derived suggestions when it recognizes likely private
keys, authorization headers, bearer/basic credentials, JWTs, labelled password/token/
key assignments, selected provider token formats, or URLs containing credentials.
Prompts longer than 16,384 JavaScript string characters are also withheld to bound
local scanning work. Rejected prompts are not logged by this filter, and the original
task remains available to the assistant.

These checks are heuristic. They can reject harmless examples and miss unfamiliar,
encoded or unlabelled secrets and personal data. They do not guarantee safe disclosure.
Use the opt-out when prompts may contain sensitive material. The plugin does not
configure gateway retention, downstream search-provider logging, or deletion. Ask
your gateway operator about those policies; no retention period is guaranteed here.
Upstream [Bifrost secrets detection](https://docs.getbifrost.ai/enterprise/guardrails/secrets-detection.md)
describes a separate gateway capability, not proof that it is enabled on your gateway.

# Preset: j-agy as a search backend

> Copy the rules below into your AGENTS.md. Core principle: **never forced** — built-in search comes first, j-agy is only the fallback.

## When to use (drop-in rules for the main agent)

Always prefer the session's built-in search tools (WebSearch / WebFetch / search MCPs). Switch to j-agy (`agy_prompt`) for search only in any of these cases:

1. **Built-in search unavailable**: the corresponding MCP is out of quota, erroring, or not configured;
2. **Built-in search broken**: repeated failures or empty results;
3. **Built-in results unsatisfying**: nothing relevant, clearly outdated, or untrustworthy — even after retrying with different keywords;
4. **The user explicitly asks** to use j-agy for search in this task or session.

Note: AGY behind j-agy is a separate process with its own network path. When the main agent's network is restricted, AGY may still work — that makes it a genuine second outlet, not a duplicate of the first one.

## How to dispatch

- Tool: `agy_prompt`; `effort` is usually `medium`, or `high` for deep research.
- The task description must be self-contained (AGY cannot see the main agent's conversation). Template:

```text
Search: <topic + the specific question to answer>
Requirements:
- Use web search; cross-check key claims against at least 2 independent sources
- Return a bullet list; every item carries its source URL and content date
- Separate "sourced facts" from "your own inference" — mark inferences as such
- If nothing is found, say "not found" explicitly and list the keywords you tried. Do not fabricate.
```

## Consuming the results

- Source URL + date are your verification handles: before a claim goes into a deliverable, the main agent spot-checks 1–2 sources itself instead of trusting the list wholesale.
- If AGY reports "not found", retry once with the main agent's built-in search before giving up; don't re-dispatch the same task in a loop.

# Preset: j-agy as a coding subagent

> Copy the rules below into your AGENTS.md. Core principle: **the main agent writes code by default**; j-agy only takes over implementation under specific conditions.

## When to use (drop-in rules for the main agent)

Implementation is done by the main agent itself by default. Dispatch to j-agy (`agy_prompt` / `agy_conversation`) only in any of these cases:

1. **The main agent's built-in subagent tools are unavailable or broken** — on errors, cancellations, or quota problems switch to j-agy directly instead of retrying the built-in tools in place;
2. **Protecting the main context**: the implementation is tedious mechanical bulk work (large repetitive edits, peripheral scripts) whose noise would pollute the main context;
3. **The user explicitly asks** to hand this task or session's implementation to j-agy.

## How to dispatch

- `effort`: `high`. Choose `mode` by risk:
  - **Two-phase (recommended)**: first `mode: "plan"` to get a proposal; after the main agent approves it, continue with `agy_conversation` + `mode: "accept-edits"` to execute;
  - Mechanical bulk edits may go straight to `accept-edits` in one step.
- The task description must be self-contained. If any line below is missing, do not dispatch:

```text
Goal: <what to change and why>
Scope: <files/directories involved, absolute paths; call out what must NOT be touched>
Constraints: <existing style to follow, dependencies not to introduce>
Acceptance: <which commands to run and what output counts as done>
Report when finished: files changed, intent of each change, and the actual output of the acceptance commands.
```

## The main agent's verification duty

- A subagent reporting "done" **is not done**: the main agent must read the diff and run the acceptance commands itself; on failure, send it back via `agy_conversation`.
- Exploration and retrieval can be outsourced freely; outsourced implementation must always come with verification. Do not mix the two trust levels.

## Security

- `skip_permissions` defaults to `true` (auto-approves file edits and commands), paired with `sandbox`;
- For sensitive work (production config, secrets), pass `mode: "plan"` or `skip_permissions: false` explicitly — never let it execute with permissions on its own.

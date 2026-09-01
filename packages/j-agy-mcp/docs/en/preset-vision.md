# Preset: j-agy as a vision backend

> Copy the rules below into your AGENTS.md. Core principle: **use your own eyes first** — if the main model has native vision, read images yourself; j-agy is only the fallback.

## When to use (drop-in rules for the main agent)

Use j-agy (`agy_prompt`) for image understanding only in any of these cases:

1. **The main model has no multimodal input**: a text-only model that cannot read image files;
2. **Native vision fails**: the image cannot be opened, the tool errors, or the result is visibly degraded to the point of being unusable;
3. **Native reading is unreliable**: the same question yields no answer or contradictory answers across attempts;
4. **The user explicitly asks** to use j-agy for this task or session.

## Capability boundaries (verified in practice)

- AGY (Gemini-based, multimodal) can open local image files with its file-reading tools and describe them: scene description, UI layout inventory, text inside the image, locating elements — all workable;
- **Not suitable for**: exact pixel coordinates or color values (the model speaks in vague terms like "roughly top-right" — never put those into code), and verbatim OCR of very tall screenshots (require cropping into segments in the task if needed);
- Image paths must be absolute, and the task should say explicitly: "open this image with your file-reading tool".

## How to dispatch

- Tool: `agy_prompt`; `effort` is usually `medium`.

```text
Open the local image at <absolute path> with your file-reading tool.
Task: <open-ended request, e.g. "describe this screenshot's layout and all visible text">
Requirements: answer openly without assumptions; for anything unclear say "uncertain" explicitly — do not guess to fill gaps.
```

## Notes

- **Ask open-ended questions** ("describe what is in the frame"); avoid leading questions ("is there a red button?" nudges the model into confirming things that do not exist).
- AGY cannot produce pixel-level ground truth (exact coordinates, hex colors). Use dedicated pixel tools for that; never copy its vague descriptions into code.

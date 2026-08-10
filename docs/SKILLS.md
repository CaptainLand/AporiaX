# AporiaX Skill System v1

AporiaX Skills are declarative workflow packages that teach the Agent **how to perform a class of work** without adding executable code or expanding tool permissions.

A Skill is intentionally different from a Plugin:

- **Skill** = instructions, workflow guidance, triggers, and recommended tools.
- **Plugin** = trusted executable JavaScript/TypeScript that may register tools, agents, or event hooks.

Skill v1 never executes JavaScript from a Skill directory.

## Skill locations

AporiaX discovers Skills from two user-controlled locations:

### Project Skills

```text
<workspace>/.aporiax/skills/<skill-name>/SKILL.md
```

Project Skills apply to that workspace only.

### User Skills

```text
<Electron userData>/skills/<skill-name>/SKILL.md
```

User Skills are available across workspaces on the same AporiaX installation.

When the same Skill name exists in more than one source, the more specific source wins:

```text
project > user > built-in
```

The registry also has a built-in source boundary for future packaged Skills, although v1 does not ship a default built-in Skill catalog.

## SKILL.md format

Example:

```md
---
name: translate-mod
title: 游戏 MOD 翻译
description: 翻译游戏本地化文件并保持变量、键名和格式控制符不变
auto: true
triggers:
  - 翻译
  - localization
  - localisation
tools:
  - read_file
  - search_text
  - write_file
---

# Workflow

1. Read the project's translation guide before editing.
2. Never modify localization keys.
3. Preserve variables such as `$VARIABLE$`.
4. Preserve game formatting/control codes.
5. Re-read changed files before delivery.
```

Supported frontmatter fields:

- `name` — stable lower-case identifier. Pattern: `[a-z][a-z0-9_-]{1,63}`.
- `title` — user-facing title.
- `description` — short discovery description.
- `version` — informational Skill version.
- `auto` — whether deterministic automatic matching is allowed. Defaults to `true`.
- `triggers` — words or phrases used for local automatic matching.
- `tools` — recommended existing AporiaX tools. This is advisory and **does not grant access to those tools**.

The Markdown body is the full workflow instruction content.

## Activation

### Automatic

Skill matching is local and deterministic in v1. AporiaX compares the current user request with a Skill's:

- `triggers`
- Skill name
- Skill title

Only the selected Skills have their full Markdown instructions loaded into the model request. Discovery lists expose metadata without injecting every Skill body into context.

At most **2 Skills** are activated for one turn in v1.

### Manual

Use either form in the normal task prompt:

```text
/skill:translate-mod 翻译这个模组
```

or:

```text
@skill translate-mod 翻译这个模组
```

Manual activation has priority over automatic matching.

The `@skill` command is kept separate from workspace `@file` mentions; it is not treated as a file named `skill`.

## Progressive disclosure

AporiaX does not place every installed Skill into every model request.

```text
Discover metadata
      ↓
Match current task
      ↓
Activate max 2 Skills
      ↓
Load only those SKILL.md bodies
      ↓
Inject into this runtime turn
```

This keeps context cost bounded as a user's Skill library grows.

## Runtime behavior

Activated Skill instructions are appended only to the **runtime copy** of the target user turn. The visible/persisted user prompt remains the user's original text.

The Skill context explicitly tells the Agent that Skill instructions:

- are workflow guidance,
- do not grant additional permissions,
- do not bypass approval,
- do not create additional tools,
- remain subordinate to the user's request and AporiaX system/safety boundaries.

The existing permission policy, command approval, sandbox behavior, Scope Leases, Builder restrictions, Review/Verify and Witness remain authoritative.

## Concurrent tasks

Skill catalogs are resolved per run. Two simultaneous AporiaX tasks in different workspaces do not share one mutable project-Skill catalog.

For example:

```text
Workspace A
.aporiax/skills/frontend/SKILL.md

Workspace B
.aporiax/skills/backend/SKILL.md
```

A task in Workspace A cannot accidentally activate Workspace B's project Skill simply because both runs are active at the same time.

## UI feedback

Task Settings shows a **Skills** card with discovered Skill metadata and source (`Project`, `User`, or future `Built-in`).

When a Skill is activated during a run, the Live Agent Status shows a Skill badge such as:

```text
translate-mod   Live   3/6
```

The full Skill body is never rendered into the conversation just to provide this status feedback.

## Security and limits

Skill v1 is deliberately bounded:

- declarative Markdown only; no Skill JavaScript execution,
- `SKILL.md` maximum file size: 128 KB,
- instruction body capped at 48,000 characters,
- maximum 2 activated Skills per turn,
- combined injected Skill context capped at 90,000 characters,
- discovery is limited to direct Skill directories under the configured Skill roots,
- symbolic-link Skill files/directories are not treated as normal Skill packages,
- tool names declared in `tools` are recommendations only.

For executable capabilities, use the existing trusted Plugin system instead of Skills.

## Current v1 boundaries

Not included yet:

- in-app Skill editor or installer,
- remote Skill marketplace/registry,
- semantic embedding-based Skill matching,
- model call solely to decide which Skill to activate,
- per-Skill permission grants,
- executable Skill hooks,
- durable historical persistence of the live Skill badge on old completed turns.

The last item affects only the badge presentation: the actual Skill selection and instructions are applied to the live runtime request.

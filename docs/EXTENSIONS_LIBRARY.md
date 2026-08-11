# AporiaX Extensions Library

The Extensions Library is the trusted installation surface for Skills and MCP server configurations.

## Use it

Open **Settings → Extensions**:

- **Discover** lists the bundled catalog. Installing a Skill validates its `SKILL.md` and copies it into the user Skill directory.
- **Installed** shows active project/user Skills and configured MCP servers. User Skills and MCP records can be removed here.
- **Sources & policy** controls whether optional extension sources are available. These switches do not grant tool permission.

Use **Import Skill folder** to select a local package whose root contains `SKILL.md`. AporiaX validates the manifest, rejects symbolic links, caps packages at 500 files / 20 MB, and atomically installs the complete folder so referenced assets remain available.

Use **Import MCP JSON** for either AporiaX `{ "servers": [...] }` configuration or the common `{ "mcpServers": { "name": {...} } }` shape. Imported servers remain disabled by normal extension, trust, and permission boundaries; importing does not start a process.

For a custom MCP server, choose **Add a custom MCP server**, select `Streamable HTTP` or `Local stdio`, and save the configuration. Prefer `${ENV_NAME}` references for credentials. AporiaX stores the reference, not a resolved secret value.

In the task composer, type `@` to search workspace files and installed/configured extensions. `@skill:<name>` explicitly activates a Skill. `@mcp:<id>` scopes MCP discovery for that turn to the named configured server, which helps avoid connecting unrelated services.

## Trust model

- Catalog Skills are declarative Markdown instructions. The Library never executes code during Skill installation.
- MCP templates only prefill a configuration form. Saving a server does not start it.
- Runtime use still passes through extension policy, Harness tool permission, approval rules, workspace boundaries, and sandbox policy.
- Project configuration can further disable a source, but cannot elevate the user-level policy.

## Catalog packages

The bundled manifest is `electron/library/catalog.json`. A Skill entry points to a packaged `SKILL.md` under `electron/library/skills/<name>/SKILL.md`. Catalog metadata and Skill frontmatter names must match.

The manifest is versioned so a future public AporiaX registry can expose the same entry model. Remote installation should require HTTPS, immutable package hashes, publisher identity, and review metadata before it is enabled; the current version deliberately accepts bundled packages only.

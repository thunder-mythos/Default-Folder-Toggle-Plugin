# Default Folder Toggle

An Obsidian plugin that automatically manages the expand/collapse state of folders in the File Explorer — driven by `folderStatus` YAML frontmatter in matching folder-notes, or by manually configured settings overrides.

---

## How It Works

The plugin resolves folder states from two sources, in priority order:

| Priority | Source | Mechanism |
| -------- | ------ | --------- |
| High | Settings overrides | Configured in plugin settings UI |
| Low | Folder-notes | YAML `folderStatus` in a matching note |

---

## Folder-Notes

A **folder-note** is a markdown file that shares the exact name of its parent folder.

```
Projects/
  Projects.md   ← folder-note for the Projects folder
  Active/
    Active.md   ← folder-note for Active
```

Add `folderStatus` to the YAML frontmatter of any folder-note:

```yaml
---
folderStatus: expanded
---
```

### Valid Values

| Value | Behavior |
| ----- | -------- |
| `expanded` | Forces the folder to always open |
| `collapsed` | Forces the folder to always stay closed |
| `default` | Defers entirely to native Obsidian behavior |

---

## Settings Overrides

Open **Settings → Default Folder Toggle** to manually pair any folder path with a status. Paths are relative to the vault root.

Examples:
- `Projects` (root-level folder)
- `Projects/Active` (nested folder)
- `Resources/References/Papers` (deeply nested)

Settings overrides take full priority over folder-note YAML. Any folder path configured in settings will not appear in the auto-detected table even if it has a matching folder-note.

---

## Installation

### From Source

```bash
# 1. Clone or copy plugin files into your vault's plugin folder
cp -r default-folder-toggle ~/.vault/.obsidian/plugins/

# 2. Install dependencies and build
cd ~/.vault/.obsidian/plugins/default-folder-toggle
npm install
npm run build

# 3. Enable the plugin in Obsidian → Settings → Community Plugins
```

### Dev Mode (live rebuild on file save)

```bash
npm run dev
```

---

## Commands

| Command | Description |
| ------- | ----------- |
| `Default Folder Toggle: Re-apply all folder states` | Manually re-asserts all tracked folder states. Useful after bulk edits or if states drift. |

---

## Architecture Notes

**Event flow:**
1. On vault ready: build status map → apply states → attach MutationObserver
2. On `metadataCache.changed`: debounced (300 ms) rebuild + apply
3. On `vault.rename / delete / create`: debounced (300 ms) rebuild + apply
4. On `workspace.layout-change`: debounced (150 ms) apply-only
5. On MutationObserver fire (DOM class change in nav tree): debounced (80 ms) apply-only

**Why MutationObserver?**
When a user manually clicks a folder in the File Explorer, Obsidian toggles its collapsed state via CSS classes. The MutationObserver catches this and re-asserts the desired state, effectively locking tracked folders open or closed.

**Internal API safety:**
All access to `fileItems` and `setCollapsed` uses `typeof` guards and optional chaining. If Obsidian's internal structure changes in a future version, the plugin degrades to a no-op rather than crashing.

---

## Troubleshooting

**Folder states not applying on startup?**
Run the `Re-apply all folder states` command. On very large vaults, the metadata cache may still be indexing when the plugin initializes.

**A folder keeps reverting to collapsed/expanded?**
Check both your settings overrides and the folder-note's frontmatter — a settings override may be conflicting with what you expect.

**States conflict with another plugin?**
Plugins that also manipulate folder states (e.g. file-tree-alternative) may fight with this plugin's MutationObserver. Disable MutationObserver re-assertion by removing the relevant folder from the status map (`default` value) and relying on the initial apply only.

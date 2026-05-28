var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => DefaultFolderTogglePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
  folderOverrides: []
};
var DefaultFolderTogglePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
    /**
     * Merged status map: absolute vault folder path → FolderStatus.
     *
     * Built from two sources (priority order, highest first):
     *   1. Settings overrides  (this.settings.folderOverrides)
     *   2. Folder-note YAML    (file.basename === file.parent.name && frontmatter.folderStatus)
     */
    this.statusMap = /* @__PURE__ */ new Map();
    this.mutationObserver = null;
    this.debounceTimer = null;
  }
  // ── Lifecycle ──────────────────────────────────────────────────────────────
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new DefaultFolderToggleSettingTab(this.app, this));
    this.addCommand({
      id: "reapply-folder-states",
      name: "Re-apply all folder states",
      callback: () => {
        this.buildStatusMap();
        this.applyFolderStates();
      }
    });
    this.app.workspace.onLayoutReady(() => {
      this.buildStatusMap();
      this.applyFolderStates();
      this.attachMutationObserver();
    });
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (!file.parent || file.basename !== file.parent.name) return;
        this.scheduleRebuildAndApply();
      })
    );
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRebuildAndApply()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRebuildAndApply()));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRebuildAndApply()));
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.scheduleDebouncedApply())
    );
  }
  onunload() {
    var _a;
    (_a = this.mutationObserver) == null ? void 0 : _a.disconnect();
    this.clearDebounce();
  }
  // ── Settings ───────────────────────────────────────────────────────────────
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.buildStatusMap();
    this.applyFolderStates();
  }
  // ── Status Map ─────────────────────────────────────────────────────────────
  /**
   * Rebuilds `this.statusMap` from scratch.
   *
   * Source 1 — Folder-notes (lower priority):
   *   Scan every markdown file. If `file.basename === file.parent.name`, it is
   *   a folder-note. Read `frontmatter.folderStatus` from the metadata cache.
   *
   * Source 2 — Settings overrides (higher priority):
   *   Write over any note-derived entry with the user's explicit settings value.
   *
   * Using `app.metadataCache` avoids disk I/O on every call; Obsidian keeps
   * the cache in memory and emits `changed` events when it goes stale.
   */
  buildStatusMap() {
    var _a;
    const map = /* @__PURE__ */ new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      const parent = file.parent;
      if (!parent) continue;
      if (file.basename !== parent.name) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const raw = (_a = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _a["folderStatus"];
      if (raw === "expanded" || raw === "collapsed" || raw === "default") {
        map.set(parent.path, raw);
      }
    }
    for (const { path, status } of this.settings.folderOverrides) {
      const trimmed = path.trim();
      if (trimmed && status) map.set(trimmed, status);
    }
    this.statusMap = map;
  }
  // ── File Explorer Interaction ──────────────────────────────────────────────
  /** Safely retrieves the internal FileExplorerView, or null if unavailable. */
  getFileExplorerView() {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0];
    const view = leaf == null ? void 0 : leaf.view;
    if (!view || typeof view !== "object") return null;
    if (!("fileItems" in view) || !("containerEl" in view)) return null;
    return view;
  }
  /**
   * Walks `statusMap` and forces each tracked folder into its designated state.
   *
   * Design choices:
   *   - `default` entries are skipped entirely (native behavior wins).
   *   - State is only mutated when `collapsed` differs from the desired value,
   *     preventing unnecessary DOM thrashing or animation jitter.
   *   - `animate = false` on `setCollapsed` avoids visible "flicker" on load.
   *   - All access to internal API fields is guarded with typeof checks so a
   *     future Obsidian internal refactor degrades gracefully (no-ops, no crash).
   */
  applyFolderStates() {
    const explorer = this.getFileExplorerView();
    if (!explorer) return;
    for (const [folderPath, status] of this.statusMap) {
      if (status === "default") continue;
      const raw = explorer.fileItems[folderPath];
      if (!raw || typeof raw !== "object") continue;
      const item = raw;
      if (typeof item.setCollapsed !== "function") continue;
      const shouldCollapse = status === "collapsed";
      if (item.collapsed !== shouldCollapse) {
        item.setCollapsed(
          shouldCollapse,
          false
          /* no animation */
        );
      }
    }
  }
  // ── Debounced Scheduling ───────────────────────────────────────────────────
  /**
   * Debounced rebuild + apply.
   * Used when vault structure changes, e.g. rename / create / delete.
   * 300 ms gives Obsidian time to update its metadata cache first.
   */
  scheduleRebuildAndApply(delay = 300) {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.buildStatusMap();
      this.applyFolderStates();
      this.debounceTimer = null;
    }, delay);
  }
  /**
   * Debounced apply-only.
   * Used when layout changes or the MutationObserver fires.
   * 100–150 ms is enough for Obsidian's render cycle to settle.
   */
  scheduleDebouncedApply(delay = 150) {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.applyFolderStates();
      this.debounceTimer = null;
    }, delay);
  }
  clearDebounce() {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
  // ── MutationObserver ───────────────────────────────────────────────────────
  /**
   * Watches the `.nav-files-container` element for `class` attribute mutations.
   *
   * Why: When a user manually clicks a folder to expand it, Obsidian toggles
   * CSS classes on folder elements. By observing these changes we can re-assert
   * our desired state after the native toggle completes — effectively "locking"
   * a folder's state even when the user clicks.
   *
   * The short 80 ms debounce lets the native toggle animation finish first,
   * reducing jank. Increase to ~200 ms if you see visual conflicts on slow hardware.
   */
  attachMutationObserver() {
    var _a, _b;
    (_a = this.mutationObserver) == null ? void 0 : _a.disconnect();
    const explorer = this.getFileExplorerView();
    const navContainer = (_b = explorer == null ? void 0 : explorer.containerEl) == null ? void 0 : _b.querySelector(
      ".nav-files-container"
    );
    if (!navContainer) return;
    this.mutationObserver = new MutationObserver(() => {
      this.scheduleDebouncedApply(80);
    });
    this.mutationObserver.observe(navContainer, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"]
      // Only care about class toggles (collapse/expand)
    });
  }
};
var DefaultFolderToggleSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Default Folder Toggle" });
    containerEl.createEl("p", {
      text: "Two ways to control folder states: (1) add folderStatus to a folder-note's YAML frontmatter, or (2) use the overrides below. Overrides always win.",
      cls: "setting-item-description"
    });
    containerEl.createEl("h3", { text: "Folder Overrides" });
    containerEl.createEl("p", {
      text: "Manually pair folder paths with a collapse/expand state. Paths are relative to your vault root (e.g. Projects/Active).",
      cls: "setting-item-description"
    });
    if (this.plugin.settings.folderOverrides.length === 0) {
      containerEl.createEl("p", {
        text: "No overrides yet. Add one below.",
        cls: "setting-item-description"
      });
    }
    this.plugin.settings.folderOverrides.forEach(
      (_, i) => this.renderOverrideRow(containerEl, i)
    );
    new import_obsidian.Setting(containerEl).addButton(
      (btn) => btn.setButtonText("\uFF0B Add Folder Override").setCta().onClick(async () => {
        this.plugin.settings.folderOverrides.push({ path: "", status: "default" });
        await this.plugin.saveSettings();
        this.display();
      })
    );
    containerEl.createEl("h3", { text: "Detected Folder-Notes" });
    containerEl.createEl("p", {
      text: "Folders automatically managed via a matching folder-note's folderStatus property. Read-only \u2014 edit the note's frontmatter to change behavior.",
      cls: "setting-item-description"
    });
    const noteEntries = this.getNoteBasedEntries();
    if (noteEntries.length === 0) {
      containerEl.createEl("p", {
        text: "None detected. Create a note inside a folder that shares the folder's exact name (e.g. Projects/Projects.md) and add folderStatus: expanded (or collapsed) to its YAML frontmatter.",
        cls: "setting-item-description"
      });
    } else {
      this.renderDetectedTable(containerEl, noteEntries);
    }
  }
  // ── Override Row ──────────────────────────────────────────────────────────
  renderOverrideRow(containerEl, index) {
    const override = this.plugin.settings.folderOverrides[index];
    new import_obsidian.Setting(containerEl).setName(`Override #${index + 1}`).addText((text) => {
      text.setPlaceholder("Folder path, e.g. Projects/Active").setValue(override.path).onChange(async (value) => {
        this.plugin.settings.folderOverrides[index].path = value;
        await this.plugin.saveSettings();
      });
      text.inputEl.style.width = "220px";
    }).addDropdown(
      (drop) => drop.addOption("default", "Default (native)").addOption("expanded", "Always Expanded").addOption("collapsed", "Always Collapsed").setValue(override.status).onChange(async (value) => {
        this.plugin.settings.folderOverrides[index].status = value;
        await this.plugin.saveSettings();
      })
    ).addExtraButton(
      (btn) => btn.setIcon("trash").setTooltip("Remove this override").onClick(async () => {
        this.plugin.settings.folderOverrides.splice(index, 1);
        await this.plugin.saveSettings();
        this.display();
      })
    );
  }
  // ── Detected Folder-Notes Table ───────────────────────────────────────────
  renderDetectedTable(containerEl, entries) {
    const table = containerEl.createEl("table");
    table.style.cssText = "width:100%;border-collapse:collapse;margin-top:8px;font-size:0.88em;";
    const thead = table.createEl("thead");
    const hrow = thead.createEl("tr");
    for (const h of ["Folder Path", "Status", "Source Note"]) {
      const th = hrow.createEl("th", { text: h });
      th.style.cssText = "text-align:left;padding:6px 10px;border-bottom:2px solid var(--background-modifier-border);color:var(--text-normal);";
    }
    const tbody = table.createEl("tbody");
    for (const { folderPath, status, notePath } of entries) {
      const row = tbody.createEl("tr");
      for (const [i, cell] of [folderPath, status, notePath].entries()) {
        const td = row.createEl("td", { text: cell });
        td.style.cssText = "padding:5px 10px;border-bottom:1px solid var(--background-modifier-border-focus);color:var(--text-muted);font-family:var(--font-monospace);";
        if (i === 1) {
          td.style.color = status === "expanded" ? "var(--color-green)" : status === "collapsed" ? "var(--color-orange)" : "var(--text-faint)";
          td.style.fontWeight = "600";
        }
      }
    }
  }
  // ── Data Helpers ──────────────────────────────────────────────────────────
  /**
   * Returns folder-note derived entries, excluding any folder path that
   * is already covered by a settings override (to avoid duplicate display).
   */
  getNoteBasedEntries() {
    var _a;
    const entries = [];
    const overridePaths = new Set(
      this.plugin.settings.folderOverrides.map((o) => o.path.trim())
    );
    for (const file of this.app.vault.getMarkdownFiles()) {
      const parent = file.parent;
      if (!parent || file.basename !== parent.name) continue;
      if (overridePaths.has(parent.path)) continue;
      const cache = this.app.metadataCache.getFileCache(file);
      const raw = (_a = cache == null ? void 0 : cache.frontmatter) == null ? void 0 : _a["folderStatus"];
      if (raw === "expanded" || raw === "collapsed" || raw === "default") {
        entries.push({
          folderPath: parent.path,
          status: String(raw),
          notePath: file.path
        });
      }
    }
    return entries.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
  }
};

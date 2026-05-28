import {
  App,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";

// ─────────────────────────────────────────────────────────────────────────────
//  Types & Interfaces
// ─────────────────────────────────────────────────────────────────────────────

type FolderStatus = "expanded" | "collapsed" | "default";

interface FolderOverride {
  path: string;
  status: FolderStatus;
}

interface DefaultFolderToggleSettings {
  /** User-defined overrides: folder path → FolderStatus. Always wins over folder-note YAML. */
  folderOverrides: FolderOverride[];
}

const DEFAULT_SETTINGS: DefaultFolderToggleSettings = {
  folderOverrides: [],
};

// ─────────────────────────────────────────────────────────────────────────────
//  Internal Obsidian API Shims
//  These mirror undocumented internal types.
//  Every access is guarded with defensive typeof / presence checks.
// ─────────────────────────────────────────────────────────────────────────────

interface FolderItem {
  el: HTMLElement;
  collapsed: boolean;
  setCollapsed(collapsed: boolean, animate?: boolean): void;
}

interface FileExplorerView {
  fileItems: Record<string, unknown>;
  containerEl: HTMLElement;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Plugin Core
// ─────────────────────────────────────────────────────────────────────────────

export default class DefaultFolderTogglePlugin extends Plugin {
  settings: DefaultFolderToggleSettings = DEFAULT_SETTINGS;

  /**
   * Merged status map: absolute vault folder path → FolderStatus.
   *
   * Built from two sources (priority order, highest first):
   *   1. Settings overrides  (this.settings.folderOverrides)
   *   2. Folder-note YAML    (file.basename === file.parent.name && frontmatter.folderStatus)
   */
  private statusMap = new Map<string, FolderStatus>();

  private mutationObserver: MutationObserver | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new DefaultFolderToggleSettingTab(this.app, this));

    // Command: manually re-apply all states (useful for debugging or after bulk edits)
    this.addCommand({
      id: "reapply-folder-states",
      name: "Re-apply all folder states",
      callback: () => {
        this.buildStatusMap();
        this.applyFolderStates();
      },
    });

    // Wait for workspace to be fully ready before touching the file explorer DOM
    this.app.workspace.onLayoutReady(() => {
      this.buildStatusMap();
      this.applyFolderStates();
      this.attachMutationObserver();
    });

    // Frontmatter edited — rebuild only when the changed file could be a folder-note
    this.registerEvent(
      this.app.metadataCache.on("changed", (file: TFile) => {
        if (!file.parent || file.basename !== file.parent.name) return;
        this.scheduleRebuildAndApply();
      })
    );

    // Vault structural changes (rename, delete, create) may affect folder-note pairs
    this.registerEvent(this.app.vault.on("rename", () => this.scheduleRebuildAndApply()));
    this.registerEvent(this.app.vault.on("delete", () => this.scheduleRebuildAndApply()));
    this.registerEvent(this.app.vault.on("create", () => this.scheduleRebuildAndApply()));

    // Layout change: file explorer may have been (re-)opened; re-assert states
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.scheduleDebouncedApply())
    );
  }

  onunload(): void {
    this.mutationObserver?.disconnect();
    this.clearDebounce();
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
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
  buildStatusMap(): void {
    const map = new Map<string, FolderStatus>();

    // ── Pass 1: Folder-notes ──────────────────────────────────────────────
    for (const file of this.app.vault.getMarkdownFiles()) {
      const parent = file.parent;
      if (!parent) continue;
      if (file.basename !== parent.name) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const raw: unknown = cache?.frontmatter?.["folderStatus"];

      if (raw === "expanded" || raw === "collapsed" || raw === "default") {
        map.set(parent.path, raw);
      }
    }

    // ── Pass 2: Settings overrides (win over note-derived values) ─────────
    for (const { path, status } of this.settings.folderOverrides) {
      const trimmed = path.trim();
      if (trimmed && status) map.set(trimmed, status);
    }

    this.statusMap = map;
  }

  // ── File Explorer Interaction ──────────────────────────────────────────────

  /** Safely retrieves the internal FileExplorerView, or null if unavailable. */
  private getFileExplorerView(): FileExplorerView | null {
    const leaf = this.app.workspace.getLeavesOfType("file-explorer")[0] as
      | (WorkspaceLeaf & { view?: unknown })
      | undefined;

    const view = leaf?.view;
    if (!view || typeof view !== "object") return null;
    if (!("fileItems" in view) || !("containerEl" in view)) return null;

    return view as FileExplorerView;
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
  applyFolderStates(): void {
    const explorer = this.getFileExplorerView();
    if (!explorer) return;

    for (const [folderPath, status] of this.statusMap) {
      if (status === "default") continue;

      const raw = explorer.fileItems[folderPath];
      if (!raw || typeof raw !== "object") continue;

      const item = raw as Partial<FolderItem>;
      if (typeof item.setCollapsed !== "function") continue;

      const shouldCollapse = status === "collapsed";
      if (item.collapsed !== shouldCollapse) {
        item.setCollapsed(shouldCollapse, false /* no animation */);
      }
    }
  }

  // ── Debounced Scheduling ───────────────────────────────────────────────────

  /**
   * Debounced rebuild + apply.
   * Used when vault structure changes, e.g. rename / create / delete.
   * 300 ms gives Obsidian time to update its metadata cache first.
   */
  private scheduleRebuildAndApply(delay = 300): void {
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
  private scheduleDebouncedApply(delay = 150): void {
    this.clearDebounce();
    this.debounceTimer = setTimeout(() => {
      this.applyFolderStates();
      this.debounceTimer = null;
    }, delay);
  }

  private clearDebounce(): void {
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
  private attachMutationObserver(): void {
    this.mutationObserver?.disconnect();

    const explorer = this.getFileExplorerView();
    const navContainer = explorer?.containerEl?.querySelector<HTMLElement>(
      ".nav-files-container"
    );

    if (!navContainer) return;

    this.mutationObserver = new MutationObserver(() => {
      this.scheduleDebouncedApply(80);
    });

    this.mutationObserver.observe(navContainer, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class"], // Only care about class toggles (collapse/expand)
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Settings Tab
// ─────────────────────────────────────────────────────────────────────────────

class DefaultFolderToggleSettingTab extends PluginSettingTab {
  plugin: DefaultFolderTogglePlugin;

  constructor(app: App, plugin: DefaultFolderTogglePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Header ────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Default Folder Toggle" });
    containerEl.createEl("p", {
      text:
        "Two ways to control folder states: (1) add folderStatus to a folder-note's " +
        "YAML frontmatter, or (2) use the overrides below. Overrides always win.",
      cls: "setting-item-description",
    });

    // ── Overrides section ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Folder Overrides" });
    containerEl.createEl("p", {
      text:
        "Manually pair folder paths with a collapse/expand state. " +
        "Paths are relative to your vault root (e.g. Projects/Active).",
      cls: "setting-item-description",
    });

    if (this.plugin.settings.folderOverrides.length === 0) {
      containerEl.createEl("p", {
        text: "No overrides yet. Add one below.",
        cls: "setting-item-description",
      });
    }

    this.plugin.settings.folderOverrides.forEach((_, i) =>
      this.renderOverrideRow(containerEl, i)
    );

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("＋ Add Folder Override")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.folderOverrides.push({ path: "", status: "default" });
          await this.plugin.saveSettings();
          this.display();
        })
    );

    // ── Detected folder-notes (read-only, informational) ─────────────────
    containerEl.createEl("h3", { text: "Detected Folder-Notes" });
    containerEl.createEl("p", {
      text:
        "Folders automatically managed via a matching folder-note's folderStatus property. " +
        "Read-only — edit the note's frontmatter to change behavior.",
      cls: "setting-item-description",
    });

    const noteEntries = this.getNoteBasedEntries();

    if (noteEntries.length === 0) {
      containerEl.createEl("p", {
        text:
          "None detected. Create a note inside a folder that shares the folder's exact name " +
          "(e.g. Projects/Projects.md) and add folderStatus: expanded (or collapsed) " +
          "to its YAML frontmatter.",
        cls: "setting-item-description",
      });
    } else {
      this.renderDetectedTable(containerEl, noteEntries);
    }
  }

  // ── Override Row ──────────────────────────────────────────────────────────

  private renderOverrideRow(containerEl: HTMLElement, index: number): void {
    const override = this.plugin.settings.folderOverrides[index];

    new Setting(containerEl)
      .setName(`Override #${index + 1}`)
      .addText((text) => {
        text
          .setPlaceholder("Folder path, e.g. Projects/Active")
          .setValue(override.path)
          .onChange(async (value) => {
            this.plugin.settings.folderOverrides[index].path = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.style.width = "220px";
      })
      .addDropdown((drop) =>
        drop
          .addOption("default", "Default (native)")
          .addOption("expanded", "Always Expanded")
          .addOption("collapsed", "Always Collapsed")
          .setValue(override.status)
          .onChange(async (value) => {
            this.plugin.settings.folderOverrides[index].status = value as FolderStatus;
            await this.plugin.saveSettings();
          })
      )
      .addExtraButton((btn) =>
        btn
          .setIcon("trash")
          .setTooltip("Remove this override")
          .onClick(async () => {
            this.plugin.settings.folderOverrides.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          })
      );
  }

  // ── Detected Folder-Notes Table ───────────────────────────────────────────

  private renderDetectedTable(
    containerEl: HTMLElement,
    entries: { folderPath: string; status: string; notePath: string }[]
  ): void {
    const table = containerEl.createEl("table");
    table.style.cssText =
      "width:100%;border-collapse:collapse;margin-top:8px;font-size:0.88em;";

    const thead = table.createEl("thead");
    const hrow = thead.createEl("tr");
    for (const h of ["Folder Path", "Status", "Source Note"]) {
      const th = hrow.createEl("th", { text: h });
      th.style.cssText =
        "text-align:left;padding:6px 10px;border-bottom:2px solid var(--background-modifier-border);color:var(--text-normal);";
    }

    const tbody = table.createEl("tbody");
    for (const { folderPath, status, notePath } of entries) {
      const row = tbody.createEl("tr");
      for (const [i, cell] of [folderPath, status, notePath].entries()) {
        const td = row.createEl("td", { text: cell });
        td.style.cssText =
          "padding:5px 10px;border-bottom:1px solid var(--background-modifier-border-focus);" +
          "color:var(--text-muted);font-family:var(--font-monospace);";
        // Color-code the status column
        if (i === 1) {
          td.style.color =
            status === "expanded"
              ? "var(--color-green)"
              : status === "collapsed"
              ? "var(--color-orange)"
              : "var(--text-faint)";
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
  private getNoteBasedEntries(): { folderPath: string; status: string; notePath: string }[] {
    const entries: { folderPath: string; status: string; notePath: string }[] = [];
    const overridePaths = new Set(
      this.plugin.settings.folderOverrides.map((o) => o.path.trim())
    );

    for (const file of this.app.vault.getMarkdownFiles()) {
      const parent = file.parent;
      if (!parent || file.basename !== parent.name) continue;
      if (overridePaths.has(parent.path)) continue;

      const cache = this.app.metadataCache.getFileCache(file);
      const raw: unknown = cache?.frontmatter?.["folderStatus"];

      if (raw === "expanded" || raw === "collapsed" || raw === "default") {
        entries.push({
          folderPath: parent.path,
          status: String(raw),
          notePath: file.path,
        });
      }
    }

    return entries.sort((a, b) => a.folderPath.localeCompare(b.folderPath));
  }
}

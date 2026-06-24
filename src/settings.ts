import { App, PluginSettingTab, Setting } from "obsidian";
import { BookProgressApi, Settings } from "./types";

export type { Settings } from "./types";

export const CHARS_PER_PAGE = 1600;
export const MIN_SAVE_TIMEOUT_MS = 5000;
export const SCROLL_POSITION_UPDATE_INTERVAL_MS = 200;
export const PROGRESS_BAR_REFRESH_INTERVAL_MS = 1000;

/** must match the `id` in manifest.json */
export const PLUGIN_FOLDER_NAME = "book-progress";

export const DEFAULT_SETTINGS: Settings = {
	readingSpeed: 300,
	appendText: "left",
	showProgressPercentage: true,
	showPagesInStatusBar: true,
	// the config-dir base path is prepended during initialization
	databaseFilePath: `plugins/${PLUGIN_FOLDER_NAME}/scroll-history.json`,
	delayAfterFileOpeningMs: 200,
	saveTimeoutMs: MIN_SAVE_TIMEOUT_MS,
};

export class SettingsTab extends PluginSettingTab {
	plugin: BookProgressApi;

	constructor(app: App, plugin: BookProgressApi) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Reading speed")
			.setDesc(
				"Words per minute. Used for the status-bar time and the book block's time " +
					"(multiplied by 5 internally to approximate characters per minute)."
			)
			.addText((text) =>
				text
					.setPlaceholder("300")
					.setValue(String(this.plugin.settings.readingSpeed))
					.onChange(async (value) => {
						const parsed = parseInt(value.trim(), 10);
						this.plugin.settings.readingSpeed =
							isNaN(parsed) || parsed <= 0 ? 300 : parsed;
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					})
			);

		new Setting(containerEl)
			.setName("Append text")
			.setDesc('Word appended after the time in the status bar, e.g. "left".')
			.addText((text) =>
				text
					.setValue(this.plugin.settings.appendText)
					.onChange(async (value) => {
						this.plugin.settings.appendText = value.trim();
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					})
			);

		new Setting(containerEl)
			.setName("Show reading progress percentage")
			.setDesc("Append the scroll percentage to the status bar.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showProgressPercentage)
					.onChange(async (value) => {
						this.plugin.settings.showProgressPercentage = value;
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					})
			);

		new Setting(containerEl)
			.setName("Show pages in status bar")
			.setDesc(
				`Show "read pages / total pages" in the status bar while reading ` +
					`(one page ≈ ${CHARS_PER_PAGE} characters). ` +
					`In the book block the page count is always shown.`
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showPagesInStatusBar)
					.onChange(async (value) => {
						this.plugin.settings.showPagesInStatusBar = value;
						await this.plugin.saveSettings();
						this.plugin.updateStatusBar();
					})
			);

		new Setting(containerEl)
			.setName("Database file path")
			.setDesc("Where reading positions are stored (relative to the config dir).")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.databaseFilePath)
					.onChange(async (value) => {
						this.plugin.settings.databaseFilePath =
							value.trim() || DEFAULT_SETTINGS.databaseFilePath;
						await this.plugin.saveSettings();
					})
			);

		// --- help section ---
		new Setting(containerEl).setName("Usage").setHeading();

		const help = containerEl.createEl("div", { cls: "bp-help" });

		help.createEl("p", {
			text:
				"Add a live progress bar for any note (treated as a book) by inserting " +
				"this code block anywhere — e.g. in your reading dashboard:",
		});

		const pre = help.createEl("pre");
		pre.createEl("code", {
			text: '```book\nname: "[[My Book]]"\n```',
		});

		help.createEl("p", {
			text:
				"The block shows the linked note's name, a progress bar, the percentage " +
				"read, the number of pages read out of the total, and the remaining " +
				"reading time. It updates automatically as you scroll through the " +
				"linked note (no need to refresh).",
		});

		const list = help.createEl("ul");
		list.createEl("li", {
			text:
				"name — required. A wiki-link to the note: name: \"[[Note Name]]\". " +
				"Anything outside [[ ]] is ignored.",
		});
		list.createEl("li", {
			text:
				"The remaining time uses the Reading speed above; change it once and " +
				"every block updates.",
		});
		list.createEl("li", {
			text:
				"A book is marked finished once you scroll past 99 %; after that the " +
				"block stays at 100 % even if you scroll back.",
		});
	}
}

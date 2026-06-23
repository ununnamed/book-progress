import {
	debounce,
	Editor,
	MarkdownView,
	Plugin,
	TAbstractFile,
} from "obsidian";
import { EditorView } from "@codemirror/view";

import {
	CHARS_PER_PAGE,
	DEFAULT_SETTINGS,
	MIN_SAVE_TIMEOUT_MS,
	SCROLL_POSITION_UPDATE_INTERVAL_MS,
	Settings,
	SettingsTab,
} from "./settings";
import { Database, ScrollStateData } from "./types";
import {
	copySerializable,
	createFileIdentifier,
	INVALID_FILE_IDENTIFIER,
	serializeError,
	sleep,
} from "./utils";
import { readingTimeText } from "./helpers";
import { ProgressBarRenderer } from "./progress-bar";

export default class BookProgressPlugin extends Plugin {
	settings: Settings;
	database: Database = {};

	private lastSavedDatabase: Database = {};
	private statusBar: HTMLElement;
	private progressBars: ProgressBarRenderer;

	// scroll restore bookkeeping
	private loadedLeafIdList: string[] = [];
	private latestScrollState: ScrollStateData | undefined;
	private lastLoadedFileName: string | undefined;
	private loadingFile = false;

	// stable-height detection (used only when restoring)
	private isWaitingForStableHeight = false;
	private lastStableScrollHeight = 0;
	private lastStableScrollTop = 0;

	// cache so we don't strip the whole text on every tick
	private charsCache: { path: string; textLength: number; charsTotal: number } | null =
		null;

	async onload(): Promise<void> {
		await this.loadSettings();
		await this.initializeDatabase();

		this.statusBar = this.addStatusBarItem();
		this.statusBar.setText("");

		this.addSettingTab(new SettingsTab(this.app, this));

		this.progressBars = new ProgressBarRenderer(this);
		this.progressBars.register();

		this.registerEvents();
		this.registerTimers();

		await this.restoreScrollState();
		this.updateStatusBar();
	}

	onunload(): void {
		void this.writeDatabase(this.database);
	}

	// ------------------------------------------------------------------ //
	//  settings + database                                               //
	// ------------------------------------------------------------------ //

	async loadSettings(): Promise<void> {
		const defaults = copySerializable(DEFAULT_SETTINGS);
		defaults.databaseFilePath =
			this.app.vault.configDir + "/" + defaults.databaseFilePath;

		this.settings = {
			...defaults,
			...(await this.loadData()),
		} as Settings;

		if (this.settings.saveTimeoutMs < MIN_SAVE_TIMEOUT_MS) {
			this.settings.saveTimeoutMs = MIN_SAVE_TIMEOUT_MS;
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private async initializeDatabase(): Promise<void> {
		try {
			this.database = await this.readDatabase();
		} catch (e) {
			console.error("BookProgress: cannot read database: " + serializeError(e));
			this.database = {};
		}
		this.lastSavedDatabase = copySerializable(this.database);
	}

	private async readDatabase(): Promise<Database> {
		let database: Database = {};
		if (await this.app.vault.adapter.exists(this.settings.databaseFilePath)) {
			const data = await this.app.vault.adapter.read(this.settings.databaseFilePath);
			database = JSON.parse(data);
		}
		return database;
	}

	private async writeDatabase(database: Database): Promise<void> {
		const changed =
			JSON.stringify(this.database) !== JSON.stringify(this.lastSavedDatabase);
		if (!changed) return;

		const folder = this.settings.databaseFilePath.substring(
			0,
			this.settings.databaseFilePath.lastIndexOf("/")
		);
		if (folder && !(await this.app.vault.adapter.exists(folder))) {
			await this.app.vault.adapter.mkdir(folder);
		}

		await this.app.vault.adapter.write(
			this.settings.databaseFilePath,
			JSON.stringify(database)
		);
		this.lastSavedDatabase = copySerializable(database);
	}

	/** Public accessor used by the progress-bar renderer. */
	getScrollData(filePath: string): ScrollStateData | undefined {
		return this.findScrollData(filePath);
	}

	// ------------------------------------------------------------------ //
	//  events + timers                                                   //
	// ------------------------------------------------------------------ //

	private registerEvents(): void {
		this.registerEvent(
			this.app.workspace.on("file-open", () => {
				void this.restoreScrollState();
				this.updateStatusBar();
			})
		);
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.updateStatusBar())
		);
		this.registerEvent(
			this.app.workspace.on("layout-change", () => this.updateStatusBar())
		);
		this.registerEvent(
			this.app.workspace.on(
				"editor-change",
				debounce(() => {
					this.charsCache = null;
					this.updateStatusBar();
				}, 500)
			)
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => this.renameFile(file, oldPath))
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.deleteFile(file)));
		this.registerEvent(
			this.app.workspace.on("quit", () => {
				void this.writeDatabase(this.database);
			})
		);
	}

	private registerTimers(): void {
		this.registerInterval(
			window.setInterval(() => void this.tick(), SCROLL_POSITION_UPDATE_INTERVAL_MS)
		);
		this.registerInterval(
			window.setInterval(
				() => void this.writeDatabase(this.database),
				this.settings.saveTimeoutMs
			)
		);
	}

	private async tick(): Promise<void> {
		this.updateStatusBar();
		await this.checkScrollStateChanged();
	}

	renameFile(file: TAbstractFile, oldPath: string): void {
		if (this.database[oldPath]) {
			this.database[file.path] = this.database[oldPath];
			delete this.database[oldPath];
		}
	}

	deleteFile(file: TAbstractFile): void {
		delete this.database[file.path];
	}

	// ------------------------------------------------------------------ //
	//  shared live measurement                                           //
	// ------------------------------------------------------------------ //

	private getScrollerEl(view: MarkdownView): HTMLElement | null {
		return (view.contentEl.querySelector(".cm-scroller") ??
			view.contentEl.querySelector(".markdown-source-view") ??
			view.contentEl) as HTMLElement | null;
	}

	/**
	 * Underlying CodeMirror 6 view for the active editor, or null if the
	 * current view is not a CM editor (e.g. reading mode).
	 */
	private getCm(view: MarkdownView): EditorView | null {
		const cm = (view.editor as any)?.cm;
		return cm instanceof EditorView ? cm : null;
	}

	/** Strips whitespace/punctuation, caching the result per file + length. */
	private getCharsTotal(path: string, editor: Editor): number {
		const text = editor.getValue();
		const textLength = text.length;
		if (
			this.charsCache &&
			this.charsCache.path === path &&
			this.charsCache.textLength === textLength
		) {
			return this.charsCache.charsTotal;
		}
		const charsTotal = text.replace(/[\s\p{P}]+/gu, "").length;
		this.charsCache = { path, textLength, charsTotal };
		return charsTotal;
	}

	/**
	 * Captures the current reading position. Stores three things:
	 *  - `scrollPos`: document character offset at the top of the viewport.
	 *    Restored via `EditorView.scrollIntoView` — invariant under font
	 *    size, window width and CM's virtual-scroll height estimates.
	 *    This is the primary restore key.
	 *  - `scrollTop`: raw pixel position (fallback if no CM available).
	 *  - `scrollProgress`: 0..1, used by the progress-bar UI.
	 */
	private getLiveScrollState(): ScrollStateData | null {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.editor) return null;

		const el = this.getScrollerEl(view);
		if (!el) return null;

		const denominator = el.scrollHeight - el.clientHeight;
		const progress = denominator > 0 ? el.scrollTop / denominator : 0;
		const clamped = Math.min(1, Math.max(0, progress));

		const path = view.file?.path ?? "";
		const charsTotal = this.getCharsTotal(path, view.editor);

		// document position at the top of the viewport (most robust to restore)
		let scrollPos: number | undefined;
		const cm = this.getCm(view);
		if (cm) {
			try {
				scrollPos = cm.lineBlockAtHeight(el.scrollTop).from;
			} catch {
				// ignore, fall back to scrollTop / scrollProgress
			}
		}

		return {
			scrollPos,
			scrollTop: el.scrollTop,
			scrollProgress: clamped,
			charsTotal,
			textLength: view.editor.getValue().length,
		};
	}

	// ------------------------------------------------------------------ //
	//  status bar                                                        //
	// ------------------------------------------------------------------ //

	updateStatusBar(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.editor) {
			this.statusBar.setText("");
			return;
		}

		const el = this.getScrollerEl(view);
		if (!el) {
			this.statusBar.setText("");
			return;
		}

		const denominator = el.scrollHeight - el.clientHeight;
		const progress = denominator > 0 ? el.scrollTop / denominator : 0;
		const clamped = Math.min(1, Math.max(0, progress));

		const path = view.file?.path ?? "";
		const charsTotal = this.getCharsTotal(path, view.editor);
		const charsBelow = Math.floor(charsTotal * (1 - clamped));

		const time = readingTimeText(charsBelow, this.settings);

		// Page counts mirror the `book` block exactly.
		const totalPages = Math.max(1, Math.ceil(charsTotal / CHARS_PER_PAGE));
		const readChars = charsTotal - charsBelow;
		const readPages = Math.min(totalPages, Math.ceil(readChars / CHARS_PER_PAGE));

		let text: string;
		if (this.settings.showPagesInStatusBar) {
			const pagesWord = totalPages === 1 ? "page" : "pages";
			let prefix = `${readPages}/${totalPages} ${pagesWord}`;
			if (this.settings.showProgressPercentage) {
				prefix += ` (${(clamped * 100).toFixed(1)}%)`;
			}
			text = `${prefix} \u2022 ${time}`;
		} else {
			text = time;
			if (this.settings.showProgressPercentage) {
				text += ` (${(clamped * 100).toFixed(1)}%)`;
			}
		}

		this.statusBar.setText(text);
	}

	// ------------------------------------------------------------------ //
	//  saving the scroll position                                        //
	// ------------------------------------------------------------------ //

	private async checkScrollStateChanged(): Promise<void> {
		const activeFile = this.app.workspace.getActiveFile();
		const fileName = activeFile?.path;

		if (
			!fileName ||
			!this.lastLoadedFileName ||
			fileName !== this.lastLoadedFileName ||
			this.loadingFile
		) {
			return;
		}

		const state = this.getLiveScrollState();
		if (!state) return;

		if (!this.latestScrollState) {
			this.latestScrollState = state;
		}

		if (this.shouldSaveScrollState(state)) {
			this.saveScrollState(state);
			this.latestScrollState = state;
		}
	}

	private shouldSaveScrollState(state: ScrollStateData): boolean {
		const hasValidProgress =
			state.scrollProgress !== undefined && !isNaN(state.scrollProgress);
		const changed = !this.isScrollStatesEqual(state, this.latestScrollState);
		return hasValidProgress && changed;
	}

	private isScrollStatesEqual(
		a: ScrollStateData | undefined,
		b: ScrollStateData | undefined
	): boolean {
		const p1 = a?.scrollProgress;
		const p2 = b?.scrollProgress;
		if (p1 !== p2) {
			if (p1 === undefined || p2 === undefined) return false;
			if (Math.abs(p1 - p2) > 0.001) return false;
		}
		if (a?.charsTotal !== b?.charsTotal) return false;
		return true;
	}

	private saveScrollState(state: ScrollStateData): void {
		const fileName = this.app.workspace.getActiveFile()?.path;
		if (!fileName || fileName !== this.lastLoadedFileName) return;

		this.updateReadStatus(fileName, state);

		const now = new Date();
		const previous = this.database[fileName];
		state.timestamp = now.toISOString();

		const isNewFile = !previous;
		const isNewDay = this.isNewVirtualDay(previous?.timestamp, now);
		state.progressAtDayStart =
			isNewDay || isNewFile ? 0 : previous?.progressAtDayStart ?? 0;

		this.database[fileName] = state;
	}

	private updateReadStatus(fileName: string, state: ScrollStateData): void {
		if (!fileName) return;
		const previousIsRead = this.database[fileName]?.isRead ?? false;
		if (previousIsRead) {
			state.isRead = true;
			return;
		}
		state.isRead = (state.scrollProgress ?? 0) > 0.99;
	}

	/** A "virtual day" rolls over at 6:00 in the morning. */
	private isNewVirtualDay(previousTimestamp: string | undefined, current: Date): boolean {
		if (!previousTimestamp) return true;
		try {
			const toVirtualDay = (date: Date): number => {
				const d = new Date(date);
				if (d.getHours() < 6) {
					d.setDate(d.getDate() - 1);
				}
				d.setHours(6, 0, 0, 0);
				return d.getTime();
			};
			return toVirtualDay(new Date(previousTimestamp)) !== toVirtualDay(current);
		} catch {
			return true;
		}
	}

	// ------------------------------------------------------------------ //
	//  restoring the scroll position                                     //
	// ------------------------------------------------------------------ //

	private async restoreScrollState(): Promise<void> {
		const fileName = this.app.workspace.getActiveFile()?.path;
		if (!fileName || (this.loadingFile && this.lastLoadedFileName === fileName)) {
			return;
		}

		if (this.lastLoadedFileName !== fileName) {
			this.isWaitingForStableHeight = false;
			this.lastStableScrollHeight = 0;
			this.lastStableScrollTop = 0;
			this.charsCache = null;
		}

		if (this.isActiveFileAlreadyLoaded()) {
			return;
		}

		this.loadedLeafIdList = this.app.workspace
			.getLeavesOfType("markdown")
			.map((leaf) => createFileIdentifier(leaf) ?? INVALID_FILE_IDENTIFIER)
			.filter((id) => id !== INVALID_FILE_IDENTIFIER);

		this.loadingFile = true;

		if (this.lastLoadedFileName !== fileName) {
			this.latestScrollState = {};
			this.lastLoadedFileName = fileName;

			const state = this.database[fileName];
			if (state) {
				await sleep(this.settings.delayAfterFileOpeningMs);
				const flashing =
					this.app.workspace.containerEl.querySelector("span.is-flashing");
				if (!flashing) {
					await sleep(10);
					await this.setScrollState(state);
				}
			}
			this.latestScrollState = state;
		}

		this.loadingFile = false;
	}

	private isActiveFileAlreadyLoaded(): boolean {
		const activeLeaf = this.app.workspace.getMostRecentLeaf();
		const fileIdentifier = createFileIdentifier(activeLeaf);
		return this.loadedLeafIdList.includes(fileIdentifier ?? INVALID_FILE_IDENTIFIER);
	}

	/**
	 * Restores a saved reading position. Tries three strategies in order:
	 *   1. `scrollPos` via CodeMirror's `EditorView.scrollIntoView` — robust to
	 *      virtual-scroll height estimates that previously caused the
	 *      "half-a-screen too low" bug.
	 *   2. raw `scrollTop` pixel value.
	 *   3. legacy `scrollProgress * range` (for entries written by older versions).
	 */
	private async setScrollState(state: ScrollStateData): Promise<void> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view) return;

		const el = this.getScrollerEl(view);
		if (!el) return;

		// wait for the editor to lay out enough content that scrollTop won't be clamped
		await this.waitForStableScrollHeight(el);

		// 1) preferred: scroll a specific character offset to the top of the viewport
		const cm = this.getCm(view);
		if (cm && state.scrollPos !== undefined && state.scrollPos >= 0) {
			const maxPos = cm.state.doc.length;
			const pos = Math.min(state.scrollPos, maxPos);
			try {
				cm.dispatch({
					effects: EditorView.scrollIntoView(pos, { y: "start" }),
				});
				return;
			} catch (e) {
				console.error("BookProgress: scrollIntoView failed, falling back", e);
			}
		}

		// 2) fallback: absolute pixel scrollTop
		if (state.scrollTop !== undefined && state.scrollTop >= 0) {
			const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
			el.scrollTop = Math.min(state.scrollTop, maxScrollTop);
			return;
		}

		// 3) legacy fallback: relative progress (kept for old database entries)
		if (state.scrollProgress !== undefined) {
			const maxScrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
			const target = Math.max(
				0,
				Math.min(state.scrollProgress * (el.scrollHeight - el.clientHeight), maxScrollTop)
			);
			el.scrollTop = target;
		}
	}

	/** Waits until scrollHeight stops changing (content finished rendering). */
	private waitForStableScrollHeight(
		element: HTMLElement,
		timeoutMs = 1000
	): Promise<number> {
		if (this.isWaitingForStableHeight) {
			return Promise.resolve(this.lastStableScrollHeight);
		}

		const currentScrollTop = element.scrollTop;
		if (
			this.lastStableScrollHeight > 0 &&
			Math.abs(currentScrollTop - this.lastStableScrollTop) < 10
		) {
			return Promise.resolve(this.lastStableScrollHeight);
		}

		this.isWaitingForStableHeight = true;

		return new Promise((resolve) => {
			let lastScrollHeight = element.scrollHeight;
			let stableCount = 0;
			const requiredStableChecks = 3;
			const checkInterval = 200;

			const finish = (height: number) => {
				this.isWaitingForStableHeight = false;
				this.lastStableScrollHeight = height;
				this.lastStableScrollTop = element.scrollTop;
				resolve(height);
			};

			const interval = window.setInterval(() => {
				const currentScrollHeight = element.scrollHeight;
				if (currentScrollHeight === lastScrollHeight) {
					stableCount++;
				} else {
					stableCount = 0;
					lastScrollHeight = currentScrollHeight;
				}
				if (stableCount >= requiredStableChecks) {
					window.clearInterval(interval);
					finish(currentScrollHeight);
				}
			}, checkInterval);

			window.setTimeout(() => {
				window.clearInterval(interval);
				finish(element.scrollHeight);
			}, timeoutMs);
		});
	}

	// ------------------------------------------------------------------ //
	//  lookup helpers                                                    //
	// ------------------------------------------------------------------ //

	private findScrollData(filePath: string): ScrollStateData | undefined {
		const normalized = filePath.startsWith("/") ? filePath.slice(1) : filePath;
		if (this.database[normalized]) return this.database[normalized];

		const withoutExt = normalized.replace(/\.md$/, "");
		if (this.database[withoutExt]) return this.database[withoutExt];

		for (const key in this.database) {
			const normalizedKey = key.startsWith("/") ? key.slice(1) : key;
			if (
				normalizedKey === normalized ||
				normalizedKey.replace(/\.md$/, "") === withoutExt
			) {
				return this.database[key];
			}
		}
		return undefined;
	}
}

import { Plugin } from "obsidian";

/**
 * User-configurable settings. Lives here (a leaf module that only imports
 * from "obsidian") so both the plugin and the settings tab can reference it
 * without importing each other.
 */
export interface Settings {
	// --- reading time ---
	/** words per minute; multiplied by 5 internally to approximate chars/min */
	readingSpeed: number;
	/** word appended after the time, e.g. "left" */
	appendText: string;
	/** show scroll percentage next to the time in the status bar */
	showProgressPercentage: boolean;
	/** show "X/Y pages" in the status bar */
	showPagesInStatusBar: boolean;

	// --- scroll history / persistence ---
	databaseFilePath: string;
	delayAfterFileOpeningMs: number;
	saveTimeoutMs: number;
}

/**
 * The subset of the plugin that the settings tab and the progress-bar
 * renderer rely on. Declaring it here (rather than importing the concrete
 * `BookProgressPlugin` default export from `main.ts`) breaks the
 * `main.ts` <-> consumer import cycle, which otherwise makes type-aware
 * linters resolve `this.plugin` as `any`.
 */
export interface BookProgressApi extends Plugin {
	settings: Settings;
	saveSettings(): Promise<void>;
	updateStatusBar(): void;
	getScrollData(filePath: string): ScrollStateData | undefined;
	resetProgress(filePath: string): Promise<boolean>;
}

/**
 * One stored reading position for a single file.
 *
 * The robust restoration field is `scrollPos` — a character offset in the
 * document. CodeMirror's `EditorView.scrollIntoView(pos)` is invariant under
 * font size, window width, and virtual-scroll height estimates, so the user
 * lands on exactly the line they left off on.
 *
 * `scrollTop` and `scrollProgress` are kept as fallbacks (for entries written
 * by an older version of the plugin or by views without a CodeMirror editor).
 */
export interface ScrollStateData {
	/** document position (character offset) at the top of the viewport */
	scrollPos?: number;
	/** raw scrollTop pixel value (fallback) */
	scrollTop?: number;
	/** relative scroll progress, 0..1 (used by the progress bar UI) */
	scrollProgress?: number;
	/** characters without whitespace/punctuation, for time estimates */
	charsTotal?: number;
	/** raw length of the note text, used as a cheap cache key */
	textLength?: number;
	/** ISO timestamp of the last save */
	timestamp?: string;
	/** progress at the start of the current "virtual day" (resets at 6:00) */
	progressAtDayStart?: number;
	/** whether the file has been read (>99%) */
	isRead?: boolean;
}

/** filePath -> last known reading position */
export type Database = { [filePath: string]: ScrollStateData };

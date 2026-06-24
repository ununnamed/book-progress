import { parseYaml } from "obsidian";
import { BookProgressApi } from "./types";
import { CHARS_PER_PAGE, PROGRESS_BAR_REFRESH_INTERVAL_MS } from "./settings";
import { readingTimeText } from "./helpers";
import { isNewVirtualDay } from "./utils";

interface BookBlockConfig {
	/** wiki-link to the note, e.g. "[[My Book]]" */
	name?: string;
}

const WIKILINK_REGEX = /^\[\[([^\]]+)\]\]$/;

/**
 * Matches a "reset" directive line in a ```book``` block. Accepts a bare
 * keyword (`reset`, `сброс`, `сбросить`) or a `key: true`-style line, in
 * English or Russian. A line like `reset: false` is intentionally NOT a
 * match, so the control can be disarmed without deleting the line.
 */
const RESET_LINE_REGEX =
	/^\s*(reset|сброс|сбросить)\s*:?\s*(true|yes|on|да|1)?\s*$/i;

/**
 * Renders ```book``` code blocks: a progress bar + "P/T pages (X%) • time left"
 * for the note referenced by `name: "[[Note]]"`. Reads everything from
 * `plugin.database`, the same in-memory store the scroll tracker writes to.
 */
export class ProgressBarRenderer {
	constructor(private plugin: BookProgressApi) {}

	register(): void {
		this.plugin.registerMarkdownCodeBlockProcessor("book", (source, el) => {
			void this.render(el, source);
		});

		// re-render visible bars when the underlying reading position changes
		this.plugin.registerInterval(
			window.setInterval(() => this.refreshAll(), PROGRESS_BAR_REFRESH_INTERVAL_MS)
		);
	}

	/**
	 * Splits the raw block source into a parsed config plus a flag telling us
	 * whether a reset control was requested. The reset line(s) are stripped
	 * before the rest is handed to the YAML parser, so mixing a bare keyword
	 * with `name: "[[...]]"` stays valid.
	 */
	private parseSource(source: string): { config: BookBlockConfig; reset: boolean } {
		let reset = false;
		const kept: string[] = [];
		for (const line of source.split(/\r?\n/)) {
			if (RESET_LINE_REGEX.test(line)) {
				reset = true;
				continue;
			}
			kept.push(line);
		}

		let config: BookBlockConfig = {};
		const cleaned = kept.join("\n").trim();
		if (cleaned) {
			config = (parseYaml(cleaned) ?? {}) as BookBlockConfig;
		}
		return { config, reset };
	}

	private extractLink(name: string | undefined): string | null {
		if (!name) return null;
		const match = name.match(WIKILINK_REGEX);
		return match ? match[1] : null;
	}

	private async render(el: HTMLElement, source: string): Promise<void> {
		let parsed: { config: BookBlockConfig; reset: boolean };
		try {
			parsed = this.parseSource(source);
		} catch {
			this.renderError(el, "Cannot parse the YAML.");
			return;
		}
		const { config, reset } = parsed;

		el.empty();
		el.addClass("bp-progress");
		el.setAttribute("data-progress-container", "true");
		el.setAttribute("data-progress-source", source);

		const linkText = this.extractLink(config.name);
		if (!linkText) {
			this.renderError(el, 'Specify a note link, e.g.  name: "[[My Book]]"');
			return;
		}

		const file = this.plugin.app.metadataCache.getFirstLinkpathDest(linkText, "");

		const link = el.createEl("a", {
			text: linkText,
			cls: "internal-link bp-book-link",
		});
		link.setAttribute("href", linkText);
		link.setAttribute("data-href", linkText);

		if (!file) {
			el.createEl("div", { cls: "bp-progress-info", text: "File not found." });
			return;
		}

		const data = this.plugin.getScrollData(file.path);
		let charsTotal = data?.charsTotal ?? 0;
		let scrollProgress = data?.scrollProgress ?? 0;

		// fallback: the file was never opened yet, compute the char count once
		if (!charsTotal) {
			try {
				const content = await this.plugin.app.vault.cachedRead(file);
				charsTotal = content.replace(/[\s\p{P}]+/gu, "").length;
			} catch (e) {
				console.error("BookProgress: cannot read file", e);
			}
		}

		const isRead = data?.isRead === true || scrollProgress > 0.99;
		if (isRead) {
			scrollProgress = Math.max(scrollProgress, 1);
		}

		const readChars = Math.round(scrollProgress * charsTotal);
		const remainingChars = Math.max(0, charsTotal - readChars);
		const percentage = charsTotal > 0 ? (readChars / charsTotal) * 100 : 0;
		const totalPages = Math.max(1, Math.ceil(charsTotal / CHARS_PER_PAGE));
		const readPages = Math.min(totalPages, Math.ceil(readChars / CHARS_PER_PAGE));

		// pages read during the current virtual day (rolls over at 06:00).
		// If the last save was on an earlier day, today's count is 0 even
		// though the stored baseline still points at yesterday.
		const staleDay = isNewVirtualDay(data?.timestamp, new Date());
		const dayStartProgress = staleDay ? scrollProgress : data?.progressAtDayStart ?? 0;
		const readTodayChars = Math.max(
			0,
			Math.round((scrollProgress - dayStartProgress) * charsTotal)
		);
		const readTodayPages = Math.round(readTodayChars / CHARS_PER_PAGE);

		// state used by refreshAll to decide whether a re-render is needed
		el.setAttribute("data-progress-file", file.path);
		el.setAttribute("data-progress-value", String(scrollProgress));

		const wrapper = el.createEl("div", { cls: "bp-progress-wrapper" });

		const finished = percentage >= 99;
		const track = wrapper.createEl("div", { cls: "bp-bar-track" });
		const fill = track.createEl("div", { cls: "bp-bar-fill" });
		fill.style.width = `${Math.min(100, Math.max(0, percentage))}%`;
		if (finished) {
			track.addClass("is-finished");
			fill.addClass("is-finished");
		}

		const pct = wrapper.createEl("span", {
			cls: "bp-progress-pct",
			text: `${percentage.toFixed(1)}%`,
		});
		if (finished) {
			pct.addClass("is-finished");
		}

		const pagesWord = totalPages === 1 ? "page" : "pages";
		const timeLeft = readingTimeText(remainingChars, this.plugin.settings);
		const status = isRead ? " (finished)" : "";

		const info = el.createEl("div", { cls: "bp-progress-info" });
		// read pages so far, e.g. "55"
		info.createSpan({ text: `${readPages}` });
		// pages read today, inlined and green, e.g. "+50" — hidden when 0
		if (readTodayPages > 0) {
			info.createSpan({ cls: "bp-today", text: `+${readTodayPages}` });
		}
		// "/156 pages (X%) • time left (finished)"
		info.createSpan({
			text: `/${totalPages} ${pagesWord} (${percentage.toFixed(
				1
			)}%) \u2022 ${timeLeft}${status}`,
		});

		if (reset) {
			this.renderResetControl(el, file.path, source);
		}
	}

	/**
	 * Renders the "reset progress" control. Arming it requires writing the
	 * keyword in the block; the actual wipe still needs a deliberate click,
	 * so simply viewing a dashboard never destroys data.
	 */
	private renderResetControl(el: HTMLElement, filePath: string, source: string): void {
		const row = el.createEl("div", { cls: "bp-reset-row" });
		const btn = row.createEl("button", {
			cls: "bp-reset-btn",
			text: "Reset progress",
		});
		btn.addEventListener("click", () => {
			void (async () => {
				btn.disabled = true;
				await this.plugin.resetProgress(filePath);
				// re-render from the same source so the bar drops back to 0%
				void this.render(el, source);
			})();
		});
	}

	private refreshAll(): void {
		const containers = this.plugin.app.workspace.containerEl.querySelectorAll(
			"[data-progress-container]"
		);

		containers.forEach((node) => {
			const el = node as HTMLElement;
			const filePath = el.getAttribute("data-progress-file");
			if (!filePath) return;

			const data = this.plugin.getScrollData(filePath);
			if (!data) return;

			const previous = parseFloat(el.getAttribute("data-progress-value") ?? "NaN");
			const current = data.scrollProgress ?? 0;

			if (isNaN(previous) || Math.abs(current - previous) > 0.001) {
				const source = el.getAttribute("data-progress-source");
				if (source === null) return;
				try {
					void this.render(el, source);
				} catch (e) {
					console.error("BookProgress: refresh failed", e);
				}
			}
		});
	}

	private renderError(el: HTMLElement, message: string): void {
		el.empty();
		el.addClass("bp-progress");
		el.createEl("div", { cls: "bp-progress-error", text: message });
	}
}

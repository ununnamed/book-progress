import { parseYaml } from "obsidian";
import type BookProgressPlugin from "./main";
import { CHARS_PER_PAGE, PROGRESS_BAR_REFRESH_INTERVAL_MS } from "./settings";
import { readingTimeText } from "./helpers";

interface BookBlockConfig {
	/** wiki-link to the note, e.g. "[[My Book]]" */
	name?: string;
}

const WIKILINK_REGEX = /^\[\[([^\]]+)\]\]$/;

/**
 * Renders ```book``` code blocks: a progress bar + "P/T pages (X%) • time left"
 * for the note referenced by `name: "[[Note]]"`. Reads everything from
 * `plugin.database`, the same in-memory store the scroll tracker writes to.
 */
export class ProgressBarRenderer {
	constructor(private plugin: BookProgressPlugin) {}

	register(): void {
		this.plugin.registerMarkdownCodeBlockProcessor("book", (source, el) => {
			let config: BookBlockConfig;
			try {
				config = (parseYaml(source) ?? {}) as BookBlockConfig;
			} catch {
				this.renderError(el, "Cannot parse the YAML.");
				return;
			}
			void this.render(el, config);
		});

		// re-render visible bars when the underlying reading position changes
		this.plugin.registerInterval(
			window.setInterval(() => this.refreshAll(), PROGRESS_BAR_REFRESH_INTERVAL_MS)
		);
	}

	private extractLink(name: string | undefined): string | null {
		if (!name) return null;
		const match = name.match(WIKILINK_REGEX);
		return match ? match[1] : null;
	}

	private async render(el: HTMLElement, config: BookBlockConfig): Promise<void> {
		el.empty();
		el.addClass("bp-progress");
		el.setAttribute("data-progress-container", "true");
		el.setAttribute("data-progress-config", JSON.stringify(config));

		const linkText = this.extractLink(config.name);
		if (!linkText) {
			this.renderError(el, 'Specify a note link, e.g.  name: "[[My Book]]"');
			return;
		}

		const file = this.plugin.app.metadataCache.getFirstLinkpathDest(linkText, "");

		const link = el.createEl("a", { text: linkText, cls: "internal-link" });
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

		// state used by refreshAll to decide whether a re-render is needed
		el.setAttribute("data-progress-file", file.path);
		el.setAttribute("data-progress-value", String(scrollProgress));

		const wrapper = el.createEl("div", { cls: "bp-progress-wrapper" });

		const bar = wrapper.createEl("progress");
		bar.value = readChars;
		bar.max = charsTotal || 100;

		const pct = wrapper.createEl("span", {
			cls: "bp-progress-pct",
			text: `${percentage.toFixed(1)}%`,
		});
		if (percentage >= 99) {
			pct.addClass("is-finished");
		}

		const pagesWord = totalPages === 1 ? "page" : "pages";
		const timeLeft = readingTimeText(remainingChars, this.plugin.settings);
		const status = isRead ? " (finished)" : "";
		el.createEl("div", {
			cls: "bp-progress-info",
			text: `${readPages}/${totalPages} ${pagesWord} (${percentage.toFixed(
				1
			)}%) \u2022 ${timeLeft}${status}`,
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
				const configJson = el.getAttribute("data-progress-config");
				if (!configJson) return;
				try {
					void this.render(el, JSON.parse(configJson) as BookBlockConfig);
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

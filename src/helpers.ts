import prettyMilliseconds from "pretty-ms";
import { Settings } from "./settings";

/**
 * Formats the remaining reading time for `charCount` characters
 * (characters counted without whitespace/punctuation).
 *
 * The reading speed is taken from the settings in words-per-minute and
 * multiplied by 5 to approximate characters-per-minute. Single source of
 * truth shared by the status bar and the `book` code block.
 *
 * Output examples ("Default" style):
 *   "0 min left"   — under a minute
 *   "12m left"     — under an hour (compact, single unit)
 *   "2h 14m left"  — over an hour (two units)
 */
export function readingTimeText(charCount: number, settings: Settings): string {
	const wordsPerMinute = settings.readingSpeed || 200;
	const charsPerMinute = wordsPerMinute * 5;

	const minutesFloat = charsPerMinute > 0 ? charCount / charsPerMinute : 0;
	const timeMs = Math.round(minutesFloat * 60 * 1000);

	const append = settings.appendText ? ` ${settings.appendText}` : "";

	if (timeMs < 60_000) {
		return `0 min${append}`;
	}

	const options: prettyMilliseconds.Options =
		timeMs > 3_600_000
			? { secondsDecimalDigits: 0, unitCount: 2 }
			: { secondsDecimalDigits: 0, compact: true };

	return `${prettyMilliseconds(timeMs, options)}${append}`;
}

import { WorkspaceLeaf } from "obsidian";

export const INVALID_FILE_IDENTIFIER = "[INVALID_FILE_IDENTIFIER]";

export function copySerializable<T>(objectToCopy: T): T {
	return JSON.parse(JSON.stringify(objectToCopy)) as T;
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * A "virtual day" rolls over at 6:00 in the morning instead of at midnight,
 * so late-night reading still counts toward the same day. Returns true when
 * `current` falls on a different virtual day than `previousTimestamp`.
 *
 * Shared by the scroll tracker (to reset the per-day baseline) and the
 * `book` block (to zero out "today" when the last save was on an earlier day).
 */
export function isNewVirtualDay(
	previousTimestamp: string | undefined,
	current: Date
): boolean {
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

export function serializeError(error: unknown): string {
	if (!error) {
		return "[empty-error]";
	}
	if (typeof error === "string") {
		return error;
	}
	if (error instanceof Error) {
		return error.message || "[no message]";
	}
	try {
		const serialized = JSON.stringify(error);
		return serialized === "{}" ? String(error) : serialized;
	} catch {
		return String(error);
	}
}

function getLeafId(leaf: WorkspaceLeaf): string {
	const id = (leaf as unknown as { id?: unknown }).id;
	if (typeof id !== "string" || !id) {
		return "[NO_LEAF_ID]";
	}
	return id;
}

/**
 * Creates a unique identifier for a specific file within a specific leaf
 * (a leaf is e.g. a tab; the same file can be open in several tabs).
 */
export function createFileIdentifier(leaf: WorkspaceLeaf | null): string | null {
	const correspondingFile = leaf?.getViewState().state?.file;
	if (!correspondingFile) {
		return null;
	}
	return getLeafId(leaf) + ":" + String(correspondingFile);
}

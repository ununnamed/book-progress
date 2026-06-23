import { WorkspaceLeaf } from "obsidian";

export const INVALID_FILE_IDENTIFIER = "[INVALID_FILE_IDENTIFIER]";

export function copySerializable<T>(objectToCopy: T): T {
	return JSON.parse(JSON.stringify(objectToCopy));
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
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
	const id = (leaf as any).id;
	if (!id || typeof id !== "string") {
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
	return getLeafId(leaf) + ":" + correspondingFile;
}

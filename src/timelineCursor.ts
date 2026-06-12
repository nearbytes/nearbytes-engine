/**
 * Per-volume timeline cursor — shared by NearbytesEngine and the CLI shell.
 * Keyed by channel secret so both hub labels and volume-session names map to
 * the same replay semantics.
 */
import type { FileService } from 'nearbytes-files';

export type TimelineCursorMap = Map<string, string>;

export function createTimelineCursorMap(): TimelineCursorMap {
  return new Map();
}

export function getTimelineCursor(cursors: TimelineCursorMap, secret: string): string | null {
  return cursors.get(secret) ?? null;
}

export function setTimelineCursor(
  cursors: TimelineCursorMap,
  secret: string,
  hash: string | null,
): void {
  if (hash === null) cursors.delete(secret);
  else cursors.set(secret, hash);
}

export function clearTimelineCursor(cursors: TimelineCursorMap, secret: string): void {
  cursors.delete(secret);
}

export function assertTimelineWritesAllowed(cursors: TimelineCursorMap, secret: string): void {
  if (getTimelineCursor(cursors, secret) !== null) {
    throw new Error('Timeline is not at live head — run `timeline live` before mutating files');
  }
}

export function replayThroughOptions(
  cursors: TimelineCursorMap,
  secret: string,
): { readonly throughEventHash: string } | undefined {
  const hash = getTimelineCursor(cursors, secret);
  return hash !== null ? { throughEventHash: hash } : undefined;
}

/** Set cursor to an inclusive event hash; returns the stored cursor (`null` at live head). */
export async function timelineGotoAtEvent(
  fileService: FileService,
  cursors: TimelineCursorMap,
  secret: string,
  eventHash: string,
): Promise<string | null> {
  const replay = await fileService.getReplayContext(secret);
  const replayIdx = replay.orderedEntries.findIndex((e) => e.eventHash === eventHash);
  if (replayIdx < 0) throw new Error(`Event not in replay log: ${eventHash}`);
  const atHead = replayIdx === replay.orderedEntries.length - 1;
  const cursor = atHead ? null : eventHash;
  setTimelineCursor(cursors, secret, cursor);
  return cursor;
}

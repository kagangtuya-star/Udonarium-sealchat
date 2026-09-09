import { EventSystem } from '../system';

export function normalizeLibraryDeleteIds(identifiers: string[]): string[] {
  return Array.from(new Set((identifiers || []).map(id => (id || '').trim()).filter(id => !!id)));
}

/** Tombstone each id, then optional catalog sync. */
export function applyLocalLibraryDelete(
  identifiers: string[],
  applyOne: (id: string) => void,
  after?: () => void,
): string[] {
  const ids = normalizeLibraryDeleteIds(identifiers);
  for (const id of ids) applyOne(id);
  if (ids.length) after?.();
  return ids;
}

/** Apply locally then tell connected peers to delete the same files. */
export function deleteLibraryFiles(
  eventName: string,
  identifiers: string[],
  applyLocal: (identifiers: string[]) => string[],
): string[] {
  const deleted = applyLocal(identifiers);
  if (deleted.length) EventSystem.call(eventName, { identifiers: deleted });
  return deleted;
}

export function applyLocalLibraryRevive(
  identifiers: string[],
  revive: (id: string) => void,
): void {
  for (const id of normalizeLibraryDeleteIds(identifiers)) revive(id);
}

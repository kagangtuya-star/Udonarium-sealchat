import { ResettableTimeout } from '../system/util/resettable-timeout';
import { catalogByteSize } from './file-transfer-scheduler';
import { isUrlBackedMediaIdentifier } from './media-identifier';
import { isContentHashIdentifier, mediaHashFromName } from 'service/folder-backup-layout';

/** Shared A/P/V catalog row (no image thumbBytes). */
export type MediaCatalogItem = {
  readonly identifier: string;
  readonly state: number;
  readonly byteSize?: number;
};

/** Floor for lazySynchronize; remesh/request timing depends on this. */
export const MEDIA_LAZY_SYNC_MIN_MS = 1500;

/** Debounced catalog publish with stop-on-immediate synchronize. */
export class LazyCatalogSynchronizer {
  private lazyTimer: ResettableTimeout | null = null;

  constructor(private readonly publish: (peer?: string) => void) {}

  synchronize(peer?: string): void {
    if (this.lazyTimer) this.lazyTimer.stop();
    this.publish(peer);
  }

  lazySynchronize(ms: number, peer?: string): void {
    const delay = Math.max(ms, MEDIA_LAZY_SYNC_MIN_MS);
    if (this.lazyTimer == null) {
      this.lazyTimer = new ResettableTimeout(() => this.synchronize(peer), delay);
    }
    this.lazyTimer.reset(delay);
  }
}

/** Packed ZIP/folder restore: reuse COMPLETE hash hit, else createPacked + store. */
export async function addPackedByContentHash<T extends { state: number }>(options: {
  file: File;
  completeState: number;
  get: (hash: string) => T | null | undefined;
  addAsync: (file: File) => Promise<T>;
  createPacked: (file: File, hash: string) => Promise<T>;
  store: (file: T) => T;
}): Promise<T> {
  const hash = mediaHashFromName(options.file.name);
  if (!isContentHashIdentifier(hash)) return options.addAsync(options.file);
  const existing = options.get(hash);
  if (existing && existing.state >= options.completeState) return existing;
  return options.store(await options.createPacked(options.file, hash));
}

/** COMPLETE → lazy sync; update-or-insert into the identifier hash. */
export function insertOrUpdateMediaFile<T extends { identifier: string; state: number }>(options: {
  hash: { [identifier: string]: T };
  file: T;
  completeState: number;
  lazySynchronize: (ms: number) => void;
  tryUpdate: (file: T) => boolean;
}): T {
  if (options.file.state === options.completeState) options.lazySynchronize(100);
  if (options.tryUpdate(options.file)) return options.hash[options.file.identifier];
  options.hash[options.file.identifier] = options.file;
  return options.file;
}

export function deleteMediaFromHash<T extends { destroy(): void }>(
  hash: { [identifier: string]: T },
  identifier: string,
): boolean {
  const file = hash[identifier];
  if (!file) return false;
  file.destroy();
  delete hash[identifier];
  return true;
}

export function getFromHash<T>(
  hash: { [identifier: string]: T },
  identifier: string,
): T | null {
  return hash[identifier] || null;
}

/**
 * Lookup by id; if missing and id is a path/HTTP asset, create + store locally.
 * COMPLETE-only catalogs never advertise URL assets to joiners — hydrate on read.
 */
export function getOrHydrateUrlBacked<T>(options: {
  hash: { [identifier: string]: T };
  identifier: string;
  createUrlBacked: (identifier: string) => T;
  store: (file: T) => T;
}): T | null {
  if (!options.identifier) return null;
  const existing = options.hash[options.identifier];
  if (existing) return existing;
  if (!isUrlBackedMediaIdentifier(options.identifier)) return null;
  return options.store(options.createUrlBacked(options.identifier));
}

/** Session-only ids that P2P catalog sync must not resurrect. */
export class SessionTombstones {
  private readonly ids = new Set<string>();

  has(identifier: string): boolean {
    return !!identifier && this.ids.has(identifier);
  }

  identifiers(): string[] {
    return Array.from(this.ids);
  }

  add(identifier: string): boolean {
    if (!identifier) return false;
    this.ids.add(identifier);
    return true;
  }

  remove(identifier: string): void {
    if (!identifier) return;
    this.ids.delete(identifier);
  }

  clear(): void {
    this.ids.clear();
  }

  /** Clear tombstone then store; `wasDeleted` is for broadcasting revive. */
  reviveThenStore<T extends { identifier: string }>(
    file: T,
    store: (file: T) => T,
  ): { stored: T; wasDeleted: boolean } {
    const wasDeleted = this.has(file.identifier);
    this.remove(file.identifier);
    return { stored: store(file), wasDeleted };
  }

  /** If tombstoned, return the existing hash entry (or `file`) so callers skip insert. */
  blockedAdd<T extends { identifier: string }>(
    hash: { [identifier: string]: T },
    file: T,
  ): T | null {
    if (!this.has(file.identifier)) return null;
    return hash[file.identifier] || file;
  }
}

/** Advertise COMPLETE blob assets only (never URL / in-progress). */
export function buildCompleteBlobCatalog(
  files: ReadonlyArray<{ identifier: string; state: number; blob?: Blob | null }>,
  completeState: number,
): MediaCatalogItem[] {
  const catalog: MediaCatalogItem[] = [];
  for (const file of files) {
    if (file.state !== completeState) continue;
    catalog.push({
      identifier: file.identifier,
      state: file.state,
      byteSize: catalogByteSize(file.blob),
    });
  }
  return catalog;
}

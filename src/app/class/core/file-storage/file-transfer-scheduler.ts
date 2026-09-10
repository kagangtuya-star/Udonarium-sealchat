import { AudioState } from './audio-file';
import {
  FileSyncPriorityTier,
  JUKEBOX_OBJECT_ID,
  clearPlayingMusicCache,
  compareFileSyncPriority,
  collectPlayingMusicIdentifiers,
  fileSyncPriorityTier,
  primePlayingMusicCache,
} from './file-sync-priority';
import { ImageState } from './image-file';
import { PdfState } from './pdf-file';
import { VideoState } from './video-file';
import { Jukebox } from '@udonarium/Jukebox';
import { EventSystem, Network } from '../system';
import { clearZeroTimeout, setZeroTimeout } from '../system/util/zero-timeout';

export type FileResourceKind = 'image' | 'audio' | 'pdf' | 'video';

/** Catalog metadata exchanged during SYNCHRONIZE_* (byteSize optional for backward compat). */
export interface TransferCatalogMeta {
  readonly identifier: string;
  readonly state: number;
  readonly byteSize?: number;
  readonly thumbBytes?: number;
}

interface PendingReceiveRequest {
  kind: FileResourceKind;
  peerId: string;
  identifier: string;
  bytes: number;
  execute: () => void;
}

const DEFAULT_UNKNOWN_BYTES = 999_999_999;
const DEFAULT_THUMB_BYTES = 4_096;
/** Wait before re-requesting after a canceled/failed receive (avoids cancel loops). */
const RECEIVE_RETRY_BACKOFF_MS = 5_000;
const OUTBOUND_PENDING_TIMEOUT_MS = 30_000;

export class FileReceiveScheduler {
  private static readonly MAX_CONCURRENT_RECEIVES = 4;
  private static activeReceives = new Set<string>();
  /** Slots reserved when a REQUEST is sent, before START_*_TRANSMISSION arrives. */
  private static outboundPending = new Set<string>();
  /** Full request retained so yield / outbound timeout can re-queue instead of orphaning. */
  private static outboundRequests = new Map<string, PendingReceiveRequest>();
  private static pending: PendingReceiveRequest[] = [];
  private static scheduleTimer: number | null = null;
  private static peerRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static receiveRetryAfter = new Map<string, number>();
  private static networkHooksRegistered = false;
  private static playingMusicPriorityKey = '';
  /**
   * Join probe needs the DataChannel for game-table object sync first.
   * Catalogs may still enqueue; dispatch resumes when the hold clears.
   */
  private static joinProbeHold = false;

  static ensureNetworkHooks(): void {
    if (FileReceiveScheduler.networkHooksRegistered) return;
    FileReceiveScheduler.networkHooksRegistered = true;
    EventSystem.register(FileReceiveScheduler)
      .on('CONNECT_PEER', () => {
        FileReceiveScheduler.clearPeerRetryTimers();
        FileReceiveScheduler.schedule();
      })
      .on('DISCONNECT_PEER', event => {
        FileReceiveScheduler.abortRequestsForPeer(event.data.peerId);
      })
      // Inbound apply uses markForChanged → identifier/aliasName events (not plain UPDATE_GAME_OBJECT).
      .on(`UPDATE_GAME_OBJECT/identifier/${JUKEBOX_OBJECT_ID}`, () => {
        FileReceiveScheduler.onPlayingMusicMaybeChanged();
      })
      .on(`UPDATE_GAME_OBJECT/aliasName/${Jukebox.aliasName}`, () => {
        FileReceiveScheduler.onPlayingMusicMaybeChanged();
      })
      .on('UPDATE_GAME_OBJECT', event => {
        if (event.data?.identifier !== JUKEBOX_OBJECT_ID) return;
        FileReceiveScheduler.onPlayingMusicMaybeChanged();
      });
  }

  /**
   * Drop queued / outbound slots aimed at a peer that left.
   * Active receives are canceled by BufferSharingTask DISCONNECT handlers.
   * Does not set receiveRetryAfter — peer death is not a transfer failure; other peers may serve the file immediately.
   */
  static abortRequestsForPeer(peerId: string): void {
    if (!peerId) return;
    FileReceiveScheduler.pending = FileReceiveScheduler.pending.filter(p => p.peerId !== peerId);
    const dropKeys: string[] = [];
    for (const [key, req] of FileReceiveScheduler.outboundRequests) {
      if (req.peerId === peerId) dropKeys.push(key);
    }
    for (const key of dropKeys) {
      FileReceiveScheduler.outboundPending.delete(key);
      FileReceiveScheduler.outboundRequests.delete(key);
    }
    const retryTimer = FileReceiveScheduler.peerRetryTimers.get(peerId);
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      FileReceiveScheduler.peerRetryTimers.delete(peerId);
    }
    FileReceiveScheduler.scheduleDeferred();
  }

  /** Re-sort pending downloads when room jukebox playing ids change. */
  private static onPlayingMusicMaybeChanged(): void {
    const key = [...collectPlayingMusicIdentifiers()].sort().join('\0');
    if (key === FileReceiveScheduler.playingMusicPriorityKey) return;
    FileReceiveScheduler.playingMusicPriorityKey = key;
    if (FileReceiveScheduler.pending.length < 1) return;
    // Re-log under a distinct label so PLAYING_AUDIO is visible after late jukebox sync.
    FileReceiveScheduler.loggedReceiveKeys.clear();
    FileReceiveScheduler.pendingReceiveOrderLogKind = 'reprioritized';
    FileReceiveScheduler.scheduleDeferred();
  }

  private static clearPeerRetryTimers() {
    for (const timer of FileReceiveScheduler.peerRetryTimers.values()) clearTimeout(timer);
    FileReceiveScheduler.peerRetryTimers.clear();
  }

  private static isPeerOpen(peerId: string): boolean {
    return !!peerId && Network.peerIds.includes(peerId);
  }

  private static schedulePeerRetry(peerId: string) {
    if (FileReceiveScheduler.peerRetryTimers.has(peerId)) return;
    FileReceiveScheduler.peerRetryTimers.set(peerId, setTimeout(() => {
      FileReceiveScheduler.peerRetryTimers.delete(peerId);
      FileReceiveScheduler.schedule();
    }, 400));
  }

  static isTransferActive(kind: FileResourceKind, identifier: string): boolean {
    const key = FileReceiveScheduler.receiveKey(kind, identifier);
    return FileReceiveScheduler.activeReceives.has(key) || FileReceiveScheduler.outboundPending.has(key);
  }

  static canEnqueueReceive(kind: FileResourceKind, identifier: string): boolean {
    if (FileReceiveScheduler.isTransferActive(kind, identifier)) return false;
    const key = FileReceiveScheduler.receiveKey(kind, identifier);
    return performance.now() >= (FileReceiveScheduler.receiveRetryAfter.get(key) ?? 0);
  }

  static noteReceiveEnded(kind: FileResourceKind, identifier: string, success: boolean): void {
    const key = FileReceiveScheduler.receiveKey(kind, identifier);
    if (success) {
      FileReceiveScheduler.receiveRetryAfter.delete(key);
      return;
    }
    FileReceiveScheduler.receiveRetryAfter.set(key, performance.now() + RECEIVE_RETRY_BACKOFF_MS);
  }

  static receiveKey(kind: FileResourceKind, identifier: string): string {
    return `${kind}:${identifier}`;
  }

  static activeReceiveCount(): number {
    return FileReceiveScheduler.activeReceives.size;
  }

  static pendingReceiveCount(): number {
    return FileReceiveScheduler.pending.length;
  }

  static outboundPendingCount(): number {
    return FileReceiveScheduler.outboundPending.size;
  }

  /** Estimated bytes still queued for receive (catalog sizes; unknown → counted separately). */
  static pendingReceiveBytes(): { knownBytes: number; unknownCount: number } {
    let knownBytes = 0;
    let unknownCount = 0;
    for (const p of FileReceiveScheduler.pending) {
      if (!Number.isFinite(p.bytes) || p.bytes < 0 || p.bytes >= DEFAULT_UNKNOWN_BYTES) {
        unknownCount++;
      } else {
        knownBytes += p.bytes;
      }
    }
    return { knownBytes, unknownCount };
  }

  /** Pending receive counts by kind (for mesh diag). */
  static pendingReceiveCountsByKind(): Record<FileResourceKind, number> {
    const counts: Record<FileResourceKind, number> = { image: 0, audio: 0, pdf: 0, video: 0 };
    for (const p of FileReceiveScheduler.pending) {
      counts[p.kind] = (counts[p.kind] || 0) + 1;
    }
    return counts;
  }

  static isTransferPending(kind: FileResourceKind, identifier: string): boolean {
    const key = FileReceiveScheduler.receiveKey(kind, identifier);
    return FileReceiveScheduler.pending.some(
      p => FileReceiveScheduler.receiveKey(p.kind, p.identifier) === key,
    );
  }

  static hasFileSyncActivity(): boolean {
    return FileReceiveScheduler.activeReceives.size > 0
      || FileReceiveScheduler.outboundPending.size > 0
      || FileReceiveScheduler.pending.length > 0;
  }

  private static reservedReceiveCount(): number {
    return FileReceiveScheduler.activeReceives.size + FileReceiveScheduler.outboundPending.size;
  }

  static isReceiveBudgetFull(): boolean {
    return FileReceiveScheduler.reservedReceiveCount() >= FileReceiveScheduler.MAX_CONCURRENT_RECEIVES;
  }

  static markReceiveStart(kind: FileResourceKind, identifier: string): void {
    const key = FileReceiveScheduler.receiveKey(kind, identifier);
    FileReceiveScheduler.outboundPending.delete(key);
    FileReceiveScheduler.outboundRequests.delete(key);
    // Drop any yielded re-queue; transfer has started.
    FileReceiveScheduler.pending = FileReceiveScheduler.pending.filter(
      p => FileReceiveScheduler.receiveKey(p.kind, p.identifier) !== key,
    );
    FileReceiveScheduler.activeReceives.add(key);
  }

  static markReceiveEnd(kind: FileResourceKind, identifier: string): void {
    const key = FileReceiveScheduler.receiveKey(kind, identifier);
    FileReceiveScheduler.outboundPending.delete(key);
    FileReceiveScheduler.outboundRequests.delete(key);
    FileReceiveScheduler.activeReceives.delete(key);
    FileReceiveScheduler.schedule();
  }

  /** Drop queued / in-flight receive for a library delete. */
  static abortReceive(kind: FileResourceKind, identifier: string): void {
    const key = FileReceiveScheduler.receiveKey(kind, identifier);
    FileReceiveScheduler.pending = FileReceiveScheduler.pending.filter(
      p => FileReceiveScheduler.receiveKey(p.kind, p.identifier) !== key,
    );
    FileReceiveScheduler.outboundPending.delete(key);
    FileReceiveScheduler.outboundRequests.delete(key);
    FileReceiveScheduler.activeReceives.delete(key);
    FileReceiveScheduler.receiveRetryAfter.delete(key);
    FileReceiveScheduler.schedule();
  }

  /** REQUEST never left the client (e.g. peer DataChannel not open yet). */
  static abortOutboundRequest(kind: FileResourceKind, identifier: string): void {
    FileReceiveScheduler.releaseOutboundToPending(
      FileReceiveScheduler.receiveKey(kind, identifier),
    );
    FileReceiveScheduler.scheduleDeferred();
  }

  /** Queue a download request; thumbs → playing BGM → full images → other media by size. */
  static enqueueReceiveRequest(
    kind: FileResourceKind,
    peerId: string,
    identifier: string,
    bytes: number,
    execute: () => void
  ): void {
    FileReceiveScheduler.ensureNetworkHooks();
    const key = FileReceiveScheduler.receiveKey(kind, identifier);
    if (!FileReceiveScheduler.canEnqueueReceive(kind, identifier)) return;
    FileReceiveScheduler.pending = FileReceiveScheduler.pending.filter(
      p => FileReceiveScheduler.receiveKey(p.kind, p.identifier) !== key
    );
    FileReceiveScheduler.pending.push({ kind, peerId, identifier, bytes, execute });
    FileReceiveScheduler.scheduleDeferred();
  }

  /** Coalesce enqueue bursts (e.g. image + audio + pdf sync) into one priority-ordered dispatch. */
  static scheduleDeferred(): void {
    if (FileReceiveScheduler.scheduleTimer != null) return;
    FileReceiveScheduler.scheduleTimer = setZeroTimeout(() => {
      FileReceiveScheduler.scheduleTimer = null;
      FileReceiveScheduler.schedule();
    });
  }

  /** Pause bulk file receives while a lobby join probe waits for game-table. */
  static beginJoinProbeHold(): void {
    if (FileReceiveScheduler.joinProbeHold) return;
    FileReceiveScheduler.joinProbeHold = true;
    console.warn('[file-sync] join probe hold — defer receives until tabletop sync');
  }

  /** Resume file receives after join probe settles (success or fail). */
  static endJoinProbeHold(): void {
    if (!FileReceiveScheduler.joinProbeHold) return;
    FileReceiveScheduler.joinProbeHold = false;
    console.warn(
      `[file-sync] join probe hold released — pending=${FileReceiveScheduler.pending.length}`,
    );
    FileReceiveScheduler.schedule();
  }

  static isJoinProbeHold(): boolean {
    return FileReceiveScheduler.joinProbeHold;
  }

  static schedule(): void {
    if (FileReceiveScheduler.joinProbeHold) return;
    primePlayingMusicCache();
    try {
      FileReceiveScheduler.pending.sort((a, b) => compareFileSyncPriority(
        a.kind, a.identifier, a.bytes,
        b.kind, b.identifier, b.bytes,
      ));
      FileReceiveScheduler.yieldHigherTiersForPhase();
      // Yield may have re-queued outbound items — keep priority order.
      FileReceiveScheduler.pending.sort((a, b) => compareFileSyncPriority(
        a.kind, a.identifier, a.bytes,
        b.kind, b.identifier, b.bytes,
      ));
      FileReceiveScheduler.logReceiveQueueOrderOnce();
      while (!FileReceiveScheduler.isReceiveBudgetFull() && FileReceiveScheduler.pending.length > 0) {
        const phase = FileReceiveScheduler.lowestDispatchablePhaseTier();
        if (phase == null) break;
        const nextIndex = FileReceiveScheduler.pending.findIndex(
          p => fileSyncPriorityTier(p.kind, p.identifier) === phase
            && !FileReceiveScheduler.outboundPending.has(FileReceiveScheduler.receiveKey(p.kind, p.identifier))
            && !FileReceiveScheduler.activeReceives.has(FileReceiveScheduler.receiveKey(p.kind, p.identifier))
            && FileReceiveScheduler.isPeerOpen(p.peerId)
        );
        if (nextIndex < 0) break;
        const next = FileReceiveScheduler.pending.splice(nextIndex, 1)[0];
        const key = FileReceiveScheduler.receiveKey(next.kind, next.identifier);
        FileReceiveScheduler.outboundPending.add(key);
        FileReceiveScheduler.outboundRequests.set(key, next);
        setTimeout(() => {
          if (FileReceiveScheduler.releaseOutboundToPending(key)) {
            FileReceiveScheduler.schedule();
          }
        }, OUTBOUND_PENDING_TIMEOUT_MS);
        next.execute();
      }
    } finally {
      clearPlayingMusicCache();
    }
  }

  /**
   * Lowest tier that can make progress now.
   * Unreachable pending peers are skipped (retry scheduled) so they do not block
   * reachable higher-tier files — those unreachable items stay queued for later.
   */
  private static lowestDispatchablePhaseTier(): FileSyncPriorityTier | null {
    let min = FileSyncPriorityTier.DEFAULT;
    let found = false;
    const consider = (tier: FileSyncPriorityTier) => {
      found = true;
      if (tier < min) min = tier;
    };
    for (const p of FileReceiveScheduler.pending) {
      const key = FileReceiveScheduler.receiveKey(p.kind, p.identifier);
      if (FileReceiveScheduler.activeReceives.has(key) || FileReceiveScheduler.outboundPending.has(key)) {
        consider(fileSyncPriorityTier(p.kind, p.identifier));
        continue;
      }
      if (FileReceiveScheduler.isPeerOpen(p.peerId)) {
        consider(fileSyncPriorityTier(p.kind, p.identifier));
      } else {
        FileReceiveScheduler.schedulePeerRetry(p.peerId);
      }
    }
    for (const key of FileReceiveScheduler.activeReceives) {
      consider(FileReceiveScheduler.tierForReceiveKey(key));
    }
    for (const key of FileReceiveScheduler.outboundPending) {
      consider(FileReceiveScheduler.tierForReceiveKey(key));
    }
    return found ? min : null;
  }

  private static tierForReceiveKey(key: string): FileSyncPriorityTier {
    const colon = key.indexOf(':');
    if (colon < 1) return FileSyncPriorityTier.DEFAULT;
    const kind = key.slice(0, colon) as FileResourceKind;
    const id = key.slice(colon + 1);
    return fileSyncPriorityTier(kind, id);
  }

  /**
   * If a lower-tier file is still pending (e.g. thumb / playing BGM just appeared),
   * return higher-tier outbound reservations to the queue so lower tier can take slots
   * and the yielded files are not orphaned.
   */
  private static yieldHigherTiersForPhase(): void {
    if (FileReceiveScheduler.pending.length < 1) return;
    let pendingMin = FileSyncPriorityTier.DEFAULT;
    let hasReachableLower = false;
    for (const p of FileReceiveScheduler.pending) {
      if (!FileReceiveScheduler.isPeerOpen(p.peerId)) continue;
      hasReachableLower = true;
      const tier = fileSyncPriorityTier(p.kind, p.identifier);
      if (tier < pendingMin) pendingMin = tier;
    }
    if (!hasReachableLower) return;
    for (const key of [...FileReceiveScheduler.outboundPending]) {
      if (FileReceiveScheduler.tierForReceiveKey(key) > pendingMin) {
        FileReceiveScheduler.releaseOutboundToPending(key);
      }
    }
  }

  /** Move an outbound reservation back to pending (yield / timeout / abort). */
  private static releaseOutboundToPending(key: string): boolean {
    if (!FileReceiveScheduler.outboundPending.delete(key)) return false;
    const req = FileReceiveScheduler.outboundRequests.get(key);
    FileReceiveScheduler.outboundRequests.delete(key);
    if (!req) return true;
    if (FileReceiveScheduler.activeReceives.has(key)) return true;
    const alreadyQueued = FileReceiveScheduler.pending.some(
      p => FileReceiveScheduler.receiveKey(p.kind, p.identifier) === key,
    );
    if (!alreadyQueued) FileReceiveScheduler.pending.push(req);
    return true;
  }

  private static loggedReceiveKeys = new Set<string>();
  /**
   * Consumed by the next successful receive-order log, then reset to `queued`.
   * Set to `reprioritized` only from jukebox playing-id changes.
   */
  private static pendingReceiveOrderLogKind: 'queued' | 'reprioritized' = 'queued';

  /**
   * Log pending receive order only when new file(s) enter the queue,
   * or when jukebox reprioritization forces a re-log.
   * Shrinking the queue (dispatch progress) must not re-log 73→72→71…
   */
  private static logReceiveQueueOrderOnce(): void {
    if (FileReceiveScheduler.pending.length < 1) {
      FileReceiveScheduler.loggedReceiveKeys.clear();
      FileReceiveScheduler.pendingReceiveOrderLogKind = 'queued';
      return;
    }
    let hasNew = false;
    for (const p of FileReceiveScheduler.pending) {
      const key = FileReceiveScheduler.receiveKey(p.kind, p.identifier);
      if (!FileReceiveScheduler.loggedReceiveKeys.has(key)) {
        hasNew = true;
        break;
      }
    }
    if (!hasNew) {
      // Do not leave a sticky `reprioritized` label for a later unrelated enqueue log.
      FileReceiveScheduler.pendingReceiveOrderLogKind = 'queued';
      return;
    }
    for (const p of FileReceiveScheduler.pending) {
      FileReceiveScheduler.loggedReceiveKeys.add(
        FileReceiveScheduler.receiveKey(p.kind, p.identifier),
      );
    }
    const rows = FileReceiveScheduler.pending.map((p, index) => ({
      order: index + 1,
      tier: FileSyncPriorityTier[fileSyncPriorityTier(p.kind, p.identifier)],
      kind: p.kind,
      id: p.identifier,
      bytes: p.bytes,
      size: formatByteSize(p.bytes),
    }));
    const kind = FileReceiveScheduler.pendingReceiveOrderLogKind;
    FileReceiveScheduler.pendingReceiveOrderLogKind = 'queued';
    const label = kind === 'reprioritized'
      ? `[file-sync] receive order (reprioritized, ${rows.length} file(s))`
      : `[file-sync] receive order (queued, ${rows.length} file(s))`;
    console.log(label, rows);
  }

  /** @internal Test helper — clears queued transfers between specs. */
  static resetForTests(): void {
    EventSystem.unregister(FileReceiveScheduler);
    FileReceiveScheduler.networkHooksRegistered = false;
    FileReceiveScheduler.joinProbeHold = false;
    FileReceiveScheduler.activeReceives.clear();
    FileReceiveScheduler.outboundPending.clear();
    FileReceiveScheduler.outboundRequests.clear();
    FileReceiveScheduler.pending = [];
    FileReceiveScheduler.receiveRetryAfter.clear();
    FileReceiveScheduler.playingMusicPriorityKey = '';
    FileReceiveScheduler.loggedReceiveKeys.clear();
    FileReceiveScheduler.pendingReceiveOrderLogKind = 'queued';
    FileReceiveScheduler.clearPeerRetryTimers();
    if (FileReceiveScheduler.scheduleTimer != null) {
      clearZeroTimeout(FileReceiveScheduler.scheduleTimer);
      FileReceiveScheduler.scheduleTimer = null;
    }
  }

  static sortByNextReceiveBytes<T extends TransferCatalogMeta>(
    kind: FileResourceKind,
    items: T[],
    localStateFor: (item: T) => number
  ): T[] {
    primePlayingMusicCache();
    try {
      return items.slice().sort((a, b) => {
        const bytesA = estimateNextReceiveBytes(kind, localStateFor(a), a);
        const bytesB = estimateNextReceiveBytes(kind, localStateFor(b), b);
        return compareFileSyncPriority(kind, a.identifier, bytesA, kind, b.identifier, bytesB);
      });
    } finally {
      clearPlayingMusicCache();
    }
  }
}

export function estimateNextReceiveBytes(
  kind: FileResourceKind,
  localState: number,
  meta: TransferCatalogMeta
): number {
  if (kind === 'image') {
    if (localState < ImageState.THUMBNAIL) {
      return meta.thumbBytes ?? meta.byteSize ?? DEFAULT_THUMB_BYTES;
    }
    return meta.byteSize ?? meta.thumbBytes ?? DEFAULT_THUMB_BYTES;
  }
  if (kind === 'audio' && localState >= AudioState.COMPLETE) return 0;
  if (kind === 'pdf' && localState >= PdfState.COMPLETE) return 0;
  if (kind === 'video' && localState >= VideoState.COMPLETE) return 0;
  return meta.byteSize ?? DEFAULT_UNKNOWN_BYTES;
}

export function catalogByteSize(blob: Blob | null | undefined, fallback = 0): number {
  return blob?.size ?? fallback;
}

function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes >= DEFAULT_UNKNOWN_BYTES) return 'unknown';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

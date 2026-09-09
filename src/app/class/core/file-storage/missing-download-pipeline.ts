import { Network } from '../system';
import { FolderMediaHydrator } from 'service/folder-media-hydrator';
import {
  estimateNextReceiveBytes,
  FileReceiveScheduler,
  FileResourceKind,
  TransferCatalogMeta,
} from './file-transfer-scheduler';

import { isUrlBackedMediaIdentifier } from './media-identifier';

export type MissingCatalogItem = TransferCatalogMeta;

export interface MissingDownloadCollector {
  kind: FileResourceKind;
  completeState: number;
  nullState: number;
  isReceiving: (identifier: string) => boolean;
  /** Current local state, or null if the slot does not exist yet. */
  getLocalState: (identifier: string) => number | null;
  ensurePlaceholder: (identifier: string) => void;
  hydrateUrlBacked: (item: MissingCatalogItem) => boolean;
  /** Skip catalog rows (e.g. images tombstoned by library delete). */
  shouldSkip?: (identifier: string) => boolean;
}

export interface MissingDownloadQueuer extends Pick<
  MissingDownloadCollector,
  'kind' | 'completeState' | 'nullState' | 'getLocalState'
> {
  requestOne: (identifier: string, localState: number, peerId: string) => void;
}

export interface MissingDownloadHooks extends MissingDownloadCollector, MissingDownloadQueuer {}

/** Path/HTTP assets load locally; never enqueue for P2P (compat with older hosts). */
export function hydrateUrlBackedMediaIfNeeded(options: {
  item: MissingCatalogItem;
  urlState: number;
  getExisting: (identifier: string) => { state: number } | null | undefined;
  addUrlBacked: (identifier: string) => void;
}): boolean {
  const { item, urlState } = options;
  if (item.state !== urlState && !isUrlBackedMediaIdentifier(item.identifier)) {
    return false;
  }
  const existing = options.getExisting(item.identifier);
  if (!existing || existing.state < urlState) {
    options.addUrlBacked(item.identifier);
  }
  return true;
}

/** Build MissingDownloadHooks for one media kind (A/P/V/image). */
export function buildMissingDownloadHooks(options: {
  kind: FileResourceKind;
  completeState: number;
  nullState: number;
  urlState: number;
  isReceiving: (identifier: string) => boolean;
  get: (identifier: string) => { state: number } | null | undefined;
  addEmpty: (identifier: string) => void;
  addUrlBacked: (identifier: string) => void;
  requestOne: (identifier: string, localState: number, peerId: string) => void;
  shouldSkip?: (identifier: string) => boolean;
}): MissingDownloadHooks {
  return {
    kind: options.kind,
    completeState: options.completeState,
    nullState: options.nullState,
    isReceiving: options.isReceiving,
    getLocalState: id => options.get(id)?.state ?? null,
    ensurePlaceholder: id => options.addEmpty(id),
    hydrateUrlBacked: item => hydrateUrlBackedMediaIfNeeded({
      item,
      urlState: options.urlState,
      getExisting: options.get,
      addUrlBacked: options.addUrlBacked,
    }),
    requestOne: options.requestOne,
    shouldSkip: options.shouldSkip,
  };
}

/** Collect incomplete local files from a peer catalog (SYNCHRONIZE / ensureRoomDownloads). */
export function collectMissingDownloadRequests(
  catalog: MissingCatalogItem[],
  hooks: MissingDownloadCollector,
): Array<{ identifier: string; state: number }> {
  const request: Array<{ identifier: string; state: number }> = [];
  for (const item of catalog) {
    if (hooks.shouldSkip?.(item.identifier)) continue;
    if (hooks.hydrateUrlBacked(item)) continue;
    let localState = hooks.getLocalState(item.identifier);
    if (localState === null) {
      hooks.ensurePlaceholder(item.identifier);
      localState = hooks.getLocalState(item.identifier) ?? hooks.nullState;
    }
    if (localState < hooks.completeState
      && !hooks.isReceiving(item.identifier)
      && FileReceiveScheduler.canEnqueueReceive(hooks.kind, item.identifier)) {
      request.push({ identifier: item.identifier, state: localState });
    }
  }
  return request;
}

/** Enqueue P2P receives for collected missing files (priority sort + folder hydrate). */
export function queueMissingDownloads(
  request: Array<{ identifier: string; state: number }>,
  peerId: string,
  catalogMeta: MissingCatalogItem[],
  hooks: MissingDownloadQueuer,
): void {
  const metaById = new Map(catalogMeta.map(item => [item.identifier, item]));
  const sorted = FileReceiveScheduler.sortByNextReceiveBytes(hooks.kind, request, item => {
    return hooks.getLocalState(item.identifier) ?? hooks.nullState;
  });
  FolderMediaHydrator.instance.beginHydrateMissing(
    hooks.kind,
    sorted.map(item => item.identifier),
  );
  for (const item of sorted) {
    const localState = hooks.getLocalState(item.identifier) ?? hooks.nullState;
    if (localState >= hooks.completeState) continue;
    const meta = metaById.get(item.identifier) ?? item;
    const bytes = estimateNextReceiveBytes(hooks.kind, localState, meta);
    FileReceiveScheduler.enqueueReceiveRequest(
      hooks.kind,
      peerId,
      item.identifier,
      bytes,
      () => hooks.requestOne(item.identifier, localState, peerId),
    );
  }
}

/** For each open peer catalog, collect missing files and queue downloads. */
export function ensureRoomMissingDownloads(
  catalogsByPeer: Map<string, MissingCatalogItem[]>,
  hooks: MissingDownloadHooks,
): void {
  for (const [peerId, catalog] of catalogsByPeer) {
    if (!Network.peerIds.includes(peerId) || !catalog?.length) continue;
    const request = collectMissingDownloadRequests(catalog, hooks);
    if (request.length) queueMissingDownloads(request, peerId, catalog, hooks);
  }
}

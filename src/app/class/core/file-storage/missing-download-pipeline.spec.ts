import { Network } from '../system';
import { FileReceiveScheduler } from './file-transfer-scheduler';
import { ImageState } from './image-file';
import {
  buildMissingDownloadHooks,
  collectMissingDownloadRequests,
  ensureRoomMissingDownloads,
  hydrateUrlBackedMediaIfNeeded,
  MissingDownloadHooks,
  queueMissingDownloads,
} from './missing-download-pipeline';
import { FolderMediaHydrator } from 'service/folder-media-hydrator';

describe('missing-download-pipeline', () => {
  let peerIds: string[];
  let local = new Map<string, number>();
  let receiving = new Set<string>();
  let hydrated: string[];
  let enqueued: Array<{ id: string; peerId: string; state: number }>;
  let hooks: MissingDownloadHooks;

  beforeEach(() => {
    FileReceiveScheduler.resetForTests();
    peerIds = ['peer-a'];
    spyOnProperty(Network, 'peerIds', 'get').and.callFake(() => peerIds);
    local = new Map();
    receiving = new Set();
    hydrated = [];
    enqueued = [];
    spyOn(FolderMediaHydrator.instance, 'beginHydrateMissing');

    hooks = {
      kind: 'image',
      completeState: ImageState.COMPLETE,
      nullState: ImageState.NULL,
      isReceiving: id => receiving.has(id),
      getLocalState: id => (local.has(id) ? local.get(id)! : null),
      ensurePlaceholder: id => { local.set(id, ImageState.NULL); },
      hydrateUrlBacked: item => {
        if (item.state === ImageState.URL) {
          hydrated.push(item.identifier);
          return true;
        }
        return false;
      },
      requestOne: (identifier, localState, peerId) => {
        enqueued.push({ id: identifier, peerId, state: localState });
      },
    };
  });

  afterEach(() => {
    FileReceiveScheduler.resetForTests();
  });

  it('collectMissingDownloadRequests skips url-backed and complete/receiving', () => {
    local.set('done', ImageState.COMPLETE);
    receiving.add('busy');
    local.set('busy', ImageState.NULL);
    const request = collectMissingDownloadRequests([
      { identifier: 'url', state: ImageState.URL },
      { identifier: 'done', state: ImageState.COMPLETE },
      { identifier: 'busy', state: ImageState.NULL },
      { identifier: 'need', state: ImageState.COMPLETE },
    ], hooks);
    expect(hydrated).toEqual(['url']);
    expect(request).toEqual([{ identifier: 'need', state: ImageState.NULL }]);
    expect(local.get('need')).toBe(ImageState.NULL);
  });

  it('collectMissingDownloadRequests skips shouldSkip ids without placeholders', () => {
    hooks.shouldSkip = id => id === 'deleted';
    const request = collectMissingDownloadRequests([
      { identifier: 'deleted', state: ImageState.COMPLETE },
      { identifier: 'need', state: ImageState.COMPLETE },
    ], hooks);
    expect(request).toEqual([{ identifier: 'need', state: ImageState.NULL }]);
    expect(local.has('deleted')).toBeFalse();
    expect(local.get('need')).toBe(ImageState.NULL);
  });

  it('queueMissingDownloads enqueues and invokes requestOne', () => {
    local.set('need', ImageState.NULL);
    queueMissingDownloads(
      [{ identifier: 'need', state: ImageState.NULL }],
      'peer-a',
      [{ identifier: 'need', state: ImageState.COMPLETE, byteSize: 1000 }],
      hooks,
    );
    FileReceiveScheduler.schedule();
    expect(enqueued).toEqual([{ id: 'need', peerId: 'peer-a', state: ImageState.NULL }]);
    expect(FolderMediaHydrator.instance.beginHydrateMissing)
      .toHaveBeenCalledWith('image', ['need']);
  });

  it('ensureRoomMissingDownloads skips closed peers', () => {
    peerIds = [];
    local.set('need', ImageState.NULL);
    ensureRoomMissingDownloads(
      new Map([['peer-a', [{ identifier: 'need', state: ImageState.COMPLETE }]]]),
      hooks,
    );
    FileReceiveScheduler.schedule();
    expect(enqueued).toEqual([]);
  });

  it('hydrateUrlBackedMediaIfNeeded returns true and may create slot', () => {
    const created: string[] = [];
    expect(hydrateUrlBackedMediaIfNeeded({
      item: { identifier: 'u1', state: ImageState.URL },
      urlState: ImageState.URL,
      getExisting: () => null,
      addUrlBacked: id => created.push(id),
    })).toBe(true);
    expect(created).toEqual(['u1']);
  });

  it('buildMissingDownloadHooks wires hydrate skip for URL assets', () => {
    const storage = new Map<string, number>();
    const built = buildMissingDownloadHooks({
      kind: 'pdf',
      completeState: 2,
      nullState: 0,
      urlState: 1000,
      isReceiving: () => false,
      get: id => (storage.has(id) ? { state: storage.get(id)! } : null),
      addEmpty: id => { storage.set(id, 0); },
      addUrlBacked: id => { storage.set(id, 1000); },
      requestOne: () => fail('should not request url'),
    });
    const request = collectMissingDownloadRequests(
      [{ identifier: 'path-asset', state: 1000 }],
      built,
    );
    expect(request).toEqual([]);
    expect(storage.get('path-asset')).toBe(1000);
  });
});

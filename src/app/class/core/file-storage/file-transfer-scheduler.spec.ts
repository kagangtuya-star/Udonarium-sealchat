import { AudioState } from './audio-file';
import { FileSyncPriorityTier, JUKEBOX_OBJECT_ID } from './file-sync-priority';
import { FileReceiveScheduler, estimateNextReceiveBytes } from './file-transfer-scheduler';
import { ImageState } from './image-file';
import { EventSystem, Network } from '../system';
import { Jukebox } from '@udonarium/Jukebox';
import { ObjectStore } from '../synchronize-object/object-store';

describe('FileReceiveScheduler', () => {
  let peerIds: string[];

  beforeEach(() => {
    FileReceiveScheduler.resetForTests();
    peerIds = ['p1'];
    spyOnProperty(Network, 'peerIds', 'get').and.callFake(() => peerIds);
  });

  afterEach(() => {
    // Unregister hooks before destroying Jukebox so teardown does not re-log.
    FileReceiveScheduler.resetForTests();
    ObjectStore.instance.get(JUKEBOX_OBJECT_ID)?.destroy();
    ObjectStore.instance.clearDeleted(JUKEBOX_OBJECT_ID);
  });

  it('finishes thumbnail phase before dispatching audio/pdf by size', () => {
    const order: string[] = [];
    FileReceiveScheduler.enqueueReceiveRequest('video', 'p1', 'big', 5_000_000, () => order.push('big'));
    FileReceiveScheduler.enqueueReceiveRequest('audio', 'p1', 'small', 100_000, () => order.push('small'));
    FileReceiveScheduler.enqueueReceiveRequest('pdf', 'p1', 'mid', 1_000_000, () => order.push('mid'));
    FileReceiveScheduler.enqueueReceiveRequest('image', 'p1', 'thumb', 4_000, () => order.push('thumb'));
    FileReceiveScheduler.schedule();
    expect(order).toEqual(['thumb']);
    FileReceiveScheduler.markReceiveStart('image', 'thumb');
    FileReceiveScheduler.markReceiveEnd('image', 'thumb');
    expect(order).toEqual(['thumb', 'small', 'mid', 'big']);
  });

  it('estimateNextReceiveBytes prefers thumbBytes for incomplete images', () => {
    const bytes = estimateNextReceiveBytes('image', ImageState.NULL, {
      identifier: 'a',
      state: ImageState.COMPLETE,
      byteSize: 500_000,
      thumbBytes: 8_000,
    });
    expect(bytes).toBe(8_000);
  });

  it('abortOutboundRequest re-queues so the file can retry', () => {
    const order: string[] = [];
    FileReceiveScheduler.enqueueReceiveRequest('pdf', 'p1', 'doc', 1_000_000, () => order.push('first'));
    FileReceiveScheduler.schedule();
    expect(order).toEqual(['first']);
    FileReceiveScheduler.abortOutboundRequest('pdf', 'doc');
    expect(FileReceiveScheduler.isTransferPending('pdf', 'doc')).toBe(true);
    expect(FileReceiveScheduler.isTransferActive('pdf', 'doc')).toBe(false);
    FileReceiveScheduler.schedule();
    expect(order).toEqual(['first', 'first']);
  });

  it('estimateNextReceiveBytes uses byteSize for audio', () => {
    const bytes = estimateNextReceiveBytes('audio', AudioState.NULL, {
      identifier: 'a',
      state: AudioState.COMPLETE,
      byteSize: 42_000,
    });
    expect(bytes).toBe(42_000);
  });

  it('logs receive order only when new files enter the queue', () => {
    const log = spyOn(console, 'log');
    peerIds = [];
    FileReceiveScheduler.enqueueReceiveRequest('audio', 'p1', 'a1', 100_000, () => {});
    FileReceiveScheduler.enqueueReceiveRequest('image', 'p1', 'i1', 4_000, () => {});
    FileReceiveScheduler.schedule();
    expect(log.calls.all().filter(c => String(c.args[0]).includes('[file-sync] receive order (queued')).length).toBe(1);
    const rows = log.calls.mostRecent().args[1] as Array<{ tier: string; id: string }>;
    expect(rows[0].tier).toBe('IMAGE_THUMB');
    expect(rows.map(r => r.id)).toEqual(['i1', 'a1']);
    expect(FileSyncPriorityTier.IMAGE_MAP_THUMB).toBe(0);
    expect(FileSyncPriorityTier.IMAGE_THUMB).toBe(1);

    log.calls.reset();
    FileReceiveScheduler.schedule();
    expect(log.calls.all().filter(c => String(c.args[0]).includes('[file-sync] receive order')).length).toBe(0);

    FileReceiveScheduler.enqueueReceiveRequest('pdf', 'p1', 'p1doc', 1_000_000, () => {});
    FileReceiveScheduler.schedule();
    expect(log.calls.all().filter(c => String(c.args[0]).includes('[file-sync] receive order (queued')).length).toBe(1);
  });

  it('abortReceive drops a queued image download', () => {
    peerIds = [];
    FileReceiveScheduler.enqueueReceiveRequest('image', 'p1', 'gone', 1000, () => {});
    expect(FileReceiveScheduler.isTransferPending('image', 'gone')).toBeTrue();
    FileReceiveScheduler.abortReceive('image', 'gone');
    expect(FileReceiveScheduler.isTransferPending('image', 'gone')).toBeFalse();
    expect(FileReceiveScheduler.isTransferActive('image', 'gone')).toBeFalse();
  });

  it('promotes playing BGM after markForChanged-style Jukebox identifier event', () => {
    const log = spyOn(console, 'log');
    peerIds = []; // keep queue pending so tiers stay visible
    FileReceiveScheduler.ensureNetworkHooks();
    spyOn(FileReceiveScheduler as any, 'scheduleDeferred').and.callFake(() => {
      FileReceiveScheduler.schedule();
    });

    FileReceiveScheduler.enqueueReceiveRequest('audio', 'p1', 'bgm-playing', 8_000_000, () => {});
    FileReceiveScheduler.enqueueReceiveRequest('pdf', 'p1', 'rules', 1_000_000, () => {});
    FileReceiveScheduler.schedule();

    let rows = log.calls.mostRecent().args[1] as Array<{ tier: string; id: string }>;
    expect(rows.find(r => r.id === 'bgm-playing')?.tier).toBe('DEFAULT');

    ObjectStore.instance.clearDeleted(JUKEBOX_OBJECT_ID);
    const jukebox = new Jukebox(JUKEBOX_OBJECT_ID);
    jukebox.initialize();
    jukebox.tracks = [{
      audioIdentifier: 'bgm-playing',
      isPlaying: true,
      isPaused: false,
      currentTime: 0,
      isLoop: true,
      roomGain: 1,
      label: '',
      queue: [],
      queueMode: 'single',
      fadeSec: 2.5,
      overlapSec: 6,
    }, ...Array.from({ length: 4 }, () => ({
      audioIdentifier: '',
      isPlaying: false,
      isPaused: false,
      currentTime: 0,
      isLoop: true,
      roomGain: 1,
      label: '',
      queue: [],
      queueMode: 'single' as const,
      fadeSec: 2.5,
      overlapSec: 6,
    }))];
    expect(jukebox.tracks[0].isPlaying).toBe(true);

    // Simulate join: files queued before jukebox apply; forget any earlier priority snapshot.
    (FileReceiveScheduler as any).playingMusicPriorityKey = '';
    log.calls.reset();
    // Same event markForChanged fires after inbound apply / releasePeerSync.
    EventSystem.trigger(`UPDATE_GAME_OBJECT/identifier/${JUKEBOX_OBJECT_ID}`, {
      aliasName: Jukebox.aliasName,
      identifier: JUKEBOX_OBJECT_ID,
    });

    const orderLogs = log.calls.all().filter(c =>
      String(c.args[0]).includes('[file-sync] receive order (reprioritized')
    );
    expect(orderLogs.length).toBe(1);
    rows = orderLogs[0].args[1] as Array<{ tier: string; id: string; order: number }>;
    expect(rows.find(r => r.id === 'bgm-playing')?.tier).toBe('PLAYING_AUDIO');
    expect(rows[0].id).toBe('bgm-playing');
    expect(rows[1].id).toBe('rules');
  });

  it('dispatches reachable higher tier while lower-tier peer is closed', () => {
    const order: string[] = [];
    peerIds = ['p-open']; // thumb's peer is offline
    FileReceiveScheduler.enqueueReceiveRequest('image', 'p-closed', 'thumb', 4_000, () => order.push('thumb'));
    FileReceiveScheduler.enqueueReceiveRequest('audio', 'p-open', 'bgm', 100_000, () => order.push('bgm'));
    FileReceiveScheduler.schedule();
    expect(order).toEqual(['bgm']);
    expect(FileReceiveScheduler.isTransferPending('image', 'thumb')).toBe(true);

    peerIds = ['p-open', 'p-closed'];
    FileReceiveScheduler.markReceiveStart('audio', 'bgm');
    FileReceiveScheduler.markReceiveEnd('audio', 'bgm');
    expect(order).toEqual(['bgm', 'thumb']);
  });

  it('yield re-queues higher-tier outbound so files are not orphaned', () => {
    peerIds = ['p1'];
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      FileReceiveScheduler.enqueueReceiveRequest('audio', 'p1', `a${i}`, 100_000 + i, () => order.push(`a${i}`));
    }
    FileReceiveScheduler.schedule();
    expect(order.length).toBe(4);
    expect(FileReceiveScheduler.outboundPendingCount()).toBe(4);

    FileReceiveScheduler.enqueueReceiveRequest('image', 'p1', 'thumb', 4_000, () => order.push('thumb'));
    FileReceiveScheduler.schedule();
    expect(order).toContain('thumb');
    // Yielded audios return to pending (still syncable).
    expect(FileReceiveScheduler.isTransferPending('audio', 'a0')).toBe(true);
    expect(FileReceiveScheduler.isTransferActive('audio', 'a0')).toBe(false);
  });

  it('eventually dispatches every queued file after yield and peer recovery', () => {
    const dispatched = new Set<string>();
    const track = (id: string) => () => { dispatched.add(id); };

    peerIds = ['p1'];
    for (let i = 0; i < 4; i++) {
      FileReceiveScheduler.enqueueReceiveRequest('audio', 'p1', `a${i}`, 50_000 + i, track(`a${i}`));
    }
    FileReceiveScheduler.schedule();
    expect(dispatched.size).toBe(4);

    // Reachable thumb forces yield of DEFAULT outbound back into pending.
    FileReceiveScheduler.enqueueReceiveRequest('image', 'p1', 'thumb', 4_000, track('thumb'));
    FileReceiveScheduler.schedule();
    expect(dispatched.has('thumb')).toBe(true);
    expect(FileReceiveScheduler.isTransferPending('audio', 'a0')).toBe(true);

    FileReceiveScheduler.markReceiveStart('image', 'thumb');
    FileReceiveScheduler.markReceiveEnd('image', 'thumb');

    // Drain re-queued audio until every id has been dispatched at least once.
    for (let n = 0; n < 8; n++) {
      FileReceiveScheduler.schedule();
      for (const id of ['a0', 'a1', 'a2', 'a3']) {
        const keyActive = FileReceiveScheduler.isTransferActive('audio', id);
        // outbound counts as active via isTransferActive
        if (keyActive) {
          FileReceiveScheduler.markReceiveStart('audio', id);
          FileReceiveScheduler.markReceiveEnd('audio', id);
        }
      }
      if (['a0', 'a1', 'a2', 'a3', 'thumb'].every(id => dispatched.has(id))
        && FileReceiveScheduler.pendingReceiveCount() === 0
        && FileReceiveScheduler.outboundPendingCount() === 0
        && FileReceiveScheduler.activeReceiveCount() === 0) {
        break;
      }
    }
    expect([...dispatched].sort()).toEqual(['a0', 'a1', 'a2', 'a3', 'thumb']);
    expect(FileReceiveScheduler.pendingReceiveCount()).toBe(0);
  });

  it('DISCONNECT_PEER drops pending and outbound slots for that peer', () => {
    FileReceiveScheduler.ensureNetworkHooks();
    peerIds = ['alive', 'dead'];
    const order: string[] = [];
    FileReceiveScheduler.enqueueReceiveRequest('image', 'dead', 'd1', 4_000, () => order.push('dead'));
    FileReceiveScheduler.enqueueReceiveRequest('image', 'alive', 'a1', 4_000, () => order.push('alive'));
    FileReceiveScheduler.schedule();
    expect(order).toContain('dead');
    expect(FileReceiveScheduler.isTransferActive('image', 'd1')).toBe(true);

    EventSystem.trigger('DISCONNECT_PEER', { peerId: 'dead' });
    peerIds = ['alive'];

    expect(FileReceiveScheduler.isTransferActive('image', 'd1')).toBe(false);
    expect(FileReceiveScheduler.isTransferPending('image', 'd1')).toBe(false);
    // Peer abort must not apply failure backoff — same file can enqueue again immediately.
    expect(FileReceiveScheduler.canEnqueueReceive('image', 'd1')).toBe(true);
    FileReceiveScheduler.schedule();
    expect(order).toContain('alive');
  });

  it('peer-abort flaps do not grow pending/outbound unboundedly', () => {
    FileReceiveScheduler.ensureNetworkHooks();
    const CYCLES = 20;
    for (let i = 0; i < CYCLES; i++) {
      peerIds = ['dead'];
      FileReceiveScheduler.enqueueReceiveRequest('image', 'dead', `f${i % 4}`, 4_000, () => {});
      FileReceiveScheduler.schedule();
      EventSystem.trigger('DISCONNECT_PEER', { peerId: 'dead' });
    }
    expect(FileReceiveScheduler.pendingReceiveCount()).toBe(0);
    expect(FileReceiveScheduler.outboundPendingCount()).toBe(0);
    expect(FileReceiveScheduler.activeReceiveCount()).toBe(0);
  });

  it('join probe hold queues receives without dispatching until released', () => {
    const order: string[] = [];
    FileReceiveScheduler.beginJoinProbeHold();
    expect(FileReceiveScheduler.isJoinProbeHold()).toBeTrue();
    FileReceiveScheduler.enqueueReceiveRequest('image', 'p1', 'thumb', 4_000, () => order.push('thumb'));
    FileReceiveScheduler.schedule();
    expect(order).toEqual([]);
    expect(FileReceiveScheduler.pendingReceiveCount()).toBe(1);

    FileReceiveScheduler.endJoinProbeHold();
    expect(FileReceiveScheduler.isJoinProbeHold()).toBeFalse();
    expect(order).toEqual(['thumb']);
  });

  it('pendingReceiveBytes separates known sizes from unknown placeholders', () => {
    FileReceiveScheduler.enqueueReceiveRequest('image', 'p1', 'a', 4_000, () => {});
    FileReceiveScheduler.enqueueReceiveRequest('pdf', 'p1', 'b', 999_999_999, () => {});
    expect(FileReceiveScheduler.pendingReceiveBytes()).toEqual({ knownBytes: 4_000, unknownCount: 1 });
    expect(FileReceiveScheduler.pendingReceiveCountsByKind()).toEqual({
      image: 1,
      audio: 0,
      pdf: 1,
      video: 0,
    });
  });
});

import { EventSystem, Network } from '@udonarium/core/system';
import { IPeerContext } from '@udonarium/core/system/network/peer-context';
import { IRoomInfo } from '@udonarium/core/system/network/room-info';
import { skyWayRecoveryGate } from '@udonarium/core/system/network/skyway2023/skyway-recovery-policy';
import { ObjectStore } from '@udonarium/core/synchronize-object/object-store';
import { ObjectSynchronizer } from '@udonarium/core/synchronize-object/object-synchronizer';
import { FileReceiveScheduler } from '@udonarium/core/file-storage/file-transfer-scheduler';
import { Room } from '@udonarium/room';
import { TableSelecter } from '@udonarium/table-selecter';
import { ConnectionBusyService } from 'service/connection-busy.service';

import { RoomConnectHelper } from './room-connect-helper';

function peer(peerId: string): IPeerContext {
  return { peerId } as IPeerContext;
}

function hostCatalog(from = 'live', identifier = 'PeerCursor') {
  EventSystem.trigger({
    eventName: 'SYNCHRONIZE_GAME_OBJECT',
    data: [{ identifier, version: 1 }],
    sendFrom: from,
  });
}

function hostTabletop(from = 'live') {
  EventSystem.trigger({
    eventName: 'UPDATE_GAME_OBJECT',
    data: {
      aliasName: 'game-table',
      identifier: 'gameTable',
      majorVersion: 1,
      minorVersion: 0,
      syncData: {},
    },
    sendFrom: from,
  });
}

const room: IRoomInfo = {
  id: 'Ab1',
  name: 'TestRoom',
  hasPassword: false,
  peers: [],
  filterByPassword: () => [],
};

describe('RoomConnectHelper settle predicates', () => {
  it('early-succeeds when at least one live peer is open', () => {
    expect(RoomConnectHelper.shouldEarlySucceed(0)).toBeFalse();
    expect(RoomConnectHelper.shouldEarlySucceed(1)).toBeTrue();
    expect(RoomConnectHelper.shouldEarlySucceed(2)).toBeTrue();
  });

  it('fails join only when every target was tried and none remain', () => {
    expect(RoomConnectHelper.shouldFailJoin(1, 2, 0)).toBeFalse();
    expect(RoomConnectHelper.shouldFailJoin(2, 2, 1)).toBeFalse();
    expect(RoomConnectHelper.shouldFailJoin(2, 2, 0)).toBeTrue();
    expect(RoomConnectHelper.shouldFailJoin(0, 0, 0)).toBeFalse();
  });

  it('treats game-table updates as join DATA, not PeerCursor catalogs', () => {
    expect(RoomConnectHelper.isJoinTabletopData('game-table')).toBeTrue();
    expect(RoomConnectHelper.isJoinTabletopData('PeerCursor')).toBeFalse();
    expect(RoomConnectHelper.isJoinTabletopData('table-selecter')).toBeFalse();
  });

  it('extends join-data wait while meshed instead of aborting', () => {
    expect(RoomConnectHelper.shouldExtendJoinDataWait(0)).toBeFalse();
    expect(RoomConnectHelper.shouldExtendJoinDataWait(1)).toBeTrue();
  });

  it('resetIfAlone is a no-op (join probe must not kick)', () => {
    const leave = spyOn(RoomConnectHelper, 'resetToLobby');
    RoomConnectHelper.resetIfAlone();
    expect(leave).not.toHaveBeenCalled();
  });

  it('filterLobbyRooms hides suppressed rooms', () => {
    RoomConnectHelper.clearLobbyRoomSuppression();
    RoomConnectHelper.suppressLobbyRoom('Ab1', 'TestRoom');
    const filtered = RoomConnectHelper.filterLobbyRooms([
      { id: 'Ab1', name: 'TestRoom' },
      { id: 'Cd2', name: 'Other' },
    ]);
    expect(filtered).toEqual([{ id: 'Cd2', name: 'Other' }]);
    RoomConnectHelper.clearLobbyRoomSuppression();
  });

  it('maps join fail reasons to lobby i18n key prefixes', () => {
    expect(RoomConnectHelper.joinFailMessageKey('all_targets_failed')).toBe('lobby.staleRoom');
    expect(RoomConnectHelper.joinFailMessageKey('no_tabletop_data')).toBe('lobby.joinDataTimeout');
    expect(RoomConnectHelper.joinFailMessageKey('connect_timeout')).toBe('lobby.joinNetworkTimeout');
    expect(RoomConnectHelper.joinFailMessageKey('network_error_open')).toBe('lobby.joinNetworkTimeout');
  });

  it('suppresses lobby rooms only for stale/empty fails, not network timeouts', () => {
    expect(RoomConnectHelper.shouldSuppressLobbyRoom('all_targets_failed')).toBeTrue();
    expect(RoomConnectHelper.shouldSuppressLobbyRoom('no_tabletop_data')).toBeTrue();
    expect(RoomConnectHelper.shouldSuppressLobbyRoom('connect_timeout')).toBeFalse();
    expect(RoomConnectHelper.shouldSuppressLobbyRoom('network_error_open')).toBeFalse();
    expect(RoomConnectHelper.shouldSuppressLobbyRoom('network_error_mesh')).toBeFalse();
  });

  it('gatherJoinTargets merges lobby seed with SkyWay room members', () => {
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self', 'room-live']);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    const merged = RoomConnectHelper.gatherJoinTargets([peer('lobby-a')]);
    expect(merged.map(p => p.peerId).sort()).toEqual(['lobby-a', 'room-live']);
  });
});

describe('RoomConnectHelper.reopenLastRoomOrLobby', () => {
  const defaultJoinStableMs = RoomConnectHelper.JOIN_STABLE_MS;

  beforeEach(() => {
    try { jasmine.clock().uninstall(); } catch { /* not installed */ }
    RoomConnectHelper.abortReopenInFlight();
    (RoomConnectHelper as any).joinOwnedUntil = 0;
    (RoomConnectHelper as any).rekeyInFlight = false;
    (RoomConnectHelper as any).backupRoomOpenInFlight = false;
    RoomConnectHelper.createRoomInFlight = false;
    (RoomConnectHelper as any).meshHealInFlight = false;
    (RoomConnectHelper as any).meshHealDebounceTimer = null;
    RoomConnectHelper.joinInProgress = false;
    RoomConnectHelper.REOPEN_BUSY_DELAY_MS_FOR_TEST = 0;
    // Remesh finish awaits stable peer; keep unit reopen tests snappy unless a case overrides.
    RoomConnectHelper.JOIN_STABLE_MS = 0;
    skyWayRecoveryGate.resetForTests();
  });

  afterEach(() => {
    RoomConnectHelper.abortReopenInFlight();
    (RoomConnectHelper as any).rekeyInFlight = false;
    (RoomConnectHelper as any).backupRoomOpenInFlight = false;
    RoomConnectHelper.createRoomInFlight = false;
    (RoomConnectHelper as any).meshHealDebounceTimer = null;
    (RoomConnectHelper as any).joinOwnedUntil = 0;
    RoomConnectHelper.joinInProgress = false;
    RoomConnectHelper.everHadRoomSession = false;
    RoomConnectHelper.hadOpenPeerThisSession = false;
    (RoomConnectHelper as any).clearSoftDeathState();
    (RoomConnectHelper as any).clearMeshDeathState();
    (RoomConnectHelper as any).documentHiddenAt = 0;
    RoomConnectHelper.SOFT_DEATH_MS_FOR_TEST = 0;
    RoomConnectHelper.MESH_DEATH_MS_FOR_TEST = 0;
    RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 0;
    RoomConnectHelper.REOPEN_BUSY_DELAY_MS_FOR_TEST = 0;
    RoomConnectHelper.JOIN_STABLE_MS = defaultJoinStableMs;
    skyWayRecoveryGate.resetForTests();
  });

  it('isNetworkReconnecting is false when alone in room with no peers', () => {
    RoomConnectHelper.everHadRoomSession = true;
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ isRoom: true, peerId: 'self' } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);
    expect(RoomConnectHelper.isNetworkReconnecting()).toBeFalse();
  });

  it('isNetworkReconnecting is true when others are in room but no open DataChannels', () => {
    RoomConnectHelper.everHadRoomSession = true;
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ isRoom: true, peerId: 'self' } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self', 'other']);
    expect(RoomConnectHelper.isNetworkReconnecting()).toBeTrue();
  });

  it('midSessionReopenErrorType uses disconnected when alone and channel ready', () => {
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
    expect(RoomConnectHelper.midSessionReopenErrorType()).toBe('disconnected');
  });

  it('midSessionReopenErrorType uses duplicate-member when others or channel dead', () => {
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self', 'ghost']);
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
    expect(RoomConnectHelper.midSessionReopenErrorType()).toBe('duplicate-member');

    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self']);
    (Network.isRoomChannelReady as jasmine.Spy).and.returnValue(false);
    expect(RoomConnectHelper.midSessionReopenErrorType()).toBe('duplicate-member');
  });

  it('holds peer sync for reopen and releases false on abort', () => {
    RoomConnectHelper.everHadRoomSession = true;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1',
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
    });
    spyOn(Network, 'open');
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ userId: 'u1', peerId: 'self' } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    const hold = spyOn(ObjectSynchronizer.instance, 'holdPeerSync').and.callThrough();
    const release = spyOn(ObjectSynchronizer.instance, 'releasePeerSync').and.callThrough();

    expect(RoomConnectHelper.reopenLastRoomOrLobby('disconnected', { skipJitter: true })).toBe('started');
    expect(hold).toHaveBeenCalled();
    expect((RoomConnectHelper as any).reopenPeerSyncHeld).toBeTrue();

    RoomConnectHelper.abortReopenInFlight();
    expect(release).toHaveBeenCalledWith(false);
    expect(release).not.toHaveBeenCalledWith(true);
    expect((RoomConnectHelper as any).reopenPeerSyncHeld).toBeFalse();
  });

  it('abort during stable wait drops queued inbound catalog', async () => {
    ObjectSynchronizer.instance.initialize();
    try {
      RoomConnectHelper.everHadRoomSession = true;
      RoomConnectHelper.JOIN_STABLE_MS = 300;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      spyOn(Network, 'open');
      spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
      spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1',
        peerId: 'self',
        isRoom: true,
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
        channelPassword: '',
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue(['other']);
      spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();
      spyOn(ObjectStore.instance, 'isDeleted').and.returnValue(true);
      const release = spyOn(ObjectSynchronizer.instance, 'releasePeerSync').and.callThrough();
      const catalogDeletes: unknown[] = [];
      spyOn(EventSystem, 'call').and.callFake(((name: string, data?: { identifier?: string }, sendTo?: string) => {
        if (name === 'DELETE_GAME_OBJECT' && data?.identifier === 'queued-catalog-item') {
          catalogDeletes.push(sendTo);
        }
      }) as typeof EventSystem.call);

      expect(RoomConnectHelper.reopenLastRoomOrLobby('disconnected', { skipJitter: true })).toBe('started');
      EventSystem.trigger({
        eventName: 'SYNCHRONIZE_GAME_OBJECT',
        data: [{ identifier: 'queued-catalog-item', version: 1 }],
        sendFrom: 'ghost',
      });
      await new Promise<void>(resolve => setTimeout(resolve, 40));
      RoomConnectHelper.abortReopenInFlight();
      await new Promise<void>(resolve => setTimeout(resolve, 30));

      expect(release).toHaveBeenCalledWith(false);
      expect(release).not.toHaveBeenCalledWith(true);
      expect(catalogDeletes).toEqual([]);
      expect((RoomConnectHelper as any).reopenPeerSyncHeld).toBeFalse();
    } finally {
      ObjectSynchronizer.instance.destroy();
    }
  });

  it('releases peer sync true after remesh with stable open peer', async () => {
    RoomConnectHelper.everHadRoomSession = true;
    RoomConnectHelper.JOIN_STABLE_MS = 0;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1',
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
    });
    spyOn(Network, 'open');
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({
      userId: 'u1',
      peerId: 'self',
      isRoom: true,
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
      channelPassword: '',
    } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue(['other']);
    spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();
    const release = spyOn(ObjectSynchronizer.instance, 'releasePeerSync').and.callThrough();

    expect(RoomConnectHelper.reopenLastRoomOrLobby('disconnected', { skipJitter: true })).toBe('started');
    await new Promise<void>(resolve => setTimeout(resolve, 40));

    expect(release).toHaveBeenCalledWith(true);
    expect((RoomConnectHelper as any).reopenPeerSyncHeld).toBeFalse();
  });

  it('releases peer sync false when open peer flaps during stable wait', async () => {
    RoomConnectHelper.everHadRoomSession = true;
    RoomConnectHelper.JOIN_STABLE_MS = 150;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1',
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
    });
    spyOn(Network, 'open');
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({
      userId: 'u1',
      peerId: 'self',
      isRoom: true,
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
      channelPassword: '',
    } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    let peers: string[] = ['ghost'];
    spyOnProperty(Network, 'peerIds', 'get').and.callFake(() => peers);
    spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();
    const release = spyOn(ObjectSynchronizer.instance, 'releasePeerSync').and.callThrough();

    expect(RoomConnectHelper.reopenLastRoomOrLobby('disconnected', { skipJitter: true })).toBe('started');
    // Ghost briefly open through remesh; flap during JOIN_STABLE_MS wait.
    await new Promise<void>(resolve => setTimeout(resolve, 40));
    peers = [];
    await new Promise<void>(resolve => setTimeout(resolve, 120));

    expect(release).toHaveBeenCalledWith(false);
    expect(release).not.toHaveBeenCalledWith(true);
    expect((RoomConnectHelper as any).reopenPeerSyncHeld).toBeFalse();
  });

  it('remeshes after OPEN_NETWORK when a room session exists', async () => {
    RoomConnectHelper.everHadRoomSession = true;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1',
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
    });
    spyOn(Network, 'open');
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ userId: 'u1', peerId: 'self' } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    const remesh = spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();

    expect(RoomConnectHelper.reopenLastRoomOrLobby()).toBe('started');
    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(remesh).toHaveBeenCalledWith('Ab1', 'TestRoom', '');
  });

  it('skips Network.open when already in the same room session with open peers', async () => {
    RoomConnectHelper.everHadRoomSession = true;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1',
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
    });
    const open = spyOn(Network, 'open');
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({
      userId: 'u1',
      peerId: 'self',
      isRoom: true,
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
      channelPassword: '',
    } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue(['other']);
    const remesh = spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();

    expect(RoomConnectHelper.reopenLastRoomOrLobby()).toBe('started');
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(open).not.toHaveBeenCalled();
    expect(remesh).toHaveBeenCalledWith('Ab1', 'TestRoom', '');
    expect(RoomConnectHelper.isReopenInFlight).toBeFalse();
  });

  it('full Network.open when matching room session but openPeerCount is 0', async () => {
    RoomConnectHelper.everHadRoomSession = true;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1',
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
    });
    const open = spyOn(Network, 'open');
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({
      userId: 'u1',
      peerId: 'self',
      isRoom: true,
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
      channelPassword: '',
    } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();

    expect(RoomConnectHelper.reopenLastRoomOrLobby()).toBe('started');
    expect(open).toHaveBeenCalledWith('u1', 'Ab1', 'TestRoom', '');
  });

  it('isNetworkReconnecting is false when alone after soft-death settled', () => {
    RoomConnectHelper.everHadRoomSession = true;
    RoomConnectHelper.hadOpenPeerThisSession = true;
    (RoomConnectHelper as any).softDeathSince = 0;
    (RoomConnectHelper as any).softDeathAttempted = true;
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ isRoom: true, peerId: 'self' } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);
    expect(RoomConnectHelper.isNetworkReconnecting()).toBeFalse();
  });

  it('isNetworkReconnecting is true while soft-death is armed', () => {
    RoomConnectHelper.everHadRoomSession = true;
    RoomConnectHelper.hadOpenPeerThisSession = true;
    (RoomConnectHelper as any).softDeathSince = Date.now();
    (RoomConnectHelper as any).softDeathAttempted = false;
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(false);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ isRoom: true, peerId: 'self' } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);
    expect(RoomConnectHelper.isSoftDeathArmed()).toBeTrue();
    expect(RoomConnectHelper.isNetworkReconnecting()).toBeTrue();
  });

  it('soft-death reopens once after threshold when previously meshed', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.SOFT_DEATH_MS_FOR_TEST = 1000;
      RoomConnectHelper.everHadRoomSession = true;
      RoomConnectHelper.hadOpenPeerThisSession = true;
      (RoomConnectHelper as any).softDeathSince = 0;
      (RoomConnectHelper as any).softDeathAttempted = false;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
      spyOn(Network, 'isRoomChannelReady').and.returnValue(false);
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1',
        peerId: 'self',
        isRoom: true,
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
      spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);

      RoomConnectHelper.noteOpenPeerPresence();
      expect(RoomConnectHelper.isSoftDeathArmed()).toBeTrue();
      expect(RoomConnectHelper.maybeSoftDeathReopen()).toBeFalse();

      jasmine.clock().tick(1000);
      expect(RoomConnectHelper.maybeSoftDeathReopen()).toBeTrue();
      // Mid-session reopen defers for ghost TTL (duplicate-member).
      expect(open).not.toHaveBeenCalled();
      expect((RoomConnectHelper as any).softDeathAttempted).toBeTrue();
      jasmine.clock().tick(17_000);
      expect(open).toHaveBeenCalled();

      // Second call in the same alone spell does not reopen again.
      RoomConnectHelper.abortReopenInFlight();
      expect(RoomConnectHelper.maybeSoftDeathReopen()).toBeFalse();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.SOFT_DEATH_MS_FOR_TEST = 0;
      RoomConnectHelper.hadOpenPeerThisSession = false;
      (RoomConnectHelper as any).clearSoftDeathState();
    }
  });

  it('soft-death does not fire when never meshed', () => {
    RoomConnectHelper.SOFT_DEATH_MS_FOR_TEST = 1;
    RoomConnectHelper.hadOpenPeerThisSession = false;
    (RoomConnectHelper as any).softDeathSince = 0;
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ isRoom: true, peerId: 'self' } as IPeerContext);
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);
    RoomConnectHelper.noteOpenPeerPresence();
    expect(RoomConnectHelper.isSoftDeathArmed()).toBeFalse();
    expect(RoomConnectHelper.maybeSoftDeathReopen()).toBeFalse();
    RoomConnectHelper.SOFT_DEATH_MS_FOR_TEST = 0;
  });

  it('soft-death settles without reopen when alone with healthy room channel', () => {
    RoomConnectHelper.everHadRoomSession = true;
    RoomConnectHelper.hadOpenPeerThisSession = true;
    (RoomConnectHelper as any).softDeathSince = 0;
    (RoomConnectHelper as any).softDeathAttempted = false;
    const open = spyOn(Network, 'open');
    spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({
      isRoom: true,
      peerId: 'self',
    } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);

    RoomConnectHelper.noteOpenPeerPresence();
    expect(RoomConnectHelper.isSoftDeathArmed()).toBeFalse();
    expect((RoomConnectHelper as any).softDeathAttempted).toBeFalse();
    expect(RoomConnectHelper.maybeSoftDeathReopen()).toBeFalse();
    expect(open).not.toHaveBeenCalled();
    expect(RoomConnectHelper.isNetworkReconnecting()).toBeFalse();
  });

  it('soft-death can re-arm after healthy settle when room channel later fails', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.SOFT_DEATH_MS_FOR_TEST = 1000;
      RoomConnectHelper.everHadRoomSession = true;
      RoomConnectHelper.hadOpenPeerThisSession = true;
      (RoomConnectHelper as any).softDeathSince = 0;
      (RoomConnectHelper as any).softDeathAttempted = false;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      const isOpen = spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
      const channelReady = spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1',
        peerId: 'self',
        isRoom: true,
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
      spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);

      RoomConnectHelper.noteOpenPeerPresence();
      expect(RoomConnectHelper.isSoftDeathArmed()).toBeFalse();

      channelReady.and.returnValue(false);
      isOpen.and.returnValue(true);
      RoomConnectHelper.noteOpenPeerPresence();
      expect(RoomConnectHelper.isSoftDeathArmed()).toBeTrue();
      jasmine.clock().tick(1000);
      expect(RoomConnectHelper.maybeSoftDeathReopen()).toBeTrue();
      jasmine.clock().tick(17_000);
      expect(open).toHaveBeenCalled();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.SOFT_DEATH_MS_FOR_TEST = 0;
      RoomConnectHelper.hadOpenPeerThisSession = false;
      (RoomConnectHelper as any).clearSoftDeathState();
    }
  });

  it('isMeshDeathArmed when open=0 with other room members', () => {
    RoomConnectHelper.hadOpenPeerThisSession = true;
    (RoomConnectHelper as any).meshDeathSince = Date.now();
    (RoomConnectHelper as any).meshDeathAttempted = false;
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self', 'peer']);
    expect(RoomConnectHelper.isMeshDeathArmed()).toBeTrue();
    expect(RoomConnectHelper.isSoftDeathArmed()).toBeFalse();
  });

  it('mesh-death reopens once after threshold when others are in room', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.MESH_DEATH_MS_FOR_TEST = 1000;
      RoomConnectHelper.everHadRoomSession = true;
      RoomConnectHelper.hadOpenPeerThisSession = true;
      (RoomConnectHelper as any).meshDeathSince = 0;
      (RoomConnectHelper as any).meshDeathAttempted = false;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
      spyOn(Network, 'isRoomChannelReady').and.returnValue(false);
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1',
        peerId: 'self',
        isRoom: true,
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
      spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self', 'peer']);

      RoomConnectHelper.noteOpenPeerPresence();
      expect(RoomConnectHelper.isMeshDeathArmed()).toBeTrue();
      expect(RoomConnectHelper.maybeMeshDeathReopen()).toBeFalse();

      jasmine.clock().tick(1000);
      expect(RoomConnectHelper.maybeMeshDeathReopen()).toBeTrue();
      // Mid-session reopen defers for ghost TTL (duplicate-member).
      expect(open).not.toHaveBeenCalled();
      expect((RoomConnectHelper as any).meshDeathAttempted).toBeTrue();
      jasmine.clock().tick(17_000);
      expect(open).toHaveBeenCalled();

      RoomConnectHelper.abortReopenInFlight();
      expect(RoomConnectHelper.maybeMeshDeathReopen()).toBeFalse();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.MESH_DEATH_MS_FOR_TEST = 0;
      RoomConnectHelper.hadOpenPeerThisSession = false;
      (RoomConnectHelper as any).clearMeshDeathState();
    }
  });

  it('mesh-death state clears when open peers return', () => {
    RoomConnectHelper.hadOpenPeerThisSession = true;
    (RoomConnectHelper as any).meshDeathSince = Date.now();
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue(['peer']);
    RoomConnectHelper.noteOpenPeerPresence();
    expect(RoomConnectHelper.isMeshDeathArmed()).toBeFalse();
  });

  it('scheduleMeshHeal is the token-refresh remesh entry point', () => {
    const heal = spyOn(RoomConnectHelper, 'scheduleMeshHeal');
    RoomConnectHelper.scheduleMeshHeal();
    expect(heal).toHaveBeenCalled();
  });

  it('wake schedules reopen after long hide when previously meshed and channel not ready', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 100;
      RoomConnectHelper.everHadRoomSession = true;
      RoomConnectHelper.hadOpenPeerThisSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
      spyOn(Network, 'isRoomChannelReady').and.returnValue(false);
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1',
        peerId: 'self',
        isRoom: true,
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
      spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);

      RoomConnectHelper.onDocumentHidden();
      jasmine.clock().tick(50);
      RoomConnectHelper.onDocumentVisible({ skipJitter: true });
      expect(open).not.toHaveBeenCalled();

      RoomConnectHelper.onDocumentHidden();
      jasmine.clock().tick(100);
      RoomConnectHelper.onDocumentVisible({ skipJitter: true });
      // Wake uses duplicate-member defer (ghost TTL), even when wake jitter is skipped.
      expect(open).not.toHaveBeenCalled();
      jasmine.clock().tick(17_000);
      expect(open).toHaveBeenCalled();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 0;
      (RoomConnectHelper as any).documentHiddenAt = 0;
    }
  });

  it('wake does not reopen healthy solo room after brief mesh (openPeers=0)', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 100;
      RoomConnectHelper.everHadRoomSession = true;
      RoomConnectHelper.hadOpenPeerThisSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'isOpen', 'get').and.returnValue(true);
      spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
      spyOnProperty(Network, 'peer', 'get').and.returnValue({ isRoom: true, peerId: 'self' } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
      spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self']);

      RoomConnectHelper.onDocumentHidden();
      jasmine.clock().tick(100);
      RoomConnectHelper.onDocumentVisible({ skipJitter: true });
      expect(open).not.toHaveBeenCalled();
      expect(RoomConnectHelper.isNetworkReconnecting()).toBeFalse();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 0;
      (RoomConnectHelper as any).documentHiddenAt = 0;
    }
  });

  it('wake does not reopen solo room that never had open peers', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 100;
      RoomConnectHelper.everHadRoomSession = true;
      RoomConnectHelper.hadOpenPeerThisSession = false;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({ isRoom: true, peerId: 'self' } as IPeerContext);
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);

      RoomConnectHelper.onDocumentHidden();
      jasmine.clock().tick(100);
      RoomConnectHelper.onDocumentVisible({ skipJitter: true });
      expect(open).not.toHaveBeenCalled();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 0;
      (RoomConnectHelper as any).documentHiddenAt = 0;
    }
  });

  it('wake skip when hide is too brief', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 5000;
      RoomConnectHelper.everHadRoomSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({ isRoom: true, peerId: 'self' } as IPeerContext);
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);

      RoomConnectHelper.onDocumentHidden();
      jasmine.clock().tick(100);
      RoomConnectHelper.onDocumentVisible({ skipJitter: true });
      expect(open).not.toHaveBeenCalled();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 0;
      (RoomConnectHelper as any).documentHiddenAt = 0;
    }
  });

  it('wake does not schedule when reopen backoff retry is pending', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 100;
      RoomConnectHelper.everHadRoomSession = true;
      RoomConnectHelper.hadOpenPeerThisSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1',
        peerId: 'self',
        isRoom: true,
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);

      RoomConnectHelper.scheduleReopenRetry('disconnected', { noteOutage: false });
      expect(RoomConnectHelper.isReopenRetryPending()).toBeTrue();

      RoomConnectHelper.onDocumentHidden();
      jasmine.clock().tick(100);
      expect(RoomConnectHelper.maybeScheduleWakeReopen(true)).toBeFalse();
      expect(open).not.toHaveBeenCalled();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.WAKE_MIN_HIDDEN_MS_FOR_TEST = 0;
      (RoomConnectHelper as any).documentHiddenAt = 0;
    }
  });

  it('duplicate-member defers Network.open for ghost TTL before join', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.everHadRoomSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1',
        peerId: 'peerDup001',
        isRoom: true,
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('peerDup001');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);

      expect(RoomConnectHelper.reopenLastRoomOrLobby('already-same-name-member-exist')).toBe('started');
      expect(open).not.toHaveBeenCalled();
      expect((RoomConnectHelper as any).reopenJitterTimer).not.toBeNull();

      jasmine.clock().tick(14_999);
      expect(open).not.toHaveBeenCalled();

      jasmine.clock().tick(5_000);
      expect(open).toHaveBeenCalled();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
    }
  });

  it('auto-reopen delays fullscreen busy so brief recoveries stay soft', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    const busy = {
      show: jasmine.createSpy('show'),
      hide: jasmine.createSpy('hide'),
    };
    const prev = (ConnectionBusyService as any)._instance;
    (ConnectionBusyService as any)._instance = busy;
    try {
      RoomConnectHelper.REOPEN_BUSY_DELAY_MS_FOR_TEST = 5_000;
      RoomConnectHelper.everHadRoomSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      spyOn(Network, 'open');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1', peerId: 'self', isRoom: true,
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);

      expect(RoomConnectHelper.reopenLastRoomOrLobby('disconnected', { skipJitter: true })).toBe('started');
      expect(busy.show).not.toHaveBeenCalled();
      expect(RoomConnectHelper.isNetworkReconnecting()).toBeTrue();

      jasmine.clock().tick(4_999);
      expect(busy.show).not.toHaveBeenCalled();

      jasmine.clock().tick(1);
      expect(busy.show).toHaveBeenCalledWith('net.reconnectingRoom');
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.REOPEN_BUSY_DELAY_MS_FOR_TEST = 0;
      (ConnectionBusyService as any)._instance = prev;
    }
  });

  it('auto-reopen that finishes before busy delay never freezes the screen', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    const busy = {
      show: jasmine.createSpy('show'),
      hide: jasmine.createSpy('hide'),
    };
    const prev = (ConnectionBusyService as any)._instance;
    (ConnectionBusyService as any)._instance = busy;
    try {
      RoomConnectHelper.REOPEN_BUSY_DELAY_MS_FOR_TEST = 5_000;
      RoomConnectHelper.everHadRoomSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      spyOn(Network, 'open');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1', peerId: 'self', isRoom: true,
      } as IPeerContext);
      spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
      spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);

      expect(RoomConnectHelper.reopenLastRoomOrLobby('disconnected', { skipJitter: true })).toBe('started');
      jasmine.clock().tick(1_000);
      // Recovery completes before the soft window ends.
      RoomConnectHelper.abortReopenInFlight();
      expect(busy.show).not.toHaveBeenCalled();

      jasmine.clock().tick(10_000);
      expect(busy.show).not.toHaveBeenCalled();
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      RoomConnectHelper.REOPEN_BUSY_DELAY_MS_FOR_TEST = 0;
      (ConnectionBusyService as any)._instance = prev;
    }
  });

  it('scheduleReopenRetry accepts OutageKind duplicate-member from lastOutageKind', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.everHadRoomSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const reopen = spyOn(RoomConnectHelper, 'reopenLastRoomOrLobby').and.returnValue('started');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1', peerId: 'self', isRoom: true,
      } as IPeerContext);

      RoomConnectHelper.scheduleReopenRetry('duplicate-member');
      expect(RoomConnectHelper.isReopenRetryPending()).toBeTrue();
      jasmine.clock().tick(15_000);
      expect(reopen).toHaveBeenCalledWith('duplicate-member', { skipJitter: true });
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
    }
  });

  it('stops duplicate-member auto-retry after DUPLICATE_MEMBER_REOPEN_MAX_ATTEMPTS', () => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(1_700_000_000_000));
    try {
      RoomConnectHelper.everHadRoomSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const reopen = spyOn(RoomConnectHelper, 'reopenLastRoomOrLobby').and.returnValue('started');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({
        userId: 'u1', peerId: 'self', isRoom: true,
      } as IPeerContext);

      for (let i = 0; i < 4; i++) {
        RoomConnectHelper.scheduleReopenRetry('duplicate-member');
        expect(RoomConnectHelper.isReopenRetryPending()).toBeTrue();
        // Advance past max backoff (90s) so each scheduled retry fires.
        jasmine.clock().tick(90_000);
        expect(reopen).toHaveBeenCalledTimes(i + 1);
      }
      expect(RoomConnectHelper.isDuplicateMemberRecoveryExhausted()).toBeTrue();
      expect(RoomConnectHelper.shouldAttemptRoomReopen('duplicate-member')).toBeFalse();
      expect(RoomConnectHelper.shouldAttemptRoomReopen('already-same-name-member-exist')).toBeFalse();

      RoomConnectHelper.scheduleReopenRetry('duplicate-member');
      expect(RoomConnectHelper.isReopenRetryPending()).toBeFalse();
      expect(reopen).toHaveBeenCalledTimes(4);
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
    }
  });

  it('mesh-death does not burn one-shot when reopen returns busy', () => {
    RoomConnectHelper.MESH_DEATH_MS_FOR_TEST = 1;
    RoomConnectHelper.everHadRoomSession = true;
    RoomConnectHelper.hadOpenPeerThisSession = true;
    (RoomConnectHelper as any).meshDeathSince = Date.now() - 10;
    (RoomConnectHelper as any).meshDeathAttempted = false;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1', roomId: 'Ab1', roomName: 'TestRoom', meshPassword: '',
    });
    spyOnProperty(Network, 'peer', 'get').and.returnValue({
      userId: 'u1', peerId: 'self', isRoom: true,
    } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'peerIds', 'get').and.returnValue([]);
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self', 'peer']);
    spyOn(RoomConnectHelper, 'reopenLastRoomOrLobby').and.returnValue('busy');

    expect(RoomConnectHelper.maybeMeshDeathReopen()).toBeFalse();
    expect((RoomConnectHelper as any).meshDeathAttempted).toBeFalse();
  });

  it('reopens lobby peer only when this page never had a room', async () => {
    RoomConnectHelper.everHadRoomSession = false;
    spyOn(Network, 'getLastRoomSession').and.returnValue(null);
    spyOn(Network, 'open');
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ userId: 'u1', peerId: 'self' } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    const remesh = spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();

    expect(RoomConnectHelper.reopenLastRoomOrLobby()).toBe('started');
    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    await new Promise<void>(resolve => setTimeout(resolve, 20));

    expect(Network.open).toHaveBeenCalled();
    expect(remesh).not.toHaveBeenCalled();
  });

  it('skips lobby reopen when room session is missing after mid-game', () => {
    RoomConnectHelper.everHadRoomSession = true;
    spyOn(Network, 'getLastRoomSession').and.returnValue(null);
    const open = spyOn(Network, 'open');

    expect(RoomConnectHelper.reopenLastRoomOrLobby()).toBe('no-session');
    expect(open).not.toHaveBeenCalled();
  });

  it('returns busy while join probe is in progress', () => {
    RoomConnectHelper.joinInProgress = true;
    RoomConnectHelper.everHadRoomSession = true;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1',
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
    });
    const open = spyOn(Network, 'open');

    expect(RoomConnectHelper.shouldAttemptReopenNow()).toBeFalse();
    expect(RoomConnectHelper.reopenLastRoomOrLobby()).toBe('busy');
    expect(open).not.toHaveBeenCalled();
  });

  it('returns busy during joinOwnedUntil after a failed probe', () => {
    RoomConnectHelper.joinInProgress = false;
    (RoomConnectHelper as any).joinOwnedUntil = Date.now() + 5000;
    RoomConnectHelper.everHadRoomSession = true;
    spyOn(Network, 'getLastRoomSession').and.returnValue({
      userId: 'u1',
      roomId: 'Ab1',
      roomName: 'TestRoom',
      meshPassword: '',
    });
    const open = spyOn(Network, 'open');

    expect(RoomConnectHelper.isJoinOwningNetworkError).toBeTrue();
    expect(RoomConnectHelper.shouldAttemptReopenNow()).toBeFalse();
    expect(RoomConnectHelper.reopenLastRoomOrLobby()).toBe('busy');
    expect(open).not.toHaveBeenCalled();
  });

  it('schedules backoff reopen retry after failed reopen', () => {
    jasmine.clock().install();
    try {
      skyWayRecoveryGate.resetForTests();
      RoomConnectHelper.clearReopenRetry();
      (RoomConnectHelper as any).reopenInFlight = false;
      RoomConnectHelper.everHadRoomSession = true;
      spyOn(Network, 'getLastRoomSession').and.returnValue({
        userId: 'u1',
        roomId: 'Ab1',
        roomName: 'TestRoom',
        meshPassword: '',
      });
      const open = spyOn(Network, 'open');
      spyOnProperty(Network, 'peer', 'get').and.returnValue({ userId: 'u1', peerId: 'self' } as IPeerContext);
      spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();

      expect(RoomConnectHelper.reopenLastRoomOrLobby()).toBe('started');
      expect(open).toHaveBeenCalledTimes(1);
      expect(RoomConnectHelper.isReopenInFlight).toBeTrue();

      EventSystem.trigger('NETWORK_ERROR', {
        peerId: 'self',
        errorType: 'server-error',
        errorMessage: 'unreachable',
        errorObject: null,
      });

      expect(RoomConnectHelper.isReopenInFlight).toBeFalse();
      expect(RoomConnectHelper.isReopenRetryPending()).toBeTrue();

      // server-error outage base delay is 8s (not the old 3s disconnected base).
      jasmine.clock().tick(8000);
      expect(open).toHaveBeenCalledTimes(2);
    } finally {
      RoomConnectHelper.abortReopenInFlight();
      jasmine.clock().uninstall();
      skyWayRecoveryGate.resetForTests();
    }
  });
});

describe('RoomConnectHelper.remeshRoomPeers', () => {
  let streamPeers: IPeerContext[];
  let openPeerIds: string[];
  const prevAttempts = (RoomConnectHelper as any).REMESH_ATTEMPTS;
  const prevDelay = (RoomConnectHelper as any).REMESH_DELAY_MS;
  const prevPeerWait = (RoomConnectHelper as any).REMESH_PEER_WAIT_MS;

  beforeEach(() => {
    streamPeers = [];
    openPeerIds = [];
    spyOn(Network, 'connect').and.returnValue(true);
    spyOn(Network, 'disconnect').and.callFake((p: IPeerContext) => {
      streamPeers = streamPeers.filter(x => x.peerId !== p.peerId);
      openPeerIds = openPeerIds.filter(id => id !== p.peerId);
      return true;
    });
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue([]);
    spyOnProperty(Network, 'peers', 'get').and.callFake(() => streamPeers);
    spyOnProperty(Network, 'peerIds', 'get').and.callFake(() => openPeerIds.slice());
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    RoomConnectHelper.stopMeshKeepalive();
    (RoomConnectHelper as any).connectingSince = new Map();
  });
  afterEach(() => {
    (RoomConnectHelper as any).REMESH_ATTEMPTS = prevAttempts;
    (RoomConnectHelper as any).REMESH_DELAY_MS = prevDelay;
    (RoomConnectHelper as any).REMESH_PEER_WAIT_MS = prevPeerWait;
    RoomConnectHelper.STUCK_CONNECTING_MS_FOR_TEST = 0;
    RoomConnectHelper.stopMeshKeepalive();
  });

  it('retries when the room listing is temporarily alone', async () => {
    (RoomConnectHelper as any).REMESH_ATTEMPTS = 3;
    (RoomConnectHelper as any).REMESH_DELAY_MS = 0;
    const list = spyOn(Network, 'listAllRooms').and.resolveTo([{
      id: 'Ab1',
      name: 'TestRoom',
      hasPassword: false,
      peers: [peer('self')],
      filterByPassword: () => [peer('self')],
    }]);

    await RoomConnectHelper.remeshRoomPeers('Ab1', 'TestRoom', '');
    expect(list).toHaveBeenCalledWith(true);
    expect(list).toHaveBeenCalledTimes(3);
    expect(Network.connect).not.toHaveBeenCalled();
  });

  it('skips lobby list this round when channel members are present', async () => {
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self', 'other']);
    (Network.connect as jasmine.Spy).and.returnValue(false);
    const list = spyOn(Network, 'listAllRooms').and.resolveTo([]);
    (RoomConnectHelper as any).REMESH_ATTEMPTS = 1;
    (RoomConnectHelper as any).REMESH_DELAY_MS = 0;
    (RoomConnectHelper as any).REMESH_PEER_WAIT_MS = 0;

    await RoomConnectHelper.remeshRoomPeers('Ab1', 'TestRoom', '');

    expect(Network.connect).toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('connects channel members before falling back to lobby list', async () => {
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self', 'other']);
    (Network.connect as jasmine.Spy).and.callFake(() => {
      streamPeers = [peer('other')];
      openPeerIds = ['other'];
      return true;
    });
    const list = spyOn(Network, 'listAllRooms');
    (RoomConnectHelper as any).REMESH_ATTEMPTS = 1;
    (RoomConnectHelper as any).REMESH_DELAY_MS = 0;
    (RoomConnectHelper as any).REMESH_PEER_WAIT_MS = 0;

    await RoomConnectHelper.remeshRoomPeers('Ab1', 'TestRoom', '');

    expect(Network.connect).toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('does not treat half-open streams as remesh success', async () => {
    streamPeers = [{ peerId: 'stuck', isOpen: false } as IPeerContext];
    openPeerIds = [];
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self', 'other']);
    (RoomConnectHelper as any).REMESH_ATTEMPTS = 1;
    (RoomConnectHelper as any).REMESH_DELAY_MS = 0;
    (RoomConnectHelper as any).REMESH_PEER_WAIT_MS = 0;
    const list = spyOn(Network, 'listAllRooms');

    await RoomConnectHelper.remeshRoomPeers('Ab1', 'TestRoom', '');

    expect(Network.connect).toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('waits for CONNECT_PEER after connect attempts before resolving', async () => {
    const other = peer('other');
    spyOn(Network, 'listAllRooms').and.resolveTo([{
      id: 'Ab1',
      name: 'TestRoom',
      hasPassword: false,
      peers: [peer('self'), other],
      filterByPassword: () => [peer('self'), other],
    }]);
    (RoomConnectHelper as any).REMESH_ATTEMPTS = 1;
    (RoomConnectHelper as any).REMESH_DELAY_MS = 0;
    (RoomConnectHelper as any).REMESH_PEER_WAIT_MS = 500;

    const done = RoomConnectHelper.remeshRoomPeers('Ab1', 'TestRoom', '');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect(Network.connect).toHaveBeenCalled();
    streamPeers = [other];
    openPeerIds = ['other'];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'other' });
    await done;
  });
});

describe('RoomConnectHelper.healMeshGaps', () => {
  let streamPeers: IPeerContext[];
  let openPeerIds: string[];
  let networkIsOpen = true;

  beforeEach(() => {
    networkIsOpen = true;
    streamPeers = [];
    openPeerIds = [];
    spyOn(Network, 'connect').and.callFake((p: IPeerContext) => {
      streamPeers = [...streamPeers, { peerId: p.peerId, isOpen: false } as IPeerContext];
      return true;
    });
    spyOn(Network, 'disconnect').and.callFake((p: IPeerContext) => {
      streamPeers = streamPeers.filter(x => x.peerId !== p.peerId);
      openPeerIds = openPeerIds.filter(id => id !== p.peerId);
      return true;
    });
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue(['self', 'a', 'b']);
    spyOnProperty(Network, 'peers', 'get').and.callFake(() => streamPeers);
    spyOnProperty(Network, 'peerIds', 'get').and.callFake(() => openPeerIds.slice());
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOnProperty(Network, 'isOpen', 'get').and.callFake(() => networkIsOpen);
    spyOn(Network, 'isRoomChannelReady').and.returnValue(true);
    spyOnProperty(Network, 'peer', 'get').and.returnValue({
      peerId: 'self', isRoom: true, userId: 'u1',
    } as IPeerContext);
    RoomConnectHelper.stopMeshKeepalive();
    (RoomConnectHelper as any).connectingSince = new Map();
    RoomConnectHelper.STUCK_CONNECTING_MS_FOR_TEST = 0;
  });

  afterEach(() => {
    RoomConnectHelper.STUCK_CONNECTING_MS_FOR_TEST = 0;
    RoomConnectHelper.stopMeshKeepalive();
    RoomConnectHelper.clearReopenRetry();
    (RoomConnectHelper as any).meshHealInFlight = false;
  });

  it('connects room members that lack an open DataChannel', async () => {
    openPeerIds = ['a'];
    streamPeers = [{
      peerId: 'a',
      isOpen: true,
      session: { ping: 50, health: 1, speed: 1, bitrateInstantBps: 0, bitrateBps: 0, grade: 0, description: '' },
    } as IPeerContext];

    await RoomConnectHelper.healMeshGaps();

    expect(Network.connect).toHaveBeenCalled();
    const connectedIds = (Network.connect as jasmine.Spy).calls.allArgs().map(args => args[0].peerId);
    expect(connectedIds).toEqual(['b']);
  });

  it('prunes stuck connecting peers then reconnects them', async () => {
    RoomConnectHelper.STUCK_CONNECTING_MS_FOR_TEST = 50;
    streamPeers = [{ peerId: 'b', isOpen: false } as IPeerContext];
    openPeerIds = [];
    (RoomConnectHelper as any).connectingSince = new Map([['b', Date.now() - 1000]]);

    await RoomConnectHelper.healMeshGaps();

    expect(Network.connect).toHaveBeenCalled();
    expect(Network.disconnect).toHaveBeenCalled();
  });

  it('skips extra gap connects in survival mesh when hub is already open (5+ members)', async () => {
    openPeerIds = ['a'];
    streamPeers = [{
      peerId: 'a',
      isOpen: true,
      session: { ping: 3000, health: 1, speed: 1, bitrateInstantBps: 0, bitrateBps: 0, grade: 0, description: '' },
    } as IPeerContext];
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self', 'a', 'b', 'c', 'd']);

    await RoomConnectHelper.healMeshGaps();

    expect(Network.connect).not.toHaveBeenCalled();
  });

  it('fills mesh gaps for small rooms even when ping is high', async () => {
    openPeerIds = ['a'];
    streamPeers = [{
      peerId: 'a',
      isOpen: true,
      session: { ping: 3000, health: 1, speed: 1, bitrateInstantBps: 0, bitrateBps: 0, grade: 0, description: '' },
    } as IPeerContext];
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self', 'a', 'b', 'c']);

    await RoomConnectHelper.healMeshGaps();

    expect(Network.connect).toHaveBeenCalled();
  });

  it('when alone in room, cleans orphan streams and skips gap connect / lobby remesh', async () => {
    streamPeers = [{ peerId: 'ghost', isOpen: false } as IPeerContext];
    openPeerIds = [];
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self']);
    const remesh = spyOn(RoomConnectHelper, 'remeshRoomPeers').and.resolveTo();

    await RoomConnectHelper.healMeshGaps();

    expect(Network.connect).not.toHaveBeenCalled();
    expect(Network.disconnect).toHaveBeenCalled();
    expect(remesh).not.toHaveBeenCalled();
  });

  it('when channel not ready but Network still open, does not schedule reopen from heal', async () => {
    (Network.isRoomChannelReady as jasmine.Spy).and.returnValue(false);
    const reopen = spyOn(RoomConnectHelper, 'scheduleReopenRetry');

    await RoomConnectHelper.healMeshGaps();

    expect(reopen).not.toHaveBeenCalled();
    expect(Network.connect).not.toHaveBeenCalled();
  });

  it('when channel not ready and Network closed, schedules reopen from heal', async () => {
    (Network.isRoomChannelReady as jasmine.Spy).and.returnValue(false);
    networkIsOpen = false;
    const reopen = spyOn(RoomConnectHelper, 'scheduleReopenRetry');

    await RoomConnectHelper.healMeshGaps();

    expect(reopen).toHaveBeenCalledWith('disconnected');
  });

  it('disconnectPeersNotInRoom drops streams not in SkyWay members', () => {
    streamPeers = [
      { peerId: 'live', isOpen: true } as IPeerContext,
      { peerId: 'ghost', isOpen: false } as IPeerContext,
    ];
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self', 'live']);

    const dropped = RoomConnectHelper.disconnectPeersNotInRoom();

    expect(dropped).toEqual(['ghost']);
    expect(Network.disconnect).toHaveBeenCalled();
  });

  it('keeps remeshing after a half-open handshake instead of aborting', async () => {
    streamPeers = [{ peerId: 'other', isOpen: false } as IPeerContext];
    openPeerIds = [];
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self', 'other']);
    (RoomConnectHelper as any).REMESH_ATTEMPTS = 2;
    (RoomConnectHelper as any).REMESH_DELAY_MS = 0;
    (RoomConnectHelper as any).REMESH_PEER_WAIT_MS = 0;
    RoomConnectHelper.STUCK_CONNECTING_MS_FOR_TEST = 1;
    (RoomConnectHelper as any).connectingSince = new Map([['other', Date.now() - 1000]]);
    const list = spyOn(Network, 'listAllRooms');

    await RoomConnectHelper.remeshRoomPeers('Ab1', 'TestRoom', '');

    expect(Network.disconnect).toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });
});

describe('RoomConnectHelper.openAndConnect', () => {
  let openPeers: IPeerContext[];
  let resetSpy: jasmine.Spy;
  let abandonSpy: jasmine.Spy;
  const prevStableMs = RoomConnectHelper.JOIN_STABLE_MS;
  const prevDataMs = RoomConnectHelper.JOIN_DATA_MS;
  const prevQuiesceMs = RoomConnectHelper.JOIN_QUIESCE_MS;

  beforeEach(() => {
    RoomConnectHelper.JOIN_STABLE_MS = 0;
    RoomConnectHelper.JOIN_DATA_MS = 0;
    RoomConnectHelper.JOIN_QUIESCE_MS = 0;
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 0;
    RoomConnectHelper.lastJoinFailReason = '';
    RoomConnectHelper.clearLobbyRoomSuppression();
    openPeers = [];
    spyOn(Network, 'open');
    spyOn(Network, 'connect').and.returnValue(true);
    spyOn(Network, 'listRoomMemberPeerIds').and.returnValue([]);
    spyOnProperty(Network, 'peers', 'get').and.callFake(() => openPeers);
    spyOnProperty(Network, 'peerIds', 'get').and.callFake(() => openPeers.map(p => p.peerId));
    spyOnProperty(Network, 'peer', 'get').and.returnValue({ userId: 'u1', peerId: 'self', isRoom: true } as IPeerContext);
    spyOnProperty(Network, 'peerId', 'get').and.returnValue('self');
    spyOn(Room, 'clearLocalTabletopForJoin');
    resetSpy = spyOn(RoomConnectHelper, 'resetToLobby');
    abandonSpy = spyOn(RoomConnectHelper, 'abandonFailedJoinProbe').and.callThrough();
  });
  afterEach(() => {
    RoomConnectHelper.JOIN_STABLE_MS = prevStableMs;
    RoomConnectHelper.JOIN_DATA_MS = prevDataMs;
    RoomConnectHelper.JOIN_QUIESCE_MS = prevQuiesceMs;
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 0;
    (RoomConnectHelper as any).JOIN_REMESH_MS = 2000;
    RoomConnectHelper.joinInProgress = false;
    RoomConnectHelper.lastJoinFailReason = '';
    RoomConnectHelper.clearLobbyRoomSuppression();
    // openAndConnect may leave the hold set if a test settles without endJoinProbe pairing.
    FileReceiveScheduler.endJoinProbeHold();
    FileReceiveScheduler.resetForTests();
  });

  it('settles tabletop remount after a successful mesh join', async () => {
    const settle = spyOn(RoomConnectHelper, 'settleTabletopAfterMeshJoin').and.stub();
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('live')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    hostTabletop('live');

    await expectAsync(result).toBeResolvedTo(true);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(settle).toHaveBeenCalled();
  });

  it('restores tabletop once on mesh settle without delayed ROOM_PIECES', () => {
    const restore = spyOn(TableSelecter.instance, 'restoreAfterRoomLoad').and.stub();
    const trigger = spyOn(EventSystem, 'trigger').and.callThrough();

    RoomConnectHelper.settleTabletopAfterMeshJoin();

    expect(restore).toHaveBeenCalled();
    const piecesCalls = trigger.calls.allArgs().filter(args => String(args[0]) === 'ROOM_PIECES_REPLACED');
    // Delayed second remount removed; restore owns the single ROOM_PIECES when not stubbed.
    expect(piecesCalls.length).toBe(0);
  });

  it('sets joinOwnedUntil when join probe fails so reopen stays busy', async () => {
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 80;
    (Network.connect as jasmine.Spy).and.returnValue(false);
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('ghost')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });

    await expectAsync(result).toBeResolvedTo(false);
    expect(RoomConnectHelper.lastJoinFailReason).toBe('connect_timeout');
    expect(RoomConnectHelper.isJoinOwningNetworkError).toBeTrue();
    expect(RoomConnectHelper.shouldAttemptReopenNow()).toBeFalse();
    (RoomConnectHelper as any).joinOwnedUntil = 0;
  });

  it('does not settle tabletop when join probe fails', async () => {
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 80;
    const settle = spyOn(RoomConnectHelper, 'settleTabletopAfterMeshJoin').and.stub();
    (Network.connect as jasmine.Spy).and.returnValue(false);
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('ghost')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });

    await expectAsync(result).toBeResolvedTo(false);
    await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(settle).not.toHaveBeenCalled();
    (RoomConnectHelper as any).joinOwnedUntil = 0;
  });

  it('soft-fails connect() until remesh finds a ready room member', async () => {
    let members: string[] = [];
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.callFake(() => members);
    (Network.connect as jasmine.Spy).and.callFake((p: IPeerContext) => {
      return members.includes(p.peerId);
    });
    (RoomConnectHelper as any).JOIN_REMESH_MS = 30;
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 5000;
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('live')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect(RoomConnectHelper.joinInProgress).toBeTrue();

    members = ['self', 'live'];
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    hostTabletop('live');

    await expectAsync(result).toBeResolvedTo(true);
  });

  it('resolves true on first CONNECT_PEER without waiting for remaining targets', async () => {
    const targets = [peer('live'), peer('ghost')];
    const result = RoomConnectHelper.openAndConnect(room, '', targets);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    hostTabletop('live');

    await expectAsync(result).toBeResolvedTo(true);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(Network.connect).toHaveBeenCalledTimes(2);
    expect(Room.clearLocalTabletopForJoin).toHaveBeenCalledTimes(1);
  });

  it('does not switch tabletop until a live peer sends a game-table', async () => {
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('live')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    hostCatalog('live');
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    expect(Room.clearLocalTabletopForJoin).not.toHaveBeenCalled();

    hostTabletop('live');
    await expectAsync(result).toBeResolvedTo(true);
    expect(Room.clearLocalTabletopForJoin).toHaveBeenCalledTimes(1);
  });

  it('extends data wait while meshed, then succeeds when game-table arrives late', async () => {
    RoomConnectHelper.JOIN_DATA_MS = 40;
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 5000;
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('live')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    hostCatalog('live');
    await new Promise<void>(resolve => setTimeout(resolve, 100));
    expect(resetSpy).not.toHaveBeenCalled();
    expect(Room.clearLocalTabletopForJoin).not.toHaveBeenCalled();

    hostTabletop('live');
    await expectAsync(result).toBeResolvedTo(true);
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('on overall timeout while meshed stays in room (never kicks self)', async () => {
    RoomConnectHelper.JOIN_DATA_MS = 40;
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 120;
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('live')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    hostCatalog('live');

    await expectAsync(result).toBeResolvedTo(true);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(Room.clearLocalTabletopForJoin).toHaveBeenCalled();
  });

  it('restarts connect budget after first peer so late game-table can still succeed', async () => {
    RoomConnectHelper.JOIN_DATA_MS = 5000;
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 100;
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('live')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    // Burn most of the open-phase budget before any DataChannel opens (slow ICE).
    await new Promise<void>(resolve => setTimeout(resolve, 70));
    expect(RoomConnectHelper.joinInProgress).toBeTrue();

    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    // Without restart, CONNECT_TIMEOUT would fire ~30ms after connect.
    await new Promise<void>(resolve => setTimeout(resolve, 70));
    expect(RoomConnectHelper.joinInProgress).toBeTrue();

    hostTabletop('live');
    await expectAsync(result).toBeResolvedTo(true);
    expect(RoomConnectHelper.lastJoinFailReason).toBe('');
  });

  it('aborts missing tabletop only after becoming alone', async () => {
    RoomConnectHelper.JOIN_DATA_MS = 40;
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 5000;
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('live')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    await new Promise<void>(resolve => setTimeout(resolve, 60));
    expect(resetSpy).not.toHaveBeenCalled();

    openPeers = [];
    EventSystem.trigger('DISCONNECT_PEER', { peerId: 'live' });
    await expectAsync(result).toBeResolvedTo(false);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(abandonSpy).toHaveBeenCalled();
    expect(RoomConnectHelper.isLobbyRoomSuppressed('Ab1', 'TestRoom')).toBeTrue();
    expect(RoomConnectHelper.lastJoinFailReason).toBe('all_targets_failed');
  });

  it('fails no_tabletop_data when alone after soft slices', async () => {
    RoomConnectHelper.JOIN_DATA_MS = 40;
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 5000;
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('ghost')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('ghost')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'ghost' });
    await new Promise<void>(resolve => setTimeout(resolve, 20));
    openPeers = [];
    EventSystem.trigger('DISCONNECT_PEER', { peerId: 'ghost' });
    await expectAsync(result).toBeResolvedTo(false);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(abandonSpy).toHaveBeenCalled();
    expect(RoomConnectHelper.isLobbyRoomSuppressed('Ab1', 'TestRoom')).toBeTrue();
    expect(['no_tabletop_data', 'all_targets_failed']).toContain(RoomConnectHelper.lastJoinFailReason);
  });

  it('resolves false and suppresses room when all targets fail while alone', async () => {
    const targets = [peer('a'), peer('b')];
    const result = RoomConnectHelper.openAndConnect(room, '', targets);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('a')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'a' });
    openPeers = [];
    EventSystem.trigger('DISCONNECT_PEER', { peerId: 'a' });
    EventSystem.trigger('DISCONNECT_PEER', { peerId: 'b' });

    await expectAsync(result).toBeResolvedTo(false);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(abandonSpy).toHaveBeenCalled();
    expect(RoomConnectHelper.lastJoinFailReason).toBe('all_targets_failed');
    expect(RoomConnectHelper.isLobbyRoomSuppressed('Ab1', 'TestRoom')).toBeTrue();
    expect(Room.clearLocalTabletopForJoin).not.toHaveBeenCalled();
  });

  it('ignores late DISCONNECT_PEER after success (settled / unregistered)', async () => {
    const targets = [peer('live'), peer('ghost')];
    const result = RoomConnectHelper.openAndConnect(room, '', targets);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    hostTabletop('live');
    await expectAsync(result).toBeResolvedTo(true);

    resetSpy.calls.reset();
    openPeers = [];
    EventSystem.trigger('DISCONNECT_PEER', { peerId: 'ghost' });
    EventSystem.trigger('DISCONNECT_PEER', { peerId: 'live' });

    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('fails join and suppresses room when the only peer is a ghost that drops', async () => {
    RoomConnectHelper.JOIN_STABLE_MS = 50;
    const targets = [peer('ghost')];
    const result = RoomConnectHelper.openAndConnect(room, '', targets);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('ghost')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'ghost' });
    openPeers = [];
    EventSystem.trigger('DISCONNECT_PEER', { peerId: 'ghost' });

    await expectAsync(result).toBeResolvedTo(false);
    expect(resetSpy).not.toHaveBeenCalled();
    expect(abandonSpy).toHaveBeenCalled();
    expect(RoomConnectHelper.isLobbyRoomSuppressed('Ab1', 'TestRoom')).toBeTrue();
    expect(Room.clearLocalTabletopForJoin).not.toHaveBeenCalled();
  });

  it('does not hide the lobby room on connect_timeout (retryable network fail)', async () => {
    RoomConnectHelper.CONNECT_TIMEOUT_MS_FOR_TEST = 80;
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('slow')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    // Connect started but never CONNECT_PEER / DISCONNECT_PEER — overall timeout.
    await expectAsync(result).toBeResolvedTo(false);
    expect(RoomConnectHelper.lastJoinFailReason).toBe('connect_timeout');
    expect(RoomConnectHelper.isLobbyRoomSuppressed('Ab1', 'TestRoom')).toBeFalse();
    expect(abandonSpy).toHaveBeenCalled();
    expect(resetSpy).not.toHaveBeenCalled();
  });

  it('meshes SkyWay room members even when lobby seed peers are ghosts', async () => {
    (Network.listRoomMemberPeerIds as jasmine.Spy).and.returnValue(['self', 'live']);
    (Network.connect as jasmine.Spy).and.callFake((p: IPeerContext) => p.peerId === 'live');
    const result = RoomConnectHelper.openAndConnect(room, '', [peer('ghost')]);

    EventSystem.trigger('OPEN_NETWORK', { peerId: 'self' });
    openPeers = [peer('live')];
    EventSystem.trigger('CONNECT_PEER', { peerId: 'live' });
    hostTabletop('live');

    await expectAsync(result).toBeResolvedTo(true);
    expect(Network.connect).toHaveBeenCalled();
    const connectedIds = (Network.connect as jasmine.Spy).calls.allArgs().map(a => a[0].peerId);
    expect(connectedIds).toContain('live');
  });
});

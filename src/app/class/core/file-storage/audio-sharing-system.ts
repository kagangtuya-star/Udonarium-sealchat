import { EventSystem, Network } from '../system';
import { netDebug } from '../system/network/net-debug';
import { FileReceiveScheduler } from './file-transfer-scheduler';
import { deferRequestIfPeerNotOpen } from './defer-request-if-peer-not-open';
import { StartTransmissionDeclineGate } from './start-transmission-decline';
import {
  hasActiveMediaTasks,
  meshCandidatePeerIds,
} from './media-sharing-helpers';
import {
  collectMissingDownloadRequests,
  ensureRoomMissingDownloads,
  buildMissingDownloadHooks,
  MissingDownloadHooks,
  queueMissingDownloads,
} from './missing-download-pipeline';
import {
  acceptOrDeclineStartTransmission,
  applyBlobContextsToStorage,
  applyReceiveProgressPercent,
  buildBlobOrUrlSendContext,
  fulfillOrRelaySingleFileRequest,
  startSingleFileReceiveTask,
  startSingleFileSendTask,
} from './single-file-media-transfer';
import { AudioFile, AudioFileContext, AudioState } from './audio-file';
import { AudioStorage, CatalogItem } from './audio-storage';
import { BufferSharingTask } from './buffer-sharing-task';
import {
  applyLocalAudioLibraryDelete,
  applyLocalAudioLibraryRevive,
} from './audio-library-delete';

export class AudioSharingSystem {
  private static _instance: AudioSharingSystem
  static get instance(): AudioSharingSystem {
    if (!AudioSharingSystem._instance) AudioSharingSystem._instance = new AudioSharingSystem();
    return AudioSharingSystem._instance;
  }

  private sendTaskMap: Map<string, BufferSharingTask<AudioFileContext>> = new Map();
  private receiveTaskMap: Map<string, BufferSharingTask<AudioFileContext>> = new Map();
  private readonly startDeclineGate = new StartTransmissionDeclineGate();

  private constructor() { }

  initialize() {
    this.destroy();
    EventSystem.register(this)
      .on('CONNECT_PEER', -1, event => {
        if (!event.isSendFromSelf) return;
        netDebug('CONNECT_PEER AudioStorageService !!!', event.data.peerId);
        AudioStorage.instance.synchronize(event.data.peerId);
        AudioStorage.instance.lazySynchronize(1000, event.data.peerId);
        const deleted = AudioStorage.instance.deletedIdentifiers();
        if (deleted.length) {
          EventSystem.call('DELETE_AUDIO_FILES', { identifiers: deleted }, event.data.peerId);
        }
      })
      .on('SYNCHRONIZE_AUDIO_LIST', event => {
        if (event.isSendFromSelf) return;
        netDebug('SYNCHRONIZE_AUDIO_LIST ' + event.sendFrom);

        let otherCatalog: CatalogItem[] = event.data;
        netDebug('SYNCHRONIZE_AUDIO_LIST active tasks ', this.sendTaskMap.size + this.receiveTaskMap.size);
        const hooks = this.missingDownloadHooks();
        const request = collectMissingDownloadRequests(otherCatalog, hooks);

        // Handle edge cases such as Peer disconnect
        if (request.length < 1 && !hasActiveMediaTasks(this.sendTaskMap.size, this.receiveTaskMap.size) && otherCatalog.length < AudioStorage.instance.getCatalog().length) {
          AudioStorage.instance.synchronize(event.sendFrom);
        }

        if (request.length < 1) {
          return;
        }
        queueMissingDownloads(request, event.sendFrom, otherCatalog, hooks);
      })
      .on('REQUEST_AUDIO_RESOURE', event => {
        if (event.isSendFromSelf) return;
        fulfillOrRelaySingleFileRequest({
          kind: 'audio',
          identifiers: event.data.identifiers,
          receiver: event.data.receiver,
          candidatePeers: event.data.candidatePeers,
          sendTaskCount: this.sendTaskMap.size,
          getLocalState: id => AudioStorage.instance.get(id)?.state ?? null,
          startSend: (id, receiver) => {
            const audio = AudioStorage.instance.get(id);
            if (audio) this.startSendTask(audio, receiver);
          },
          relayTo: peerId => EventSystem.call(event, peerId),
          onSend: (receiver, id) => netDebug('REQUEST_AUDIO_RESOURE Send!!! ' + receiver + ' -> ' + id),
          onRelay: peerId => netDebug('REQUEST_AUDIO_RESOURE AudioStorageService Relay!!! ' + peerId + ' -> ' + event.data.identifiers),
          onOverflow: (receiver, count) => netDebug('REQUEST_FILE_RESOURE AudioStorageService overflow...' + receiver, count),
        });
      })
      .on('UPDATE_AUDIO_RESOURE', 1000, event => {
        let updateAudios: AudioFileContext[] = event.data;
        netDebug('UPDATE_AUDIO_RESOURE AudioStorageService ' + event.sendFrom + ' -> ', updateAudios);
        applyBlobContextsToStorage(updateAudios, ctx => {
          if (AudioStorage.instance.isDeleted(ctx.identifier)) return;
          AudioStorage.instance.add(ctx);
        });
      })
      .on('START_AUDIO_TRANSMISSION', event => {
        netDebug('START_AUDIO_TRANSMISSION ' + event.data.fileIdentifier);
        const identifier: string = event.data.fileIdentifier;
        if (AudioStorage.instance.isDeleted(identifier)) return;
        acceptOrDeclineStartTransmission({
          identifier,
          sendFrom: event.sendFrom,
          isReceiving: this.receiveTaskMap.has(identifier),
          localState: AudioStorage.instance.get(identifier)?.state ?? null,
          completeState: AudioState.COMPLETE,
          declineGate: this.startDeclineGate,
          startReceive: (id, from) => this.startReceiveTask(id, from),
        });
      })
      .on('DELETE_AUDIO_FILES', event => {
        const identifiers: string[] = event.data?.identifiers || [];
        if (!event.isSendFromSelf) applyLocalAudioLibraryDelete(identifiers);
        this.cancelAudioTransfers(identifiers);
      })
      .on('REVIVE_AUDIO_FILES', event => {
        if (event.isSendFromSelf) return;
        applyLocalAudioLibraryRevive(event.data?.identifiers || []);
      });
  }

  private destroy() {
    EventSystem.unregister(this);
  }

  private async startSendTask(audio: AudioFile, sendTo: string) {
    await startSingleFileSendTask({
      identifier: audio.identifier,
      sendTo,
      sendTaskMap: this.sendTaskMap,
      startEventName: 'START_AUDIO_TRANSMISSION',
      synchronizeWhen: 'success',
      synchronize: () => AudioStorage.instance.synchronize(),
      buildContext: () => buildBlobOrUrlSendContext({
        identifier: audio.identifier,
        name: audio.name,
        state: audio.state,
        urlState: AudioState.URL,
        url: audio.url,
        blob: audio.blob,
      }),
    });
  }

  private startReceiveTask(identifier: string, fromPeerId?: string) {
    const audio = AudioStorage.instance.get(identifier);
    startSingleFileReceiveTask({
      kind: 'audio',
      identifier,
      fromPeerId,
      receiveTaskMap: this.receiveTaskMap,
      applyProgress: (loaded, total) => {
        if (audio) applyReceiveProgressPercent(audio, loaded, total);
      },
      updateEventName: 'UPDATE_AUDIO_RESOURE',
      lazySynchronize: ms => AudioStorage.instance.lazySynchronize(ms),
      stopReceiveTask: id => this.stopReceiveTask(id),
      onStarted: () => netDebug('startReceiveTask => ', this.receiveTaskMap.size),
    });
  }

  private stopReceiveTask(identifier: string) {
    let task = this.receiveTaskMap.get(identifier);
    if (task) { task.cancel(); }
    this.receiveTaskMap.delete(identifier);
    FileReceiveScheduler.markReceiveEnd('audio', identifier);

    netDebug('stopReceiveTask => ', this.receiveTaskMap.size);
  }

  private cancelAudioTransfers(identifiers: string[]) {
    for (const id of identifiers) {
      if (!id) continue;
      this.stopReceiveTask(id);
      const suffix = `:${id}`;
      for (const key of Array.from(this.sendTaskMap.keys())) {
        if (key === id || key.endsWith(suffix)) {
          const task = this.sendTaskMap.get(key);
          if (task) task.cancel();
          this.sendTaskMap.delete(key);
        }
      }
    }
  }

  ensureRoomDownloads(catalogsByPeer: Map<string, CatalogItem[]>) {
    const hooks = this.missingDownloadHooks();
    ensureRoomMissingDownloads(catalogsByPeer, hooks);
  }

  private missingDownloadHooks(): MissingDownloadHooks {
    return buildMissingDownloadHooks({
      kind: 'audio',
      completeState: AudioState.COMPLETE,
      nullState: AudioState.NULL,
      urlState: AudioState.URL,
      isReceiving: id => this.receiveTaskMap.has(id),
      get: id => AudioStorage.instance.get(id),
      addEmpty: id => {
        AudioStorage.instance.add(AudioFile.createEmpty(id));
      },
      addUrlBacked: id => {
        AudioStorage.instance.add(AudioFile.create(id));
      },
      requestOne: (identifier, localState, peerId) => {
        this.request([{ identifier, state: localState }], peerId);
      },
      shouldSkip: id => AudioStorage.instance.isDeleted(id),
    });
  }

  private request(request: CatalogItem[], peerId: string) {
    const identifier = request[0]?.identifier;
    if (deferRequestIfPeerNotOpen('audio', peerId, identifier, (ms, peer) => {
      AudioStorage.instance.lazySynchronize(ms, peer);
    })) {
      return;
    }
    netDebug('requestFile() ' + peerId);
    EventSystem.call('REQUEST_AUDIO_RESOURE', {
      identifiers: request,
      receiver: Network.peerId,
      candidatePeers: meshCandidatePeerIds()
    }, peerId);
  }
}

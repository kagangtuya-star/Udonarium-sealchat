import { EventSystem, Network } from '../system';
import { UUID } from '../system/util/uuid';
import { netDebug } from '../system/network/net-debug';
import { BufferSharingTask } from './buffer-sharing-task';
import { FileReaderUtil } from './file-reader-util';
import { ImageContext, ImageFile, ImageState } from './image-file';
import { CatalogItem, ImageStorage } from './image-storage';
import { FileReceiveScheduler } from './file-transfer-scheduler';
import { finishMediaReceiveTask } from './receive-task-finish';
import { deferRequestIfPeerNotOpen } from './defer-request-if-peer-not-open';
import { StartTransmissionDeclineGate } from './start-transmission-decline';
import {
  hasActiveMediaTasks,
  isSendTaskLimitReached,
  mediaSendTaskKey,
  meshCandidatePeerIds,
} from './media-sharing-helpers';
import {
  collectMissingDownloadRequests,
  ensureRoomMissingDownloads,
  buildMissingDownloadHooks,
  MissingDownloadHooks,
  queueMissingDownloads,
} from './missing-download-pipeline';
import { repackTransferredBlob } from './single-file-media-transfer';
import { MimeType } from './mime-type';
import {
  applyLocalImageLibraryDelete,
  applyLocalImageLibraryRevive,
} from './image-library-delete';

export class ImageSharingSystem {
  private static _instance: ImageSharingSystem
  static get instance(): ImageSharingSystem {
    if (!ImageSharingSystem._instance) ImageSharingSystem._instance = new ImageSharingSystem();
    return ImageSharingSystem._instance;
  }

  private sendTaskMap: Map<string, BufferSharingTask<ImageContext[]>> = new Map();
  private receiveTaskMap: Map<string, BufferSharingTask<ImageContext[]>> = new Map();
  private readonly startDeclineGate = new StartTransmissionDeclineGate();
  /** Peer declined our outbound transfer — pause resend (peerId:imageId). */
  private declinedSendKeys = new Map<string, number>();
  private static readonly SEND_DECLINE_COOLDOWN_MS = 45_000;
  private static readonly SEND_DECLINE_RETRY_MS = 20_000;

  private constructor() {
  }

  initialize() {
    EventSystem.register(this)
      .on('CONNECT_PEER', 1, event => {
        if (!event.isSendFromSelf) return;
        netDebug('image sync on CONNECT_PEER', event.data.peerId.slice(0, 16));
        netDebug('CONNECT_PEER ImageStorageService !!!', event.data.peerId);
        this.clearDeclinedForPeer(event.data.peerId);
        ImageStorage.instance.synchronize(event.data.peerId);
        const deleted = ImageStorage.instance.deletedIdentifiers();
        if (deleted.length) {
          EventSystem.call('DELETE_IMAGE_FILES', { identifiers: deleted }, event.data.peerId);
        }
      })
      .on('XML_LOADED', event => {
        convertUrlImage(event.data.xmlElement);
      })
      .on('SYNCHRONIZE_FILE_LIST', event => {
        if (event.isSendFromSelf) return;
        netDebug('SYNCHRONIZE_FILE_LIST ImageStorageService ' + event.sendFrom);

        let otherCatalog: CatalogItem[] = event.data;
        const hooks = this.missingDownloadHooks();
        const request = collectMissingDownloadRequests(otherCatalog, hooks);

        // Handle edge cases such as Peer disconnect
        if (request.length < 1 && !hasActiveMediaTasks(this.sendTaskMap.size, this.receiveTaskMap.size) && otherCatalog.length < ImageStorage.instance.getCatalog().length) {
          ImageStorage.instance.synchronize(event.sendFrom);
        }

        if (request.length < 1) {
          return;
        }
        queueMissingDownloads(request, event.sendFrom, otherCatalog, hooks);
      })
      .on('REQUEST_FILE_RESOURE', async event => {
        if (event.isSendFromSelf) return;

        let request: CatalogItem[] = event.data.identifiers;
        let randomRequest: CatalogItem[] = [];

        for (let item of request) {
          if (ImageStorage.instance.isDeleted(item.identifier)) continue;
          let image: ImageFile = ImageStorage.instance.get(item.identifier);
          if (image && item.state < image.state
            && !this.isSendDeclined(event.data.receiver, item.identifier)) {
            randomRequest.push({ identifier: item.identifier, state: item.state });
          }
        }

        if (!isSendTaskLimitReached(this.sendTaskMap.size) && 0 < randomRequest.length) {
          const sorted = FileReceiveScheduler.sortByNextReceiveBytes(
            'image',
            randomRequest,
            item => item.state
          );
          const batch = this.makeSendUpdateImages(sorted, 256 * 1024);
          if (batch.length) {
            netDebug('REQUEST_FILE_RESOURE send ' + event.data.receiver + ' -> ' + batch.length);
            this.startSendTask(batch, event.data.receiver);
          }
        } else {
          // 中継 — prefer open peers, fall back when hub reconnects
          const openSet = new Set(Network.peerIds);
          const candidatePeers: string[] = event.data.candidatePeers
            .filter((id: string) => id && id !== Network.peerId)
            .sort((a, b) => (openSet.has(a) ? 0 : 1) - (openSet.has(b) ? 0 : 1));

          for (let peerId of candidatePeers) {
            if (!openSet.has(peerId)) continue;
            netDebug('REQUEST_FILE_RESOURE ImageStorageService Relay!!! ' + peerId + ' -> ' + event.data.identifiers);
            EventSystem.call(event, peerId);
            return;
          }
          netDebug('REQUEST_FILE_RESOURE ImageStorageService overflow...' + event.data.receiver, randomRequest.length);
        }
      })
      .on('UPDATE_FILE_RESOURE', 1000, event => {
        let updateImages: ImageContext[] = event.data.updateImages;
        netDebug('UPDATE_FILE_RESOURE ImageStorageService ' + event.sendFrom + ' -> ', updateImages);
        for (let context of updateImages) {
          if (ImageStorage.instance.isDeleted(context.identifier)) continue;
          if (context.blob) context.blob = repackTransferredBlob(context.blob, context.type) as Blob;
          if (context.thumbnail?.blob) {
            context.thumbnail.blob = repackTransferredBlob(
              context.thumbnail.blob,
              context.thumbnail.type,
            ) as Blob;
          }
          ImageStorage.instance.add(context);
        }
      })
      .on('START_FILE_TRANSMISSION', event => {
        netDebug('START_FILE_TRANSMISSION ' + event.data.taskIdentifier);
        let identifier = event.data.taskIdentifier;
        if (ImageStorage.instance.isDeleted(identifier)) return;
        let image: ImageFile = ImageStorage.instance.get(identifier);
        if (this.receiveTaskMap.has(identifier)) {
          return;
        }
        if (image && ImageState.COMPLETE <= image.state) {
          netDebug('START_FILE_TRANSMISSION decline (already complete)', identifier);
          this.startDeclineGate.cancelRedundantStart(event.sendFrom, identifier);
          return;
        }
        this.startReceiveTask(identifier, event.sendFrom);
      })
      .on('DELETE_IMAGE_FILES', event => {
        const identifiers: string[] = event.data?.identifiers || [];
        if (!event.isSendFromSelf) applyLocalImageLibraryDelete(identifiers);
        this.cancelImageTransfers(identifiers);
      })
      .on('REVIVE_IMAGE_FILES', event => {
        if (event.isSendFromSelf) return;
        applyLocalImageLibraryRevive(event.data?.identifiers || []);
      });
  }

  private destroy() {
    EventSystem.unregister(this);
  }

  private async startSendTask(updateImages: ImageContext[], sendTo: string) {
    let identifier = updateImages.length === 1 ? updateImages[0].identifier : UUID.generateUuid();
    if (updateImages.length === 1 && this.isSendDeclined(sendTo, identifier)) {
      netDebug('startSendTask skipped (peer declined)', sendTo, identifier);
      return;
    }
    const taskKey = mediaSendTaskKey(sendTo, identifier);
    const prev = this.sendTaskMap.get(taskKey);
    if (prev) {
      netDebug('startSendTask skipped (already sending)', sendTo, identifier);
      return;
    }

    let task = BufferSharingTask.createSendTask<ImageContext[]>(identifier, sendTo);
    this.sendTaskMap.set(taskKey, task);
    EventSystem.call('START_FILE_TRANSMISSION', { taskIdentifier: identifier }, sendTo);

    /* hotfix issue #1 */
    for (let context of updateImages) {
      if (context.thumbnail.blob) {
        context.thumbnail.blob = <any>await FileReaderUtil.readAsArrayBufferAsync(context.thumbnail.blob);
      } else if (context.blob) {
        context.blob = <any>await FileReaderUtil.readAsArrayBufferAsync(context.blob);
      }
    }
    /* */

    task.oncancel = (canceled) => {
      this.removeSendTask(taskKey);
      // Peer CANCEL_TASK = decline. DISCONNECT / local cancel must not poison declinedSendKeys.
      if (!canceled.didCancelFromPeer) return;
      this.declinedSendKeys.set(taskKey, performance.now());
      const retryTo = canceled.sendTo;
      setTimeout(() => {
        this.declinedSendKeys.delete(taskKey);
        if (retryTo) ImageStorage.instance.lazySynchronize(1500, retryTo);
      }, ImageSharingSystem.SEND_DECLINE_RETRY_MS);
    };

    task.onfinish = (task, data) => {
      this.removeSendTask(taskKey);
      if (task.didCompleteSuccessfully && task.sendTo) {
        ImageStorage.instance.lazySynchronize(800, task.sendTo);
      }
    }

    task.start(updateImages);
  }

  private startReceiveTask(identifier: string, fromPeerId?: string) {
    FileReceiveScheduler.markReceiveStart('image', identifier);
    let task = BufferSharingTask.createReceiveTask<ImageContext[]>(identifier, fromPeerId);
    this.receiveTaskMap.set(identifier, task);
    task.onfinish = (task, data) => {
      finishMediaReceiveTask('image', task, data, {
        stopReceiveTask: id => this.stopReceiveTask(id),
        onSuccess: updateImages => EventSystem.trigger('UPDATE_FILE_RESOURE', {
          identifier: task.identifier,
          updateImages,
        }),
        lazySynchronize: ms => ImageStorage.instance.lazySynchronize(ms),
        successLazyMs: 1000,
      });
    }

    task.start();
    netDebug('startReceiveTask => ', this.receiveTaskMap.size);
  }

  private stopSendTask(sendKey: string) {
    let task = this.sendTaskMap.get(sendKey);
    if (task) { task.cancel(); }
    this.removeSendTask(sendKey);

    netDebug('stopSendTask => ', this.sendTaskMap.size);
  }

  private removeSendTask(sendKey: string) {
    this.sendTaskMap.delete(sendKey);
  }

  private isSendDeclined(sendTo: string, identifier: string): boolean {
    const key = mediaSendTaskKey(sendTo, identifier);
    const last = this.declinedSendKeys.get(key);
    return last != null && performance.now() - last < ImageSharingSystem.SEND_DECLINE_COOLDOWN_MS;
  }

  private stopReceiveTask(identifier: string) {
    let task = this.receiveTaskMap.get(identifier);
    if (task) { task.cancel(); }
    this.receiveTaskMap.delete(identifier);
    FileReceiveScheduler.markReceiveEnd('image', identifier);

    netDebug('stopReceiveTask => ', this.receiveTaskMap.size);
  }

  private cancelImageTransfers(identifiers: string[]) {
    for (const id of identifiers) {
      if (!id) continue;
      this.stopReceiveTask(id);
      const suffix = `:${id}`;
      for (const key of Array.from(this.sendTaskMap.keys())) {
        if (key === id || key.endsWith(suffix)) this.stopSendTask(key);
      }
    }
  }

  private missingDownloadHooks(): MissingDownloadHooks {
    return buildMissingDownloadHooks({
      kind: 'image',
      completeState: ImageState.COMPLETE,
      nullState: ImageState.NULL,
      urlState: ImageState.URL,
      isReceiving: id => this.receiveTaskMap.has(id),
      get: id => ImageStorage.instance.get(id),
      addEmpty: id => {
        ImageStorage.instance.add(ImageFile.createEmpty(id));
      },
      addUrlBacked: id => {
        ImageStorage.instance.add(ImageFile.create(id));
      },
      requestOne: (identifier, localState, peerId) => {
        this.request([{ identifier, state: localState }], peerId);
      },
      shouldSkip: id => ImageStorage.instance.isDeleted(id),
    });
  }

  private clearDeclinedForPeer(peerId: string) {
    if (!peerId) return;
    const prefix = `${peerId}:`;
    for (const key of this.declinedSendKeys.keys()) {
      if (key.startsWith(prefix)) this.declinedSendKeys.delete(key);
    }
  }

  ensureRoomDownloads(catalogsByPeer: Map<string, CatalogItem[]>) {
    const hooks = this.missingDownloadHooks();
    ensureRoomMissingDownloads(catalogsByPeer, hooks);
  }

  private request(request: CatalogItem[], peerId: string) {
    const identifier = request[0]?.identifier;
    if (deferRequestIfPeerNotOpen('image', peerId, identifier, (ms, peer) => {
      ImageStorage.instance.lazySynchronize(ms, peer);
    })) {
      return;
    }
    netDebug('requestFile() ' + peerId);
    EventSystem.call('REQUEST_FILE_RESOURE', {
      identifiers: request,
      receiver: Network.peerId,
      candidatePeers: meshCandidatePeerIds()
    }, peerId);
  }

  private makeSendUpdateImages(catalog: CatalogItem[], maxSize: number = 1024 * 1024 * 0.5): ImageContext[] {
    let updateImages: ImageContext[] = [];
    let byteSize: number = 0;

    const sorted = FileReceiveScheduler.sortByNextReceiveBytes('image', catalog, item => item.state);

    for (let i = 0; i < sorted.length; i++) {
      let item: { identifier: string, state: number } = sorted[i];
      let image: ImageFile = ImageStorage.instance.get(item.identifier);

      let context: ImageContext = {
        identifier: image.identifier,
        name: image.name,
        type: '',
        blob: null,
        url: null,
        thumbnail: { type: '', blob: null, url: null, }
      };

      if (image.state === ImageState.URL) {
        context.url = image.url;
      } else if (item.state === ImageState.NULL) {
        context.thumbnail.blob = image.thumbnail.blob;//
        context.thumbnail.type = image.thumbnail.type;
      } else {
        context.blob = image.blob;//
        context.type = image.blob.type;
      }

      let size = context.blob
        ? context.blob.size
        : context.thumbnail.blob
          ? context.thumbnail.blob.size
          : 100;

      updateImages.push(context);
      byteSize += size;
      if (maxSize < byteSize) break;
    }
    return updateImages;
  }
}

function convertUrlImage(xmlElement: Element) {
  let urls: string[] = [];

  let imageElements = xmlElement.querySelectorAll('*[type="image"]');
  for (let i = 0; i < imageElements.length; i++) {
    let url = imageElements[i].innerHTML;
    if (!ImageStorage.instance.get(url) && 0 < MimeType.type(url).length) {
      urls.push(url);
    }
  }

  imageElements = xmlElement.querySelectorAll('*[imageIdentifier]');
  for (let i = 0; i < imageElements.length; i++) {
    let url = imageElements[i].getAttribute('imageIdentifier');
    if (!ImageStorage.instance.get(url) && 0 < MimeType.type(url).length) {
      urls.push(url);
    }
  }
  for (let url of urls) {
    ImageStorage.instance.add(url)
  }
}

import { EventSystem } from '../system';
import { ResettableTimeout } from '../system/util/resettable-timeout';
import { catalogByteSize } from './file-transfer-scheduler';
import { ImageContext, ImageFile, ImageState } from './image-file';
import {
  addPackedByContentHash,
  deleteMediaFromHash,
  getOrHydrateUrlBacked,
  insertOrUpdateMediaFile,
  SessionTombstones,
} from './media-storage-helpers';

export type CatalogItem = {
  readonly identifier: string;
  readonly state: number;
  readonly byteSize?: number;
  readonly thumbBytes?: number;
};

export class ImageStorage {
  private static _instance: ImageStorage
  static get instance(): ImageStorage {
    if (!ImageStorage._instance) ImageStorage._instance = new ImageStorage();
    return ImageStorage._instance;
  }

  private imageHash: { [identifier: string]: ImageFile } = {};
  private readonly tombstones = new SessionTombstones();

  get images(): ImageFile[] {
    let images: ImageFile[] = [];
    for (let identifier in this.imageHash) {
      images.push(this.imageHash[identifier]);
    }
    return images;
  }

  private lazyTimer: ResettableTimeout;

  private constructor() {
  }

  private destroy() {
    for (let identifier in this.imageHash) {
      this.delete(identifier);
    }
  }

  async addAsync(file: File): Promise<ImageFile>
  async addAsync(blob: Blob): Promise<ImageFile>
  async addAsync(arg: any): Promise<ImageFile> {
    let image: ImageFile = await ImageFile.createAsync(arg);

    return this.reviveAndStore(image);
  }

  /** Restore `<sha256>.ext` from ZIP / folder media under the filename hash. */
  async addPackedAsync(file: File, opts?: { revive?: boolean }): Promise<ImageFile> {
    const revive = opts?.revive !== false;
    return addPackedByContentHash({
      file,
      completeState: ImageState.COMPLETE,
      get: id => this.get(id),
      addAsync: f => this.addAsync(f),
      createPacked: (f, hash) => ImageFile.createPackedAsync(f, hash),
      store: image => revive ? this.reviveAndStore(image) : this._add(image),
    });
  }

  add(url: string): ImageFile
  add(image: ImageFile): ImageFile
  add(context: ImageContext): ImageFile
  add(arg: any): ImageFile {
    let image: ImageFile;
    if (typeof arg === 'string') {
      image = ImageFile.create(arg);
    } else if (arg instanceof ImageFile) {
      image = arg;
    } else {
      if (this.update(arg)) return this.imageHash[arg.identifier];
      image = ImageFile.create(arg);
    }
    return this._add(image);
  }

  private _add(image: ImageFile): ImageFile {
    const blocked = this.tombstones.blockedAdd(this.imageHash, image);
    if (blocked) return blocked;
    return insertOrUpdateMediaFile({
      hash: this.imageHash,
      file: image,
      completeState: ImageState.COMPLETE,
      lazySynchronize: ms => this.lazySynchronize(ms),
      tryUpdate: file => this.update(file),
    });
  }

  /** User / ZIP re-import of a previously deleted hash: clear tombstone then store. */
  private reviveAndStore(image: ImageFile): ImageFile {
    const { stored, wasDeleted } = this.tombstones.reviveThenStore(image, file => this._add(file));
    if (wasDeleted) EventSystem.call('REVIVE_IMAGE_FILES', { identifiers: [image.identifier] });
    return stored;
  }

  private update(image: ImageFile): boolean
  private update(image: ImageContext): boolean
  private update(image: any): boolean {
    let context: ImageContext;
    if (image instanceof ImageFile) {
      context = image.toContext();
    } else {
      context = image;
    }
    let updatingImage: ImageFile = this.imageHash[image.identifier];
    if (updatingImage) {
      updatingImage.apply(image);
      return true;
    }
    return false;
  }

  delete(identifier: string): boolean {
    return deleteMediaFromHash(this.imageHash, identifier);
  }

  isDeleted(identifier: string): boolean {
    return this.tombstones.has(identifier);
  }

  deletedIdentifiers(): string[] {
    return this.tombstones.identifiers();
  }

  markDeleted(identifier: string): void {
    if (!this.tombstones.add(identifier)) return;
    this.delete(identifier);
  }

  revive(identifier: string): void {
    this.tombstones.remove(identifier);
  }

  /** @internal Clears tombstones between specs. */
  resetDeletedForTests(): void {
    this.tombstones.clear();
  }

  get(identifier: string): ImageFile {
    if (this.isDeleted(identifier)) return null;
    return getOrHydrateUrlBacked({
      hash: this.imageHash,
      identifier,
      createUrlBacked: id => ImageFile.create(id),
      store: file => this._add(file),
    });
  }

  synchronize(peer?: string) {
    if (this.lazyTimer) this.lazyTimer.stop();
    EventSystem.call('SYNCHRONIZE_FILE_LIST', this.getCatalog(), peer);
  }

  lazySynchronize(ms: number, peer?: string) {
    const delay = Math.max(ms, 1500);
    if (this.lazyTimer == null) this.lazyTimer = new ResettableTimeout(() => this.synchronize(peer), delay);
    this.lazyTimer.reset(delay);
  }

  getCatalog(): CatalogItem[] {
    let catalog: CatalogItem[] = [];
    for (let image of this.images) {
      // Exclude ImageState.URL (1000): COMPLETE <= URL would advertise path/HTTP assets for P2P.
      if (image.state === ImageState.COMPLETE) {
        catalog.push({
          identifier: image.identifier,
          state: image.state,
          thumbBytes: catalogByteSize(image.thumbnail?.blob),
          byteSize: catalogByteSize(image.blob, catalogByteSize(image.thumbnail?.blob)),
        });
      }
    }
    return catalog;
  }
}

import { EventSystem } from '../system';
import { AudioFile, AudioFileContext, AudioState } from './audio-file';
import {
  addPackedByContentHash,
  buildCompleteBlobCatalog,
  deleteMediaFromHash,
  getOrHydrateUrlBacked,
  insertOrUpdateMediaFile,
  LazyCatalogSynchronizer,
  MediaCatalogItem,
  SessionTombstones,
} from './media-storage-helpers';

export type CatalogItem = MediaCatalogItem;

export class AudioStorage {
  private static _instance: AudioStorage
  static get instance(): AudioStorage {
    if (!AudioStorage._instance) AudioStorage._instance = new AudioStorage();
    return AudioStorage._instance;
  }

  private readonly catalogSync = new LazyCatalogSynchronizer(peer => {
    EventSystem.call('SYNCHRONIZE_AUDIO_LIST', this.getCatalog(), peer);
  });
  private hash: { [identifier: string]: AudioFile } = {};
  private readonly tombstones = new SessionTombstones();

  get audios(): AudioFile[] {
    let audios: AudioFile[] = [];
    for (let identifier in this.hash) {
      audios.push(this.hash[identifier]);
    }
    return audios;
  }

  private constructor() {
  }

  private destroy() {
    for (let identifier in this.hash) {
      this.delete(identifier);
    }
  }

  async addAsync(file: File, displayName?: string): Promise<AudioFile>
  async addAsync(blob: Blob, displayName?: string): Promise<AudioFile>
  async addAsync(arg: any, displayName?: string): Promise<AudioFile> {
    let audio: AudioFile = await AudioFile.createAsync(arg, displayName);

    return this.reviveAndStore(audio);
  }

  async addPackedAsync(file: File, opts?: { revive?: boolean }): Promise<AudioFile> {
    const revive = opts?.revive !== false;
    return addPackedByContentHash({
      file,
      completeState: AudioState.COMPLETE,
      get: id => this.get(id),
      addAsync: f => this.addAsync(f),
      createPacked: (f, hash) => AudioFile.createPackedAsync(f, hash),
      store: audio => revive ? this.reviveAndStore(audio) : this._add(audio),
    });
  }

  add(url: string): AudioFile
  add(audio: AudioFile): AudioFile
  add(context: AudioFileContext): AudioFile
  add(arg: any): AudioFile {
    return this.put(arg, false);
  }

  /** User / ZIP / URL import: clear the session tombstone then store (broadcasts REVIVE). */
  addImported(url: string): AudioFile
  addImported(audio: AudioFile): AudioFile
  addImported(context: AudioFileContext): AudioFile
  addImported(arg: any): AudioFile {
    return this.put(arg, true);
  }

  private put(arg: any, asImport: boolean): AudioFile {
    let audio: AudioFile;
    if (typeof arg === 'string') {
      audio = AudioFile.create(arg);
    } else if (arg instanceof AudioFile) {
      audio = arg;
    } else {
      if (!asImport && this.update(arg)) return this.hash[arg.identifier];
      audio = AudioFile.create(arg);
    }
    return asImport ? this.reviveAndStore(audio) : this._add(audio);
  }

  private _add(audio: AudioFile): AudioFile {
    const blocked = this.tombstones.blockedAdd(this.hash, audio);
    if (blocked) return blocked;
    return insertOrUpdateMediaFile({
      hash: this.hash,
      file: audio,
      completeState: AudioState.COMPLETE,
      lazySynchronize: ms => this.lazySynchronize(ms),
      tryUpdate: file => this.update(file),
    });
  }

  /** User / ZIP re-import of a previously deleted hash: clear tombstone then store. */
  private reviveAndStore(audio: AudioFile): AudioFile {
    const { stored, wasDeleted } = this.tombstones.reviveThenStore(audio, file => this._add(file));
    if (wasDeleted) EventSystem.call('REVIVE_AUDIO_FILES', { identifiers: [audio.identifier] });
    return stored;
  }

  private update(audio: AudioFile): boolean
  private update(audio: AudioFileContext): boolean
  private update(audio: any): boolean {
    let context: AudioFileContext;
    if (audio instanceof AudioFile) {
      context = audio.toContext();
    } else {
      context = audio;
    }
    let updateAudio: AudioFile = this.hash[audio.identifier];
    if (updateAudio) {
      updateAudio.apply(audio);
      return true;
    }
    return false;
  }

  delete(identifier: string): boolean {
    return deleteMediaFromHash(this.hash, identifier);
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

  get(identifier: string): AudioFile {
    if (this.isDeleted(identifier)) return null;
    return getOrHydrateUrlBacked({
      hash: this.hash,
      identifier,
      createUrlBacked: id => AudioFile.create(id),
      store: file => this._add(file),
    });
  }

  synchronize(peer?: string) {
    this.catalogSync.synchronize(peer);
  }

  lazySynchronize(ms: number, peer?: string) {
    this.catalogSync.lazySynchronize(ms, peer);
  }

  getCatalog(): CatalogItem[] {
    return buildCompleteBlobCatalog(this.audios, AudioState.COMPLETE);
  }
}

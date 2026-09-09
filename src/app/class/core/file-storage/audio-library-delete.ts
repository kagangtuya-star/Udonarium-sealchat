import { AudioLibrary } from '@udonarium/audio-library';
import { AudioStorage } from './audio-storage';
import { FileReceiveScheduler } from './file-transfer-scheduler';
import {
  applyLocalLibraryDelete,
  applyLocalLibraryRevive,
  deleteLibraryFiles,
  normalizeLibraryDeleteIds,
} from './library-delete';

export { normalizeLibraryDeleteIds as normalizeAudioLibraryDeleteIds };

/** Remove blobs + library listings locally and block P2P resurrection for this session. */
export function applyLocalAudioLibraryDelete(identifiers: string[]): string[] {
  return applyLocalLibraryDelete(identifiers, id => {
    AudioStorage.instance.markDeleted(id);
    AudioLibrary.instance.removeAudioMeta(id);
    FileReceiveScheduler.abortReceive('audio', id);
  }, () => AudioStorage.instance.lazySynchronize(100));
}

/** Apply locally then tell connected peers to delete the same files. */
export function deleteAudioLibraryFiles(identifiers: string[]): string[] {
  return deleteLibraryFiles('DELETE_AUDIO_FILES', identifiers, applyLocalAudioLibraryDelete);
}

export function applyLocalAudioLibraryRevive(identifiers: string[]): void {
  applyLocalLibraryRevive(identifiers, id => AudioStorage.instance.revive(id));
}

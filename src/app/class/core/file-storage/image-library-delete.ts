import { ObjectStore } from '../synchronize-object/object-store';
import { ImageTag } from '@udonarium/image-tag';
import { ImageStorage } from './image-storage';
import { FileReceiveScheduler } from './file-transfer-scheduler';
import {
  applyLocalLibraryDelete,
  applyLocalLibraryRevive,
  deleteLibraryFiles,
  normalizeLibraryDeleteIds,
} from './library-delete';

export { normalizeLibraryDeleteIds as normalizeImageLibraryDeleteIds };

/** Remove blobs + tags locally and block P2P resurrection for this session. */
export function applyLocalImageLibraryDelete(identifiers: string[]): string[] {
  return applyLocalLibraryDelete(identifiers, id => {
    ImageStorage.instance.markDeleted(id);
    ImageTag.get(id)?.destroy();
    FileReceiveScheduler.abortReceive('image', id);
  }, () => ImageStorage.instance.lazySynchronize(100));
}

/** Apply locally then tell connected peers to delete the same files. */
export function deleteImageLibraryFiles(identifiers: string[]): string[] {
  return deleteLibraryFiles('DELETE_IMAGE_FILES', identifiers, applyLocalImageLibraryDelete);
}

export function applyLocalImageLibraryRevive(identifiers: string[]): void {
  applyLocalLibraryRevive(identifiers, id => ImageStorage.instance.revive(id));
}

/** True when a non-tag room object still points at this image. */
export function imageIsReferencedInRoom(identifier: string): boolean {
  if (!identifier) return false;
  for (const obj of ObjectStore.instance.getObjects()) {
    if (obj instanceof ImageTag) continue;
    if (obj.aliasName === 'image-tag-list') continue;
    try {
      const xml = obj.toXml();
      if (xml && xml.indexOf(identifier) >= 0) return true;
    } catch {
      /* skip objects that cannot serialize */
    }
  }
  return false;
}

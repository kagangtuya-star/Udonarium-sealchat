import { ImageFile, ImageState } from '@udonarium/core/file-storage/image-file';
import { ImageStorage } from '@udonarium/core/file-storage/image-storage';
import { AudioStorage } from '@udonarium/core/file-storage/audio-storage';
import { FileArchiver } from '@udonarium/core/file-storage/file-archiver';
import { Network } from '@udonarium/core/system';

import { FolderBackupService } from './folder-backup.service';
import { FolderMediaHydrator } from './folder-media-hydrator';

describe('FolderMediaHydrator', () => {
  const hash = 'a'.repeat(64);
  const fileName = `${hash}.png`;

  beforeEach(() => {
    FolderMediaHydrator.invalidateIndex();
    spyOn(Network, 'GuestMode').and.returnValue(false);
    spyOnProperty(FolderBackupService, 'instance', 'get').and.returnValue({
      isReady: true,
      getMediaDirectoryHandle: jasmine.createSpy('getMediaDirectoryHandle'),
    } as unknown as FolderBackupService);
  });

  it('canHydrate is false in guest mode', () => {
    (Network.GuestMode as jasmine.Spy).and.returnValue(true);
    expect(FolderMediaHydrator.instance.canHydrate()).toBeFalse();
  });

  it('canHydrate is false when folder backup is not ready', () => {
    (FolderBackupService.instance as { isReady: boolean }).isReady = false;
    expect(FolderMediaHydrator.instance.canHydrate()).toBeFalse();
  });

  it('hydrate returns true when storage already has COMPLETE image', async () => {
    const image = ImageFile.createEmpty(hash);
    const thumbBlob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const fullBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    image.apply({
      identifier: hash,
      name: hash,
      type: 'image/png',
      blob: fullBlob,
      url: 'blob:test',
      thumbnail: { type: 'image/png', blob: thumbBlob, url: 'blob:thumb' },
    });
    spyOn(ImageStorage.instance, 'get').and.returnValue(image);
    expect(image.state).toBeGreaterThanOrEqual(ImageState.COMPLETE);

    const result = await FolderMediaHydrator.instance.hydrate('image', hash);
    expect(result).toBeTrue();
    expect(FolderBackupService.instance!.getMediaDirectoryHandle).not.toHaveBeenCalled();
  });

  it('hydrate imports from media/ when hash is indexed', async () => {
    const thumbBlob = new Blob([new Uint8Array([1])], { type: 'image/png' });
    const fullBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    const hydrated = ImageFile.createEmpty(hash);
    hydrated.apply({
      identifier: hash,
      name: hash,
      type: 'image/png',
      blob: fullBlob,
      url: 'blob:test',
      thumbnail: { type: 'image/png', blob: thumbBlob, url: 'blob:thumb' },
    });

    let stored: ImageFile | null = null;
    spyOn(ImageStorage.instance, 'get').and.callFake((id: string) => id === hash ? stored : null);
    const importSpy = spyOn(FileArchiver.instance, 'importMediaFile').and.callFake(async () => {
      stored = hydrated;
    });
    const rawFile = new File([new Uint8Array([137, 80, 78, 71])], fileName, { type: 'image/png' });

    const mediaDir = {
      entries: async function* () {
        yield [fileName, { kind: 'file' }];
      },
      getFileHandle: async () => ({
        getFile: async () => rawFile,
      }),
    };

    (FolderBackupService.instance!.getMediaDirectoryHandle as jasmine.Spy).and.resolveTo(mediaDir);
    spyOn(FolderMediaHydrator.instance, 'findFileName').and.resolveTo(fileName);

    const result = await FolderMediaHydrator.instance.hydrate('image', hash);
    expect(result).toBeTrue();
    expect(importSpy).toHaveBeenCalled();
  });

  it('hydrate returns false when media file is missing', async () => {
    spyOn(ImageStorage.instance, 'get').and.returnValue(null);
    spyOn(FolderMediaHydrator.instance, 'findFileName').and.resolveTo(null);

    const result = await FolderMediaHydrator.instance.hydrate('image', hash);
    expect(result).toBeFalse();
  });

  it('hydrate skips non-hash identifiers without reading media/', async () => {
    const result = await FolderMediaHydrator.instance.hydrate('image', 'https://example.com/a.png');
    expect(result).toBeFalse();
    expect(FolderBackupService.instance!.getMediaDirectoryHandle).not.toHaveBeenCalled();
  });

  it('hydrate skips tombstoned images without reading media/', async () => {
    spyOn(ImageStorage.instance, 'isDeleted').and.returnValue(true);
    const result = await FolderMediaHydrator.instance.hydrate('image', hash);
    expect(result).toBeFalse();
    expect(FolderBackupService.instance!.getMediaDirectoryHandle).not.toHaveBeenCalled();
  });

  it('hydrate skips if the hash is tombstoned after disk lookup', async () => {
    let deleted = false;
    spyOn(ImageStorage.instance, 'isDeleted').and.callFake(() => deleted);
    spyOn(ImageStorage.instance, 'get').and.returnValue(null);
    spyOn(FolderMediaHydrator.instance, 'findFileName').and.callFake(async () => {
      deleted = true;
      return fileName;
    });
    const importSpy = spyOn(FileArchiver.instance, 'importMediaFile').and.returnValue(Promise.resolve());

    const result = await FolderMediaHydrator.instance.hydrate('image', hash);
    expect(result).toBeFalse();
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('invalidateIndex clears cached index', async () => {
    const hydrator = FolderMediaHydrator.instance as any;
    hydrator.index = new Map([[hash, fileName]]);
    FolderMediaHydrator.invalidateIndex();
    expect(hydrator.index).toBeNull();
  });
});

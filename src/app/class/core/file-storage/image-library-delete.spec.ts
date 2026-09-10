import { ImageFile } from './image-file';
import { ImageStorage } from './image-storage';
import {
  applyLocalImageLibraryDelete,
  deleteImageLibraryFiles,
  imageIsReferencedInRoom,
} from './image-library-delete';
import { ImageTag } from '@udonarium/image-tag';
import { ObjectStore } from '../synchronize-object/object-store';
import { makeMask, resetTabletopStore } from '../../../../testing/tabletop-test.util';

function putEmpty(id: string): ImageFile {
  const image = ImageFile.createEmpty(id);
  ImageStorage.instance.add(image);
  return image;
}

function destroyImageTags() {
  for (const tag of ObjectStore.instance.getObjects(ImageTag)) {
    try { tag.destroy(); } catch { /* ignore */ }
  }
  ObjectStore.instance.clearDeleteHistory();
}

describe('image library delete', () => {
  afterEach(() => {
    for (const image of ImageStorage.instance.images) {
      ImageStorage.instance.delete(image.identifier);
    }
    ImageStorage.instance.resetDeletedForTests();
    destroyImageTags();
    resetTabletopStore();
  });

  it('markDeleted removes the blob and blocks P2P add()', () => {
    putEmpty('img_gone');
    expect(ImageStorage.instance.get('img_gone')).toBeTruthy();

    ImageStorage.instance.markDeleted('img_gone');
    expect(ImageStorage.instance.get('img_gone')).toBeNull();
    expect(ImageStorage.instance.isDeleted('img_gone')).toBeTrue();

    ImageStorage.instance.add(ImageFile.createEmpty('img_gone'));
    expect(ImageStorage.instance.get('img_gone')).toBeNull();
    expect(ImageStorage.instance.images.some(i => i.identifier === 'img_gone')).toBeFalse();
  });

  it('revive then add restores a previously deleted hash', () => {
    putEmpty('img_back');
    ImageStorage.instance.markDeleted('img_back');
    ImageStorage.instance.revive('img_back');
    ImageStorage.instance.add(ImageFile.createEmpty('img_back'));
    expect(ImageStorage.instance.isDeleted('img_back')).toBeFalse();
    expect(ImageStorage.instance.get('img_back')?.identifier).toBe('img_back');
  });

  it('applyLocalImageLibraryDelete removes storage and image tags', () => {
    putEmpty('img_tagged');
    const tag = ImageTag.create('img_tagged');
    tag.tag = 'junk';
    expect(ImageTag.get('img_tagged')).toBe(tag);

    const deleted = applyLocalImageLibraryDelete(['img_tagged', 'img_tagged', '']);
    expect(deleted).toEqual(['img_tagged']);
    expect(ImageStorage.instance.get('img_tagged')).toBeNull();
    expect(ImageTag.get('img_tagged')).toBeFalsy();
  });

  it('deleteImageLibraryFiles removes the file from the library', () => {
    putEmpty('img_net');
    deleteImageLibraryFiles(['img_net']);
    expect(ImageStorage.instance.get('img_net')).toBeNull();
    expect(ImageStorage.instance.isDeleted('img_net')).toBeTrue();
  });

  it('imageIsReferencedInRoom ignores tags and detects tabletop usage', () => {
    ImageTag.create('img_only_tag');
    expect(imageIsReferencedInRoom('img_only_tag')).toBeFalse();

    const mask = makeMask('m-del');
    mask.setImage('img_used');
    expect(imageIsReferencedInRoom('img_used')).toBeTrue();
    expect(imageIsReferencedInRoom('img_unused')).toBeFalse();
  });
});

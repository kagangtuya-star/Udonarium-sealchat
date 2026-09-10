import { AudioLibrary } from '@udonarium/audio-library';
import { AudioFile } from './audio-file';
import { AudioStorage } from './audio-storage';
import {
  applyLocalAudioLibraryDelete,
  deleteAudioLibraryFiles,
} from './audio-library-delete';

function putEmpty(id: string): AudioFile {
  const audio = AudioFile.createEmpty(id);
  AudioStorage.instance.add(audio);
  return audio;
}

describe('audio library delete', () => {
  afterEach(() => {
    for (const audio of AudioStorage.instance.audios) {
      AudioStorage.instance.delete(audio.identifier);
    }
    AudioStorage.instance.resetDeletedForTests();
    AudioLibrary.instance.removeAudioMeta('aud_gone');
    AudioLibrary.instance.removeAudioMeta('aud_back');
    AudioLibrary.instance.removeAudioMeta('aud_listed');
    AudioLibrary.instance.removeAudioMeta('aud_net');
    AudioLibrary.instance.deleteFolder('folder-a');
  });

  it('markDeleted removes the blob and blocks P2P add()', () => {
    putEmpty('aud_gone');
    expect(AudioStorage.instance.get('aud_gone')).toBeTruthy();

    AudioStorage.instance.markDeleted('aud_gone');
    expect(AudioStorage.instance.get('aud_gone')).toBeNull();
    expect(AudioStorage.instance.isDeleted('aud_gone')).toBeTrue();

    AudioStorage.instance.add(AudioFile.createEmpty('aud_gone'));
    expect(AudioStorage.instance.get('aud_gone')).toBeNull();
    expect(AudioStorage.instance.audios.some(a => a.identifier === 'aud_gone')).toBeFalse();
  });

  it('addImported restores a previously deleted hash; add() stays blocked', () => {
    putEmpty('aud_back');
    AudioStorage.instance.markDeleted('aud_back');
    expect(AudioStorage.instance.get('aud_back')).toBeNull();

    AudioStorage.instance.add(AudioFile.createEmpty('aud_back'));
    expect(AudioStorage.instance.get('aud_back')).toBeNull();

    AudioStorage.instance.addImported(AudioFile.createEmpty('aud_back'));
    expect(AudioStorage.instance.isDeleted('aud_back')).toBeFalse();
    expect(AudioStorage.instance.get('aud_back')?.identifier).toBe('aud_back');
  });

  it('applyLocalAudioLibraryDelete removes storage and library listing', () => {
    putEmpty('aud_listed');
    AudioLibrary.instance.ensureListed('aud_listed', '');
    expect(AudioLibrary.instance.isInFolder('aud_listed', '')).toBeTrue();

    const deleted = applyLocalAudioLibraryDelete(['aud_listed', 'aud_listed', '']);
    expect(deleted).toEqual(['aud_listed']);
    expect(AudioStorage.instance.get('aud_listed')).toBeNull();
    expect(AudioLibrary.instance.foldersOf('aud_listed')).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(AudioLibrary.instance.data.membership, 'aud_listed')).toBeFalse();
  });

  it('deleteAudioLibraryFiles removes the file from the library', () => {
    putEmpty('aud_net');
    deleteAudioLibraryFiles(['aud_net']);
    expect(AudioStorage.instance.get('aud_net')).toBeNull();
    expect(AudioStorage.instance.isDeleted('aud_net')).toBeTrue();
  });

  it('deleteAudioLibraryFiles removes a track listed in several folders', () => {
    putEmpty('aud_listed');
    AudioLibrary.instance.ensureListed('aud_listed', '');
    AudioLibrary.instance.ensureFolder('folder-a', 'A');
    AudioLibrary.instance.ensureListed('aud_listed', 'folder-a');
    expect(AudioLibrary.instance.foldersOf('aud_listed').length).toBeGreaterThan(1);

    deleteAudioLibraryFiles(['aud_listed']);
    expect(AudioStorage.instance.get('aud_listed')).toBeNull();
    expect(AudioLibrary.instance.foldersOf('aud_listed')).toEqual([]);
  });
});

import { AudioLibrary } from '@udonarium/audio-library';
import { FileArchiver } from './file-archiver';
import { AudioStorage } from './audio-storage';
import { MimeType } from './mime-type';
import { VideoStorage } from './video-storage';
import { isMediaFileName, packedMediaFileName, toPackedAudioFile } from 'service/folder-backup-layout';

function clearAudio() {
  for (const a of [...AudioStorage.instance.audios]) {
    AudioStorage.instance.delete(a.identifier);
  }
}

function clearVideo() {
  for (const v of [...VideoStorage.instance.videos]) {
    VideoStorage.instance.delete(v.identifier);
  }
}

async function roundTrip(file: File): Promise<{ id: string; reloadType: string; reloadName: string }> {
  await FileArchiver.instance.load([file]);
  expect(AudioStorage.instance.audios.length).withContext(`import ${file.name}`).toBe(1);
  const original = AudioStorage.instance.audios[0];
  AudioLibrary.instance.ensureListed(original.identifier);

  const saved = toPackedAudioFile(original.blob, original.identifier);
  const savedName = saved.name;

  clearAudio();
  clearVideo();

  // Folder restore often has empty File.type — rely on extension like production.
  const extracted = new File([saved], savedName, { type: MimeType.type(savedName) });
  await FileArchiver.instance.load([extracted]);

  expect(VideoStorage.instance.videos.length)
    .withContext(`${file.name} must not become video`)
    .toBe(0);
  expect(AudioStorage.instance.audios.length)
    .withContext(`${file.name} reload`)
    .toBe(1);
  expect(AudioStorage.instance.get(original.identifier)).toBeTruthy();
  expect(AudioLibrary.instance.orderedIdsInFolder('')).toContain(original.identifier);
  return { id: original.identifier, reloadType: extracted.type, reloadName: savedName };
}

describe('audio ZIP / folder-backup round-trip', () => {
  beforeEach(() => {
    clearAudio();
    clearVideo();
  });

  afterEach(() => {
    clearAudio();
    clearVideo();
  });

  it('round-trips common audio formats including AIFF / WMA / OGA', async () => {
    const samples: File[] = [
      new File([new Uint8Array([0xff, 0xfb, 0x90, 0x00])], 'a.mp3', { type: 'audio/mpeg' }),
      new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'b.wav', { type: 'audio/wav' }),
      new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], 'c.ogg', { type: 'audio/ogg' }),
      new File([new Uint8Array([0x00, 0x00, 0x00, 0x20])], 'd.m4a', { type: 'audio/mp4' }),
      new File([new Uint8Array([0x66, 0x4c, 0x61, 0x43])], 'e.flac', { type: 'audio/flac' }),
      new File([new Uint8Array([0x4f, 0x70, 0x75, 0x73])], 'f.opus', { type: 'audio/opus' }),
      new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], 'g.weba', { type: 'audio/webm' }),
      new File([new Uint8Array([0x46, 0x4f, 0x52, 0x4d])], 'h.aiff', { type: 'audio/aiff' }),
      new File([new Uint8Array([0x30, 0x26, 0xb2, 0x75])], 'i.wma', { type: 'audio/x-ms-wma' }),
      new File([new Uint8Array([0x4f, 0x67, 0x67, 0x53])], 'j.oga', { type: 'audio/ogg' }),
    ];
    for (const sample of samples) {
      clearAudio();
      clearVideo();
      const result = await roundTrip(sample);
      expect(MimeType.type(result.reloadName).indexOf('audio/'))
        .withContext(sample.name)
        .toBe(0);
    }
  });

  it('recovers legacy <sha256>.mpeg MP3s that were typed as video/mpeg', async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0xaa, 0xbb, 0xcc, 0xdd]);
    const legacyName = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mpeg';
    const extracted = new File([bytes], legacyName, { type: 'video/mpeg' });
    await FileArchiver.instance.load([extracted]);

    expect(VideoStorage.instance.videos.length).toBe(0);
    expect(AudioStorage.instance.audios.length).toBe(1);
  });

  it('does not steal real video files into the jukebox', async () => {
    const videos = [
      new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], 'clip.mp4', { type: 'video/mp4' }),
      new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], 'clip.webm', { type: 'video/webm' }),
      new File([new Uint8Array([0x00, 0x00, 0x01, 0xba])], 'movie.mpeg', { type: 'video/mpeg' }),
      new File([new Uint8Array([0x00, 0x00, 0x01, 0xba])], 'movie.mpg', { type: 'video/mpeg' }),
      new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], 'clip.mkv', { type: 'video/x-matroska' }),
      new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'clip.avi', { type: 'video/x-msvideo' }),
      new File([new Uint8Array([0x00, 0x00, 0x00, 0x14])], 'clip.mov', { type: 'video/quicktime' }),
      new File([new Uint8Array([0x00, 0x00, 0x00, 0x18])], 'clip.3gp', { type: '' }),
    ];
    for (const video of videos) {
      clearAudio();
      clearVideo();
      await FileArchiver.instance.load([video]);
      expect(AudioStorage.instance.audios.length)
        .withContext(`${video.name} must not be audio`)
        .toBe(0);
      expect(VideoStorage.instance.videos.length)
        .withContext(`${video.name} must be video`)
        .toBe(1);
    }
  });

  it('restores packed <sha256>.mp3 without renaming over AudioLibrary names', async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0x11, 0x22, 0x33, 0x44]);
    const uploaded = new File([bytes], 'battle-theme.mp3', { type: 'audio/mpeg' });
    await FileArchiver.instance.load([uploaded]);
    const id = AudioStorage.instance.audios[0].identifier;
    AudioLibrary.instance.renameAudio(id, '戰鬥主題');
    AudioLibrary.instance.ensureListed(id, '');
    expect(AudioLibrary.instance.displayName(AudioStorage.instance.get(id))).toBe('戰鬥主題');

    const blob = AudioStorage.instance.get(id).blob;
    clearAudio();
    expect(AudioLibrary.instance.data.names[id]).toBe('戰鬥主題');

    const { AudioImportNameService } = await import('service/audio-import-name.service');
    let resolveCalls = 0;
    const prev = AudioImportNameService.instance;
    const originalResolve = prev?.resolveDisplayName?.bind(prev);
    if (prev && originalResolve) {
      prev.resolveDisplayName = async (file: File) => {
        resolveCalls++;
        return originalResolve(file);
      };
    }

    try {
      const packed = new File([blob], packedMediaFileName(id, 'mp3'), { type: 'audio/mpeg' });
      expect(isMediaFileName(packed.name)).toBeTrue();
      await FileArchiver.instance.load([packed]);

      expect(resolveCalls).withContext('must not open import-name flow').toBe(0);
      expect(AudioStorage.instance.get(id)).toBeTruthy();
      expect(AudioLibrary.instance.displayName(AudioStorage.instance.get(id))).toBe('戰鬥主題');
    } finally {
      if (prev && originalResolve) prev.resolveDisplayName = originalResolve;
    }
  });

  it('restores nested media/<sha256>.mpeg as audio under the content-hash identifier', async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0xaa, 0xbb]);
    const hash = 'b'.repeat(64);
    const nested = new File([bytes], `media/${hash}.mpeg`, { type: 'video/mpeg' });
    await FileArchiver.instance.load([nested]);

    expect(VideoStorage.instance.videos.length).toBe(0);
    expect(AudioStorage.instance.get(hash)).toBeTruthy();
    expect(AudioStorage.instance.audios.some(a => a.identifier.startsWith('media/'))).toBeFalse();
  });

  it('restores nested media/<sha256>.mp3 with the content-hash identifier', async () => {
    const bytes = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0xaa, 0xbb]);
    const uploaded = new File([bytes], 'theme.mp3', { type: 'audio/mpeg' });
    await FileArchiver.instance.load([uploaded]);
    const id = AudioStorage.instance.audios[0].identifier;
    const blob = AudioStorage.instance.get(id).blob;
    clearAudio();
    clearVideo();

    const nested = new File([blob], `media/${id}.mp3`, { type: MimeType.type(`${id}.mp3`) });
    await FileArchiver.instance.load([nested]);

    expect(VideoStorage.instance.videos.length).toBe(0);
    expect(AudioStorage.instance.get(id)).toBeTruthy();
    expect(AudioStorage.instance.audios.some(a => a.identifier.startsWith('media/'))).toBeFalse();
  });
});

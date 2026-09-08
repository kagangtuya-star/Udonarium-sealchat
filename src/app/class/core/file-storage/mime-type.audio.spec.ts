import { MimeType } from './mime-type';
import { isMediaFileName } from 'service/folder-backup-layout';

describe('MimeType audio packing / reload safety', () => {
  const colliding = ['mpeg', 'mpg', 'mp4', 'webm', 'mov', 'm4v'];

  it('maps common browser audio MIME types to safe extensions', () => {
    expect(MimeType.audioExtension('audio/mpeg')).toBe('mp3');
    expect(MimeType.audioExtension('audio/mp3')).toBe('mp3');
    expect(MimeType.audioExtension('audio/wav')).toBe('wav');
    expect(MimeType.audioExtension('audio/x-wav')).toBe('wav');
    expect(MimeType.audioExtension('audio/ogg')).toBe('ogg');
    expect(MimeType.audioExtension('audio/opus')).toBe('opus');
    expect(MimeType.audioExtension('audio/aac')).toBe('aac');
    expect(MimeType.audioExtension('audio/mp4')).toBe('m4a');
    expect(MimeType.audioExtension('audio/x-m4a')).toBe('m4a');
    expect(MimeType.audioExtension('audio/flac')).toBe('flac');
    expect(MimeType.audioExtension('audio/webm')).toBe('weba');
    expect(MimeType.audioExtension('audio/webm;codecs=opus')).toBe('weba');
    expect(MimeType.audioExtension('audio/aiff')).toBe('aiff');
    expect(MimeType.audioExtension('audio/x-aiff')).toBe('aiff');
    expect(MimeType.audioExtension('audio/x-ms-wma')).toBe('wma');
    expect(MimeType.audioExtension('audio/midi')).toBe('mid');
    expect(MimeType.audioExtension('audio/amr')).toBe('amr');
    expect(MimeType.audioExtension('audio/x-caf')).toBe('caf');
    expect(MimeType.audioExtension('audio/x-matroska')).toBe('mka');
  });

  it('never packs audio as a video-colliding extension', () => {
    const mimes = [
      'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/webm', 'audio/ogg',
      'audio/wav', 'audio/flac', 'audio/aac', 'audio/opus', 'audio/x-m4a',
      'audio/aiff', 'audio/x-ms-wma', 'audio/midi',
    ];
    for (const mime of mimes) {
      const ext = MimeType.audioExtension(mime);
      expect(colliding).withContext(mime).not.toContain(ext);
      expect(MimeType.type(`x.${ext}`).indexOf('audio/'))
        .withContext(`${mime} → .${ext}`)
        .toBe(0);
    }
  });

  it('extension() for audio/* matches audioExtension()', () => {
    expect(MimeType.extension('audio/mpeg')).toBe('mp3');
    expect(MimeType.extension('audio/webm')).toBe('weba');
    expect(MimeType.extension('audio/mp4')).toBe('m4a');
  });

  it('detects audio by MIME, safe extension, and legacy hash.mpeg only', () => {
    expect(MimeType.isAudioFile({ type: 'audio/ogg', name: 'a.bin' })).toBeTrue();
    expect(MimeType.isAudioFile({ type: '', name: 'clip.flac' })).toBeTrue();
    expect(MimeType.isAudioFile({ type: '', name: 'clip.opus' })).toBeTrue();
    expect(MimeType.isAudioFile({ type: '', name: 'clip.weba' })).toBeTrue();
    expect(MimeType.isAudioFile({ type: '', name: 'clip.aiff' })).toBeTrue();
    expect(MimeType.isAudioFile({ type: '', name: 'clip.wma' })).toBeTrue();
    expect(MimeType.isAudioFile({ type: '', name: 'clip.mid' })).toBeTrue();
    expect(MimeType.isAudioFile({ type: '', name: 'clip.mka' })).toBeTrue();
    expect(MimeType.isAudioFile({
      type: 'video/mpeg',
      name: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mpeg',
    })).toBeTrue();

    // Real video must not be treated as jukebox audio.
    expect(MimeType.isAudioFile({ type: 'video/mp4', name: 'clip.mp4' })).toBeFalse();
    expect(MimeType.isAudioFile({ type: 'video/mpeg', name: 'movie.mpeg' })).toBeFalse();
    expect(MimeType.isAudioFile({ type: 'video/webm', name: 'clip.webm' })).toBeFalse();
    expect(MimeType.isAudioFile({ type: '', name: 'clip.mpg' })).toBeFalse();
  });

  it('keeps generic .mpeg typed as video (only hashed legacy is special)', () => {
    expect(MimeType.type('track.mpeg')).toBe('video/mpeg');
    expect(MimeType.isLegacyMisnamedAudioFile('track.mpeg')).toBeFalse();
    expect(MimeType.isLegacyMisnamedAudioFile(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mpeg'
    )).toBeTrue();
  });

  it('detects packed hash media names via the shared layout helper', () => {
    expect(isMediaFileName(
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.mp3'
    )).toBeTrue();
    expect(isMediaFileName('battle-theme.mp3')).toBeFalse();
  });
});

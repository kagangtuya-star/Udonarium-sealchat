import { MimeType } from './mime-type';

describe('MimeType video packing / reload safety', () => {
  const audioOnly = ['mp3', 'm4a', 'weba', 'ogg', 'oga', 'wav', 'flac', 'aac', 'opus'];

  it('maps common video MIME types to stable extensions', () => {
    expect(MimeType.videoExtension('video/mp4')).toBe('mp4');
    expect(MimeType.videoExtension('video/webm')).toBe('webm');
    expect(MimeType.videoExtension('video/quicktime')).toBe('mov');
    expect(MimeType.videoExtension('video/ogg')).toBe('ogv');
    expect(MimeType.videoExtension('video/mpeg')).toBe('mpg');
    expect(MimeType.videoExtension('video/x-matroska')).toBe('mkv');
    expect(MimeType.videoExtension('video/x-msvideo')).toBe('avi');
    expect(MimeType.videoExtension('video/x-ms-wmv')).toBe('wmv');
    expect(MimeType.videoExtension('video/3gpp')).toBe('3gp');
    expect(MimeType.videoExtension('video/mp2t')).toBe('ts');
  });

  it('never packs video as an audio-only extension', () => {
    const mimes = [
      'video/mp4', 'video/webm', 'video/ogg', 'video/mpeg', 'video/quicktime',
      'video/x-matroska', 'video/x-msvideo', 'video/3gpp',
    ];
    for (const mime of mimes) {
      const ext = MimeType.videoExtension(mime);
      expect(audioOnly).withContext(mime).not.toContain(ext);
      expect(MimeType.type(`x.${ext}`).indexOf('video/'))
        .withContext(`${mime} → .${ext}`)
        .toBe(0);
    }
  });

  it('extension() for video/* matches videoExtension()', () => {
    expect(MimeType.extension('video/webm')).toBe('webm');
    expect(MimeType.extension('video/ogg')).toBe('ogv');
    expect(MimeType.extension('video/x-matroska')).toBe('mkv');
  });

  it('detects video by MIME or common extension, without stealing audio', () => {
    expect(MimeType.isVideoFile({ type: 'video/mp4', name: 'a.bin' })).toBeTrue();
    expect(MimeType.isVideoFile({ type: '', name: 'clip.mkv' })).toBeTrue();
    expect(MimeType.isVideoFile({ type: '', name: 'clip.avi' })).toBeTrue();
    expect(MimeType.isVideoFile({ type: '', name: 'clip.mov' })).toBeTrue();
    expect(MimeType.isVideoFile({ type: '', name: 'clip.3gp' })).toBeTrue();
    expect(MimeType.isVideoFile({ type: 'video/ogg', name: 'a.ogg' })).toBeTrue();

    expect(MimeType.isVideoFile({ type: 'audio/ogg', name: 'theme.ogg' })).toBeFalse();
    expect(MimeType.isVideoFile({ type: '', name: 'theme.ogg' })).toBeFalse();
    expect(MimeType.isVideoFile({ type: '', name: 'theme.mp3' })).toBeFalse();
    expect(MimeType.isVideoFile({ type: 'audio/mp4', name: 'theme.m4a' })).toBeFalse();
  });
});

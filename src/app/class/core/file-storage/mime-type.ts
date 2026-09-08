export namespace MimeType {
  const types: { [ext: string]: string } = {
    avif: 'image/avif',
    gif: 'image/gif',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jpe: 'image/jpeg',
    jfif: 'image/jpeg',
    pjpeg: 'image/jpeg',
    pjp: 'image/jpeg',
    png: 'image/png',
    apng: 'image/apng',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    svgz: 'image/svg+xml',
    ico: 'image/x-icon',
    cur: 'image/x-icon',
    bmp: 'image/bmp',
    html: 'text/html',
    htm: 'text/html',
    shtml: 'text/html',
    xml: 'text/xml',
    yml: 'text/yaml',
    yaml: 'text/yaml',
    json: 'application/json',
    map: 'application/json',
    zip: 'application/zip',
    pdf: 'application/pdf',
    // Audio — extensions here must round-trip to audio/* via type(), never video/*.
    mp3: 'audio/mpeg',
    mpga: 'audio/mpeg',
    wav: 'audio/wav',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    ogg: 'audio/ogg',
    oga: 'audio/ogg',
    opus: 'audio/opus',
    flac: 'audio/flac',
    weba: 'audio/webm',
    aiff: 'audio/aiff',
    aif: 'audio/aiff',
    aifc: 'audio/aiff',
    wma: 'audio/x-ms-wma',
    mid: 'audio/midi',
    midi: 'audio/midi',
    caf: 'audio/x-caf',
    amr: 'audio/amr',
    mka: 'audio/x-matroska',
    '3ga': 'audio/3gpp',
    // Video
    mpg: 'video/mpeg',
    mpeg: 'video/mpeg',
    mp4: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    m4v: 'video/mp4',
    ogv: 'video/ogg',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    wmv: 'video/x-ms-wmv',
    '3gp': 'video/3gpp',
    '3g2': 'video/3gpp2',
    ts: 'video/mp2t',
    mts: 'video/mp2t',
    m2ts: 'video/mp2t',
    flv: 'video/x-flv',
    asf: 'video/x-ms-asf',
  };

  const AUDIO_EXTS = extsForPrefix('audio/');
  const VIDEO_EXTS = extsForPrefix('video/');

  /** Subtypes / aliases that must never be used as on-disk audio extensions. */
  const VIDEO_COLLIDING_AUDIO_SUBTYPES: { [subtype: string]: string } = {
    mpeg: 'mp3',
    mp3: 'mp3',
    mp4: 'm4a',
    webm: 'weba',
  };

  /** Canonical + browser alias MIME → pack extension (first matching `types` key wins). */
  const AUDIO_EXT_BY_MIME: { [mime: string]: string } = {
    ...firstExtByMime('audio/'),
    'audio/mp3': 'mp3',
    'audio/x-wav': 'wav',
    'audio/wave': 'wav',
    'audio/vorbis': 'ogg',
    'audio/x-m4a': 'm4a',
    'audio/x-flac': 'flac',
    'audio/x-aiff': 'aiff',
    'audio/aif': 'aiff',
    'audio/wma': 'wma',
    'audio/x-midi': 'mid',
    'application/ogg': 'ogg',
  };

  const VIDEO_EXT_BY_MIME: { [mime: string]: string } = {
    ...firstExtByMime('video/'),
    'video/avi': 'avi',
    'video/x-m4v': 'm4v',
  };

  export const AUDIO_FILE_ACCEPT = fileAccept('audio/*', AUDIO_EXTS);
  export const VIDEO_FILE_ACCEPT = fileAccept('video/*', VIDEO_EXTS);

  function extsForPrefix(prefix: string): Set<string> {
    return new Set(Object.keys(types).filter(ext => types[ext].indexOf(prefix) === 0));
  }

  function firstExtByMime(prefix: string): { [mime: string]: string } {
    const out: { [mime: string]: string } = {};
    for (const ext of Object.keys(types)) {
      const mime = types[ext];
      if (mime.indexOf(prefix) === 0 && out[mime] == null) out[mime] = ext;
    }
    return out;
  }

  function fileAccept(wildcard: string, exts: Set<string>): string {
    return wildcard + ',' + [...exts].sort().map(e => '.' + e).join(',');
  }

  function packExtension(
    mimeType: string,
    prefix: 'audio/' | 'video/',
    byMime: { [mime: string]: string },
    knownExts: Set<string>,
    fallback: string,
    colliding?: { [subtype: string]: string },
  ): string {
    const normalized = stripMimeParams(mimeType);
    if (byMime[normalized]) return byMime[normalized];
    if (normalized.indexOf(prefix) === 0) {
      const subtype = normalized.slice(prefix.length).replace(/^x-/, '');
      if (colliding && colliding[subtype]) return colliding[subtype];
      if (knownExts.has(subtype)) return subtype;
      if (prefix === 'audio/' && subtype && /^[a-z0-9]+$/i.test(subtype)) return subtype;
    }
    return fallback;
  }

  function mimeForExtension(ext: string, prefix: string, fallback: string): string {
    const e = (ext || '').toLowerCase();
    if (types[e] && types[e].indexOf(prefix) === 0) return types[e];
    return fallback;
  }

  export function type(fileName: string): string {
    let ext = fileName.replace(/.*[\.\/\\]/, '').toLowerCase();
    return types[ext] ? types[ext] : '';
  }

  export function extension(mimeType: string): string {
    const normalized = stripMimeParams(mimeType);
    if (normalized.indexOf('audio/') === 0) {
      return audioExtension(normalized);
    }
    if (normalized.indexOf('video/') === 0) {
      return videoExtension(normalized);
    }
    for (let key in types) {
      if (types[key] === normalized) {
        return key;
      }
    }
    return normalized.split('/')[1] || '';
  }

  /**
   * Extension used when packing AudioStorage blobs into ZIP / folder media.
   * Never returns mpeg/mpg/mp4/webm (those reload as video/*).
   */
  export function audioExtension(mimeType: string): string {
    return packExtension(
      mimeType, 'audio/', AUDIO_EXT_BY_MIME, AUDIO_EXTS, 'mp3', VIDEO_COLLIDING_AUDIO_SUBTYPES,
    );
  }

  export function audioMimeForExtension(ext: string): string {
    return mimeForExtension(ext, 'audio/', 'audio/mpeg');
  }

  export function videoExtension(mimeType: string): string {
    return packExtension(mimeType, 'video/', VIDEO_EXT_BY_MIME, VIDEO_EXTS, 'mp4');
  }

  export function videoMimeForExtension(ext: string): string {
    return mimeForExtension(ext, 'video/', 'video/mp4');
  }

  export function isAudioMime(mimeType: string): boolean {
    return isKindMime(mimeType, 'audio/');
  }

  export function isAudioExtension(ext: string): boolean {
    return AUDIO_EXTS.has((ext || '').toLowerCase());
  }

  export function isVideoMime(mimeType: string): boolean {
    return isKindMime(mimeType, 'video/');
  }

  export function isVideoExtension(ext: string): boolean {
    return VIDEO_EXTS.has((ext || '').toLowerCase());
  }

  function isKindMime(mimeType: string, prefix: string): boolean {
    return stripMimeParams(mimeType).indexOf(prefix) === 0;
  }

  export function fileBaseName(fileName: string): string {
    return (fileName || '').split(/[\\/]/).pop() || '';
  }

  export function fileExtension(fileName: string): string {
    const base = fileBaseName(fileName);
    const i = base.lastIndexOf('.');
    return i >= 0 ? base.slice(i + 1).toLowerCase() : '';
  }

  /**
   * Legacy buggy saves: browser MP3 (audio/mpeg) was written as "<sha256>.mpeg",
   * which MimeType.type maps to video/mpeg. Only this hashed form is recovered as audio.
   */
  export function isLegacyMisnamedAudioFile(fileName: string): boolean {
    return /^[a-f0-9]{64}\.mpeg$/i.test(fileBaseName(fileName));
  }

  /** True when ZIP / drop / folder restore should import this file as jukebox audio. */
  export function isAudioFile(file: { name?: string; type?: string }): boolean {
    if (isLegacyMisnamedAudioFile(file?.name || '')) return true;
    const type = file?.type || '';
    if (isVideoMime(type) && !isAudioMime(type)) return false;
    if (isAudioMime(type) || type === 'application/ogg') return true;
    if (isAudioExtension(fileExtension(file?.name || ''))) return true;
    return false;
  }

  /** True when ZIP / drop / folder restore should import this file as note / cut-in video. */
  export function isVideoFile(file: { name?: string; type?: string }): boolean {
    if (isAudioFile(file)) return false;
    if (isVideoMime(file?.type || '')) return true;
    if (isVideoExtension(fileExtension(file?.name || ''))) return true;
    return false;
  }

  function stripMimeParams(mimeType: string): string {
    return (mimeType || '').toLowerCase().split(';')[0].trim();
  }
}

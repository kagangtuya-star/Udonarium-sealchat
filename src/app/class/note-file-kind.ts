/** Classify files for shared-note import / tabletop drop. */

import { MimeType } from '@udonarium/core/file-storage/mime-type';

export type NoteFileKind = 'image' | 'video' | 'pdf' | 'text';

/** File picker accept string for note inventory / settings import. */
export const NOTE_FILE_ACCEPT =
  'image/*,application/pdf,text/plain,text/*,application/json,' +
  MimeType.VIDEO_FILE_ACCEPT + ',' +
  '.png,.jpg,.jpeg,.jfif,.gif,.webp,.bmp,.svg,.avif,.apng,.ico,' +
  '.pdf,' +
  '.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml,.yml,.yaml,.log,.ini,.conf,.rst,.tex,.rtf';

const IMAGE_EXT = /\.(png|jpe?g|jfif|gif|webp|bmp|svg|avif|apng|ico)$/i;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log|ini|conf|rst|tex|rtf)$/i;

/**
 * Resolve note media kind for a File.
 * `.ogg` is video only when MIME is `video/ogg` (audio/ogg stays out of notes).
 */
export function classifyNoteFile(file: File | null | undefined): NoteFileKind | null {
  if (!file) return null;
  const type = (file.type || '').toLowerCase();
  const name = (file.name || '').toLowerCase();

  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';

  if (MimeType.isVideoFile(file)) return 'video';

  if (type.indexOf('image/') === 0 || IMAGE_EXT.test(name)) return 'image';

  if (
    type.indexOf('text/') === 0
    || type === 'application/json'
    || type === 'application/xml'
    || type === 'application/rtf'
    || type === 'text/rtf'
    || TEXT_EXT.test(name)
  ) {
    return 'text';
  }

  return null;
}

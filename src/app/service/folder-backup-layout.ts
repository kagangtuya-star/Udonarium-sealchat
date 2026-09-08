/** Folder auto-backup layout (v2): shared media + per-room state directories. */

import { MimeType } from '@udonarium/core/file-storage/mime-type';

export const FOLDER_BACKUP_FORMAT_VERSION = 2;

export const MEDIA_DIR = 'media';
export const ROOMS_DIR = 'rooms';
export const LATEST_DIR = 'latest';
export const RECENT_DIR = 'recent';
export const PREVIEW_FILE = 'preview.jpg';
export const MANIFEST_FILE = 'manifest.json';
export const STATE_ZIP_FILE = 'state.zip';
export const ROOM_META_FILE = 'room.meta.json';

export const RECENT_SLOT_COUNT = 4;
export const RECENT_INTERVAL_MS = 15 * 60 * 1000;
export const SNAP_1D_MS = 24 * 60 * 60 * 1000;
export const SNAP_7D_MS = 7 * SNAP_1D_MS;
export const SNAP_30D_MS = 30 * SNAP_1D_MS;

export const SNAP_DIRS = ['snap_1d', 'snap_7d', 'snap_30d'] as const;
export type SnapDir = (typeof SNAP_DIRS)[number];

/** State / config files written into each slot directory (not media blobs). */
export const STATE_FILE_NAMES = new Set([
  'fly_data.xml',
  'fly_chat.xml',
  'fly_rollTable.xml',
  'fly_cutIn.xml',
  'summary.xml',
  'fly_auraNames.xml',
  'fly_combat.xml',
  'fly_scenePerm.xml',
  'fly_scenePreset.xml',
  'fly_scenarioText.xml',
  'fly_audioLibrary.xml',
  'fly_jukebox.xml',
  'fly_imageTag.xml',
  'fly_audioUrls.json',
]);

export type FolderBackupSlotKind = 'latest' | 'recent' | 'snap_1d' | 'snap_7d' | 'snap_30d' | 'legacy_zip';

export interface FolderBackupManifest {
  formatVersion: number;
  savedAt: string;
  files: Record<string, string>;
  media: { hash: string; name: string; kind?: string }[];
  stateFingerprint?: string;
  stateZip?: string;
}

export interface FolderBackupRoomMetaV2 {
  formatVersion: number;
  roomId: string;
  displayName: string;
  savedAt: string;
  /** First successful v2 save — retention intervals count from this. */
  firstSavedAt?: string;
  includeAudio?: boolean;
  allowUser?: boolean;
  allowGuest?: boolean;
  secrets?: {
    v: 1;
    salt: string;
    iv: string;
    data: string;
  };
  /** @deprecated legacy */
  gmPassword?: string;
  userPassword?: string;
  guestPassword?: string;
  slots?: {
    latest?: string;
    recent?: string[];
    snap_1d?: string;
    snap_7d?: string;
    snap_30d?: string;
    recentIndex?: number;
  };
}

/** Media blob names: "<sha256>.ext" (same as card / token images). */
export function isMediaFileName(name: string): boolean {
  const base = (name || '').split(/[\\/]/).pop() || '';
  if (!base || STATE_FILE_NAMES.has(base)) return false;
  if (base === MANIFEST_FILE || base === PREVIEW_FILE) return false;
  return /^[a-f0-9]{64}\.[A-Za-z0-9]+$/i.test(base);
}

export function mediaHashFromName(name: string): string {
  const base = (name || '').split(/[\\/]/).pop() || '';
  const i = base.lastIndexOf('.');
  return i > 0 ? base.slice(0, i).toLowerCase() : base.toLowerCase();
}

/** ZIP / folder media blob name for cards, tokens, audio, PDF, and video. */
export function packedMediaFileName(hash: string, ext: string): string {
  const e = (ext || 'bin').replace(/^\./, '');
  return `${(hash || '').toLowerCase()}.${e}`;
}

export function toPackedMediaFile(blob: Blob, identifier: string, ext: string, type: string): File {
  return new File([blob], packedMediaFileName(identifier, ext), { type });
}

export function toPackedAudioFile(blob: Blob, identifier: string): File {
  const ext = MimeType.audioExtension(blob.type || 'audio/mpeg');
  return toPackedMediaFile(blob, identifier, ext, MimeType.audioMimeForExtension(ext));
}

export function toPackedVideoFile(blob: Blob, identifier: string): File {
  const ext = MimeType.videoExtension(blob.type || 'video/mp4');
  return toPackedMediaFile(blob, identifier, ext, MimeType.videoMimeForExtension(ext));
}

/** Catalog / media identifiers: 64-char content SHA-256 hex. */
export function isContentHashIdentifier(identifier: string): boolean {
  return /^[a-f0-9]{64}$/i.test(identifier || '');
}

export async function sha256Hex(data: ArrayBuffer | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Aggregate fingerprint used to skip rewriting state.zip when room XML is unchanged.
 * Input: per-file name → content hash (same map written into manifest.files).
 */
export async function computeStateFingerprint(
  fileFingerprints: Record<string, string>
): Promise<string> {
  const parts = Object.keys(fileFingerprints)
    .sort()
    .map(name => `${name}:${fileFingerprints[name]}`);
  return sha256Hex(parts.join('|'));
}

/** True when previous manifest fingerprint matches current state (skip state.zip write). */
export function shouldSkipStateZipWrite(
  stateFingerprint: string,
  previousStateFingerprint: string | undefined | null
): boolean {
  return !!stateFingerprint && stateFingerprint === (previousStateFingerprint || '');
}

export type ManifestMediaEntry = { hash: string; name: string; kind?: string };

/**
 * Folder autosave must never drop media entries that were written earlier.
 * Otherwise a brief incomplete ImageStorage/PdfStorage (peers joining, remesh)
 * rewrites manifest.media to a subset, and the next load skips orphaned media/
 * blobs even though the files still exist on disk.
 */
export function unionManifestMedia(
  previous: ManifestMediaEntry[] | null | undefined,
  next: ManifestMediaEntry[] | null | undefined,
): ManifestMediaEntry[] {
  const byHash = new Map<string, ManifestMediaEntry>();
  const absorb = (list: ManifestMediaEntry[] | null | undefined) => {
    if (!list?.length) return;
    for (const entry of list) {
      if (!entry?.hash || !entry?.name) continue;
      if (!isMediaFileName(entry.name) && !isContentHashIdentifier(entry.hash)) continue;
      const hash = entry.hash.toLowerCase();
      const name = entry.name;
      const prev = byHash.get(hash);
      byHash.set(hash, {
        hash,
        name: isMediaFileName(name) ? name : (prev?.name || name),
        kind: entry.kind || prev?.kind,
      });
    }
  };
  absorb(previous);
  absorb(next);
  return Array.from(byHash.values()).sort((a, b) => a.hash.localeCompare(b.hash));
}

/**
 * Collect content-hash media ids referenced by room XML / tag attributes /
 * jukebox JSON (audioIdentifier, fly_audioLibrary dataJson).
 * Used to pull orphaned media/ files that fell out of manifest.media.
 */
export function collectReferencedMediaHashes(...texts: string[]): string[] {
  const found = new Set<string>();
  const attrRe = /(?:pdfIdentifier|videoIdentifier|audioIdentifier|imageIdentifier|toImageIdentifier|backgroundImageIdentifier2?|currentValue)\s*[=:]\s*["']?([a-f0-9]{64})/gi;
  const attachedRe = /attachedImageIdentifiers\s*=\s*["']([^"']+)["']/gi;
  const typeImageRe = /type\s*=\s*["']image["'][^>]*>\s*([a-f0-9]{64})\s*</gi;
  // fly_audioLibrary.xml / fly_jukebox.xml keep ids inside JSON attributes (dataJson, tracksJson).
  const hashTokenRe = /[a-f0-9]{64}/gi;
  for (const text of texts) {
    if (!text) continue;
    let m: RegExpExecArray | null;
    attrRe.lastIndex = 0;
    while ((m = attrRe.exec(text)) !== null) found.add(m[1].toLowerCase());
    attachedRe.lastIndex = 0;
    while ((m = attachedRe.exec(text)) !== null) {
      for (const id of m[1].trim().split(/\s+/)) {
        if (isContentHashIdentifier(id)) found.add(id.toLowerCase());
      }
    }
    typeImageRe.lastIndex = 0;
    while ((m = typeImageRe.exec(text)) !== null) found.add(m[1].toLowerCase());
    hashTokenRe.lastIndex = 0;
    while ((m = hashTokenRe.exec(text)) !== null) found.add(m[0].toLowerCase());
  }
  return Array.from(found);
}

export function dataUrlToJpegBlob(dataUrl: string): Blob | null {
  if (!dataUrl || !dataUrl.startsWith('data:')) return null;
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const base64 = dataUrl.slice(comma + 1);
  const mime = /data:([^;]+)/.exec(header)?.[1] || 'image/jpeg';
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  } catch {
    return null;
  }
}

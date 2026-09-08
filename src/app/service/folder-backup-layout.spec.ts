import {
  STATE_FILE_NAMES,
  collectReferencedMediaHashes,
  computeStateFingerprint,
  isContentHashIdentifier,
  isMediaFileName,
  mediaHashFromName,
  packedMediaFileName,
  toPackedAudioFile,
  toPackedVideoFile,
  sha256Hex,
  shouldSkipStateZipWrite,
  unionManifestMedia,
} from './folder-backup-layout';

describe('folder-backup-layout', () => {
  it('STATE_FILE_NAMES includes fly_data.xml and scene files', () => {
    expect(STATE_FILE_NAMES.has('fly_data.xml')).toBeTrue();
    expect(STATE_FILE_NAMES.has('fly_scenePerm.xml')).toBeTrue();
    expect(STATE_FILE_NAMES.has('fly_scenarioText.xml')).toBeTrue();
    expect(STATE_FILE_NAMES.has('fly_scenePreset.xml')).toBeTrue();
  });

  it('isMediaFileName rejects state files and accepts content-hash blobs', () => {
    expect(isMediaFileName('fly_data.xml')).toBeFalse();
    expect(isMediaFileName('manifest.json')).toBeFalse();
    expect(isMediaFileName('preview.jpg')).toBeFalse();
    const hash = 'a'.repeat(64);
    expect(isMediaFileName(`${hash}.png`)).toBeTrue();
    expect(isMediaFileName(`media/${hash}.png`)).toBeTrue();
    expect(isMediaFileName('not-a-hash.png')).toBeFalse();
  });

  it('mediaHashFromName strips extension and directory prefixes', () => {
    const hash = 'b'.repeat(64);
    expect(mediaHashFromName(`${hash}.jpg`)).toBe(hash);
    expect(mediaHashFromName(`media/${hash}.mp3`)).toBe(hash);
    expect(mediaHashFromName(`media\\${hash}.mpeg`)).toBe(hash);
  });

  it('packedMediaFileName is always <sha256>.ext', () => {
    const hash = 'd'.repeat(64);
    expect(packedMediaFileName(hash, 'mp3')).toBe(`${hash}.mp3`);
    expect(packedMediaFileName(hash, '.png')).toBe(`${hash}.png`);
    expect(isMediaFileName(packedMediaFileName(hash, 'pdf'))).toBeTrue();
  });

  it('toPackedAudioFile / toPackedVideoFile use the shared hash.ext pack names', () => {
    const hash = 'e'.repeat(64);
    const audio = toPackedAudioFile(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }), hash);
    expect(audio.name).toBe(`${hash}.mp3`);
    expect(audio.type).toBe('audio/mpeg');
    const video = toPackedVideoFile(new Blob([new Uint8Array([1])], { type: 'video/webm' }), hash);
    expect(video.name).toBe(`${hash}.webm`);
    expect(video.type).toBe('video/webm');
  });

  it('isContentHashIdentifier accepts 64-char hex only', () => {
    const hash = 'c'.repeat(64);
    expect(isContentHashIdentifier(hash)).toBeTrue();
    expect(isContentHashIdentifier(hash.toUpperCase())).toBeTrue();
    expect(isContentHashIdentifier('https://example.com/x.png')).toBeFalse();
    expect(isContentHashIdentifier(hash.slice(0, 63))).toBeFalse();
  });

  it('sha256Hex is stable for the same payload (fingerprint skip input)', async () => {
    const a = await sha256Hex('fly_data.xml-content');
    const b = await sha256Hex('fly_data.xml-content');
    const c = await sha256Hex('fly_data.xml-changed');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.length).toBe(64);
  });

  it('computeStateFingerprint is order-independent and stable', async () => {
    const a = await computeStateFingerprint({
      'fly_chat.xml': 'aaa',
      'fly_data.xml': 'bbb',
    });
    const b = await computeStateFingerprint({
      'fly_data.xml': 'bbb',
      'fly_chat.xml': 'aaa',
    });
    const c = await computeStateFingerprint({
      'fly_chat.xml': 'aaa',
      'fly_data.xml': 'CHANGED',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('shouldSkipStateZipWrite only when fingerprints match', () => {
    expect(shouldSkipStateZipWrite('abc', 'abc')).toBeTrue();
    expect(shouldSkipStateZipWrite('abc', 'xyz')).toBeFalse();
    expect(shouldSkipStateZipWrite('abc', '')).toBeFalse();
    expect(shouldSkipStateZipWrite('', '')).toBeFalse();
  });

  it('unionManifestMedia keeps previous hashes when next save packs fewer blobs', () => {
    const card = '5'.repeat(64);
    const table = 'a'.repeat(64);
    const pdf = 'e'.repeat(64);
    const previous = [
      { hash: card, name: `${card}.png` },
      { hash: table, name: `${table}.jpg` },
      { hash: pdf, name: `${pdf}.pdf` },
    ];
    const next = [
      { hash: table, name: `${table}.jpg` },
    ];
    const union = unionManifestMedia(previous, next);
    expect(union.map(e => e.hash).sort()).toEqual([card, pdf, table].sort());
    expect(union.find(e => e.hash === pdf)?.name).toBe(`${pdf}.pdf`);
  });

  it('collectReferencedMediaHashes finds pdf and card image ids in room XML', () => {
    const card = 'c'.repeat(64);
    const pdf = 'd'.repeat(64);
    const xml = `
      <card imageIdentifier="${card}" />
      <text-note pdfIdentifier="${pdf}" contentMode="pdf" />
      <data type="image">${card}</data>
    `;
    expect(collectReferencedMediaHashes(xml).sort()).toEqual([card, pdf].sort());
  });

  it('collectReferencedMediaHashes finds jukebox / library audio ids so orphaned media/ files restore', () => {
    const bgm = '1'.repeat(64);
    const se = '2'.repeat(64);
    const pad = '3'.repeat(64);
    const xml = `
      <jukebox audioIdentifier="${bgm}" tracksJson="{&quot;audioIdentifier&quot;:&quot;${se}&quot;}" />
      <audio-library dataJson="{&quot;orders&quot;:{&quot;&quot;:[&quot;${pad}&quot;]}}" />
    `;
    const found = collectReferencedMediaHashes(xml).sort();
    expect(found).toContain(bgm);
    expect(found).toContain(se);
    expect(found).toContain(pad);
  });

  it('collectReferencedMediaHashes finds table / chat / combat / bake / scene hashes in JSON XML', () => {
    const map = '4'.repeat(64);
    const chat = '5'.repeat(64);
    const combat = '6'.repeat(64);
    const bake = '7'.repeat(64);
    const scene = '8'.repeat(64);
    const xml = `
      <game-table imageIdentifier="${map}" />
      <chat-message attachedImageIdentifiers="${chat}" />
      <combat-tracker encountersJson="[{&quot;imageIdentifier&quot;:&quot;${combat}&quot;}]" />
      <terrain bakeCropJson="{&quot;sourceImageIdentifier&quot;:&quot;${bake}&quot;}" />
      <scene-preset tabletopJson="{&quot;imageIdentifier&quot;:&quot;${scene}&quot;}" />
    `;
    const found = collectReferencedMediaHashes(xml);
    expect(found).toContain(map);
    expect(found).toContain(chat);
    expect(found).toContain(combat);
    expect(found).toContain(bake);
    expect(found).toContain(scene);
  });
});

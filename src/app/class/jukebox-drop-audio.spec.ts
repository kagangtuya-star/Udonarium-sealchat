import { trackAfterDroppingAudio } from './jukebox-drop-audio';
import type { JukeboxTrackState } from './Jukebox';

function track(partial: Partial<JukeboxTrackState>): JukeboxTrackState {
  return {
    audioIdentifier: '',
    isPlaying: false,
    isPaused: false,
    currentTime: 0,
    isLoop: true,
    roomGain: 1,
    label: '',
    queue: [],
    queueMode: 'single',
    fadeSec: 0,
    overlapSec: 0,
    ...partial,
  };
}

describe('trackAfterDroppingAudio', () => {
  it('leaves unrelated tracks alone', () => {
    const t = track({ audioIdentifier: 'a', queue: ['a'] });
    expect(trackAfterDroppingAudio(t, 'b').action).toBe('unchanged');
  });

  it('drops a queued id that is not currently playing', () => {
    const t = track({ audioIdentifier: 'a', queue: ['a', 'b', 'c'], queueMode: 'queue-loop' });
    const result = trackAfterDroppingAudio(t, 'b');
    expect(result.action).toBe('update');
    expect(result.next.audioIdentifier).toBe('a');
    expect(result.next.queue).toEqual(['a', 'c']);
  });

  it('plays the next queued id when the current track is deleted', () => {
    const t = track({
      audioIdentifier: 'a',
      isPlaying: true,
      queue: ['a', 'b'],
      queueMode: 'queue-loop',
    });
    const result = trackAfterDroppingAudio(t, 'a');
    expect(result.action).toBe('play');
    expect(result.next.audioIdentifier).toBe('b');
    expect(result.next.queue).toEqual(['b']);
  });

  it('clears a once-queue when the last remaining id is deleted', () => {
    const t = track({
      audioIdentifier: 'a',
      isPlaying: true,
      queue: ['a'],
      queueMode: 'queue-once',
    });
    const result = trackAfterDroppingAudio(t, 'a');
    expect(result.action).toBe('clear');
    expect(result.next.audioIdentifier).toBe('');
    expect(result.next.isPlaying).toBeFalse();
  });

  it('wraps a loop queue to the first remaining id', () => {
    const t = track({
      audioIdentifier: 'c',
      isPlaying: true,
      queue: ['a', 'b', 'c'],
      queueMode: 'queue-loop',
    });
    const result = trackAfterDroppingAudio(t, 'c');
    expect(result.action).toBe('play');
    expect(result.next.audioIdentifier).toBe('a');
    expect(result.next.queue).toEqual(['a', 'b']);
  });
});

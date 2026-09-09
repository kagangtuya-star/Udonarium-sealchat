import type { JukeboxQueueMode, JukeboxTrackState } from './Jukebox';

export type DropAudioTrackAction = 'unchanged' | 'update' | 'play' | 'clear';

function clearedTrack(track: JukeboxTrackState): JukeboxTrackState {
  return {
    ...track,
    audioIdentifier: '',
    isPlaying: false,
    isPaused: false,
    currentTime: 0,
    queue: [],
    queueMode: 'single',
  };
}

function nextIdAfterDrop(queue: string[], audioId: string, mode: JukeboxQueueMode): string | null {
  const remaining = queue.filter(id => id !== audioId);
  if (remaining.length < 1) return null;
  let i = queue.indexOf(audioId) + 1;
  while (i < queue.length) {
    if (queue[i] !== audioId) return queue[i];
    i++;
  }
  if (mode === 'shuffle-once' || mode === 'queue-once') return null;
  return remaining[0];
}

/** Remove a deleted audio from the current assignment and folder queue. */
export function trackAfterDroppingAudio(
  track: JukeboxTrackState,
  audioId: string,
): { next: JukeboxTrackState; action: DropAudioTrackAction } {
  if (!audioId) return { next: track, action: 'unchanged' };
  const queue = Array.isArray(track.queue) ? track.queue : [];
  const currentGone = track.audioIdentifier === audioId;
  const inQueue = queue.includes(audioId);
  if (!currentGone && !inQueue) return { next: track, action: 'unchanged' };

  const nextQueue = queue.filter(id => id !== audioId);
  if (!currentGone) {
    return { next: { ...track, queue: nextQueue }, action: 'update' };
  }

  const nextId = nextIdAfterDrop(queue, audioId, track.queueMode);
  if (!nextId) return { next: clearedTrack(track), action: 'clear' };
  return {
    next: {
      ...track,
      audioIdentifier: nextId,
      queue: nextQueue,
      currentTime: 0,
      isPaused: false,
      isPlaying: true,
      isLoop: false,
    },
    action: 'play',
  };
}

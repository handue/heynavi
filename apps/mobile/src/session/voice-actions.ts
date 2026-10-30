/**
 * What a recognized voice command does to the search session. Pure, so the stop / cancel /
 * quiet semantics are unit-tested; use-search-session.ts runs the actions.
 */
import { phrases } from '../agent/phrases.ts';
import { isActive } from '../agent/search-machine.ts';
import type { SearchStatus } from '../agent/types.ts';
import type { Command } from '../voice/command-grammar.ts';

export type VoiceContext = {
  /** HeyNavi's TTS is speaking now (speech-tracker.ts). */
  speaking: boolean;
  /**
   * HeyNavi was speaking when the user began the command (HeardCommand.speakingAtStart).
   * Defaults to `speaking`. The final arrives about a second after the user stopped talking, so
   * a guidance line may have started in between: what the user meant follows from this.
   */
  speakingAtStart?: boolean;
  status: SearchStatus;
  /** The camera can deliver frames (permission granted and preview ready). */
  canSearch: boolean;
};

export type VoiceAction =
  /** Set the concept (the chooser follows) and start or replace the goal. */
  | { type: 'start'; concept: string }
  /** Ends the search; the search machine says "Stopped searching.". */
  | { type: 'stop-search' }
  /** Stops all speech; the search goes on. */
  | { type: 'silence' }
  | { type: 'pause' }
  | { type: 'resume' }
  /** Repeats the last utterance, or says there is nothing to repeat. */
  | { type: 'repeat' }
  | { type: 'reply'; key: string; text: string };

/** A search (or a paused one) that "stop" can end. */
export function hasSearch(status: SearchStatus): boolean {
  return status !== 'IDLE' && status !== 'CANCELLED';
}

export function planCommand(command: Command, context: VoiceContext): VoiceAction[] {
  const voice = phrases('en-US').voice;
  const { speaking, status } = context;
  switch (command.type) {
    case 'find':
      return context.canSearch
        ? [{ type: 'start', concept: command.concept }]
        : [{ type: 'reply', key: 'camera-not-ready', text: voice.cameraNotReady() }];
    case 'stop':
      // Said over HeyNavi's speech, "stop" only stops the speech; said in silence, it ends the
      // search (and silences anything that started since, like "cancel").
      if (context.speakingAtStart ?? speaking) return speaking ? [{ type: 'silence' }] : [];
      return endSearch(speaking, status);
    case 'cancel':
      return endSearch(speaking, status);
    case 'quiet':
      return speaking ? [{ type: 'silence' }] : [];
    case 'pause':
      if (isActive(status)) return [{ type: 'pause' }, { type: 'reply', key: 'paused', text: voice.paused() }];
      if (status === 'PAUSED') return [{ type: 'reply', key: 'paused', text: voice.paused() }];
      return [{ type: 'reply', key: 'nothing-to-pause', text: voice.nothingToPause() }];
    case 'resume':
      if (status === 'PAUSED') return [{ type: 'resume' }];
      // Already searching: nothing to do, and nothing worth saying over the search.
      if (isActive(status)) return [];
      return [{ type: 'reply', key: 'nothing-to-resume', text: voice.nothingToResume() }];
    case 'repeat':
      return [{ type: 'repeat' }];
    case 'help':
      return [{ type: 'reply', key: 'help', text: voice.help() }];
  }
}

function endSearch(speaking: boolean, status: SearchStatus): VoiceAction[] {
  const actions: VoiceAction[] = [];
  if (speaking) actions.push({ type: 'silence' });
  if (hasSearch(status)) actions.push({ type: 'stop-search' });
  return actions;
}

/** True when the actions cut speech off or end the search: a stop-latency sample is due. */
export function stopsSpeech(actions: readonly VoiceAction[]): boolean {
  return actions.some((a) => a.type === 'silence' || a.type === 'stop-search');
}

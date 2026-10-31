/**
 * What a recognized voice command does to the camera session: the search and the scene updates.
 * Pure, so the stop / cancel / quiet / pause semantics are unit-tested; use-camera-session.ts
 * runs the actions.
 */
import { phrases } from '../agent/phrases.ts';
import { isActive } from '../agent/search-machine.ts';
import type { SearchStatus } from '../agent/types.ts';
import { scenePhrases } from '../scene/scene-phrases.ts';
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
  /** Proactive scene updates: looking right now, or held by the user ("pause", "updates off"). */
  scene?: { running: boolean; pausedByUser: boolean };
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
  | { type: 'reply'; key: string; text: string }
  /** Describe the current view now (a priority-0 answer). */
  | { type: 'describe' }
  /** Hold or restart the proactive scene updates (the user's own pause). */
  | { type: 'pause-updates' }
  | { type: 'resume-updates' }
  /** Step verbosity; the session replies with the result. */
  | { type: 'verbosity'; delta: 1 | -1 }
  /** Answer a question from the current view (it may hand off to a search). */
  | { type: 'ask'; question: string }
  /** Walking directions (M6): start a route, the next step, where the user is, end the route. */
  | { type: 'navigate'; destination: string }
  | { type: 'next-step' }
  | { type: 'where-am-i' }
  | { type: 'stop-navigation' };

/** Only a "where is …" question may hand off to a search when its thing is not in view. */
export function startsSearch(question: string): boolean {
  return /^(where|where's|wheres|where're)\b/.test(question);
}

/** A search (or a paused one) that "stop" can end. */
export function hasSearch(status: SearchStatus): boolean {
  return status !== 'IDLE' && status !== 'CANCELLED';
}

export function planCommand(command: Command, context: VoiceContext): VoiceAction[] {
  const voice = phrases('en-US').voice;
  const { speaking, status } = context;
  const scene = context.scene ?? { running: false, pausedByUser: false };
  const holdUpdates: VoiceAction[] = [
    { type: 'pause-updates' },
    { type: 'reply', key: 'updates-paused', text: scenePhrases.updatesPaused() },
  ];
  switch (command.type) {
    case 'find':
      return context.canSearch
        ? [{ type: 'start', concept: command.concept }]
        : [{ type: 'reply', key: 'camera-not-ready', text: voice.cameraNotReady() }];
    case 'stop':
      // Said over HeyNavi's speech, "stop" only stops the speech. Said in silence, it ends the
      // search, or, with no search, holds the scene updates.
      if (context.speakingAtStart ?? speaking) return speaking ? [{ type: 'silence' }] : [];
      if (hasSearch(status)) return endSearch(speaking, status);
      return scene.running ? [...(speaking ? [{ type: 'silence' } as const] : []), ...holdUpdates] : endSearch(speaking, status);
    case 'cancel':
      return endSearch(speaking, status);
    case 'quiet':
      return speaking ? [{ type: 'silence' }] : [];
    case 'pause':
      if (isActive(status)) return [{ type: 'pause' }, { type: 'reply', key: 'paused', text: voice.paused() }];
      if (status === 'PAUSED') return [{ type: 'reply', key: 'paused', text: voice.paused() }];
      if (scene.running) return holdUpdates;
      if (scene.pausedByUser) return [{ type: 'reply', key: 'updates-paused', text: scenePhrases.updatesPaused() }];
      return [{ type: 'reply', key: 'nothing-to-pause', text: voice.nothingToPause() }];
    case 'resume':
      if (status === 'PAUSED') return [{ type: 'resume' }];
      // Already searching: nothing to do, and nothing worth saying over the search.
      if (isActive(status)) return [];
      if (scene.pausedByUser) return resumeUpdates();
      if (scene.running) return [];
      return [{ type: 'reply', key: 'nothing-to-resume', text: voice.nothingToResume() }];
    case 'repeat':
      return [{ type: 'repeat' }];
    case 'help':
      return [{ type: 'reply', key: 'help', text: voice.help() }];
    case 'describe':
      return context.canSearch
        ? [{ type: 'describe' }]
        : [{ type: 'reply', key: 'camera-not-ready', text: voice.cameraNotReady() }];
    case 'more-updates':
      return [{ type: 'verbosity', delta: 1 }];
    case 'fewer-updates':
      return [{ type: 'verbosity', delta: -1 }];
    case 'updates-off':
      if (scene.pausedByUser) return [{ type: 'reply', key: 'updates-paused', text: scenePhrases.updatesPaused() }];
      return holdUpdates;
    case 'updates-on':
      return scene.pausedByUser
        ? resumeUpdates()
        : [{ type: 'reply', key: 'updates-on', text: scenePhrases.updatesAlreadyOn() }];
    case 'ask':
      return context.canSearch
        ? [{ type: 'ask', question: command.question }]
        : [{ type: 'reply', key: 'camera-not-ready', text: voice.cameraNotReady() }];
    // Navigation does not need the camera: the map and the GPS do the work.
    case 'navigate':
      return [{ type: 'navigate', destination: command.destination }];
    case 'next-step':
      return [{ type: 'next-step' }];
    case 'where-am-i':
      return [{ type: 'where-am-i' }];
    case 'stop-navigation':
      return [...(speaking ? [{ type: 'silence' } as const] : []), { type: 'stop-navigation' }];
  }
}

function resumeUpdates(): VoiceAction[] {
  return [{ type: 'resume-updates' }, { type: 'reply', key: 'updates-resumed', text: scenePhrases.updatesResumed() }];
}

function endSearch(speaking: boolean, status: SearchStatus): VoiceAction[] {
  const actions: VoiceAction[] = [];
  if (speaking) actions.push({ type: 'silence' });
  if (hasSearch(status)) actions.push({ type: 'stop-search' });
  return actions;
}

/** True when the actions cut speech off, end the search or hold the updates: a stop-latency sample is due. */
export function stopsSpeech(actions: readonly VoiceAction[]): boolean {
  return actions.some((a) => a.type === 'silence' || a.type === 'stop-search' || a.type === 'pause-updates');
}

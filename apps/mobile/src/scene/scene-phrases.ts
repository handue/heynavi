/**
 * What HeyNavi says about the scene (ARCHITECTURE 6.3). Proactive lines are templates filled
 * with validated labels and camera-relative positions, never the model's free text; only the
 * summary sentence comes from the model, after two wording filters. Same voice-audit rules as
 * agent/phrases.ts: no line or clause may parse as a command, and no wake word
 * (scene-phrases.test.ts).
 */
import { pluralLabel, withArticle } from '../agent/phrases.ts';
import type { Position } from '../agent/types.ts';
import type { Band, SceneItem, Verbosity } from './types.ts';

const MIDDLE: Record<Position, string> = {
  left: 'on the left of the camera view',
  center: 'in the center of the camera view',
  right: 'on the right of the camera view',
};

/** "on the left of the camera view", "in the lower center of the camera view". */
export function where(position: Position, band: Band): string {
  if (band === 'middle') return MIDDLE[position];
  return `in the ${band} ${position} of the camera view`;
}

type Describable = Pick<SceneItem, 'label' | 'count' | 'position' | 'band'>;

/** "a chair in the lower center of the camera view", "2 people on the left of the camera view". */
export function itemPhrase(item: Describable): string {
  const noun = item.count > 1 ? `${item.count} ${pluralLabel(item.label)}` : withArticle(item.label);
  return `${noun} ${where(item.position, item.band)}`;
}

export const scenePhrases = {
  /** Spoken when exploring starts; the first look follows a few seconds later. */
  exploreStart: () => "I'm looking around. I'll tell you what I notice.",
  item: (item: Describable) => `I see ${itemPhrase(item)}.`,
  /** A sign or poster with readable text. `text` must already have passed the filters. */
  text: (item: Describable, text: string) => `I see ${itemPhrase(item)}. It reads: ${text}.`,
  textUnreadable: (item: Describable) => `I see ${itemPhrase(item)} with some text on it.`,
  /** One sentence listing a few items: "I see a door …, and a chair …". */
  items: (items: readonly Describable[]) => {
    const parts = items.map(itemPhrase);
    if (parts.length <= 1) return `I see ${parts[0] ?? 'nothing I can describe'}.`;
    return `I see ${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
  },
  /** A model summary, normalized to one sentence with a final period. */
  summary: (text: string) => {
    const trimmed = text.trim();
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
  },
  /** Said at once for "what's around me"; the answer follows when Spark replies. */
  describeAck: () => 'Let me look.',
  /** Reply to "what's around me" when there is nothing to say. */
  nothingNotable: () => "I can't make out anything to describe right now.",
  updatesPaused: () => 'Updates paused. To hear them again, say resume.',
  // Not "Updates on.": that is a voice command, and the microphone hears HeyNavi.
  updatesResumed: () => 'Updates are back on.',
  updatesAlreadyOn: () => 'Updates are already on.',
  // No "fewer updates" / "more updates" in them: those are voice commands.
  verbosity: (v: Verbosity) =>
    ({
      quiet: "Okay. I'll only mention important things.",
      normal: "Okay. I'll mention new things as usual.",
      detailed: "Okay. I'll mention more of what I see.",
    })[v],
  verbosityLimit: (v: Verbosity) =>
    v === 'quiet' ? 'Updates are already at the fewest.' : 'Updates are already at the most.',
  ui: {
    // VoiceOver reads these aloud and the microphone hears it, so none is a voice command and
    // none starts with "stop" (an interim "stop" cuts speech off).
    observing: 'Observing',
    paused: 'Observing paused',
    searching: 'Searching',
    starting: 'Starting the camera',
    verbosity: (v: Verbosity) => ({ quiet: 'Update level: few', normal: 'Update level: normal', detailed: 'Update level: many' })[v],
    pauseButton: 'Pause observing',
    pauseHint: 'Keeps quiet about the scene and stops looking until you resume. You can also say pause.',
    resumeButton: 'Resume observing',
    resumeHint: 'Looks again and mentions what the camera notices. You can also say resume.',
    describeButton: 'Describe the view',
    describeHint: 'Describes what the camera sees now. You can also ask what is around you.',
    lastSaid: 'Last said',
  },
} as const;

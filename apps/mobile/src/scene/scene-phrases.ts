/**
 * What HeyNavi says about the scene (ARCHITECTURE 6.3). Proactive lines are templates filled
 * with validated labels and camera-relative positions, never the model's free text; only the
 * summary sentence comes from the model, after two wording filters. Same voice-audit rules as
 * agent/phrases.ts: no line or clause may parse as a command, and no wake word
 * (scene-phrases.test.ts).
 */
import { isPluralOnly, pluralLabel, withArticle } from '../agent/phrases.ts';
import type { Position } from '../agent/types.ts';
import type { Band, HoldFrame, SceneItem, Verbosity } from './types.ts';

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

/** User-relative directions, used only while the phone is held upright and level. */
const AHEAD: Record<Position, string> = {
  left: 'ahead on your left',
  center: 'directly ahead',
  right: 'ahead on your right',
};

/**
 * Where something is, in words. "forward": the phone is held upright and level, so the camera's
 * left is the user's left ("ahead on your left"). Otherwise relative to the camera view, with
 * its vertical third ("in the lower center of the camera view"). Never a distance.
 */
export function direction(position: Position, band: Band, frame: HoldFrame): string {
  return frame === 'forward' ? AHEAD[position] : where(position, band);
}

type Describable = Pick<SceneItem, 'label' | 'count' | 'position' | 'band'>;

/** Nouns that read as a distance with a number in front ("3 steps"): their count is not said. */
const NO_COUNT = new Set(['step', 'stair', 'block', 'pace']);
/** Things that are not counted: "some clothing", never "3 clothings". */
const MASS = new Set(['clothing', 'clothes', 'laundry', 'trash', 'garbage', 'rubbish', 'furniture', 'luggage', 'equipment', 'debris', 'clutter', 'water', 'paper', 'mail']);
/** Already plural as Spark names them ("steps", "stairs"). */
const PLURAL_LABELS = new Set(['steps', 'stairs', 'clothes', 'shoes']);

function noun(item: Pick<SceneItem, 'label' | 'count'>): { text: string; plural: boolean } {
  const last = item.label.split(' ').pop() ?? item.label;
  if (MASS.has(last)) return { text: `some ${item.label}`, plural: last === 'clothes' };
  if (isPluralOnly(item.label) || PLURAL_LABELS.has(last)) return { text: isPluralOnly(item.label) ? pluralLabel(item.label) : item.label, plural: true };
  if (item.count > 1) {
    const plural = pluralLabel(item.label);
    return { text: NO_COUNT.has(item.label) ? plural : `${item.count} ${plural}`, plural: true };
  }
  return { text: withArticle(item.label), plural: false };
}

/** "a chair in the lower center of the camera view", "2 people ahead on your left". */
export function itemPhrase(item: Describable, frame: HoldFrame = 'camera'): string {
  return `${noun(item).text} ${direction(item.position, item.band, frame)}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Where something is, for the "is visible" and hedged lines. Held forward: "ahead",
 * "ahead on your left", and "on the floor ahead" for a possible obstacle low in the view.
 * Otherwise relative to the camera view.
 */
function visibleWhere(item: Describable & { kind?: SceneItem['kind'] }, frame: HoldFrame): string {
  if (frame !== 'forward') return where(item.position, item.band);
  const side = item.position === 'center' ? 'ahead' : `ahead on your ${item.position}`;
  return item.kind === 'possible_obstacle' && item.band === 'lower' ? `on the floor ${side}` : side;
}

export const scenePhrases = {
  /** Spoken when exploring starts; the first look follows a few seconds later. */
  exploreStart: () => "I'm looking around. I'll tell you what I notice.",
  /** "There's a chair ahead on your left." / "There are stairs directly ahead." */
  item: (item: Describable, frame: HoldFrame = 'camera') => {
    const n = noun(item);
    return `${n.plural ? 'There are' : "There's"} ${n.text} ${direction(item.position, item.band, frame)}.`;
  },
  /** "A bag is visible on the floor ahead." "Steps are visible ahead." "A person is visible ahead on your right." */
  visible: (item: Describable & { kind?: SceneItem['kind'] }, frame: HoldFrame = 'camera') => {
    const n = noun(item);
    return `${capitalize(n.text)} ${n.plural ? 'are' : 'is'} visible ${visibleWhere(item, frame)}.`;
  },
  /** Spark saw it but SAM could not localize it: a hedged observation, never a confirmed one. */
  uncertain: (item: Describable & { kind?: SceneItem['kind'] }, frame: HoldFrame = 'camera') =>
    `There may be ${noun(item).text} ${visibleWhere(item, frame)}.`,
  /** Two confirmed hazards in one sentence. */
  obstacles: (items: readonly Describable[], frame: HoldFrame = 'camera') =>
    `Possible obstacles: ${items.map((i) => itemPhrase(i, frame)).join(', and ')}.`,
  /** Only for a hazard SAM confirmed (ARCHITECTURE 5.2). */
  obstacle: (item: Describable, frame: HoldFrame = 'camera') => `Possible obstacle: ${itemPhrase(item, frame)}.`,
  /** A sign or poster with readable text. `text` must already have passed the filters. */
  text: (item: Describable, text: string, frame: HoldFrame = 'camera') =>
    `${capitalize(itemPhrase(item, frame))}. It reads: ${text}.`,
  textUnreadable: (item: Describable, frame: HoldFrame = 'camera') =>
    `There's ${noun(item).text} with some text ${direction(item.position, item.band, frame)}.`,
  /** One sentence listing a few items: "There's a door …, and a chair …". */
  items: (items: readonly Describable[], frame: HoldFrame = 'camera') => {
    const parts = items.map((i) => itemPhrase(i, frame));
    if (parts.length === 0) return 'There is nothing I can describe.';
    const lead = noun(items[0]).plural ? 'There are' : "There's";
    if (parts.length === 1) return `${lead} ${parts[0]}.`;
    return `${lead} ${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}.`;
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

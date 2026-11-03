/**
 * Text for the decision panel (ARCHITECTURE 3.3): the latest look as the three steps of the
 * agent loop, Muse Spark saw, SAM 3.1 checked, HeyNavi decided. Pure, so it runs under
 * `node --test`.
 */
import type { DecisionNote } from '../scene/attention-policy.ts';
import type { LastLook, LookItem } from '../scene/scene-controller.ts';
import type { SceneChange, SceneKind } from '../scene/types.ts';

const KIND_NAME: Record<SceneKind, string> = {
  possible_obstacle: 'obstacle',
  level_change: 'level change',
  overhead: 'overhead',
  person: 'person',
  landmark: 'landmark',
  text: 'sign',
  object: 'object',
};

const CHANGE_NAME: Record<SceneChange, string> = { none: 'same view', minor: 'small change', major: 'new view' };

/** Why a look ended without a line. None of these starts with a command word. */
const HELD_BACK: Partial<Record<DecisionNote, string>> = {
  'nothing-new': 'Nothing new to mention',
  gap: 'Held back: it spoke moments ago',
  rate: 'Held back: enough lines this minute',
  unspeakable: 'Held back by the wording filter',
};

export function seconds(ms: number | null): string {
  return ms == null ? '–' : `${(ms / 1000).toFixed(1)} s`;
}

export type PanelItem = {
  label: string;
  detail: string;
  sam: LookItem['sam'];
  samText: string;
  /** Relevant to walking: HeyNavi may mention it on its own. */
  considered: boolean;
};

export function panelItems(look: LastLook): PanelItem[] {
  return look.items.map((i) => ({
    label: i.count > 1 ? `${i.label} ×${i.count}` : i.label,
    detail: `${KIND_NAME[i.kind]} · ${i.importance}`,
    sam: i.sam,
    samText:
      i.sam === 'found'
        ? i.confidence == null
          ? 'found'
          : `${Math.round(i.confidence * 100)}%`
        : i.sam === 'missed'
          ? 'not found'
          : 'not checked',
    considered: i.considered,
  }));
}

export function samTally(look: LastLook): string {
  const checked = look.items.filter((i) => i.sam !== 'unchecked');
  if (checked.length === 0) return 'nothing checked';
  return `${checked.filter((i) => i.sam === 'found').length} of ${checked.length} found`;
}

export function sparkMeta(look: LastLook): string {
  return `${seconds(look.sparkMs)} · ${CHANGE_NAME[look.change]}`;
}

/** What HeyNavi did with the look: the line it queued, or why it held back. */
export function decision(look: LastLook): { spoke: boolean; text: string } {
  if (look.said) return { spoke: true, text: look.said };
  return { spoke: false, text: HELD_BACK[look.note] ?? 'Nothing to mention' };
}

export function footer(look: LastLook, remembered: number, told: number): string {
  return `Look ${look.frame} · ${seconds(look.totalMs)} photo to decision · remembers ${remembered}, told ${told} · $${look.costUsd.toFixed(4)}`;
}

/**
 * The whole panel as one VoiceOver element. It starts with a fixed name and never contains the
 * wake word, so the microphone hearing VoiceOver cannot take it for a command.
 */
export function panelLabel(look: LastLook | null, remembered: number, told: number): string {
  if (!look) return 'Decision panel. Waiting for the first look.';
  const items = panelItems(look)
    .map((i) => `${i.label}, ${i.detail}, ${i.sam === 'found' ? 'checked and found' : i.samText}`)
    .join('; ');
  const { spoke, text } = decision(look);
  return [
    'Decision panel',
    `Spark saw ${items || 'nothing to list'}`,
    `SAM: ${samTally(look)}`,
    spoke ? `Said: ${text}` : text,
    footer(look, remembered, told).replace(/·/g, ','),
  ].join('. ');
}

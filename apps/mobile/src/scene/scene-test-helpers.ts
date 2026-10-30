/** Builders shared by the scene tests (imported only from *.test.ts files). */
import type { SceneItem } from './types.ts';

export function sceneItem(label: string, overrides: Partial<SceneItem> = {}): SceneItem {
  return {
    label,
    count: 1,
    kind: 'object',
    position: 'center',
    band: 'middle',
    status: 'new',
    importance: 'medium',
    ground: label,
    text: null,
    grounded: true,
    detections: [],
    ...overrides,
  };
}

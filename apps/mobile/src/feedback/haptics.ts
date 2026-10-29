import * as Haptics from 'expo-haptics';

import type { HapticKind } from '@/agent/types';

/** found: success notification; centered: one light tap. Failures (no Taptic Engine) are ignored. */
export function playHaptic(kind: HapticKind): void {
  const played =
    kind === 'found'
      ? Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  played.catch(() => {});
}

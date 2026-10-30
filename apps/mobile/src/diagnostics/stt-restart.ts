/**
 * Auto-restart policy for the speech recognition test. The implementation moved to
 * src/voice/restart-policy.ts so the live listener and this test share one policy.
 */
export {
  BUSY_BASE_DELAY_MS,
  BUSY_MAX_DELAY_MS,
  MAX_ERROR_STREAK,
  RESTART_BASE_DELAY_MS,
  RESTART_MAX_DELAY_MS,
  isSelfInflictedAbort,
  nextErrorStreak,
  restartDelayMs,
} from '../voice/restart-policy.ts';

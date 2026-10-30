import { makeMutable } from 'react-native-reanimated';

/**
 * The microphone input level, 0..1, readable on the UI thread: the HeyNavi symbol's listening
 * ripple follows it. Updated from the recognizer's volume events (about 3 a second while
 * listening); 0 when listening ends.
 */
export const micLevelValue = makeMutable(0);

/** `volume` is expo-speech-recognition's level, -2..10 (below 0 is inaudible). */
export function setMicVolume(volume: number): void {
  micLevelValue.value = Math.min(1, Math.max(0, volume / 8));
}

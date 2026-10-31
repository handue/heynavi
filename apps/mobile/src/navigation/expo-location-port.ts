import type { LocationPort } from '@/navigation/navigation-controller';

/**
 * expo-location for navigation: position about once a second at navigation accuracy, and the
 * compass heading while it is calibrated (level 2 or 3 of 3). Loaded lazily: a build without the
 * native module (an older dev client) gets null, and navigation says it is unavailable.
 */
export function createExpoLocationPort(): LocationPort | null {
  let Location: typeof import('expo-location');
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    Location = require('expo-location') as typeof import('expo-location');
  } catch {
    return null;
  }
  return {
    async requestPermission() {
      const current = await Location.getForegroundPermissionsAsync();
      if (current.granted) return true;
      if (!current.canAskAgain) return false;
      return (await Location.requestForegroundPermissionsAsync()).granted;
    },
    async watch(onFix, onHeading) {
      const position = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        (location) =>
          onFix({
            at: performance.now(),
            point: { lat: location.coords.latitude, lon: location.coords.longitude },
            accuracyM: location.coords.accuracy ?? null,
          }),
      );
      const heading = await Location.watchHeadingAsync((h) => {
        const degrees = h.trueHeading >= 0 ? h.trueHeading : h.magHeading;
        onHeading(h.accuracy >= 2 && degrees >= 0 ? degrees : null);
      }).catch(() => null);
      return () => {
        position.remove();
        heading?.remove();
      };
    },
  };
}

import { requireOptionalNativeModule } from 'expo';

/** A place from MapKit search. */
export type MapPlace = { name: string; address: string; latitude: number; longitude: number };

/** One step of a walking route: MapKit's instruction for where the step starts, and its line. */
export type MapStep = { instructions: string; notice: string; distance: number; points: [number, number][] };

export type MapRoute = { distance: number; expectedTravelTime: number; steps: MapStep[] };

export type MapAddress = { name?: string; street?: string; area?: string; city?: string };

type NativeMaps = {
  searchPlaces(query: string, latitude: number, longitude: number, radiusMeters: number): Promise<MapPlace[]>;
  walkingRoute(fromLatitude: number, fromLongitude: number, toLatitude: number, toLongitude: number): Promise<MapRoute>;
  reverseGeocode(latitude: number, longitude: number): Promise<MapAddress>;
};

/**
 * Apple MapKit on the phone (modules/heynavi-maps/ios). Null in a build without the native
 * module (an older dev client): navigation then says it is unavailable.
 */
export const HeynaviMaps = requireOptionalNativeModule<NativeMaps>('HeynaviMaps');

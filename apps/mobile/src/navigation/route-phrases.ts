import { analyze, parse } from '../voice/command-grammar.ts';
import { turnDeg } from './geo.ts';
import type { Maneuver, RouteStep } from './route.ts';

/**
 * Everything HeyNavi says about a walking route (ARCHITECTURE 8). Distances come from the map,
 * are always "about" and rounded to 10 m; nothing says a way is safe or clear. MapKit's
 * instruction text is used as given unless it would command HeyNavi or contains the wake word,
 * then a plain one is said instead.
 */

/** "about 40 meters", "about 1.2 kilometers", "a few meters". */
export function aboutDistance(meters: number): string {
  if (meters < 10) return 'a few meters';
  if (meters < 995) return `about ${Math.round(meters / 10) * 10} meters`;
  return `about ${(Math.round(meters / 100) / 10).toFixed(1).replace(/\.0$/, '')} kilometers`;
}

const PLAIN: Record<Maneuver, string> = {
  left: 'Turn left',
  right: 'Turn right',
  'slight-left': 'Bear left',
  'slight-right': 'Bear right',
  'sharp-left': 'Turn sharply left',
  'sharp-right': 'Turn sharply right',
  'u-turn': 'Turn around',
  straight: 'Continue straight',
  arrive: 'The destination is ahead',
};

/** Map text HeyNavi may say: short, not a command, no wake word. */
function speakable(text: string): boolean {
  return text.length > 0 && text.length <= 120 && parse(text) == null && !analyze(text).wake && !/\bnav(i|y)\b/i.test(text);
}

/** MapKit's instruction, unless it would command HeyNavi; without a trailing period. */
export function instructionText(step: RouteStep): string {
  const text = step.instruction.replace(/[.\s]+$/, '');
  return speakable(text) ? text : PLAIN[step.maneuver];
}

/** "In about 40 meters, turn right onto Sejong-daero." */
function inDistance(meters: number, step: RouteStep): string {
  const text = instructionText(step);
  return `In ${aboutDistance(meters)}, ${text.charAt(0).toLowerCase()}${text.slice(1)}.`;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/**
 * Which way the route leaves: relative to where the phone faces when the heading is good, else a
 * compass direction.
 */
export function startDirection(startBearingDeg: number | null, headingDeg: number | null, street: string | null = null): string | null {
  if (startBearingDeg == null) return null;
  const on = street && speakable(street) ? `, on ${street}` : '';
  if (headingDeg == null) return `Head ${COMPASS[Math.round(startBearingDeg / 45) % 8]}${on.replace(',', '')}.`;
  const turn = turnDeg(headingDeg, startBearingDeg);
  if (Math.abs(turn) <= 30) return `The route starts ahead of you${on}.`;
  if (Math.abs(turn) >= 150) return `The route starts behind you${on}.`;
  return `The route starts to your ${turn > 0 ? 'right' : 'left'}${on}.`;
}

/** Short meters for the route card ("40 m", "1.2 km"). */
export function shortDistance(meters: number): string {
  if (meters < 10) return 'a few m';
  if (meters < 995) return `${Math.round(meters / 10) * 10} m`;
  return `${(Math.round(meters / 100) / 10).toFixed(1).replace(/\.0$/, '')} km`;
}

export const routePhrases = {
  /**
   * Route card strings. VoiceOver reads them aloud and the microphone hears VoiceOver, so none is
   * a voice command: the close button is not "End route" (that one ends the route by voice).
   */
  ui: {
    locating: 'Finding your location…',
    searching: (query: string) => `Looking for ${query}…`,
    routing: 'Getting a walking route…',
    rerouting: 'Recalculating the route…',
    arrived: (place: string) => `Near ${place}`,
    fromMap: 'According to the map',
    weakGps: 'Weak GPS signal',
    inAbout: (meters: number) => `In about ${shortDistance(meters)}`,
    left: (meters: number, place: string) => `${shortDistance(meters)} to ${place}`,
    closeButton: 'Close route guidance',
    closeHint: 'Ends the walking directions. The camera keeps running.',
  },

  unavailable: () => "Walking directions aren't available in this version of HeyNavi.",
  locationDenied: () => 'Location access is off. To get walking directions, allow it in Settings, HeyNavi, Location.',
  locating: () => 'Finding your location.',
  noLocation: () => "I can't get your location right now. The GPS works best outdoors.",
  searching: (query: string) => `Looking for ${query} on the map.`,
  notFound: (query: string) => `I couldn't find ${query} nearby on the map.`,
  noRoute: (place: string) => `The map has no walking route to ${place}.`,
  failed: () => "I couldn't get a route from the map. Please try again.",
  /** "Route to Starbucks: about 450 meters, 3 turns. The route starts to your left. In about 20 meters, turn right." */
  start: (place: string, lengthM: number, turns: number, direction: string | null, first: { step: RouteStep; inM: number } | null) =>
    [
      `Route to ${place}: ${aboutDistance(lengthM)}, ${turns === 0 ? 'no turns' : turns === 1 ? '1 turn' : `${turns} turns`}.`,
      direction,
      first ? inDistance(first.inM, first.step) : null,
    ]
      .filter(Boolean)
      .join(' '),
  prepare: (step: RouteStep, inM: number) => inDistance(inM, step),
  /** "Now, turn right onto Sejong-daero. Then, in about 30 meters, turn left." */
  step: (step: RouteStep, then: { step: RouteStep; inM: number } | null) => {
    const text = instructionText(step);
    const now = `Now, ${text.charAt(0).toLowerCase()}${text.slice(1)}.`;
    return then ? `${now} Then, ${inDistance(then.inM, then.step).replace(/^In/, 'in')}` : now;
  },
  /** "what's next" */
  next: (step: RouteStep | null, inM: number | null, place: string, leftM: number | null) =>
    [
      step == null ? null : inM == null ? `Next: ${instructionText(step)}.` : `Next: ${inDistance(inM, step).replace(/^In/, 'in')}`,
      leftM == null ? null : `${aboutDistance(leftM).replace(/^about/, 'About')} to ${place}.`,
    ]
      .filter(Boolean)
      .join(' ') || `Following the route to ${place}.`,
  weakGps: () => "The GPS signal is weak, so I can't place you on the route right now.",
  offRoute: () => 'You may be off the route. Recalculating.',
  rerouted: (lengthM: number) => `New route: ${aboutDistance(lengthM)}.`,
  arrived: (place: string) => `You're near ${place}, according to the map. The route has ended.`,
  ended: () => 'Route ended.',
  notNavigating: () => 'No route is active. Ask me for directions to a place.',
  /** "where am I": the street and area, from the map. */
  whereAmI: (address: { street?: string; area?: string; city?: string; name?: string }, route: { place: string; leftM: number | null } | null) => {
    const where = address.street
      ? `You're on ${address.street}${address.area ? ` in ${address.area}` : address.city ? ` in ${address.city}` : ''}, according to the map.`
      : address.area || address.city
        ? `You're in ${address.area || address.city}, according to the map.`
        : "I couldn't tell which street you're on.";
    return route && route.leftM != null ? `${where} ${aboutDistance(route.leftM).replace(/^about/, 'About')} to ${route.place}.` : where;
  },
};

/**
 * Last check before anything about the camera view is spoken (ARCHITECTURE 6.3). The backend
 * runs the same rules (backend/app/wording.py); this copy also guards the app's own templates
 * filled with model labels, and adds the voice-audit rules: HeyNavi must never say the wake
 * word or a line (or clause) that parses as one of its own commands.
 */
import { analyze, parse } from '../voice/command-grammar.ts';

const UNITS =
  '(?:m|cm|mm|km|meters?|metres?|centimeters?|centimetres?|kilometers?|kilometres?|' +
  'feet|foot|ft|inch(?:es)?|yards?|yd|steps?|paces?|blocks?)';
// No bare "a": "a step" or "a block" names an object; "a meter" is caught by the next rule.
const NUMBER = '(?:\\d+(?:[.,]\\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|a few|few|several|half a)';

const RULES: readonly (readonly [string, RegExp])[] = [
  ['distance', new RegExp(`\\b${NUMBER}[\\s-]*${UNITS}\\b`)],
  ['distance', /\b(?:meters?|metres?|feet|yards?|inches|centimeters?|centimetres?)\b/],
  ['distance', /\b(?:arm'?s length|within reach|steps? (?:ahead|away|forward|in front))\b/],
  ['safety', /\b(?:safe|safely|safety|unsafe|danger(?:ous)?|hazard(?:ous)?|harmless)\b/],
  [
    'safety',
    /\b(?:all clear|clear (?:path|way|route|walkway)|(?:path|way|route|walkway|road|floor|sidewalk)(?: \w+){0,2} (?:is|looks|seems|appears) (?:clear|free|open|empty)|clear ahead|no obstacles?|nothing (?:is )?in (?:your|the) way|unobstructed|obstacle[- ]free|free of obstacles)\b/,
  ],
  [
    'permission',
    /\b(?:you (?:can|could|may|should|must|need to|have to|'ll be able to) (?:walk|go|cross|proceed|move|continue|pass|step|turn)|go ahead|it'?s (?:fine|okay|ok) to)\b/,
  ],
  [
    'direction',
    /(?:^|[.!?;]\s*)(?:please\s+)?(?:walk|turn|step|move|go|head|proceed|cross|keep|stop|watch out|be careful|careful|avoid|veer|wait)\b/,
  ],
  ['signal', /\b(?:green|red|amber|yellow) (?:light|signal|man)\b/],
  [
    'signal',
    /\b(?:light|signal|traffic light|crossing light|pedestrian light) (?:is|turned|shows|says) (?:green|red|amber|yellow|walk|on|off)\b|\bwalk signal\b/,
  ],
  ['wake_word', /\bnav(?:i|y|vy|ie)\b/],
];

/** The first rule `text` breaks, or null when it may be spoken as a camera observation. */
export function checkCameraText(text: string): string | null {
  const lowered = text.toLowerCase().replace(/[‘’ʼ]/g, "'");
  for (const [reason, pattern] of RULES) {
    if (pattern.test(lowered)) return reason;
  }
  return null;
}

/** The recognizer may cut a line into segments at any pause: sentences and clauses. */
export function clauses(line: string): string[] {
  return line
    .split(/[.,:;!?]/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * Why a line built from model output must not be spoken, or null when it may be. Besides the
 * wording rules, no clause may be a voice command ("It reads: Stop.") and the line may not
 * contain the wake word, because the microphone hears HeyNavi through the loudspeaker.
 */
export function unspeakableReason(line: string): string | null {
  const wording = checkCameraText(line);
  if (wording) return wording;
  if (analyze(line).wake) return 'wake_word';
  if (parse(line) != null || clauses(line).some((c) => parse(c) != null)) return 'command';
  return null;
}

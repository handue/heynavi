/**
 * Every user-facing sentence, in en-US and ko-KR. Positions are relative to the camera view and
 * size is only "looks close / far away": never meters, steps, or claims that something is safe.
 */
import type { Lang, Position, SearchStatus } from './types.ts';

export type ConceptId = 'chair' | 'cup' | 'bottle' | 'door' | 'person' | 'bag';

type ConceptLabels = { en: string; enPlural: string; ko: string; /** Korean counter word. */ koCounter: string };

/** SAM English noun -> labels. Order is the order shown in the concept chooser. */
export const CONCEPTS: Record<ConceptId, ConceptLabels> = {
  chair: { en: 'chair', enPlural: 'chairs', ko: '의자', koCounter: '개' },
  cup: { en: 'cup', enPlural: 'cups', ko: '컵', koCounter: '개' },
  bottle: { en: 'bottle', enPlural: 'bottles', ko: '병', koCounter: '개' },
  door: { en: 'door', enPlural: 'doors', ko: '문', koCounter: '개' },
  person: { en: 'person', enPlural: 'people', ko: '사람', koCounter: '명' },
  bag: { en: 'bag', enPlural: 'bags', ko: '가방', koCounter: '개' },
};

export const CONCEPT_IDS = Object.keys(CONCEPTS) as ConceptId[];

export function isConceptId(value: string): value is ConceptId {
  return Object.hasOwn(CONCEPTS, value);
}

/** Unknown concepts (a future free-form goal) fall back to the English noun itself. */
function labels(concept: string): ConceptLabels {
  return isConceptId(concept)
    ? CONCEPTS[concept]
    : { en: concept, enPlural: `${concept}s`, ko: concept, koCounter: '개' };
}

export function conceptLabel(concept: string, lang: Lang): string {
  const l = labels(concept);
  return lang === 'ko-KR' ? l.ko : l.en;
}

// --- Korean particles -------------------------------------------------------------------------

/** True when the last Hangul syllable has a final consonant; null when it is not Hangul. */
export function hasBatchim(word: string): boolean | null {
  const trimmed = word.trimEnd();
  const code = trimmed.charCodeAt(trimmed.length - 1);
  if (!(code >= 0xac00 && code <= 0xd7a3)) return null;
  return (code - 0xac00) % 28 !== 0;
}

export type JosaPair = '을/를' | '이/가' | '은/는' | '과/와';

/** Word + particle: 의자를, 컵을, 의자가, 컵이. Non-Hangul endings get both forms: "TV을(를)". */
export function josa(word: string, pair: JosaPair): string {
  const [afterConsonant, afterVowel] = pair.split('/');
  const batchim = hasBatchim(word);
  if (batchim == null) return `${word}${afterConsonant}(${afterVowel})`;
  return word + (batchim ? afterConsonant : afterVowel);
}

// --- English helpers --------------------------------------------------------------------------

function withArticle(noun: string): string {
  return `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`;
}

export type SizeHint = 'close' | 'far' | null;

export type ErrorKind =
  | 'network'
  | 'slow'
  | 'unauthorized'
  | 'notConfigured'
  | 'cantAnalyze'
  | 'server'
  | 'camera';

export type Phrasebook = {
  start(concept: string): string;
  found(concept: string, position: Position, size: SizeHint): string;
  foundMany(concept: string, count: number, position: Position, size: SizeHint): string;
  guide(position: Position): string;
  lost(concept: string): string;
  coaching(concept: string, attempt: number): string;
  checkIn(concept: string): string;
  resume(concept: string): string;
  stop(): string;
  error(kind: ErrorKind): string;
  reconnected(): string;
  ui: {
    status(status: SearchStatus): string;
    startButton(concept: string): string;
    stopButton: string;
    conceptGroup: string;
    languageGroup: string;
  };
};

const EN_WHERE: Record<Position, string> = {
  left: 'on the left',
  center: 'in the center',
  right: 'on the right',
};

const EN_SIZE: Record<'close' | 'far', string> = {
  close: 'It looks close.',
  far: 'It looks far away.',
};

const EN_TIPS = ['Try turning slowly.', 'Try tilting the phone up or down a little.'];

const en: Phrasebook = {
  start: (c) => `Looking for ${withArticle(labels(c).en)}. Move your phone slowly.`,
  found: (c, p, size) =>
    `I found ${withArticle(labels(c).en)}, ${EN_WHERE[p]} of the camera view.` +
    (size ? ` ${EN_SIZE[size]}` : ''),
  foundMany: (c, n, p, size) =>
    `I see ${n} ${labels(c).enPlural}. The largest is ${EN_WHERE[p]}.` +
    (size ? ` ${EN_SIZE[size]}` : ''),
  guide: (p) => (p === 'center' ? 'Centered.' : `Now ${EN_WHERE[p]}.`),
  lost: (c) => `I lost sight of the ${labels(c).en}. Still looking.`,
  coaching: (c, attempt) =>
    `Still looking for ${withArticle(labels(c).en)}. ${EN_TIPS[attempt % EN_TIPS.length]}`,
  checkIn: (c) =>
    `I haven't found ${withArticle(labels(c).en)} in the last minute. ` +
    'Keep moving slowly, or tap Stop searching to end.',
  resume: (c) => `Looking for ${withArticle(labels(c).en)} again.`,
  stop: () => 'Stopped searching.',
  error: (kind) =>
    ({
      network: "I can't reach the HeyNavi server. I'll keep trying.",
      slow: "The HeyNavi server is slow to answer. I'll keep trying.",
      unauthorized: "The HeyNavi server didn't accept this app. Check the app token.",
      notConfigured: "The HeyNavi server isn't set up yet. I'll keep trying.",
      cantAnalyze: "I can't analyze this view. Try pointing the camera somewhere else.",
      server: "The HeyNavi server had a problem. I'll keep trying.",
      camera: "I can't get a picture from the camera. I'll keep trying.",
    })[kind],
  reconnected: () => 'Connected again.',
  ui: {
    status: (s) =>
      ({
        IDLE: 'Ready',
        SEARCHING: 'Searching',
        CONFIRMING: 'Checking',
        FOUND: 'Found',
        GUIDING: 'Guiding',
        LOST: 'Lost',
        PAUSED: 'Paused',
        CANCELLED: 'Stopped',
      })[s],
    startButton: (c) => `Start searching for ${withArticle(labels(c).en)}`,
    stopButton: 'Stop searching',
    conceptGroup: 'Object to find',
    languageGroup: 'Language',
  },
};

const KO_WHERE: Record<Position, string> = { left: '왼쪽', center: '가운데', right: '오른쪽' };

const KO_SIZE: Record<'close' | 'far', string> = {
  close: '가까이 있는 것 같아요.',
  far: '멀리 있는 것 같아요.',
};

const KO_TIPS = ['천천히 돌려 보세요.', '휴대폰을 위아래로 조금 기울여 보세요.'];

const ko: Phrasebook = {
  start: (c) => `${josa(labels(c).ko, '을/를')} 찾을게요. 휴대폰을 천천히 움직여 주세요.`,
  found: (c, p, size) =>
    `${josa(labels(c).ko, '을/를')} 찾았어요. 화면 ${KO_WHERE[p]}에 있어요.` +
    (size ? ` ${KO_SIZE[size]}` : ''),
  foundMany: (c, n, p, size) =>
    `${josa(labels(c).ko, '이/가')} ${n}${labels(c).koCounter} 보여요. 가장 큰 것은 화면 ${KO_WHERE[p]}에 있어요.` +
    (size ? ` ${KO_SIZE[size]}` : ''),
  guide: (p) => (p === 'center' ? '가운데에 있어요.' : `이제 ${KO_WHERE[p]}에 있어요.`),
  lost: (c) => `${josa(labels(c).ko, '이/가')} 화면에서 사라졌어요. 계속 찾을게요.`,
  coaching: (c, attempt) =>
    `아직 ${josa(labels(c).ko, '을/를')} 찾고 있어요. ${KO_TIPS[attempt % KO_TIPS.length]}`,
  checkIn: (c) =>
    `1분 동안 ${josa(labels(c).ko, '을/를')} 찾지 못했어요. ` +
    '계속 천천히 움직이거나, 끝내려면 찾기 멈추기 버튼을 눌러 주세요.',
  resume: (c) => `다시 ${josa(labels(c).ko, '을/를')} 찾을게요.`,
  stop: () => '찾기를 멈췄어요.',
  error: (kind) =>
    ({
      network: '헤이나비 서버에 연결할 수 없어요. 계속 시도할게요.',
      slow: '헤이나비 서버 응답이 늦어요. 계속 시도할게요.',
      unauthorized: '헤이나비 서버가 이 앱을 허용하지 않았어요. 앱 토큰을 확인해 주세요.',
      notConfigured: '헤이나비 서버가 아직 준비되지 않았어요. 계속 시도할게요.',
      cantAnalyze: '이 화면은 분석할 수 없어요. 카메라를 다른 곳으로 돌려 보세요.',
      server: '헤이나비 서버에 문제가 생겼어요. 계속 시도할게요.',
      camera: '카메라에서 사진을 가져올 수 없어요. 계속 시도할게요.',
    })[kind],
  reconnected: () => '다시 연결됐어요.',
  ui: {
    status: (s) =>
      ({
        IDLE: '대기',
        SEARCHING: '찾는 중',
        CONFIRMING: '확인 중',
        FOUND: '찾음',
        GUIDING: '안내 중',
        LOST: '놓침',
        PAUSED: '일시 정지',
        CANCELLED: '멈춤',
      })[s],
    startButton: (c) => `${labels(c).ko} 찾기 시작`,
    stopButton: '찾기 멈추기',
    conceptGroup: '찾을 물건',
    languageGroup: '언어',
  },
};

export const PHRASES: Record<Lang, Phrasebook> = { 'en-US': en, 'ko-KR': ko };

export function phrases(lang: Lang): Phrasebook {
  return PHRASES[lang];
}

/// <reference types="node" />
// Run from apps/mobile: node --test 'src/**/*.test.ts'
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CONCEPTS,
  CONCEPT_IDS,
  PHRASES,
  conceptLabel,
  hasBatchim,
  josa,
  phrases,
  type ErrorKind,
} from './phrases.ts';
import type { Position, SearchStatus } from './types.ts';

describe('hasBatchim / josa', () => {
  it('reads the final consonant of the last Hangul syllable', () => {
    assert.equal(hasBatchim('의자'), false);
    assert.equal(hasBatchim('컵'), true);
    assert.equal(hasBatchim('가방'), true);
    assert.equal(hasBatchim('사람'), true);
    assert.equal(hasBatchim('병 '), true, 'trailing space ignored');
    assert.equal(hasBatchim('TV'), null);
    assert.equal(hasBatchim(''), null);
  });

  it('chooses 을/를 and 이/가 by the final consonant', () => {
    assert.equal(josa('의자', '을/를'), '의자를');
    assert.equal(josa('컵', '을/를'), '컵을');
    assert.equal(josa('문', '을/를'), '문을');
    assert.equal(josa('의자', '이/가'), '의자가');
    assert.equal(josa('병', '이/가'), '병이');
    assert.equal(josa('사람', '은/는'), '사람은');
    assert.equal(josa('TV', '을/를'), 'TV을(를)');
  });
});

describe('concepts', () => {
  it('has the six VS-1 concepts with Korean labels', () => {
    assert.deepEqual(CONCEPT_IDS, ['chair', 'cup', 'bottle', 'door', 'person', 'bag']);
    assert.deepEqual(
      CONCEPT_IDS.map((c) => conceptLabel(c, 'ko-KR')),
      ['의자', '컵', '병', '문', '사람', '가방'],
    );
    assert.equal(conceptLabel('cup', 'en-US'), 'cup');
    assert.equal(conceptLabel('umbrella', 'ko-KR'), 'umbrella', 'unknown concepts fall back to the noun');
    assert.equal(CONCEPTS.person.enPlural, 'people');
  });
});

describe('English phrases', () => {
  const en = phrases('en-US');

  it('matches the specified lines', () => {
    assert.equal(en.start('chair'), 'Looking for a chair. Move your phone slowly.');
    assert.equal(en.found('chair', 'left', null), 'I found a chair, on the left of the camera view.');
    assert.equal(en.lost('chair'), 'I lost sight of the chair. Still looking.');
    assert.equal(en.coaching('chair', 0), 'Still looking for a chair. Try turning slowly.');
    assert.equal(en.stop(), 'Stopped searching.');
    assert.equal(en.error('network'), "I can't reach the HeyNavi server. I'll keep trying.");
  });

  it('describes several instances and size', () => {
    assert.equal(en.foundMany('chair', 2, 'center', null), 'I see 2 chairs. The largest is in the center.');
    assert.equal(
      en.foundMany('person', 3, 'right', 'close'),
      'I see 3 people. The largest is on the right. It looks close.',
    );
    assert.equal(
      en.found('bottle', 'center', 'far'),
      'I found a bottle, in the center of the camera view. It looks far away.',
    );
  });

  it('guides by camera-view position', () => {
    assert.deepEqual(
      (['left', 'center', 'right'] as Position[]).map(en.guide),
      ['Now on the left.', 'Centered.', 'Now on the right.'],
    );
  });

  it('labels the toggle button', () => {
    assert.equal(en.ui.startButton('chair'), 'Start searching for a chair');
    assert.equal(en.ui.stopButton, 'Stop searching');
  });
});

describe('Korean phrases', () => {
  const ko = phrases('ko-KR');

  it('matches the specified lines', () => {
    assert.equal(ko.start('chair'), '의자를 찾을게요. 휴대폰을 천천히 움직여 주세요.');
    assert.equal(ko.found('chair', 'left', null), '의자를 찾았어요. 화면 왼쪽에 있어요.');
    assert.equal(ko.lost('chair'), '의자가 화면에서 사라졌어요. 계속 찾을게요.');
    assert.equal(ko.coaching('chair', 0), '아직 의자를 찾고 있어요. 천천히 돌려 보세요.');
    assert.equal(ko.stop(), '찾기를 멈췄어요.');
    assert.equal(ko.error('network'), '헤이나비 서버에 연결할 수 없어요. 계속 시도할게요.');
  });

  it('applies particles per concept', () => {
    assert.equal(ko.start('cup'), '컵을 찾을게요. 휴대폰을 천천히 움직여 주세요.');
    assert.equal(ko.lost('bag'), '가방이 화면에서 사라졌어요. 계속 찾을게요.');
    assert.equal(ko.foundMany('person', 2, 'center', null), '사람이 2명 보여요. 가장 큰 것은 화면 가운데에 있어요.');
    assert.equal(ko.foundMany('cup', 3, 'right', 'close'), '컵이 3개 보여요. 가장 큰 것은 화면 오른쪽에 있어요. 가까이 있는 것 같아요.');
  });
});

describe('safety wording', () => {
  it('never claims distances in meters or steps, or that anything is safe', () => {
    const forbidden = /\d\s*(m|meters?|feet|ft|steps?)\b|meter|step|safe|미터|걸음|안전/i;
    const positions: Position[] = ['left', 'center', 'right'];
    const statuses: SearchStatus[] = ['IDLE', 'SEARCHING', 'CONFIRMING', 'FOUND', 'GUIDING', 'LOST', 'PAUSED', 'CANCELLED'];
    const errors: ErrorKind[] = ['network', 'slow', 'unauthorized', 'notConfigured', 'cantAnalyze', 'server', 'camera'];
    for (const p of Object.values(PHRASES)) {
      const lines: string[] = [p.stop(), p.reconnected(), p.ui.stopButton];
      for (const c of CONCEPT_IDS) {
        lines.push(p.start(c), p.lost(c), p.checkIn(c), p.resume(c), p.ui.startButton(c));
        for (let i = 0; i < 4; i++) lines.push(p.coaching(c, i));
        for (const pos of positions) {
          for (const size of ['close', 'far', null] as const) {
            lines.push(p.found(c, pos, size), p.foundMany(c, 2, pos, size));
          }
        }
      }
      for (const pos of positions) lines.push(p.guide(pos));
      for (const s of statuses) lines.push(p.ui.status(s));
      for (const e of errors) lines.push(p.error(e));
      for (const line of lines) {
        assert.ok(line.length > 0);
        assert.doesNotMatch(line, forbidden, line);
        assert.doesNotMatch(line, /undefined|NaN/, line);
      }
    }
  });
});

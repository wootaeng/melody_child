import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUMENTS, pickInstrument, DEFAULT_INSTRUMENT } from '../src/instruments.js';

// 악기는 순수 데이터다. 브라우저 API를 모르므로 여기서 불변식을 직접 검증할 수 있다 —
// 실제 소리(대역 에너지)는 OfflineAudioContext가 필요해 브라우저에서만 잴 수 있고,
// 그 경계를 흐리면 "테스트는 통과하는데 소리는 안 바뀌는" 상태가 된다.

const NAMES = Object.keys(INSTRUMENTS);

test('모든 프리셋에 필수 필드가 있다', () => {
  for (const name of NAMES) {
    const p = INSTRUMENTS[name];
    for (const field of ['label', 'octave', 'harmonics', 'attackSec', 'holdShare', 'sustain', 'filterFrom', 'level']) {
      assert.ok(p[field] !== undefined, `${name}에 ${field}가 없다`);
    }
    assert.ok(Array.isArray(p.harmonics) && p.harmonics.length >= 2, `${name}: 배음 배열`);
    // createPeriodicWave의 imag 배열은 첫 항이 DC다 — 0이 아니면 파형이 치우친다
    assert.equal(p.harmonics[0], 0, `${name}: 첫 항(DC)은 0이어야 한다`);
    assert.ok(p.octave >= 0 && p.octave <= 2, `${name}: 옥타브 ${p.octave}`);
    assert.ok(p.sustain > 0 && p.sustain <= 1, `${name}: sustain ${p.sustain}`);
    assert.ok(p.holdShare >= 0 && p.holdShare < 0.9, `${name}: holdShare ${p.holdShare}`);
  }
});

test('필터 엔벨로프는 고배음을 깎는 방향으로만 움직인다', () => {
  // 피아노다움의 핵심은 고배음이 기본음보다 먼저 죽는 것이다. 차단 주파수가
  // 올라가면 그 반대가 되어 악기 성격이 뒤집힌다.
  for (const name of NAMES) {
    const { filterFrom, filterTo } = INSTRUMENTS[name];
    if (filterTo === undefined) continue; // 고정 필터 — 엔벨로프 없음
    assert.ok(filterTo < filterFrom, `${name}: ${filterFrom} → ${filterTo}는 열리는 방향이다`);
  }
});

test('감쇠 깊이가 타악기 → 지속음 순서다', () => {
  // 마림바·오르골은 때리면 곧 조용해지고, 피아노는 더 남고, 신디는 거의 유지된다.
  // 이 순서가 곧 네 악기가 서로 다른 소리로 들리는 이유다.
  const s = (name) => INSTRUMENTS[name].sustain;
  assert.ok(s('marimba') < s('orgel'), `마림바 ${s('marimba')} < 오르골 ${s('orgel')}`);
  assert.ok(s('orgel') < s('piano'), `오르골 ${s('orgel')} < 피아노 ${s('piano')}`);
  assert.ok(s('piano') < s('synth'), `피아노 ${s('piano')} < 신디 ${s('synth')}`);
});

test('신디는 예전 소리를 그대로 재현한다 (A/B 기준선)', () => {
  // 이 값이 바뀌면 "악기를 바꿔서 좋아졌다"의 비교 대상이 사라진다. 기대값을
  // 하드코딩해 둔다 — 상수를 참조하면 상수를 바꿀 때 테스트가 함께 움직인다.
  const synth = INSTRUMENTS.synth;
  assert.deepEqual(synth.harmonics, [0, 1, 0.75, 0.55, 0.38, 0.24, 0.14]);
  assert.equal(synth.octave, 0, '예전 소리는 음역을 옮기지 않았다');
  assert.equal(synth.holdShare, 0.6);
  assert.equal(synth.sustain, 0.75);
  assert.equal(synth.filterFrom, 3500);
  assert.equal(synth.filterTo, undefined, '예전 소리는 필터 엔벨로프가 없다');
});

test('피아노가 기본이고 음역을 올려 목소리를 비킨다', () => {
  // 목소리 기본음(실기 154Hz)과 같은 대역에서 울리면 마스킹돼 묻힌다.
  assert.equal(DEFAULT_INSTRUMENT, 'piano');
  assert.ok(INSTRUMENTS.piano.octave >= 1, '피아노가 목소리 음역에 머물러 있다');
});

test('알 수 없는 이름은 조용히 무시하지 않고 기본 악기로 떨어진다', () => {
  assert.equal(pickInstrument('없는악기'), INSTRUMENTS[DEFAULT_INSTRUMENT]);
  assert.equal(pickInstrument(null), INSTRUMENTS[DEFAULT_INSTRUMENT]);
  assert.equal(pickInstrument(undefined), INSTRUMENTS[DEFAULT_INSTRUMENT]);
  assert.equal(pickInstrument('orgel'), INSTRUMENTS.orgel);
});

// 실기에서 관측된 가장 낮은 음(midi 51). 여기서 배음이 어디까지 닿는지가
// "멜로디가 작다"를 가른다 — 지각 음량은 진폭이 아니라 어느 대역에 에너지가
// 있는지의 문제이고, 저음역 순음은 구조적으로 불리하다.
const LOW_MIDI_HZ = 155;

const reachHz = (p) => Math.min(LOW_MIDI_HZ * 2 ** p.octave * (p.harmonics.length - 1), p.filterFrom);

test('새 악기는 배음이 1kHz 위까지 닿는다 (귀가 가장 민감한 대역)', () => {
  for (const name of NAMES) {
    if (name === 'synth') continue; // 예전 소리 보존 — 아래에서 따로 단정한다
    const reach = reachHz(INSTRUMENTS[name]);
    assert.ok(reach >= 1000, `${name}: 최고 성분 ${Math.round(reach)}Hz — 1kHz에 못 닿는다`);
  }
});

test('예전 소리는 그 대역에 구조적으로 못 닿았다 — 그게 "작다"의 원인이었다', () => {
  // 이 단정이 빨강이 되면 신디 프리셋이 예전 소리가 아니게 됐다는 뜻이다.
  // 7차에 기록한 "1~3kHz 에너지 54배"는 더 높은 픽스처 음에서 잰 값이라
  // 실기 음역(midi 51~55)에서는 대부분 무효였다 — 그 사실을 여기 남긴다.
  assert.ok(
    reachHz(INSTRUMENTS.synth) < 1000,
    `신디가 ${Math.round(reachHz(INSTRUMENTS.synth))}Hz까지 닿는다 — 기준선이 바뀌었다`,
  );
});

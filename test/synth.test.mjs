import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressAt, voiceSpan, alignToBeats, mixLevels } from '../src/synth.js';

const SR = 48000;
const at = (sec) => Math.round(sec * SR);

// 느슨한 정렬. 요점은 하나 — 음절 시작은 박에 맞추되 **음절 자체는 자르지 않는다**.
// 음절을 늘리거나 자르면 기계음·끊김이 돌아온다.

test('음절 시작이 모두 격자의 정수배에 놓인다', () => {
  const bounds = [
    { start: at(0.0), end: at(0.2) },
    { start: at(0.4), end: at(1.1) }, // 0.7초 음절 — 여러 칸이 필요하다
    { start: at(1.5), end: at(1.6) },
  ];
  const { placed, gridSec } = alignToBeats(bounds, SR, 0.5);
  for (const [i, chunk] of placed.entries()) {
    const units = chunk.at / gridSec;
    assert.ok(Math.abs(units - Math.round(units)) < 1e-9, `조각 ${i}: ${chunk.at}초는 격자가 아니다`);
  }
});

test('격자를 자연스러운 음절 간격에서 고른다 (박에 하나씩 놓지 않는다)', () => {
  // 초당 약 2.7음절(간격 0.37초)로 말한 녹음. 96bpm의 한 박은 0.625초라
  // 박마다 하나씩 놓으면 말이 1.7배 늘어난다 — 8분음표(0.3125초)를 골라야 한다.
  const bounds = Array.from({ length: 6 }, (_, i) => ({
    start: at(i * 0.37),
    end: at(i * 0.37 + 0.25),
  }));
  const beatSec = 0.625;
  const { gridSec, totalSec } = alignToBeats(bounds, SR, beatSec);
  assert.equal(+gridSec.toFixed(4), 0.3125, `격자 ${gridSec}`);
  // 총 길이가 자연 발화(약 2.2초)에서 크게 벗어나지 않는다
  assert.ok(totalSec < 2.5, `${totalSec.toFixed(2)}초로 늘어났다`);
});

test('빠르게 말한 곳은 붙어 있고 쉰 곳은 벌어진다 (원래 리듬 유지)', () => {
  const bounds = [
    { start: at(0.0), end: at(0.2) },
    { start: at(0.3), end: at(0.5) }, // 바로 이어서
    { start: at(1.5), end: at(1.7) }, // 1초 쉬고
  ];
  const { placed, gridSec } = alignToBeats(bounds, SR, 0.6);
  const gap1 = placed[1].at - placed[0].at;
  const gap2 = placed[2].at - placed[1].at;
  assert.ok(gap2 > gap1 * 2, `쉼이 반영되지 않았다: ${gap1.toFixed(2)} → ${gap2.toFixed(2)}`);
  assert.ok(Math.abs(gap1 - 0.3) <= gridSec, `붙은 음절이 벌어졌다: ${gap1.toFixed(2)}`);
});

test('음절은 절대 잘리지 않는다 (재생 길이 ≥ 음절 길이)', () => {
  const bounds = [
    { start: at(0.0), end: at(0.45) }, // 박(0.5)보다 조금 짧다
    { start: at(0.5), end: at(1.05) }, // 박보다 조금 길다 → 2박
    { start: at(2.0), end: at(2.3) },
  ];
  const { placed } = alignToBeats(bounds, SR, 0.5);
  for (const [i, chunk] of placed.entries()) {
    assert.ok(
      chunk.dur >= chunk.syllableSec - 1e-9,
      `조각 ${i}: 재생 ${chunk.dur.toFixed(3)}초 < 음절 ${chunk.syllableSec.toFixed(3)}초`,
    );
  }
});

test('조각이 서로 겹치지 않는다', () => {
  const bounds = [
    { start: at(0.0), end: at(0.3) },
    { start: at(0.35), end: at(0.9) },
    { start: at(1.0), end: at(1.2) },
  ];
  const { placed } = alignToBeats(bounds, SR, 0.4);
  for (let i = 1; i < placed.length; i++) {
    assert.ok(
      placed[i - 1].at + placed[i - 1].dur <= placed[i].at + 1e-9,
      `조각 ${i - 1}이 ${i}과 겹친다`,
    );
  }
});

test('마지막 조각은 여운까지 쓰되 배정된 칸을 넘지 않는다', () => {
  const { placed, gridSec } = alignToBeats([{ start: at(1.0), end: at(1.2) }], SR, 0.5, 0.25);
  // 음절 0.2초 + 여운 0.25초 = 0.45초 재료. 배정 칸을 넘겨 재생하지 않는다.
  assert.ok(placed[0].dur <= 0.45 + 1e-9, `${placed[0].dur}`);
  assert.ok(placed[0].dur <= placed[0].units * gridSec + 1e-9);
  assert.ok(placed[0].dur >= 0.2 - 1e-9, '음절이 잘렸다');
  assert.equal(placed[0].from, 1);
});

// 멜로디 음량은 목소리 RMS에서 나온다 — 고정 숫자면 마이크 레벨이 다른 녹음마다
// 어긋난다("목소리만 크다"는 실기 지적).
test('조용한 녹음이든 큰 녹음이든 멜로디가 목소리에 비례한다', () => {
  const tone = (amp) => {
    const s = new Float32Array(SR);
    for (let i = 0; i < s.length; i++) s[i] = amp * Math.sin((2 * Math.PI * 200 * i) / SR);
    return s;
  };
  const quiet = mixLevels(tone(0.1), 0, SR);
  const loud = mixLevels(tone(0.7), 0, SR);
  assert.ok(loud.melodyLevel > quiet.melodyLevel, `${loud.melodyLevel} vs ${quiet.melodyLevel}`);
  // 어느 쪽도 클리핑하지 않는다
  for (const [name, mix] of [['quiet', quiet], ['loud', loud]]) {
    const peak = name === 'quiet' ? 0.1 : 0.7;
    assert.ok((peak + mix.melodyLevel) * mix.master <= 0.99, `${name} 클리핑`);
  }
});

test('무음 녹음에서도 멜로디는 들린다 (하한)', () => {
  const mix = mixLevels(new Float32Array(SR), 0, SR);
  assert.ok(mix.melodyLevel >= 0.12, `${mix.melodyLevel}`);
  assert.ok(mix.master > 0 && mix.master <= 0.9);
});

// 챈트가 목소리를 어디까지 흘려보내는지. 음절 사이를 건드리지 않는다는 것이
// 이 함수의 요점이다 — 조각을 잘라 이어붙이면 말이 뚝뚝 끊긴다(실기 지적).
test('앞뒤 침묵만 잘라내고 음절 사이는 그대로 둔다', () => {
  const buffer = { sampleRate: 48000, duration: 10 };
  const bounds = [
    { start: 48000, end: 72000 }, // 1.0~1.5초
    { start: 120000, end: 144000 }, // 2.5~3.0초
  ];
  const span = voiceSpan(buffer, bounds);
  assert.equal(span.from, 1);
  // 마지막 음절 끝(3.0초) + 여운 0.25초까지 = 2.25초 분량. 사이의 1초 공백도
  // 그대로 포함된다(자연스러운 이음새라 잘라내면 안 된다).
  assert.equal(+span.sec.toFixed(3), 2.25);
});

test('꼬리 여운이 녹음 끝을 넘지 않는다', () => {
  const buffer = { sampleRate: 48000, duration: 2 };
  const span = voiceSpan(buffer, [{ start: 0, end: 96000 }]);
  assert.equal(span.from, 0);
  assert.equal(span.sec, 2);
});

test('조각이 없으면 녹음 전체', () => {
  const buffer = { sampleRate: 48000, duration: 3.5 };
  assert.deepEqual(voiceSpan(buffer, []), { from: 0, sec: 3.5 });
  assert.deepEqual(voiceSpan(buffer, null), { from: 0, sec: 3.5 });
});

// 진행선의 위치 계산. 캔버스 그리기는 이 하네스에서 관측할 수 없다(창이 가려져
// 있으면 rAF가 1초에 0프레임 — 실측). 그래서 시간→위치 매핑만 여기서 못 박고
// 선이 실제로 보이는지는 실기에서 확인한다.

test('첫 음 이전은 0, 마지막 음 이후는 1', () => {
  const times = [10, 11, 12, 13];
  assert.equal(progressAt(times, 9), 0);
  assert.equal(progressAt(times, 10), 0);
  assert.equal(progressAt(times, 13), 1);
  assert.equal(progressAt(times, 99), 1);
});

test('음 사이를 시간으로 보간한다 (구슬 간격 = 1/(음수-1))', () => {
  const times = [0, 1, 2, 3, 4]; // 구슬 5개 → 간격 0.25
  assert.equal(progressAt(times, 1), 0.25);
  assert.equal(progressAt(times, 1.5), 0.375);
  assert.equal(progressAt(times, 3), 0.75);
});

test('음 길이가 달라도 각 구슬에 정확히 그 시각에 닿는다', () => {
  // 8분음표 짝(0.25초)과 4분음표(0.5초)가 섞인 배치
  const times = [0, 0.5, 0.75, 1, 1.5];
  for (const [i, t] of times.entries()) {
    assert.equal(progressAt(times, t), i / (times.length - 1), `구슬 ${i}`);
  }
  // 구간 중간은 그 구간 안에서만 움직인다
  const mid = progressAt(times, 0.625);
  assert.ok(mid > 0.25 && mid < 0.5, `${mid}`);
});

test('음이 하나뿐이면 0 (나눌 구간이 없다)', () => {
  assert.equal(progressAt([5], 5), 0);
  assert.equal(progressAt([5], 99), 0);
  assert.equal(progressAt([], 1), 0);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressAt, voiceSpan, alignToBeats, mergeContiguous, mixLevels } from '../src/synth.js';

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

test('긴 쉼이 섞여도 격자가 4분음표까지 올라가지 않는다', () => {
  // 실기에서 격자가 625ms로 뽑혔다 — 쉼이 중앙값을 끌어올린 결과이고, 그 격자는
  // 말을 늘려 다시 끊기게 만든다. 어절 안 간격만 보고 상한 400ms를 지켜야 한다.
  const bounds = [
    { start: at(0.0), end: at(0.25) },
    { start: at(0.3), end: at(0.55) }, // 어절 안 (간격 0.3)
    { start: at(1.6), end: at(1.85) }, // 1.3초 쉼
    { start: at(1.9), end: at(2.15) },
    { start: at(3.4), end: at(3.65) }, // 또 긴 쉼
  ];
  const { gridSec, placed } = alignToBeats(bounds, SR, 0.625);
  assert.ok(gridSec <= 0.4, `격자 ${Math.round(gridSec * 1000)}ms`);
  // 쉼은 격자가 아니라 배정 칸 수로 표현된다 — 길게 쉰 자리는 여러 칸을 먹는다
  assert.ok(placed[1].units > 1 || placed[3].units > 1, '쉼이 사라졌다');
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

// 연속 조각 병합. 정렬된 조각 중 다수는 **원본에서도 연속이고 배치도 연속**인데,
// 그 이음매에까지 페이드를 걸면 아무 이유 없이 진폭을 0까지 떨어뜨렸다 올린다
// (실기 지적 "말이 살짝 끊긴다"의 원인 절반 — 페이드 20 + 침묵 42 + 페이드 20ms).
// 합쳐 두면 페이드가 실제로 침묵이 있는 자리에만 남는다.

// 어느 출력 샘플에서 원본의 어느 샘플이 들리는지. 병합이 이 매핑을 바꾸지 않아야
// "같은 파형"이라는 주장이 성립한다.
function sourceMap(placed) {
  const map = new Map();
  for (const c of placed) {
    const at0 = Math.round(c.at * SR);
    const from0 = Math.round(c.from * SR);
    for (let i = 0; i < Math.round(c.dur * SR); i++) map.set(at0 + i, from0 + i);
  }
  return map;
}

// 쉼 없이 이어 말한 녹음. 자연 간격이 격자와 맞아떨어져 배정이 재료와 같아진다.
const CONTIGUOUS = [
  { start: at(0.0), end: at(0.3) },
  { start: at(0.3), end: at(0.6) },
  { start: at(0.6), end: at(0.9) },
];

test('원본에서 연속인 조각은 하나로 합쳐진다', () => {
  const { placed } = alignToBeats(CONTIGUOUS, SR, 0.6);
  const merged = mergeContiguous(placed);
  assert.ok(merged.length < placed.length, `${placed.length} → ${merged.length}: 병합되지 않았다`);
});

test('병합은 어느 시각에 원본의 어디가 들리는지를 바꾸지 않는다', () => {
  const { placed } = alignToBeats(CONTIGUOUS, SR, 0.6);
  const before = sourceMap(placed);
  const after = sourceMap(mergeContiguous(placed));
  assert.equal(after.size, before.size, '재생되는 샘플 수가 달라졌다');
  for (const [out, src] of before) {
    assert.equal(after.get(out), src, `출력 ${out}번 샘플이 원본 ${src} → ${after.get(out)}로 바뀌었다`);
  }
});

test('병합은 원본 placed를 변형하지 않는다', () => {
  const { placed } = alignToBeats(CONTIGUOUS, SR, 0.6);
  const durs = placed.map((c) => c.dur);
  mergeContiguous(placed);
  assert.deepEqual(placed.map((c) => c.dur), durs, '호출자의 배열이 바뀌었다');
});

// 삽입 침묵. 배정 칸이 재료보다 길면 그 차이가 침묵이 되고, 실기에서 목소리 7.3초가
// 정렬 7.8초로 늘어난 0.5초(조각당 42ms)가 정확히 그것이었다.
//
// 침묵과 재료 건너뛰기는 **같은 반올림 오차의 두 방향**이다. 총량은 보존되므로
// 어느 쪽으로 보낼지만 고를 수 있고, 침묵은 소리가 사라지는 반면 건너뛰기는
// 음절 뒤의 쉼만 자른다(음절 자체는 ceil 하한이 지킨다). 그래서 내림으로 편향한다.

// 실기 녹음에 가까운 픽스처: 실제 녹음은 음절 사이에 무음이 없어 슬라이서가 음절이
// 아니라 어절 덩이를 잡고, 그 간격에 쉼이 섞인다.
const PHRASES = [
  { start: at(0.0), end: at(0.75) },
  { start: at(0.95), end: at(1.6) },
  { start: at(1.85), end: at(2.7) },
  { start: at(3.0), end: at(3.85) },
  { start: at(4.1), end: at(4.9) },
];
const PHRASE_NATURAL = 4.9 + 0.25; // voiceSpan과 같은 정의(마지막 끝 + 여운)

test('배정 칸을 재료보다 길게 잡지 않는다 (삽입 침묵 ≤ 자연 길이의 2%)', () => {
  const { placed, gridSec } = alignToBeats(PHRASES, SR, 0.625);
  const silence = placed.reduce((sum, c) => sum + (c.units * gridSec - c.dur), 0);
  assert.ok(
    silence <= PHRASE_NATURAL * 0.02,
    `침묵 ${(silence * 1000).toFixed(0)}ms — 자연 길이의 ${((silence / PHRASE_NATURAL) * 100).toFixed(1)}%`,
  );
});

test('정렬이 말을 늘리지 않는다 (늘어난 만큼이 곧 침묵이다)', () => {
  const { totalSec } = alignToBeats(PHRASES, SR, 0.625);
  assert.ok(totalSec <= PHRASE_NATURAL + 1e-9, `${totalSec.toFixed(2)}초 > 자연 ${PHRASE_NATURAL}초`);
  // 쉼이 통째로 사라지면 말이 뭉친다 — 압축에도 하한을 둔다
  assert.ok(totalSec >= PHRASE_NATURAL * 0.8, `${totalSec.toFixed(2)}초로 압축됐다`);
});

test('재료를 건너뛴 경계는 병합하지 않는다 (페이드가 필요한 자리다)', () => {
  // 배정 칸이 재료보다 짧으면 음절 뒤 쉼을 건너뛰고 다음 음절로 넘어간다 —
  // 원본에서 불연속이므로 이음매에 페이드가 있어야 한다.
  const bounds = [
    { start: at(0.0), end: at(0.3) },
    { start: at(0.8), end: at(1.1) },
    { start: at(1.6), end: at(1.9) },
  ];
  const { placed } = alignToBeats(bounds, SR, 1.0);
  const merged = mergeContiguous(placed);
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const skipped = Math.abs(prev.from + prev.dur - merged[i].from) > 1e-9;
    const gap = Math.abs(prev.at + prev.dur - merged[i].at) > 1e-9;
    assert.ok(skipped || gap, `조각 ${i - 1}·${i}는 연속인데 합쳐지지 않았다`);
  }
});

// 음량: 목소리를 먼저 정규화하고 그 위에서 멜로디 비율을 잡는다. 절대 RMS에
// 비례시키면 작게 녹음한 날 멜로디가 하한에 붙는다(실기 지적).
// 말소리처럼 피크는 높고 평균은 낮은 신호(파고율 약 4.5). 순음으로 재면 파고율이
// 1.4밖에 안 되어 정규화 뒤 멜로디가 상한에 붙어버려 비율 계산을 검증하지 못한다.
// 파고율이 낮은 쪽(정상 음)도 클리핑 검사에 함께 넣는다 — 정규화 상한 계산이
// 파고율에 따라 갈리므로 한쪽만 재면 반쪽만 검증된다.
const tonePeak = (amp) => {
  const s = new Float32Array(SR);
  for (let i = 0; i < s.length; i++) s[i] = amp * Math.sin((2 * Math.PI * 200 * i) / SR);
  return s;
};

const speechLike = (amp) => {
  const s = new Float32Array(SR);
  const period = Math.round(SR * 0.25);
  for (let i = 0; i < s.length; i++) {
    const speaking = i % period < period * 0.2;
    s[i] = speaking ? amp * Math.sin((2 * Math.PI * 200 * i) / SR) : 0;
  }
  return s;
};

test('작게 녹음해도 크게 녹음한 것과 같은 균형이 나온다', () => {
  const quiet = mixLevels(speechLike(0.2), 0, SR);
  const loud = mixLevels(speechLike(0.75), 0, SR);
  assert.ok(quiet.voiceGain > loud.voiceGain, `증폭이 반대다: ${quiet.voiceGain} vs ${loud.voiceGain}`);
  assert.equal(+loud.voiceGain.toFixed(2), +(0.89 / 0.75).toFixed(2));
  // 정규화 뒤 멜로디 음량이 사실상 같다 — 이것이 정규화의 목적이다
  assert.ok(
    Math.abs(quiet.melodyLevel - loud.melodyLevel) < 0.02,
    `${quiet.melodyLevel.toFixed(3)} vs ${loud.melodyLevel.toFixed(3)}`,
  );
});

test('아주 작게 녹음하면 증폭 상한에 걸려 멜로디도 함께 작아진다', () => {
  // 잡음까지 끌어올리지 않기 위한 상한(8배)의 대가다. 숨기지 않고 못 박아 둔다 —
  // 진단 칩의 "증폭 8.0배"가 곧 "더 크게 말해야 한다"는 신호다.
  const tiny = mixLevels(speechLike(0.05), 0, SR);
  const normal = mixLevels(speechLike(0.4), 0, SR);
  assert.equal(tiny.voiceGain, 8);
  assert.ok(tiny.melodyLevel < normal.melodyLevel, `${tiny.melodyLevel} vs ${normal.melodyLevel}`);
});

test('정규화·합성 후에도 클리핑하지 않는다', () => {
  for (const amp of [0.05, 0.2, 0.6, 0.99]) {
    for (const signal of [speechLike(amp), tonePeak(amp)]) {
      const mix = mixLevels(signal, 0, SR);
      const peak = (Math.min(0.89, amp * mix.voiceGain) + mix.melodyLevel) * mix.master;
      assert.ok(peak <= 0.98, `amp ${amp}: 피크 ${peak.toFixed(3)}`);
    }
  }
});

test('비율을 올리면 멜로디만 커진다 (URL 손잡이)', () => {
  const base = mixLevels(speechLike(0.3), 0, SR, 1);
  const louder = mixLevels(speechLike(0.3), 0, SR, 2);
  assert.ok(louder.melodyLevel > base.melodyLevel * 1.8, `${louder.melodyLevel} vs ${base.melodyLevel}`);
  assert.equal(louder.voiceGain, base.voiceGain);
  // 기본 비율이 상한에 닿지 않는다 — 닿으면 손잡이가 무동작이 된다
  assert.ok(mixLevels(speechLike(0.3), 0, SR).melodyLevel < 1, '상한에 붙었다');
});

test('무음 녹음에서 증폭이 폭주하지 않는다', () => {
  const mix = mixLevels(new Float32Array(SR), 0, SR);
  assert.ok(mix.voiceGain <= 8, `${mix.voiceGain}`);
  assert.ok(mix.melodyLevel >= 0.08 && mix.master > 0);
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

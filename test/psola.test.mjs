import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPitchMarks, renderNote, readOffset } from '../src/psola.js';
import { renderVoices, attackSamples } from '../src/synth.js';
import { detectF0, findGrain } from '../src/pitch.js';
import { composeMelody, midiToHz } from '../src/composer.js';
import { sliceSyllables } from '../src/slicer.js';
import { makeDevSample, DEV_SAMPLE_F0S } from '../src/devsample.js';

const SR = 48000;

// 픽스처는 반드시 활강 신호를 쓴다. 정상상태 사인파에는 표류할 것이 없어
// 음정이 음절 안에서 흐르는 결함이 원리상 드러나지 않는다 — 지난 회차에
// 테스트 34개가 전부 초록인 채로 실사용에서 무너진 직접 원인이다.
const GLIDE_CENTS = 400;

function glideSample(opts = {}) {
  const samples = makeDevSample(SR, { glideCents: GLIDE_CENTS, ...opts });
  return { samples, segs: sliceSyllables(samples, SR) };
}

function marksOf(samples, seg) {
  const grain = findGrain(samples, SR, seg);
  assert.ok(grain !== null, '그레인 검출 실패 — 힌트를 만들 수 없다');
  return findPitchMarks(samples, SR, seg, { periodHint: SR / grain.f0 });
}

// 프로덕션 경로 그대로 렌더한다. 어택 길이·음 길이를 테스트가 따로 계산하면
// 실제로 쓰이지 않는 값으로만 검증하게 된다(리뷰 지적: attackLength=0 기본값
// 때문에 프로덕션 어택을 한 번도 실행하지 않았다).
function renderSong(samples, segs, seed = 1) {
  const grains = segs.map((s) => findGrain(samples, SR, s));
  const pitchMarks = segs.map((s, i) =>
    grains[i] ? findPitchMarks(samples, SR, s, { periodHint: SR / grains[i].f0 }) : null,
  );
  const voiced = grains.filter(Boolean).map((g) => g.f0).sort((a, b) => a - b);
  const melody = composeMelody(segs.length, seed, voiced[Math.floor(voiced.length / 2)]);
  const voices = renderVoices(samples, SR, { segments: segs, grains, pitchMarks, melody });
  return { voices, melody, grains, pitchMarks };
}

const cents = (hz, ref) => 1200 * Math.log2(hz / ref);

function maxStep(samples, from = 0, to = samples.length) {
  let max = 0;
  for (let i = from + 1; i < to; i++) max = Math.max(max, Math.abs(samples[i] - samples[i - 1]));
  return max;
}

function zeroRuns(samples, from, to) {
  let runs = 0;
  let run = 0;
  for (let i = from; i < to; i++) {
    if (samples[i] === 0) run++;
    else {
      if (run >= 8) runs++;
      run = 0;
    }
  }
  return run >= 8 ? runs + 1 : runs;
}

test('프로덕션 경로에서 음 전체의 음정이 목표에 머문다', () => {
  const { samples, segs } = glideSample();
  const { voices, melody } = renderSong(samples, segs);
  const hop = Math.round(0.01 * SR);
  const win = Math.round(0.032 * SR); // detectF0의 최소 입력(28.5ms)보다 커야 한다
  for (const [i, voice] of voices.entries()) {
    assert.ok(voice !== null, `음 ${i} 렌더 실패 — 폴백으로 떨어졌다`);
    const target = midiToHz(melody.notes[i].midi);
    // 음의 앞머리는 설계상 원음 음정(자음 흔적)이라 제외하고, 나머지 전 구간을
    // 훑는다. 한 지점만 재면 표류를 놓친다(리뷰 지적: 45% 한 점만 재고 있었다).
    const skip = Math.round(0.06 * SR);
    let checked = 0;
    let inTune = 0;
    for (let s = skip; s + win <= voice.length; s += hop) {
      const hz = detectF0(voice.subarray(s, s + win), SR);
      if (hz === null) continue;
      checked++;
      if (Math.abs(cents(hz, target)) <= 35) inTune++;
    }
    assert.ok(checked >= 5, `음 ${i}: 잴 구간이 없다 (${checked})`);
    assert.ok(inTune / checked >= 0.9, `음 ${i}: 음정 유지 ${inTune}/${checked}`);
  }
});

test('원음 음정으로 나가는 앞머리는 음의 25%를 넘지 않는다', () => {
  const { samples, segs } = glideSample();
  const { voices, melody, grains } = renderSong(samples, segs);
  const secPerBeat = 60 / melody.bpm;
  // 어택은 자음을 들려주기 위한 장치지만 음정을 옮기지 않는다. 길면 음마다
  // "원래 목소리 → 목표 음정"으로 튀어 멜로디가 흐려진다(리뷰 실측 -577~-1077센트).
  // 길이는 프로덕션 함수에서 그대로 가져온다 — 같은 식을 여기 다시 쓰면 실제로
  // 쓰이지 않는 값을 검증하게 된다.
  for (const [i, voice] of voices.entries()) {
    const attack = attackSamples(segs[i], grains[i], melody.notes[i].beats * secPerBeat, SR);
    assert.ok(
      attack / voice.length <= 0.25,
      `음 ${i}: 어택 비율 ${((attack / voice.length) * 100).toFixed(0)}%`,
    );
  }
});

test('어택과 유지음 이음매에 계단이 없다', () => {
  const { samples, segs } = glideSample();
  const { voices } = renderSong(samples, segs);
  const inputStep = maxStep(samples);
  for (const [i, voice] of voices.entries()) {
    // 원음이 만들 수 있는 최대 기울기의 배수로 본다 — 크로스페이드가 없으면
    // 위상 불일치가 그대로 계단이 되어 음마다 딱 소리가 난다.
    assert.ok(
      maxStep(voice) <= inputStep * 3,
      `음 ${i}: 최대 인접차 ${maxStep(voice).toFixed(3)} (원음 ${inputStep.toFixed(3)})`,
    );
  }
});

test('큰 하향 이조에서도 유지음에 구멍이 없다', () => {
  const { samples, segs } = glideSample();
  const seg = segs[0];
  const pm = marksOf(samples, seg);
  const grain = findGrain(samples, SR, seg);
  // 창이 국소 주기만큼만 넓으면 목표 주기가 국소 주기의 2배를 넘는 순간
  // 창이 서로 닿지 않아 주기 사이가 빈다. 그 문턱(약 0.5배) 아래까지 훑는다.
  for (const ratio of [0.35, 0.4, 0.45, 0.5, 0.7, 1, 1.5, 2]) {
    const out = renderNote(samples, SR, {
      targetHz: grain.f0 * ratio,
      outLength: Math.round(0.4 * SR),
      attackFrom: seg.start,
      attackLength: Math.round(0.03 * SR),
      pitchMarks: pm,
    });
    assert.ok(out !== null, `비율 ${ratio}: 렌더 실패`);
    // 20ms RMS로는 100샘플 구멍이 평균에 묻힌다 — 0인 구간을 직접 센다
    assert.equal(zeroRuns(out, 0, Math.round(out.length * 0.9)), 0, `비율 ${ratio}: 무음 구멍`);
  }
});

test('진폭이 계속 커지는 음절에서도 마크가 음절 앞부터 붙는다', () => {
  // AGC 게인 상승·강세·크레셴도를 흉내낸 스웰. 씨앗 탐색 상한이 씨앗과 함께
  // 전진하면 씨앗이 음절 끝까지 걸어가고, 마크 몇 개가 꼬리에만 몰린 채
  // "성공"으로 반환돼 그레인 폴백조차 걸리지 않는다(리뷰에서 실측한 결함).
  const { samples, segs } = glideSample();
  const swelled = Float32Array.from(samples);
  for (const seg of segs) {
    const len = seg.end - seg.start;
    for (let i = 0; i < len; i++) swelled[seg.start + i] *= 0.3 + (1.7 * i) / len;
  }
  for (const [i, seg] of sliceSyllables(swelled, SR).entries()) {
    const pm = marksOf(swelled, seg);
    assert.ok(pm !== null, `조각 ${i}: 마크 실패`);
    const covered = (pm.marks[pm.marks.length - 1] - pm.marks[0]) / (seg.end - seg.start);
    assert.ok(covered >= 0.5, `조각 ${i}: 마크가 조각의 ${(covered * 100).toFixed(0)}%만 덮는다`);
    assert.ok(
      (pm.marks[0] - seg.start) / (seg.end - seg.start) <= 0.35,
      `조각 ${i}: 첫 마크가 ${((pm.marks[0] - seg.start) / (seg.end - seg.start) * 100).toFixed(0)}% 지점`,
    );
  }
});

test('음절은 자연 속도로 읽고, 남는 길이는 끝부분 왕복으로 채운다', () => {
  const inSpan = 1000;
  const tailLen = 400;
  // 재료가 있는 동안은 1:1 — 늘리면 자음→모음 전이가 함께 늘어나 말이 뭉개진다
  for (const t of [0, 1, 500, 999, 1000]) {
    assert.equal(readOffset(t, inSpan, tailLen), t, `t=${t}`);
  }
  // 그 뒤로는 [inSpan-tailLen, inSpan] 안에서만 왕복한다 (자음까지 되돌아가지 않게)
  let prev = readOffset(1000, inSpan, tailLen);
  for (let t = 1001; t < 4000; t++) {
    const at = readOffset(t, inSpan, tailLen);
    assert.ok(at >= inSpan - tailLen && at <= inSpan, `t=${t}: ${at}`);
    assert.ok(Math.abs(at - prev) <= 1.0001, `t=${t}: 위치가 튀었다 (${prev}→${at})`);
    prev = at;
  }
  // 왕복이 실제로 되돌아온다 — 한 방향으로만 가면 재료가 곧 바닥난다
  assert.ok(readOffset(1000 + tailLen, inSpan, tailLen) < readOffset(1000 + tailLen * 1.5, inSpan, tailLen));
  // 꼬리가 없으면 끝에 머문다(0으로 나누지 않는다)
  assert.equal(readOffset(2000, inSpan, 0), inSpan);
});

test('마크 간격이 음절 안의 주기 변화를 따라간다', () => {
  const { samples, segs } = glideSample();
  for (const [i, seg] of segs.entries()) {
    const pm = marksOf(samples, seg);
    assert.ok(pm !== null, `조각 ${i} 마크 실패`);
    const nominal = SR / DEV_SAMPLE_F0S[i];
    // 활강 폭(±200센트 = ±12%)보다 조금 넓은 한계. 탐색창(25%)보다 좁게 잡아야
    // "추적기가 탐색창 끝에 붙어 있는" 상태를 걸러낸다.
    for (const [k, period] of pm.periods.entries()) {
      assert.ok(
        Math.abs(period - nominal) / nominal < 0.16,
        `조각 ${i} 마크 ${k}: 주기 ${period.toFixed(1)} (기준 ${nominal.toFixed(1)})`,
      );
    }
    for (let k = 1; k < pm.marks.length; k++) {
      assert.ok(pm.marks[k] > pm.marks[k - 1], '마크가 단조 증가하지 않는다');
      assert.ok(pm.marks[k] < seg.end, '마크가 조각을 벗어났다');
    }
  }
});

test('음을 올려도 길이가 줄지 않는다 (재생속도 방식은 절반이 된다)', () => {
  const { samples, segs } = glideSample();
  const pm = marksOf(samples, segs[0]);
  const outLength = Math.round(0.4 * SR);
  for (const target of [165, 330, 660]) {
    const out = renderNote(samples, SR, {
      targetHz: target, outLength, attackFrom: segs[0].start, attackLength: 0, pitchMarks: pm,
    });
    assert.equal(out.length, outLength, `목표 ${target}Hz에서 길이가 달라졌다`);
    const hz = detectF0(out.subarray(Math.round(out.length * 0.4), Math.round(out.length * 0.7)), SR);
    assert.ok(hz !== null && Math.abs(cents(hz, target)) <= 40, `목표 ${target}Hz인데 ${hz}Hz`);
  }
});

test('어택 구간은 원음이 그대로 남는다 (자음의 흔적)', () => {
  const { samples, segs } = glideSample();
  const seg = segs[0];
  const attackLength = Math.round(0.02 * SR);
  const out = renderNote(samples, SR, {
    targetHz: 330, outLength: Math.round(0.4 * SR), attackFrom: seg.start, attackLength,
    pitchMarks: marksOf(samples, seg),
  });
  // 끝 5ms는 유지음과 섞이므로(위상 불일치 계단 방지) 그 앞까지만 원음이다
  const untouched = attackLength - Math.round(0.005 * SR);
  for (let i = 0; i < untouched; i++) {
    assert.equal(out[i], samples[seg.start + i], `어택 ${i}번 샘플이 변했다`);
  }
  assert.notEqual(out[attackLength - 1], samples[seg.start + attackLength - 1], '이음매가 섞이지 않았다');
});

test('주기 힌트가 없거나 구간이 짧으면 null (그레인 경로로 폴백)', () => {
  const { samples, segs } = glideSample();
  assert.equal(findPitchMarks(samples, SR, segs[0], { periodHint: 0 }), null);
  assert.equal(findPitchMarks(samples, SR, segs[0], {}), null);
  const short = { start: segs[0].start, end: segs[0].start + 200 };
  assert.equal(findPitchMarks(samples, SR, short, { periodHint: SR / 220 }), null);
  assert.equal(
    renderNote(samples, SR, { targetHz: 330, outLength: 1000, attackFrom: 0, pitchMarks: null }),
    null,
  );
  // 유지음이 두 주기도 안 되면 무음 버퍼가 아니라 null이어야 폴백이 걸린다
  assert.equal(
    renderNote(samples, SR, {
      targetHz: 80, outLength: 800, attackFrom: segs[0].start, attackLength: 0,
      pitchMarks: marksOf(samples, segs[0]),
    }),
    null,
  );
});

test('마크가 음절 꼬리에만 몰리면 실패로 본다', () => {
  // 앞 90%가 무음이고 끝에서만 소리가 나는 조각 — 마크가 몇 개 찍히더라도
  // 음절을 대표하지 못하므로 성공으로 반환하면 안 된다.
  const { samples } = glideSample();
  const seg = { start: 0, end: 12000 };
  const tail = new Float32Array(12000);
  for (let i = 11000; i < 12000; i++) tail[i] = samples[1000 + i - 11000];
  assert.equal(findPitchMarks(tail, SR, seg, { periodHint: SR / 220 }), null);
});

test('정상상태 픽스처(glideCents 0)에서도 동작한다', () => {
  const samples = makeDevSample(SR);
  const segs = sliceSyllables(samples, SR);
  const { voices } = renderSong(samples, segs);
  assert.ok(voices.every(Boolean), '정상상태 신호에서 폴백으로 떨어졌다');
});

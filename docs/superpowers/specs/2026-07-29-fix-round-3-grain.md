# 수정 라운드 3 — 음절이 음이 되게 한다

작성일: 2026-07-29

아이폰 실측 결과(사용자 녹음 → WAV 내보내기)를 분석해 드러난 설계 결함을 고친다.

## 무엇이 틀렸나

내보낸 WAV(6.27초, 48kHz)를 분석한 값:

| 항목 | 측정값 | 정상 |
|---|---|---|
| 등장한 반음 | **18종, MIDI 41~80 (3옥타브 초과)** | 5음계 = 5종 |
| 한 음 내부 f0 | 0.0~0.4초에 172→162→86→177Hz | 한 음 = 한 음정 |
| 저명료도 고주파 | 814Hz(0.36)·842(0.51)·511(0.6) | 0.9대 |
| 40ms 엔벨로프 | 끝까지 0으로 안 떨어짐 | 음마다 끊김 |
| 셰이커 주기 상관 | 0.358 (무의미) | 뚜렷한 8분음표 주기 |

**근본 원인**: 음절 전체를 하나의 비율로 밀면 말소리는 음이 되지 않는다. 사람이 한 음절을 말하는 200ms 안에서 음높이가 계속 움직이는데(억양), 앞 28.5ms에서 f0를 한 번 재서 전체를 그 비율로만 밀면 억양이 그대로 살아남는다. 위 3옥타브 산포가 그 억양이다.

부차 원인 둘: 비율이 1보다 크면 재생 길이가 모자라 루프 분기로 빠지고, 루프 구간이 주기의 정수배가 아니라 이음매에서 버즈가 난다(511·814Hz 저명료도 성분). 그리고 음이 8ms 어택·20ms 릴리스로 맞붙어 있고 반주 패드가 마디 전체를 지속해 빈틈을 메운다.

**왜 테스트가 못 잡았나**: 픽스처가 정상상태 사인파였다. 억양이 없는 신호에서는 이 결함이 원리상 드러나지 않는다. 그래서 픽스처부터 고친다.

## 해결 방식 — 자음 + 유지음 그레인

샘플러가 쓰는 방식이다. 음절을 세 부분으로 나눠 쓴다.

1. **자음(어택)**: 음절 앞부분을 **원음 속도 그대로** 들려준다. 단어의 흔적이 여기 남는다.
2. **유지음**: 음절 중앙의 안정 구간에서 60~70ms 그레인을 떼어 **주기의 정수배로 잘라** 루프한다. 그레인이 짧아 억양이 담기지 않으므로 음정이 고정되고, 정수배라 이음매가 매끄러워 버즈가 사라진다.
3. **여백**: 음 길이의 15%를 비워 음 경계가 들리게 한다.

대가: 노래에서 단어를 알아듣기는 어려워진다(자음 흔적만 남는다). 정확한 멜로디와의 교환으로 받아들인 결정이다.

---

## 1. `src/pitch.js` — 명료도 노출 + 그레인 탐색

기존 `detectF0`의 본문을 `detectF0Detail`로 옮기고, 반환값에 명료도를 담는다. `detectF0`는 얇은 래퍼로 남긴다(호출자와 기존 테스트가 그대로 동작해야 한다).

```js
export function detectF0Detail(samples, sampleRate, opts = {}) {
  // ... 기존 detectF0 본문 그대로 ...
  // 마지막 return만 교체:
  //   const picked = peaks.find((p) => p.c >= best.c * 0.9);
  //   return { hz: sampleRate / picked.lag, clarity: best.c };
}

export function detectF0(samples, sampleRate, opts = {}) {
  const detail = detectF0Detail(samples, sampleRate, opts);
  return detail ? detail.hz : null;
}
```

그 아래에 그레인 탐색을 추가한다.

```js
const MIN_GRAIN_PERIODS = 3;

// 음절에서 유지음으로 쓸 그레인을 찾는다.
//
// 음절 전체를 하나의 비율로 밀면 그 안의 억양이 살아남아 음정이 흐른다
// (실측: 한 음 안에서 172→86→177Hz, 곡 전체 3옥타브 산포). 안정 구간의 짧은
// 그레인을 주기의 정수배로 잘라 루프하면 음정이 고정되고 이음매도 매끄럽다.
//
// 앞 35%는 건너뛴다 — 자음과 성문 어택이 있어 가장 불안정한 구간이다.
export function findGrain(samples, sampleRate, seg, opts = {}) {
  const { skipHead = 0.35, windowMs = 70, minClarity = 0.5 } = opts;

  const win = Math.round((sampleRate * windowMs) / 1000);
  const from = seg.start + Math.floor((seg.end - seg.start) * skipHead);
  if (seg.end - from < win) return null;

  const hop = Math.max(1, Math.floor(win / 2));
  let best = null;
  for (let s = from; s + win <= seg.end; s += hop) {
    const detail = detectF0Detail(samples.subarray(s, s + win), sampleRate);
    if (detail && detail.clarity >= minClarity && (!best || detail.clarity > best.clarity)) {
      best = { start: s, hz: detail.hz, clarity: detail.clarity };
    }
  }
  if (!best) return null;

  // 주기의 정수배로 자른다 — 루프 이음매에서 파형이 이어지도록
  const period = sampleRate / best.hz;
  let periods = Math.floor(win / period);
  while (periods >= MIN_GRAIN_PERIODS && best.start + Math.round(periods * period) > seg.end) {
    periods -= 1;
  }
  if (periods < MIN_GRAIN_PERIODS) return null;

  return { start: best.start, end: best.start + Math.round(periods * period), f0: best.hz };
}
```

### 테스트 (`test/pitch.test.mjs`에 추가)

```js
import { detectF0, detectF0Detail, findGrain } from '../src/pitch.js';

test('detectF0Detail은 명료도를 함께 준다', () => {
  const d = detectF0Detail(sine(440, 0.3), SR);
  assert.ok(d !== null);
  assert.ok(Math.abs(d.hz - 440) / 440 < 0.01);
  assert.ok(d.clarity > 0.9, `명료도 ${d.clarity}`);
  assert.equal(detectF0Detail(new Float32Array(SR * 0.3), SR), null);
});

test('findGrain은 합성 신호의 각 조각에서 정답 음높이를 찾는다', () => {
  const samples = makeDevSample(SR);
  const segs = sliceSyllables(samples, SR);
  for (const [i, seg] of segs.entries()) {
    const grain = findGrain(samples, SR, seg);
    assert.ok(grain !== null, `조각 ${i}에서 그레인 실패`);
    const expected = DEV_SAMPLE_F0S[i];
    assert.ok(Math.abs(grain.f0 - expected) / expected < 0.03, `조각 ${i}: ${grain.f0} vs ${expected}`);
    assert.ok(grain.start >= seg.start && grain.end <= seg.end, '그레인이 조각을 벗어났다');
  }
});

test('그레인 길이는 주기의 정수배다 (루프 이음매가 매끄러워야 한다)', () => {
  const samples = makeDevSample(SR);
  for (const seg of sliceSyllables(samples, SR)) {
    const grain = findGrain(samples, SR, seg);
    const period = SR / grain.f0;
    const periods = (grain.end - grain.start) / period;
    assert.ok(Math.abs(periods - Math.round(periods)) < 0.02, `정수배가 아니다: ${periods}`);
    assert.ok(Math.round(periods) >= 3, `주기가 너무 적다: ${periods}`);
  }
});

test('억양이 흐르는 음절에서도 그레인 음정은 안정적이다', () => {
  // 200Hz에서 260Hz로 활강하는 음절 — 실제 말소리에 가까운 신호.
  // 앞 28.5ms만 재면 200Hz에 가깝게 나오지만, 중앙 그레인은 중간값에 가까워야 한다.
  const dur = 0.3;
  const n = Math.round(dur * SR);
  const s = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const hz = 200 + (60 * i) / n;
    phase += (2 * Math.PI * hz) / SR;
    s[i] = 0.6 * Math.sin(phase);
  }
  const grain = findGrain(s, SR, { start: 0, end: n });
  assert.ok(grain !== null, '그레인을 못 찾았다');
  assert.ok(grain.f0 > 215 && grain.f0 < 275, `온셋 음높이에 붙었다: ${grain.f0}`);
});

test('백색소음에서는 그레인이 없다', () => {
  let s = 42;
  const noise = new Float32Array(Math.round(0.3 * SR));
  for (let i = 0; i < noise.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = s / 0x3fffffff - 1;
  }
  assert.equal(findGrain(noise, SR, { start: 0, end: noise.length }), null);
});
```

---

## 2. `src/devsample.js` — 억양이 흐르는 픽스처

정상상태 사인파만으로는 이 결함을 못 잡는다. 활강 옵션을 추가한다.

```js
export function makeDevSample(sampleRate = 48000, { glideCents = 0 } = {}) {
  const burst = Math.round(DEV_SAMPLE_BURST_SEC * sampleRate);
  const gap = Math.round(DEV_SAMPLE_GAP_SEC * sampleRate);
  const out = new Float32Array((burst + gap) * DEV_SAMPLE_F0S.length);
  const fade = Math.round(0.01 * sampleRate);

  let pos = 0;
  for (const f0 of DEV_SAMPLE_F0S) {
    // 위상을 누적해야 활강 중에도 파형이 끊기지 않는다
    let phase = 0;
    for (let i = 0; i < burst; i++) {
      // glideCents가 0이면 기존과 동일한 정상상태 신호다
      const hz = f0 * Math.pow(2, (glideCents * (i / burst - 0.5)) / 1200);
      phase += (2 * Math.PI * hz) / sampleRate;
      const harmonics =
        Math.sin(phase) + 0.5 * Math.sin(2 * phase) + 0.25 * Math.sin(3 * phase);
      const env = Math.min(1, i / fade, (burst - i) / fade);
      out[pos + i] = 0.5 * env * (harmonics / 1.75);
    }
    pos += burst + gap;
  }
  return out;
}
```

`glideCents = 0`일 때 기존 테스트가 그대로 통과해야 한다. 위상 누적 방식으로 바뀌므로 값이 미세하게 달라질 수 있다 — `devsample.test.mjs`·`slicer.test.mjs`·`pitch.test.mjs`가 전부 통과하는지 확인하고, 만약 어긋나면 상수를 조정하지 말고 보고할 것.

---

## 3. `src/synth.js` — 자음 + 그레인 루프, 그리고 여백

`buildGraph` 스펙의 `f0s`를 `grains`로 바꾼다(그레인이 f0를 품고 있다). `scheduleSegment`를 아래로 교체한다.

```js
const NOTE_GAP = 0.15; // 음 사이 여백 비율 — 없으면 음이 붙어 박자가 안 들린다

function scheduleSegment(ctx, dest, buffer, seg, grain, targetHz, when, noteSec) {
  const sr = buffer.sampleRate;
  const sounding = Math.max(0.06, noteSec * (1 - NOTE_GAP));

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(1, when + 0.006);
  gain.gain.setValueAtTime(1, when + sounding * 0.75);
  gain.gain.linearRampToValueAtTime(0, when + sounding);
  gain.connect(dest);

  if (!grain) {
    // 무성음(ㅅ·ㅋ 등): 음정 이동을 포기하고 원음 그대로 — 리듬만 맞춘다
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    src.start(when, seg.start / sr, Math.min(sounding, (seg.end - seg.start) / sr));
    return;
  }

  const rate = targetHz / grain.f0;
  const attackSec = Math.min((grain.start - seg.start) / sr, sounding * 0.35);
  const hasAttack = attackSec > 0.015;

  // 자음은 원음 속도로 — 단어의 흔적이 여기 남는다
  if (hasAttack) {
    const head = ctx.createBufferSource();
    head.buffer = buffer;
    head.connect(gain);
    head.start(when, seg.start / sr, attackSec);
  }

  // 유지음: 주기의 정수배 그레인을 루프해 음정을 고정한다
  const body = ctx.createBufferSource();
  body.buffer = buffer;
  body.playbackRate.value = rate;
  body.loop = true;
  body.loopStart = grain.start / sr;
  body.loopEnd = grain.end / sr;
  body.connect(gain);
  body.start(when + (hasAttack ? attackSec * 0.8 : 0), grain.start / sr);
  body.stop(when + sounding);
}
```

`buildGraph`의 호출부:

```js
export function buildGraph(ctx, { audioBuffer, segments, grains, melody, chords }, startTime = 0) {
  // ... 개수 검사, 버스 구성은 그대로 ...
  let when = startTime;
  melody.notes.forEach((note, i) => {
    noteTimes.push(when);
    const noteSec = note.beats * secPerBeat;
    scheduleSegment(ctx, voiceBus, audioBuffer, segments[i], grains[i], midiToHz(note.midi), when, noteSec);
    when += noteSec;
  });
  // ...
}
```

반주도 빈틈을 메우지 않게 고친다. `scheduleAccompaniment` 안에서:

```js
      // 패드는 마디를 다 채우지 않는다 — 목소리 사이 여백이 들려야 박자가 생긴다
      const padDur = dur * 0.6;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(0.1, when + 0.04);
      gain.gain.linearRampToValueAtTime(0, when + padDur);
      osc.start(when);
      osc.stop(when + padDur);
```

셰이커는 들리게 올린다(실측에서 주기 상관 0.358 — 사실상 안 들렸다):

```js
    gain.gain.setValueAtTime(beat % 1 === 0 ? 0.16 : 0.09, when);
```

---

## 4. `src/ui.js` — 그레인 계산과 전달

`analyze()`에서 조각마다 그레인을 구해 세션에 담는다. `referenceHz`는 그레인의 f0 중앙값으로 구한다 — 안정 구간에서 재 값이라 더 믿을 수 있다.

```js
import { detectF0, findGrain } from './pitch.js';
```

`analyze()` 안에서 `f0s` 계산을 아래로 교체한다:

```js
  const segments = normalizeSegments(found);
  const grains = segments.map((seg) => findGrain(samples, sampleRate, seg));
  const voiced = grains.filter(Boolean).map((g) => g.f0).sort((a, b) => a - b);
  const referenceHz = voiced.length ? voiced[Math.floor(voiced.length / 2)] : null;
```

반환 객체에서 `f0s`를 `grains`로 바꾸고, `medianF0` 함수는 삭제한다(이제 쓰이지 않는다).

`play()`와 `save()`가 `buildGraph`/`renderOffline`에 넘기는 `f0s: current.f0s`를 `grains: current.grains`로 바꾼다.

`?dev=glide`로 활강 픽스처를 쓸 수 있게 한다 — 이 결함을 브라우저에서 재현·검증하는 경로다:

```js
function loadDevSample(glideCents) {
  const ctx = new AudioContext();
  const samples = makeDevSample(ctx.sampleRate, { glideCents });
  // ... 이하 동일 ...
}

const devMode = new URLSearchParams(location.search).get('dev');
if (devMode === 'sample') {
  loadDevSample(0);
} else if (devMode === 'glide') {
  loadDevSample(400); // 음절 안에서 4반음 활강 — 실제 말소리에 가깝다
} else {
  drawBeads(null);
  show('idle');
}
```

---

## 검증

1. `node --test` — 기존 37개 + 신규 5개 = **42개 통과**. 실패하면 상수·허용치를 조정하지 말고 실측값과 함께 보고.
2. 포트 8000에 정적 서버가 이미 떠 있다. `http://localhost:8000/index.html?dev=glide`를 열고 **콘솔에서 렌더 결과의 음정 안정성을 측정한다.** 이게 이번 수정의 핵심 증거다:
   - `renderOffline`으로 렌더한 뒤, 출력에 100ms 창 자기상관을 돌려 등장한 MIDI 음 집합을 구한다.
   - **통과 기준**: 등장 음이 해당 곡의 5음계 음이름(으뜸음 기준 0·2·4·7·9 반음, 옥타브 무관) 안에 대부분 들어오고, 반음 종류가 3옥타브로 흩어지지 않을 것. 수정 전 값은 18종·MIDI 41~80이었다.
   - 명료도 0.36~0.6대의 고주파 성분(511·814·842Hz)이 사라졌는지도 함께 본다.
3. `?dev=sample`(정상상태)도 여전히 동작하는지 확인.
4. 재생·새 멜로디·노래 저장·다시 녹음 클릭 후 콘솔 에러 0건.

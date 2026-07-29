# melody_child 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 마이크로 말한 오늘의 이야기를 음절 단위로 잘라 각 조각을 멜로디 음정으로 이동시키고, 8음 한 절을 절마다 반복하는 동요로 만들어 재생·WAV 저장까지 제공하는 정적 웹페이지를 만든다.

**Architecture:** ES 모듈 8개. 순수 모듈 5개(`devsample`·`slicer`·`pitch`·`composer`·`exporter`)는 브라우저 API를 모르므로 `node --test`로 직접 검증한다. 브라우저에 묶이는 3개(`recorder`·`synth`·`ui`)는 마이크 없이 전체 파이프라인을 돌리는 개발 하네스(`dev.html`, `index.html?dev=sample`)로 검증한다. 백엔드 코드는 0줄이며 정적 서버로만 서빙한다.

**Tech Stack:** Web Audio API, MediaRecorder, Web Speech API(선택적), Canvas 2D, Node 25 내장 테스트 러너. 외부 의존성 없음.

## Global Constraints

- **런타임 의존성 0개.** `npm install`로 받는 패키지를 추가하지 않는다. `package.json`에 `dependencies`·`devDependencies`를 두지 않는다.
- **ES 모듈만.** 모든 `src/*.js`는 `export`를 쓰고 `index.html`은 `<script type="module">`로 로드한다. 이 때문에 `file://`로 열면 CORS로 실패한다 — 항상 정적 서버로 확인한다.
- **순수 모듈 경계 유지.** `src/devsample.js`·`slicer.js`·`pitch.js`·`composer.js`·`exporter.js`는 `window`·`document`·`AudioContext`를 참조하지 않는다. 이 파일들이 브라우저 API를 쓰기 시작하면 테스트가 불가능해진다.
- **테스트 명령:** `node --test`
- **UI 문구는 한국어.** 아이와 부모가 읽는다는 전제로 짧고 평서문으로 쓴다.
- **에이전트는 커밋하지 않는다.** 각 태스크의 마지막 스텝은 커밋 명령을 **제시**만 하고, 실행은 사용자가 한다. `git add`/`git commit`을 직접 실행하지 말 것.
- **AI 흔적 금지.** 커밋 메시지·주석·문서 어디에도 Co-Authored-By나 AI 생성 표기를 넣지 않는다.
- 상수: 녹음 30초(`MAX_RECORD_MS = 30000`), 한 절 8음(`VERSE_LEN = 8`), 최소 음 개수 8(`MIN_NOTES = 8`).
- **음 개수 상한은 없다.** 이야기가 길면 절이 늘어난다. 조각을 잘라 버리지 않는다.

## 파일 구조

| 파일 | 책임 |
|---|---|
| `package.json` | `type: module`, test 스크립트 |
| `.gitignore` | node_modules, 렌더 산출물 |
| `index.html` | 실제 앱 화면(3상태) |
| `dev.html` | 마이크 없이 파이프라인을 돌리는 개발 하네스 |
| `src/devsample.js` | 알려진 음높이의 합성 음성 유사 신호 생성 (순수) |
| `src/slicer.js` | 파형 → 음절 조각 경계 (순수) |
| `src/pitch.js` | 조각 → 기본주파수 f0 (순수) |
| `src/composer.js` | 조각 개수 → 멜로디·화성, `midiToHz` (순수) |
| `src/exporter.js` | Float32 채널 → WAV Blob (순수) |
| `src/synth.js` | 오디오 그래프 구성, 재생·오프라인 렌더 (브라우저) |
| `src/recorder.js` | 마이크 캡처 + STT 병행 (브라우저) |
| `src/ui.js` | 상태 머신, 파형 그리기, 버튼 배선 (브라우저) |
| `test/*.test.mjs` | 순수 모듈 테스트 |
| `README.md` | 실행·배포 방법 |

---

### Task 1: 프로젝트 스캐폴드 + 테스트용 합성 음성 신호

`devsample.js`를 먼저 만드는 이유는 이후 모든 태스크의 테스트 픽스처가 되기 때문이다. 음높이를 우리가 아는 신호이므로 `pitch` 검증의 정답지로도 쓰인다.

**Files:**
- Create: `package.json`, `.gitignore`, `src/devsample.js`
- Test: `test/devsample.test.mjs`

**Interfaces:**
- Consumes: 없음
- Produces: `makeDevSample(sampleRate?: number) -> Float32Array`, `DEV_SAMPLE_F0S: number[]`, `DEV_SAMPLE_BURST_SEC: number`, `DEV_SAMPLE_GAP_SEC: number`

- [ ] **Step 1: 스캐폴드 파일 생성**

`package.json`:

```json
{
  "name": "melody-child",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test"
  }
}
```

`.gitignore`:

```
node_modules/
*.wav
.superpowers/
```

- [ ] **Step 2: 실패하는 테스트 작성**

`test/devsample.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDevSample,
  DEV_SAMPLE_F0S,
  DEV_SAMPLE_BURST_SEC,
  DEV_SAMPLE_GAP_SEC,
} from '../src/devsample.js';

const SR = 48000;

function rms(samples, fromSec, toSec) {
  const a = Math.round(fromSec * SR);
  const b = Math.round(toSec * SR);
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (b - a));
}

test('Float32Array를 반환하고 클리핑되지 않는다', () => {
  const s = makeDevSample(SR);
  assert.ok(s instanceof Float32Array);
  let peak = 0;
  for (let i = 0; i < s.length; i++) peak = Math.max(peak, Math.abs(s[i]));
  assert.ok(peak > 0.1, `너무 조용하다: ${peak}`);
  assert.ok(peak <= 1.0, `클리핑됨: ${peak}`);
});

test('버스트 구간은 소리가 있고 갭 구간은 조용하다', () => {
  const s = makeDevSample(SR);
  const step = DEV_SAMPLE_BURST_SEC + DEV_SAMPLE_GAP_SEC;
  for (let i = 0; i < DEV_SAMPLE_F0S.length; i++) {
    const burstMid = i * step + DEV_SAMPLE_BURST_SEC / 2;
    const gapMid = i * step + DEV_SAMPLE_BURST_SEC + DEV_SAMPLE_GAP_SEC / 2;
    assert.ok(rms(s, burstMid - 0.02, burstMid + 0.02) > 0.05, `버스트 ${i}이 조용하다`);
    assert.ok(rms(s, gapMid - 0.02, gapMid + 0.02) < 0.001, `갭 ${i}에 소리가 있다`);
  }
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `node --test test/devsample.test.mjs`
Expected: FAIL — `Cannot find module '.../src/devsample.js'`

- [ ] **Step 4: 구현**

`src/devsample.js`:

```js
// 마이크 없이 파이프라인을 검증하기 위한 합성 신호.
// 사람 모음처럼 f0가 뚜렷하도록 기본음 + 2·3배음을 섞고, 음절처럼 무음으로 구분한다.

export const DEV_SAMPLE_F0S = [220, 262, 220, 196, 247, 220];
export const DEV_SAMPLE_BURST_SEC = 0.25;
export const DEV_SAMPLE_GAP_SEC = 0.12;

export function makeDevSample(sampleRate = 48000) {
  const burst = Math.round(DEV_SAMPLE_BURST_SEC * sampleRate);
  const gap = Math.round(DEV_SAMPLE_GAP_SEC * sampleRate);
  const out = new Float32Array((burst + gap) * DEV_SAMPLE_F0S.length);
  const fade = Math.round(0.01 * sampleRate);

  let pos = 0;
  for (const f0 of DEV_SAMPLE_F0S) {
    for (let i = 0; i < burst; i++) {
      const t = i / sampleRate;
      const harmonics =
        Math.sin(2 * Math.PI * f0 * t) +
        0.5 * Math.sin(4 * Math.PI * f0 * t) +
        0.25 * Math.sin(6 * Math.PI * f0 * t);
      const env = Math.min(1, i / fade, (burst - i) / fade);
      out[pos + i] = 0.5 * env * (harmonics / 1.75);
    }
    pos += burst + gap;
  }
  return out;
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `node --test test/devsample.test.mjs`
Expected: PASS (2 tests)

- [ ] **Step 6: 커밋 명령 제시 (사용자가 실행)**

```bash
cd /mnt/d/ws/study/melody_child && git add package.json .gitignore src/devsample.js test/devsample.test.mjs && git commit -m "feat: 프로젝트 스캐폴드와 테스트용 합성 음성 신호"
```

---

### Task 2: 음절 분할 (`slicer.js`)

프레임 RMS로 소리의 골짜기를 찾아 조각 경계를 낸다.

**Files:**
- Create: `src/slicer.js`
- Test: `test/slicer.test.mjs`

**Interfaces:**
- Consumes: `makeDevSample`, `DEV_SAMPLE_F0S`, `DEV_SAMPLE_BURST_SEC` (Task 1)
- Produces: `sliceSyllables(samples: Float32Array, sampleRate: number, opts?: {hopMs?, minSegMs?, minGapMs?, thresholdRatio?}) -> Array<{start: number, end: number}>` — `start`/`end`는 **샘플 인덱스**

- [ ] **Step 1: 실패하는 테스트 작성**

`test/slicer.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sliceSyllables } from '../src/slicer.js';
import { makeDevSample, DEV_SAMPLE_F0S, DEV_SAMPLE_BURST_SEC } from '../src/devsample.js';

const SR = 48000;

test('합성 신호에서 버스트 개수만큼 조각을 찾는다', () => {
  const segs = sliceSyllables(makeDevSample(SR), SR);
  assert.equal(segs.length, DEV_SAMPLE_F0S.length);
});

test('각 조각의 길이가 버스트 길이와 두 홉 이내로 일치한다', () => {
  const segs = sliceSyllables(makeDevSample(SR), SR);
  const expected = DEV_SAMPLE_BURST_SEC * SR;
  const tolerance = 0.02 * SR * 2; // 홉 20ms의 2배
  for (const [i, s] of segs.entries()) {
    const len = s.end - s.start;
    assert.ok(
      Math.abs(len - expected) <= tolerance,
      `조각 ${i} 길이 ${len}이 기대값 ${expected}에서 ${tolerance} 넘게 벗어남`,
    );
  }
});

test('조각은 순서대로이고 겹치지 않는다', () => {
  const segs = sliceSyllables(makeDevSample(SR), SR);
  for (let i = 0; i < segs.length; i++) {
    assert.ok(segs[i].end > segs[i].start);
    if (i > 0) assert.ok(segs[i].start >= segs[i - 1].end);
  }
});

test('무음만 있으면 빈 배열을 반환한다', () => {
  assert.deepEqual(sliceSyllables(new Float32Array(SR), SR), []);
});

test('minSegMs보다 짧은 조각은 버린다', () => {
  const s = new Float32Array(SR);
  // 10ms짜리 클릭 하나 — minSegMs 기본값 80ms보다 짧다
  for (let i = 1000; i < 1000 + 0.01 * SR; i++) s[i] = 0.8;
  assert.deepEqual(sliceSyllables(s, SR), []);
});

test('배경 잡음이 섞여도 버스트 개수를 찾는다', () => {
  let seed = 7;
  const noisy = Float32Array.from(makeDevSample(SR), (v) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return v + (seed / 0x3fffffff - 1) * 0.01;
  });
  assert.equal(sliceSyllables(noisy, SR).length, DEV_SAMPLE_F0S.length);
});

test('충격음이 섞여도 조용한 발화를 잃지 않는다', () => {
  // 10ms 스파이크(진폭 1.0) + 200ms 발화(진폭 0.05).
  // 스파이크가 기준을 정하면 발화가 전부 임계값 미달이 되어 사라진다.
  const n = Math.round(0.6 * SR);
  const s = new Float32Array(n);
  for (let i = 0; i < Math.round(0.01 * SR); i++) s[i] = i % 2 ? 1 : -1;
  const from = Math.round(0.3 * SR);
  for (let i = from; i < from + Math.round(0.2 * SR); i++) {
    s[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / SR);
  }
  const segs = sliceSyllables(s, SR);
  assert.equal(segs.length, 1, `조각 ${segs.length}개 — 발화가 사라졌다`);
  const len = segs[0].end - segs[0].start;
  assert.ok(
    len >= Math.round(0.15 * SR),
    `발화 조각이 너무 짧다: ${((len / SR) * 1000).toFixed(0)}ms`,
  );
});

test('무음 구간이 없는 연속 음성도 버퍼 끝까지 한 조각으로 검출한다', () => {
  const n = SR; // 1초 내내 소리
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const segs = sliceSyllables(s, SR);
  assert.equal(segs.length, 1, `조각 ${segs.length}개 — 연속 음성이 미검출됐다`);
  assert.ok(segs[0].end <= n, `end ${segs[0].end}이 버퍼 길이 ${n}을 넘는다`);
  assert.ok(segs[0].end - segs[0].start > 0.9 * n, '마지막 조각이 버퍼 끝까지 이어지지 않는다');
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/slicer.test.mjs`
Expected: FAIL — `Cannot find module '.../src/slicer.js'`

- [ ] **Step 3: 구현**

`src/slicer.js`:

```js
// 프레임 RMS로 음절 경계를 찾는다. 임계값은 최대 프레임의 일정 비율로 잡아
// 녹음 볼륨에 자동으로 맞춘다.
//
// 백분위로 노이즈 플로어를 추정하지 않는 이유: 무음 구간이 없는 녹음
// (쉬지 않고 말한 경우, 한 음을 길게 낸 경우)에서는 백분위가 신호 자체 안에
// 들어앉아 RMS 리플을 무음으로 오판한다. 실측에서 220Hz 순음이 조용한 프레임
// 3연속 패턴을 만들어 minGap에 걸리고, 쪼개진 조각이 전부 최소 길이 미달로
// 걸러져 결과가 0개가 됐다.
//
// 배경 잡음이 최대치의 20%를 넘을 만큼 심하면 전체가 한 조각으로 뭉친다 —
// 음이 하나로 줄어들 뿐, 미검출로 실패하지는 않는다.

// 임계값을 낮춰가며 최대 세 번 시도한다. 진폭 기준 16배까지의 동적 범위를
// 구제하고, 그보다 조용한 발화는 빈 결과로 남긴다 — 그 경우엔 실제로 더 크게
// 말하는 편이 맞다.
const RETRY_FACTORS = [1, 0.25, 0.0625];

function collectSegments(frames, hop, threshold, minGapFrames) {
  const segments = [];
  let start = -1;
  let quiet = 0;

  for (let f = 0; f < frames.length; f++) {
    if (frames[f] >= threshold) {
      if (start < 0) start = f;
      quiet = 0;
    } else if (start >= 0) {
      quiet++;
      if (quiet >= minGapFrames) {
        segments.push({ start: start * hop, end: (f - quiet + 1) * hop });
        start = -1;
        quiet = 0;
      }
    }
  }
  if (start >= 0) {
    segments.push({ start: start * hop, end: frames.length * hop });
  }
  return segments;
}

export function sliceSyllables(samples, sampleRate, opts = {}) {
  const {
    hopMs = 20,
    minSegMs = 80,
    minGapMs = 60,
    thresholdRatio = 0.2,
  } = opts;

  const hop = Math.max(1, Math.round((sampleRate * hopMs) / 1000));
  // 마지막 hop 미만의 나머지 샘플(최대 hopMs)은 프레임을 이루지 못해 버린다
  const frameCount = Math.floor(samples.length / hop);
  if (frameCount === 0) return [];

  const frames = new Float64Array(frameCount);
  for (let f = 0; f < frameCount; f++) {
    let sum = 0;
    const from = f * hop;
    for (let i = from; i < from + hop; i++) sum += samples[i] * samples[i];
    frames[f] = Math.sqrt(sum / hop);
  }

  let peak = 0;
  for (let f = 0; f < frameCount; f++) peak = Math.max(peak, frames[f]);
  if (peak <= 1e-6) return [];

  const minGapFrames = Math.max(1, Math.round(minGapMs / hopMs));
  const minSegSamples = Math.round((sampleRate * minSegMs) / 1000);

  // peak이 임계값을 넘는다는 것만으로는 조각이 남는다는 보장이 안 된다 —
  // 그 프레임이 minSegMs를 못 채우면 걸러지기 때문이다. 마이크를 탁 치는 등
  // 한 순간만 크게 튄 녹음에서는 스파이크가 peak을 정하고 실제 발화가 전부
  // 임계값 미달이 되어 결과가 0개가 된다. 그래서 빈 결과일 때 임계값을 낮춰
  // 다시 훑는다.
  //
  // 대가: 낮춘 임계값이 배경 잡음까지 넘기면 쉼 구간이 메워져 여러 음절이 한
  // 조각으로 뭉칠 수 있다. 조각이 줄어들 뿐 실패는 아니므로 빈 결과보다 낫다고
  // 보고 이쪽을 택했다.
  for (const factor of RETRY_FACTORS) {
    const segments = collectSegments(
      frames,
      hop,
      peak * thresholdRatio * factor,
      minGapFrames,
    ).filter((s) => s.end - s.start >= minSegSamples);
    if (segments.length > 0) return segments;
  }
  return [];
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/slicer.test.mjs`
Expected: PASS (8 tests)

- [ ] **Step 5: 커밋 명령 제시 (사용자가 실행)**

```bash
cd /mnt/d/ws/study/melody_child && git add src/slicer.js test/slicer.test.mjs && git commit -m "feat: RMS 기반 음절 분할"
```

---

### Task 3: 음높이 추정 (`pitch.js`)

이 프로젝트의 성패가 걸린 모듈이다. 조각의 원래 음높이를 모르면 목표 음정으로 정규화할 수 없고, 결과가 멜로디로 들리지 않는다.

옥타브 오류(진짜 주기의 2배 지점도 상관값이 높다)를 막기 위해 최대 상관값의 90% 이상인 **가장 짧은** 지연을 고른다.

**Files:**
- Create: `src/pitch.js`
- Test: `test/pitch.test.mjs`

**Interfaces:**
- Consumes: `makeDevSample`, `DEV_SAMPLE_F0S`, `DEV_SAMPLE_BURST_SEC`, `DEV_SAMPLE_GAP_SEC` (Task 1), `sliceSyllables` (Task 2)
- Produces: `detectF0(samples: Float32Array, sampleRate: number, opts?: {minHz?, maxHz?, minClarity?}) -> number | null` — `null`은 무성음/검출 실패

- [ ] **Step 1: 실패하는 테스트 작성**

`test/pitch.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectF0 } from '../src/pitch.js';
import { makeDevSample, DEV_SAMPLE_F0S } from '../src/devsample.js';
import { sliceSyllables } from '../src/slicer.js';

const SR = 48000;

function sine(hz, sec, sampleRate = SR) {
  const out = new Float32Array(Math.round(sec * sampleRate));
  for (let i = 0; i < out.length; i++) {
    out[i] = 0.7 * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  }
  return out;
}

test('440Hz 사인파를 1% 오차 안에 검출한다', () => {
  const f0 = detectF0(sine(440, 0.3), SR);
  assert.ok(f0 !== null, 'null이 반환됐다');
  assert.ok(Math.abs(f0 - 440) / 440 < 0.01, `검출값 ${f0}`);
});

test('낮은 음(110Hz)도 1% 오차 안에 검출한다', () => {
  const f0 = detectF0(sine(110, 0.3), SR);
  assert.ok(f0 !== null && Math.abs(f0 - 110) / 110 < 0.01, `검출값 ${f0}`);
});

test('탐색 범위 상한(1000Hz)에서도 옥타브 오류가 없다', () => {
  const f0 = detectF0(sine(1000, 0.3), SR);
  assert.ok(f0 !== null, 'null이 반환됐다');
  assert.ok(Math.abs(f0 - 1000) / 1000 < 0.01, `검출값 ${f0} — 절반으로 읽혔을 수 있다`);
});

test('탐색 범위 하한(70Hz)도 검출한다', () => {
  const f0 = detectF0(sine(70, 0.3), SR);
  assert.ok(f0 !== null, 'null이 반환됐다');
  assert.ok(Math.abs(f0 - 70) / 70 < 0.01, `검출값 ${f0}`);
});

test('무음은 null', () => {
  assert.equal(detectF0(new Float32Array(SR * 0.3), SR), null);
});

test('백색소음은 null (무성 자음 대용)', () => {
  // 결정적 난수 — 테스트가 흔들리지 않게 LCG 사용
  let s = 42;
  const noise = new Float32Array(Math.round(0.3 * SR));
  for (let i = 0; i < noise.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    noise[i] = s / 0x3fffffff - 1;
  }
  assert.equal(detectF0(noise, SR), null);
});

test('너무 짧은 입력은 null', () => {
  assert.equal(detectF0(sine(440, 0.005), SR), null);
});

test('합성 신호의 각 조각에서 정답 음높이를 복원한다', () => {
  const samples = makeDevSample(SR);
  const segs = sliceSyllables(samples, SR);
  assert.equal(segs.length, DEV_SAMPLE_F0S.length);
  for (const [i, seg] of segs.entries()) {
    const f0 = detectF0(samples.subarray(seg.start, seg.end), SR);
    assert.ok(f0 !== null, `조각 ${i}에서 검출 실패`);
    const expected = DEV_SAMPLE_F0S[i];
    assert.ok(
      Math.abs(f0 - expected) / expected < 0.03,
      `조각 ${i}: 검출 ${f0}, 기대 ${expected}`,
    );
  }
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/pitch.test.mjs`
Expected: FAIL — `Cannot find module '.../src/pitch.js'`

- [ ] **Step 3: 구현**

`src/pitch.js`:

```js
// 정규화 자기상관으로 기본주파수를 찾는다.
// 후보는 자기상관 곡선의 국소 최대점만 쓴다. 값만 보고 "최댓값의 90% 이상인
// 가장 짧은 지연"을 고르면, 곡선이 진짜 주기까지 완만히 상승하는 탓에 피크에
// 닿기 전 상승 구간에 걸려 음이 일관되게 5%쯤 높게 나온다(실측).
//
// 국소 최대점들 중에서는 최고값의 90% 이상인 가장 짧은 주기를 택한다 —
// 진짜 주기의 정수배 지점도 상관값이 높아 옥타브 오류가 나기 때문.
//
// 반환값은 `sampleRate / 정수 지연`이라 고음에서 해상도가 거칠다. 48kHz에서
// 990Hz는 1000Hz로 읽힌다(오차 1%). 반음이 5.9%이므로 음정 판단에는 무해하다.
//
// 분석 창은 `maxLag * 2`(기본값 48kHz에서 28.5ms)로 고정된다. 음절이 300ms여도
// 앞 28.5ms만 본다 — 음절 시작부의 음높이를 그 음절의 대표값으로 쓰는 것이다.

export function detectF0(samples, sampleRate, opts = {}) {
  const { minHz = 70, maxHz = 1000, minClarity = 0.3 } = opts;

  const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
  const maxLag = Math.floor(sampleRate / minHz);
  if (samples.length < maxLag * 2) return null;

  const n = Math.min(samples.length, maxLag * 2);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += samples[i];
  mean /= n;

  const x = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    x[i] = samples[i] - mean;
    energy += x[i] * x[i];
  }
  if (energy <= 1e-9) return null;

  // lag 1부터 계산한다. minLag부터 시작하면 탐색 상한 근처의 진짜 주기가 배열
  // 첫 칸에 놓여 양옆 비교를 못 해 후보에서 빠진다(실측: 1000Hz가 500Hz로).
  const corrs = [];
  for (let lag = 1; lag <= maxLag && lag < n; lag++) {
    let dot = 0;
    let e1 = 0;
    let e2 = 0;
    for (let i = 0; i + lag < n; i++) {
      dot += x[i] * x[i + lag];
      e1 += x[i] * x[i];
      e2 += x[i + lag] * x[i + lag];
    }
    const norm = Math.sqrt(e1 * e2);
    corrs.push({ lag, c: norm > 0 ? dot / norm : 0 });
  }

  // lag 0에서 내려오는 주 로브를 건너뛴다. 이 구간은 주기와 무관하게 상관값이
  // 높아서, 후보로 두면 저음에서 짧은 지연이 뽑힌다(실측: 70Hz가 1000Hz로).
  let from = 1;
  while (from < corrs.length && corrs[from].c > 0) from++;

  const peaks = [];
  for (let i = from; i < corrs.length; i++) {
    if (corrs[i].lag < minLag) continue;
    const risesFromLeft = corrs[i].c > corrs[i - 1].c;
    const holdsAgainstRight = i === corrs.length - 1 || corrs[i].c >= corrs[i + 1].c;
    if (risesFromLeft && holdsAgainstRight) peaks.push(corrs[i]);
  }
  if (peaks.length === 0) return null;

  const best = peaks.reduce((a, b) => (b.c > a.c ? b : a));
  if (best.c < minClarity) return null;
  const picked = peaks.find((p) => p.c >= best.c * 0.9);
  return sampleRate / picked.lag;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/pitch.test.mjs`
Expected: PASS (8 tests)

실측 기준값(정수 지연 해상도 한계까지 포함): 440Hz→440.37, 110Hz→110.09, dev 샘플 6조각→220.2·262.3·220.2·196.7·247.4·220.2. 전부 오차 0.5% 이내다.

하나라도 실패하면 계수나 허용오차를 건드리지 말고 그 사실을 보고하고 멈춘다. 임계값을 흔들어 통과시킨 검출기는 테스트는 녹색이면서 노래는 틀리게 만든다.

- [ ] **Step 5: 커밋 명령 제시 (사용자가 실행)**

```bash
cd /mnt/d/ws/study/melody_child && git add src/pitch.js test/pitch.test.mjs && git commit -m "feat: 자기상관 기반 음높이 추정"
```

---

### Task 4: 멜로디·화성 생성 (`composer.js`)

5음계만 쓰면 어떤 순서로 나열해도 불협이 나지 않는다. 시드를 받으므로 테스트가 결정적이고, "새 멜로디" 버튼은 시드만 바꿔 호출한다.

**절 반복이 이 모듈의 핵심이다.** 8음짜리 한 절(4음 프레이즈 A + 4음 프레이즈 B)을 만들고, 요청된 음 개수만큼 같은 절을 반복해 채운다. 이야기가 길어져도 곡이 산만해지지 않는 이유가 여기 있다 — 동요는 원래 같은 곡조를 절마다 반복한다. 이 반복이 `composer` 안에서 끝나므로 `notes.length === noteCount` 계약이 유지되고, `synth`는 절의 존재를 알 필요가 없다.

**Files:**
- Create: `src/composer.js`
- Test: `test/composer.test.mjs`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `composeMelody(noteCount: number, seed: number) -> {notes: Array<{midi: number, beats: number}>, bpm: number, tonicMidi: number, verseLen: number, verseCount: number}`
  - `chordsFor(melody) -> Array<{rootMidi: number, semitones: number[], startBeat: number, beats: number}>`
  - `midiToHz(midi: number) -> number`
  - `PENTATONIC: number[]`, `VERSE_LEN: number`

- [ ] **Step 1: 실패하는 테스트 작성**

`test/composer.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMelody, chordsFor, midiToHz, PENTATONIC, VERSE_LEN } from '../src/composer.js';

test('요청한 개수만큼 음을 만든다', () => {
  for (const count of [1, 3, 8, 17, 24, 60, 137]) {
    assert.equal(composeMelody(count, 1).notes.length, count, `count=${count}`);
  }
});

test('한 절이 그대로 반복된다 (마지막 음 제외)', () => {
  const m = composeMelody(35, 5);
  const verse = m.notes.slice(0, VERSE_LEN);
  for (let i = 0; i < m.notes.length - 1; i++) {
    assert.deepEqual(m.notes[i], verse[i % VERSE_LEN], `음 ${i}이 절 패턴과 다르다`);
  }
});

test('절 개수와 절 길이를 보고한다', () => {
  assert.equal(composeMelody(35, 5).verseLen, VERSE_LEN);
  assert.equal(composeMelody(35, 5).verseCount, Math.ceil(35 / VERSE_LEN));
  assert.equal(composeMelody(8, 5).verseCount, 1);
  assert.equal(composeMelody(9, 5).verseCount, 2);
});

test('모든 음이 으뜸음 기준 5음계에 속한다', () => {
  for (let seed = 0; seed < 20; seed++) {
    const m = composeMelody(40, seed);
    for (const note of m.notes) {
      const degree = ((note.midi - m.tonicMidi) % 12 + 12) % 12;
      assert.ok(PENTATONIC.includes(degree), `seed=${seed} midi=${note.midi} degree=${degree}`);
    }
  }
});

test('마지막 음은 으뜸음이다', () => {
  for (let seed = 0; seed < 20; seed++) {
    const m = composeMelody(9, seed);
    assert.equal(m.notes.at(-1).midi, m.tonicMidi, `seed=${seed}`);
  }
});

test('BPM은 96~120 범위', () => {
  for (let seed = 0; seed < 20; seed++) {
    const { bpm } = composeMelody(8, seed);
    assert.ok(bpm >= 96 && bpm <= 120, `bpm=${bpm}`);
  }
});

test('같은 시드는 같은 결과 (결정적)', () => {
  assert.deepEqual(composeMelody(12, 7), composeMelody(12, 7));
});

test('다른 시드는 다른 결과', () => {
  const a = composeMelody(12, 1);
  const b = composeMelody(12, 2);
  assert.notDeepEqual(a.notes, b.notes);
});

test('noteCount가 1 미만이면 예외', () => {
  assert.throws(() => composeMelody(0, 1), RangeError);
  assert.throws(() => composeMelody(-3, 1), RangeError);
  assert.throws(() => composeMelody(2.5, 1), RangeError);
});

test('화성은 멜로디 전체 길이를 덮는다 (긴 곡도)', () => {
  const m = composeMelody(53, 3);
  const totalBeats = m.notes.reduce((s, n) => s + n.beats, 0);
  const chords = chordsFor(m);
  assert.ok(chords.length > 0);
  assert.equal(chords[0].startBeat, 0);
  const covered = chords.reduce((s, c) => s + c.beats, 0);
  assert.ok(Math.abs(covered - totalBeats) < 1e-9, `덮인 박 ${covered}, 전체 ${totalBeats}`);
});

test('midiToHz: A4(69)는 440Hz, 한 옥타브 위는 두 배', () => {
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-6);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/composer.test.mjs`
Expected: FAIL — `Cannot find module '.../src/composer.js'`

- [ ] **Step 3: 구현**

`src/composer.js`:

```js
// 장5음계 8음 한 절을 만들어 절마다 반복한다 — 동요의 실제 구조.
// 5음계만 쓰는 이유: 어떤 순서로 나열해도 불협이 생기지 않아
// 무작위 생성이 안전하다.

export const PENTATONIC = [0, 2, 4, 7, 9];
export const VERSE_LEN = 8; // 4음 프레이즈 두 개

export function midiToHz(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// 결정적 PRNG (mulberry32) — 같은 시드면 항상 같은 곡
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PHRASE_LEN = 4;

export function composeMelody(noteCount, seed) {
  if (!Number.isInteger(noteCount) || noteCount < 1) {
    throw new RangeError(`noteCount는 1 이상의 정수여야 한다: ${noteCount}`);
  }
  const rnd = mulberry32(seed);
  const tonicMidi = 60 + Math.floor(rnd() * 5); // C4~E4
  const bpm = 96 + Math.floor(rnd() * 25); // 96~120

  const makePhrase = () =>
    Array.from({ length: PHRASE_LEN }, () => ({
      midi:
        tonicMidi +
        PENTATONIC[Math.floor(rnd() * PENTATONIC.length)] +
        (rnd() < 0.2 ? 12 : 0),
      beats: rnd() < 0.25 ? 0.5 : 1,
    }));

  // 한 절 = 프레이즈 여러 개. VERSE_LEN에서 개수를 끌어내므로 절 길이를 바꿀 때
  // 고칠 곳이 한 군데다 — 상수와 생성 로직이 각자 8을 가정하면 VERSE_LEN만
  // 바꿨을 때 조용히 undefined 노트가 섞인다.
  const verse = Array.from({ length: VERSE_LEN / PHRASE_LEN }, makePhrase).flat();

  // 절을 반복해 음절 수를 채운다. 8의 배수가 아니면 마지막 절은 중간에서 끝난다 —
  // 가짜 음절을 채워 넣지 않는다.
  const notes = Array.from({ length: noteCount }, (_, i) => ({ ...verse[i % VERSE_LEN] }));

  // 끝난 느낌을 위해 마지막은 반드시 으뜸음, 최소 1박
  notes[notes.length - 1] = {
    midi: tonicMidi,
    beats: Math.max(1, notes[notes.length - 1].beats),
  };

  return {
    notes,
    bpm,
    tonicMidi,
    verseLen: VERSE_LEN,
    verseCount: Math.ceil(noteCount / VERSE_LEN),
  };
}

// I - V - vi - IV. 장·단을 degree 값으로 유추하지 않고 함께 선언한다 —
// 진행에 다른 단화음을 넣을 때 고칠 곳이 한 군데여야 한다.
const PROGRESSION = [
  { degree: 0, minor: false },
  { degree: 7, minor: false },
  { degree: 9, minor: true },
  { degree: 5, minor: false },
];
const BAR_BEATS = 4;

export function chordsFor(melody) {
  const totalBeats = melody.notes.reduce((s, n) => s + n.beats, 0);
  const chords = [];
  for (let startBeat = 0, i = 0; startBeat < totalBeats; startBeat += BAR_BEATS, i++) {
    const { degree, minor } = PROGRESSION[i % PROGRESSION.length];
    chords.push({
      rootMidi: melody.tonicMidi - 12 + degree,
      semitones: minor ? [0, 3, 7] : [0, 4, 7],
      startBeat,
      beats: Math.min(BAR_BEATS, totalBeats - startBeat),
    });
  }
  return chords;
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/composer.test.mjs`
Expected: PASS (11 tests)

- [ ] **Step 5: 커밋 명령 제시 (사용자가 실행)**

```bash
cd /mnt/d/ws/study/melody_child && git add src/composer.js test/composer.test.mjs && git commit -m "feat: 5음계 멜로디와 화성 생성"
```

---

### Task 5: WAV 인코딩 (`exporter.js`)

16bit PCM RIFF 헤더를 직접 쓴다. 라이브러리를 넣지 않는다.

**Files:**
- Create: `src/exporter.js`
- Test: `test/exporter.test.mjs`

**Interfaces:**
- Consumes: 없음
- Produces: `encodeWav(channels: Float32Array[], sampleRate: number) -> Blob` (MIME `audio/wav`)

- [ ] **Step 1: 실패하는 테스트 작성**

`test/exporter.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav } from '../src/exporter.js';

const SR = 44100;

async function parse(blob) {
  const view = new DataView(await blob.arrayBuffer());
  const str = (off, len) =>
    String.fromCharCode(...Array.from({ length: len }, (_, i) => view.getUint8(off + i)));
  return {
    view,
    riff: str(0, 4),
    wave: str(8, 4),
    fmt: str(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: str(36, 4),
    dataSize: view.getUint32(40, true),
    chunkSize: view.getUint32(4, true),
  };
}

test('모노 WAV 헤더가 올바르다', async () => {
  const blob = encodeWav([new Float32Array(100)], SR);
  const h = await parse(blob);
  assert.equal(h.riff, 'RIFF');
  assert.equal(h.wave, 'WAVE');
  assert.equal(h.fmt, 'fmt ');
  assert.equal(h.audioFormat, 1);
  assert.equal(h.channels, 1);
  assert.equal(h.sampleRate, SR);
  assert.equal(h.bitsPerSample, 16);
  assert.equal(h.blockAlign, 2);
  assert.equal(h.byteRate, SR * 2);
  assert.equal(h.data, 'data');
  assert.equal(h.dataSize, 200);
  assert.equal(h.chunkSize, blob.size - 8);
  assert.equal(blob.size, 44 + 200);
  assert.equal(blob.type, 'audio/wav');
});

test('스테레오는 채널을 인터리브한다', async () => {
  const left = Float32Array.from([1, 0]);
  const right = Float32Array.from([-1, 0]);
  const h = await parse(encodeWav([left, right], SR));
  assert.equal(h.channels, 2);
  assert.equal(h.blockAlign, 4);
  assert.equal(h.dataSize, 2 * 2 * 2);
  assert.equal(h.view.getInt16(44, true), 32767); // L[0]
  assert.equal(h.view.getInt16(46, true), -32768); // R[0]
});

test('±1을 넘는 값은 클리핑한다', async () => {
  const h = await parse(encodeWav([Float32Array.from([2.5, -2.5])], SR));
  assert.equal(h.view.getInt16(44, true), 32767);
  assert.equal(h.view.getInt16(46, true), -32768);
});

test('빈 채널 배열은 예외', () => {
  assert.throws(() => encodeWav([], SR), RangeError);
});

test('채널 길이가 다르면 예외 (조용히 0으로 채우지 않는다)', () => {
  assert.throws(() => encodeWav([new Float32Array(10), new Float32Array(5)], SR), RangeError);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test test/exporter.test.mjs`
Expected: FAIL — `Cannot find module '.../src/exporter.js'`

- [ ] **Step 3: 구현**

`src/exporter.js`:

```js
// Float32 채널들을 16bit PCM WAV Blob으로 인코딩한다.

export function encodeWav(channels, sampleRate) {
  if (!Array.isArray(channels) || channels.length === 0) {
    throw new RangeError('channels는 비어 있을 수 없다');
  }
  const numCh = channels.length;
  const frames = channels[0].length;
  // 길이가 다르면 짧은 채널에서 undefined를 읽어 조용히 0으로 기록된다.
  for (let c = 1; c < numCh; c++) {
    if (channels[c].length !== frames) {
      throw new RangeError(`채널 길이가 다르다: ${frames} vs ${channels[c].length}`);
    }
  }
  const dataSize = frames * numCh * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt 청크 크기
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numCh, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numCh * 2, true);
  view.setUint16(32, numCh * 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numCh; c++) {
      const clamped = Math.max(-1, Math.min(1, channels[c][i]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test test/exporter.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: 전체 순수 모듈 테스트 확인**

Run: `node --test`
Expected: PASS — 34 tests (devsample 2 + slicer 8 + pitch 8 + composer 11 + exporter 5)

- [ ] **Step 6: 커밋 명령 제시 (사용자가 실행)**

```bash
cd /mnt/d/ws/study/melody_child && git add src/exporter.js test/exporter.test.mjs && git commit -m "feat: 16bit PCM WAV 인코딩"
```

---

### Task 6: 오디오 그래프와 개발 하네스 (`synth.js`, `dev.html`)

브라우저 모듈의 첫 태스크. `buildGraph`가 컨텍스트를 **인자로** 받는 이유는 재생(`AudioContext`)과 WAV 렌더(`OfflineAudioContext`)가 같은 코드로 같은 소리를 내야 하기 때문이다. 렌더 경로를 따로 쓰면 두 결과가 조용히 갈라진다.

이 태스크에는 `dev.html`이 포함된다. 마이크 없이 파이프라인 전체를 돌릴 방법이 없으면 `synth.js`가 동작한다고 주장할 수 없다.

**Files:**
- Create: `src/synth.js`, `dev.html`
- Test: 브라우저 실측 (`dev.html`)

**Interfaces:**
- Consumes: `midiToHz` (Task 4), `sliceSyllables` (Task 2), `detectF0` (Task 3), `composeMelody`/`chordsFor` (Task 4), `encodeWav` (Task 5), `makeDevSample` (Task 1)
- Produces:
  - `buildGraph(ctx, {audioBuffer, segments, f0s, melody, chords}) -> {durationSec: number}` — `segments.length === melody.notes.length`가 아니면 `RangeError`
  - `renderOffline({audioBuffer, segments, f0s, melody, chords}) -> Promise<AudioBuffer>`

- [ ] **Step 1: `synth.js` 구현**

`src/synth.js`:

```js
import { midiToHz } from './composer.js';

const ACCOMP_GAIN = 0.5; // 목소리보다 약 6dB 낮게 — 가사가 묻히지 않게
// 마지막 음이 끝난 뒤 남기는 여유. 재생 길이 보고와 오프라인 렌더 버퍼 할당이
// 같은 값을 써야 한다 — 따로 두면 한쪽만 고쳤을 때 꼬리가 잘린다.
const TAIL_SEC = 0.5;

// 조각 하나를 목표 음정·목표 길이로 스케줄링한다.
// 재생 속도를 바꾸면 길이도 함께 바뀌므로(Web Audio는 playbackRate와 detune을
// 곱해 하나의 속도로 합산한다), 부족한 길이는 조각 후반을 루프해 채운다.
function scheduleSegment(ctx, dest, buffer, seg, rate, when, noteSec) {
  const sr = buffer.sampleRate;
  const segSec = (seg.end - seg.start) / sr;
  const playableSec = segSec / rate;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;

  const gain = ctx.createGain();
  const attack = 0.008;
  const release = 0.02;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(1, when + attack);
  gain.gain.setValueAtTime(1, when + Math.max(attack, noteSec - release));
  gain.gain.linearRampToValueAtTime(0, when + noteSec);

  src.connect(gain);
  gain.connect(dest);

  if (playableSec >= noteSec) {
    src.start(when, seg.start / sr, noteSec * rate);
  } else {
    // 뒤쪽 60%를 루프 구간으로 — 모음의 안정된 부분이 여기 있다
    src.loop = true;
    src.loopStart = seg.start / sr + segSec * 0.4;
    src.loopEnd = seg.end / sr;
    src.start(when, seg.start / sr);
    src.stop(when + noteSec);
  }
}

function makeNoiseBuffer(ctx) {
  const length = Math.round(ctx.sampleRate * 0.06);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let s = 12345;
  for (let i = 0; i < length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    data[i] = s / 0x3fffffff - 1;
  }
  return buffer;
}

function scheduleAccompaniment(ctx, dest, melody, chords, secPerBeat) {
  for (const chord of chords) {
    const when = chord.startBeat * secPerBeat;
    const dur = chord.beats * secPerBeat;
    for (const semitone of chord.semitones) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToHz(chord.rootMidi + semitone);
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(0.12, when + 0.05);
      gain.gain.linearRampToValueAtTime(0, when + dur);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(when);
      osc.stop(when + dur);
    }
  }

  // 8분음표 셰이커 — 정박을 조금 세게
  const totalBeats = melody.notes.reduce((s, n) => s + n.beats, 0);
  const noise = makeNoiseBuffer(ctx);
  for (let beat = 0; beat < totalBeats; beat += 0.5) {
    const when = beat * secPerBeat;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(beat % 1 === 0 ? 0.09 : 0.045, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    src.connect(hp);
    hp.connect(gain);
    gain.connect(dest);
    src.start(when);
    src.stop(when + 0.06);
  }
}

export function buildGraph(ctx, { audioBuffer, segments, f0s, melody, chords }) {
  if (segments.length !== melody.notes.length) {
    throw new RangeError(
      `segments(${segments.length})와 notes(${melody.notes.length}) 개수가 다르다 — 호출 전에 정규화할 것`,
    );
  }

  const secPerBeat = 60 / melody.bpm;

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const voiceBus = ctx.createGain();
  voiceBus.gain.value = 1;
  voiceBus.connect(master);

  const accompBus = ctx.createGain();
  accompBus.gain.value = ACCOMP_GAIN;
  accompBus.connect(master);

  let when = 0;
  melody.notes.forEach((note, i) => {
    const f0 = f0s[i];
    // f0가 null인 조각(무성 자음)은 음정 이동을 포기하고 원음 그대로 — 리듬만 맞춘다
    const rate = f0 ? midiToHz(note.midi) / f0 : 1;
    const noteSec = note.beats * secPerBeat;
    scheduleSegment(ctx, voiceBus, audioBuffer, segments[i], rate, when, noteSec);
    when += noteSec;
  });

  scheduleAccompaniment(ctx, accompBus, melody, chords, secPerBeat);

  return { durationSec: when + TAIL_SEC };
}

export async function renderOffline(spec) {
  const secPerBeat = 60 / spec.melody.bpm;
  const totalBeats = spec.melody.notes.reduce((s, n) => s + n.beats, 0);
  const sampleRate = spec.audioBuffer.sampleRate;
  const length = Math.ceil((totalBeats * secPerBeat + TAIL_SEC) * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  buildGraph(ctx, spec);
  return ctx.startRendering();
}
```

- [ ] **Step 2: 개발 하네스 작성**

`dev.html`:

```html
<meta charset="utf-8" />
<title>melody_child 개발 하네스</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; max-width: 40rem; }
  button { font-size: 1rem; padding: 0.5rem 1rem; margin-right: 0.5rem; }
  pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; }
</style>
<h1>개발 하네스</h1>
<p>마이크 없이 합성 신호로 분할 → 음높이 → 작곡 → 연주 → WAV 전체를 돌립니다.</p>
<button id="play">재생</button>
<button id="save">WAV 저장</button>
<pre id="log">준비됨</pre>
<script type="module">
  import { makeDevSample, DEV_SAMPLE_F0S } from './src/devsample.js';
  import { sliceSyllables } from './src/slicer.js';
  import { detectF0 } from './src/pitch.js';
  import { composeMelody, chordsFor } from './src/composer.js';
  import { buildGraph, renderOffline } from './src/synth.js';
  import { encodeWav } from './src/exporter.js';

  const logEl = document.getElementById('log');
  const lines = [];
  const log = (msg) => {
    lines.push(msg);
    logEl.textContent = lines.join('\n');
    console.log(msg);
  };

  function buildSpec(ctx, seed) {
    const sampleRate = ctx.sampleRate;
    const samples = makeDevSample(sampleRate);
    const audioBuffer = ctx.createBuffer(1, samples.length, sampleRate);
    audioBuffer.copyToChannel(samples, 0);

    const segments = sliceSyllables(samples, sampleRate);
    const f0s = segments.map((seg) => detectF0(samples.subarray(seg.start, seg.end), sampleRate));
    const melody = composeMelody(segments.length, seed);
    const chords = chordsFor(melody);

    log(`조각 ${segments.length}개 (기대 ${DEV_SAMPLE_F0S.length})`);
    log(`f0: ${f0s.map((f) => (f === null ? 'null' : f.toFixed(1))).join(', ')}`);
    log(`정답: ${DEV_SAMPLE_F0S.join(', ')}`);
    log(`bpm ${melody.bpm}, 으뜸음 ${melody.tonicMidi}, 음 ${melody.notes.length}개`);
    return { audioBuffer, segments, f0s, melody, chords };
  }

  // 브라우저는 동시에 살아 있는 AudioContext 수를 제한한다. 이 페이지는 반복
  // 클릭이 용도이므로 새로 만들기 전에 이전 것을 닫는다.
  let playing = null;

  document.getElementById('play').addEventListener('click', async () => {
    if (playing) await playing.close();
    const ctx = new AudioContext();
    playing = ctx;
    await ctx.resume();
    const spec = buildSpec(ctx, 1);
    const { durationSec } = buildGraph(ctx, spec);
    log(`재생 ${durationSec.toFixed(2)}초`);
  });

  document.getElementById('save').addEventListener('click', async () => {
    const probe = new AudioContext();
    const spec = buildSpec(probe, 2);
    await probe.close();
    const rendered = await renderOffline(spec);
    const channels = Array.from({ length: rendered.numberOfChannels }, (_, c) =>
      rendered.getChannelData(c),
    );
    const blob = encodeWav(channels, rendered.sampleRate);
    log(`렌더 완료: ${rendered.duration.toFixed(2)}초, ${blob.size}바이트`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'dev-sample.wav';
    a.click();
    URL.revokeObjectURL(url);
  });
</script>
```

- [ ] **Step 3: 정적 서버 실행**

`.claude/launch.json`을 만들어 preview 도구로 서버를 띄운다. 이 서버는 Windows에서 실행되므로 `python`이고, README에 적는 사용자용 명령은 WSL 기준이라 `python3`이다 — 둘이 다른 건 의도된 것이다.

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "melody-child",
      "runtimeExecutable": "python",
      "runtimeArgs": ["-m", "http.server", "8000"],
      "port": 8000
    }
  ]
}
```

- [ ] **Step 4: 브라우저에서 검증**

`http://localhost:8000/dev.html`을 열고:

1. 콘솔 에러가 0건인지 확인한다
2. "재생"을 누르고 로그를 확인한다. **통과 기준:** 조각 6개, f0 6개가 모두 `null`이 아니며 정답(220, 262, 220, 196, 247, 220)과 3% 이내
3. "WAV 저장"을 누른다. **통과 기준:** 렌더 시간이 0보다 크고 바이트 수가 `44 + frames*4`와 일치, 파일이 실제로 다운로드됨
4. 스크린샷으로 로그 내용을 남긴다

`OfflineAudioContext` 렌더가 무음으로 나오면 `buildGraph`가 `ctx.destination`까지 연결됐는지, `startRendering` 전에 그래프를 만들었는지 확인한다.

- [ ] **Step 5: 커밋 명령 제시 (사용자가 실행)**

```bash
cd /mnt/d/ws/study/melody_child && git add src/synth.js dev.html .claude/launch.json && git commit -m "feat: 오디오 그래프 구성과 개발 하네스"
```

---

### Task 7: 마이크 녹음과 받아쓰기 (`recorder.js`)

STT는 **음악 생성에 불필요**하다 — 화면에 가사를 띄우는 용도뿐이다. 그래서 미지원 브라우저에서 실패해도 녹음은 정상 진행되어야 한다.

30초 녹음에서 주의할 점: Chrome의 음성인식기는 침묵이 길어지면 `continuous = true`여도 스스로 종료된다. 이야기를 말하다 잠깐 멈추면 뒷부분 가사가 통째로 빠지므로, `onend`에서 재시작한다. 재시작 시 `event.results`가 초기화되므로 확정된 텍스트는 **누적해서** 보관해야 한다.

**Files:**
- Create: `src/recorder.js`
- Test: 브라우저 실측 (Task 8의 `index.html`에서 함께 확인)

**Interfaces:**
- Consumes: 없음
- Produces:
  - `isSpeechRecognitionSupported() -> boolean`
  - `startRecording({maxMs?, onLevel?, onTranscript?, onAutoStop?}) -> Promise<{stop(): Promise<{audioBuffer: AudioBuffer, transcript: string}>}>`
  - `MAX_RECORD_MS: number` (= 30000)

- [ ] **Step 1: 구현**

`src/recorder.js`:

```js
export const MAX_RECORD_MS = 30000;

export function isSpeechRecognitionSupported() {
  return typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

// 받아쓰기는 음악 생성에 필요하지 않다 — 실패해도 녹음을 막지 않는다.
function startTranscription(onTranscript) {
  if (!isSpeechRecognitionSupported()) return null;
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
  const recognition = new Ctor();
  recognition.lang = 'ko-KR';
  recognition.continuous = true;
  recognition.interimResults = true;

  // Chrome은 침묵이 길면 스스로 종료하고, 재시작하면 event.results가 비워진다.
  // 따라서 세션이 끝날 때마다 확정 텍스트를 누적해 둔다.
  const state = { committed: '', current: '', done: false };
  const joined = () => `${state.committed} ${state.current}`.trim();

  recognition.onresult = (event) => {
    let finalText = '';
    let interim = '';
    for (const result of event.results) {
      if (result.isFinal) finalText += result[0].transcript;
      else interim += result[0].transcript;
    }
    state.current = finalText;
    onTranscript(`${state.committed} ${finalText}${interim}`.trim());
  };

  recognition.onerror = () => {}; // network/no-speech는 무시 — 음악은 계속된다

  recognition.onend = () => {
    state.committed = joined();
    state.current = '';
    if (state.done) return;
    try {
      recognition.start(); // 침묵으로 끊긴 것 — 다시 듣는다
    } catch {
      /* 이미 시작된 경우 무시 */
    }
  };

  try {
    recognition.start();
  } catch {
    return null;
  }
  return { recognition, state, text: joined };
}

export async function startRecording({
  maxMs = MAX_RECORD_MS,
  onLevel = () => {},
  onTranscript = () => {},
  onAutoStop = () => {},
} = {}) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });

  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  const stopped = new Promise((resolve) => {
    recorder.onstop = resolve;
  });
  recorder.start();

  const frame = new Float32Array(analyser.fftSize);
  let rafId = requestAnimationFrame(function tick() {
    analyser.getFloatTimeDomainData(frame);
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
    onLevel(Math.sqrt(sum / frame.length));
    rafId = requestAnimationFrame(tick);
  });

  const transcriber = startTranscription(onTranscript);

  const timer = setTimeout(() => {
    if (recorder.state === 'recording') {
      recorder.stop();
      onAutoStop();
    }
  }, maxMs);

  return {
    async stop() {
      clearTimeout(timer);
      cancelAnimationFrame(rafId);
      if (recorder.state === 'recording') recorder.stop();
      await stopped;
      stream.getTracks().forEach((track) => track.stop());
      if (transcriber) {
        transcriber.state.done = true; // onend에서 재시작하지 않게
        try {
          transcriber.recognition.stop();
        } catch {
          /* 이미 멈춘 경우 */
        }
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      try {
        const audioBuffer = await ctx.decodeAudioData(await blob.arrayBuffer());
        return { audioBuffer, transcript: transcriber ? transcriber.text() : '' };
      } finally {
        // 디코딩이 실패해도 분석용 컨텍스트는 닫는다 — 실패가 반복되면 쌓인다
        await ctx.close();
      }
    },
  };
}
```

- [ ] **Step 2: 커밋 명령 제시 (사용자가 실행)**

```bash
cd /mnt/d/ws/study/melody_child && git add src/recorder.js && git commit -m "feat: 마이크 녹음과 선택적 받아쓰기"
```

---

### Task 8: 화면 통합 (`index.html`, `src/ui.js`, `README.md`)

3상태 머신, 파형 그리기, 버튼 4개, 조각 개수 정규화, 에러 처리를 붙여 앱을 완성한다.

**Files:**
- Create: `index.html`, `src/ui.js`, `README.md`
- Test: 브라우저 실측

**Interfaces:**
- Consumes: 앞선 모든 모듈
- Produces: 없음 (최종 소비자)

- [ ] **Step 1: `ui.js` 구현**

`src/ui.js`:

```js
import { sliceSyllables } from './slicer.js';
import { detectF0 } from './pitch.js';
import { composeMelody, chordsFor } from './composer.js';
import { buildGraph, renderOffline } from './synth.js';
import { encodeWav } from './exporter.js';
import { startRecording, isSpeechRecognitionSupported, MAX_RECORD_MS } from './recorder.js';
import { makeDevSample } from './devsample.js';

const MIN_NOTES = 8; // 한 절

const el = (id) => document.getElementById(id);
const screens = { idle: el('screen-idle'), recording: el('screen-recording'), result: el('screen-result') };

let session = null; // { audioBuffer, segments, f0s, transcript, rawCount }
let seed = 1;
let handle = null;
let playing = null; // AudioContext

function show(name) {
  for (const [key, node] of Object.entries(screens)) {
    node.hidden = key !== name;
  }
}

function setNotice(text) {
  el('notice').textContent = text;
}

// 조각이 한 절(8개)보다 적으면 순환 반복해 채운다. 상한은 없다 —
// 이야기가 길면 절이 늘어난다. 이 정규화를 여기서 끝내므로
// synth.buildGraph는 개수 불일치를 다루지 않는다.
function normalizeSegments(segments) {
  const out = segments.slice();
  for (let i = 0; out.length < MIN_NOTES; i++) out.push(segments[i % segments.length]);
  return out;
}

function drawWaveform(samples, segments) {
  const canvas = el('waveform');
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = '#e8f0fe';
  ctx.fillRect(0, 0, width, height);

  const step = Math.max(1, Math.floor(samples.length / width));
  ctx.strokeStyle = '#3b6fd4';
  ctx.beginPath();
  for (let x = 0; x < width; x++) {
    let peak = 0;
    const from = x * step;
    for (let i = from; i < from + step && i < samples.length; i++) {
      peak = Math.max(peak, Math.abs(samples[i]));
    }
    const h = peak * height * 0.45;
    ctx.moveTo(x, height / 2 - h);
    ctx.lineTo(x, height / 2 + h);
  }
  ctx.stroke();

  ctx.strokeStyle = '#d94f4f';
  ctx.lineWidth = 1;
  for (const seg of segments) {
    for (const pos of [seg.start, seg.end]) {
      const x = (pos / samples.length) * width;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
  }
}

function analyze(audioBuffer, transcript) {
  const samples = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const found = sliceSyllables(samples, sampleRate);
  if (found.length === 0) return null;

  const segments = normalizeSegments(found);
  const f0s = segments.map((seg) => detectF0(samples.subarray(seg.start, seg.end), sampleRate));
  drawWaveform(samples, found);
  return { audioBuffer, segments, f0s, transcript, rawCount: found.length };
}

function stopPlayback() {
  if (playing) {
    playing.close();
    playing = null;
  }
}

async function play() {
  stopPlayback();
  // await 사이에 "새 멜로디"·"다시 녹음"이 끼어들 수 있다. 세션을 지금 붙잡고,
  // 재개된 뒤에는 이 컨텍스트가 아직 최신인지 확인한다 — 그러지 않으면 이미
  // 닫힌 컨텍스트에 그래프를 붙이거나 비워진 세션을 읽는다.
  const current = session;
  if (!current) return;

  const melody = composeMelody(current.segments.length, seed);
  const ctx = new AudioContext();
  playing = ctx;
  await ctx.resume();
  if (playing !== ctx) return;

  buildGraph(ctx, {
    audioBuffer: current.audioBuffer,
    segments: current.segments,
    f0s: current.f0s,
    melody,
    chords: chordsFor(melody),
  });
}

async function save() {
  const melody = composeMelody(session.segments.length, seed);
  const rendered = await renderOffline({
    audioBuffer: session.audioBuffer,
    segments: session.segments,
    f0s: session.f0s,
    melody,
    chords: chordsFor(melody),
  });
  const channels = Array.from({ length: rendered.numberOfChannels }, (_, c) => rendered.getChannelData(c));
  const url = URL.createObjectURL(encodeWav(channels, rendered.sampleRate));
  const link = document.createElement('a');
  link.href = url;
  link.download = '내동요.wav';
  link.click();
  URL.revokeObjectURL(url);
}

function showResult() {
  el('lyrics').textContent = session.transcript;
  el('lyrics').hidden = !session.transcript;
  const melody = composeMelody(session.segments.length, seed);
  const notes = [`${melody.verseCount}절 노래가 됐어요.`];
  if (session.rawCount < MIN_NOTES) notes.push('소리가 적어서 몇 번 반복했어요.');
  el('result-note').textContent = notes.join(' ');
  show('result');
}

async function startSession() {
  setNotice('');
  try {
    handle = await startRecording({
      onLevel: (level) => {
        el('level').style.width = `${Math.min(100, level * 400)}%`;
      },
      onTranscript: (text) => {
        el('live-transcript').textContent = text;
      },
      onAutoStop: () => {
        finishSession();
      },
    });
  } catch {
    setNotice('마이크를 쓸 수 없어요. 브라우저에서 마이크를 허용해 주세요.');
    show('idle');
    return;
  }
  el('live-transcript').textContent = '';
  el('level').style.width = '0%';
  el('stt-warning').hidden = isSpeechRecognitionSupported();
  show('recording');
}

async function finishSession() {
  if (!handle) return;
  const current = handle;
  handle = null;
  let recording;
  try {
    recording = await current.stop();
  } catch {
    setNotice('녹음을 읽지 못했어요. 다시 해볼까요?');
    show('idle');
    return;
  }
  const analyzed = analyze(recording.audioBuffer, recording.transcript);
  if (!analyzed) {
    setNotice('소리가 너무 작아요. 조금 더 크게 말해 주세요.');
    show('idle');
    return;
  }
  session = analyzed;
  seed = 1;
  showResult();
  play().catch(() => setNotice('노래를 틀지 못했어요. 다시 듣기를 눌러 주세요.'));
}

function loadDevSample() {
  const ctx = new AudioContext();
  const samples = makeDevSample(ctx.sampleRate);
  const audioBuffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  audioBuffer.copyToChannel(samples, 0);
  ctx.close();
  const analyzed = analyze(audioBuffer, '개발용 샘플');
  if (!analyzed) throw new Error('개발 샘플 분석 실패');
  session = analyzed;
  showResult();
}

// 녹음 경로처럼 재생·저장 경로도 실패를 화면에 알린다. 감싸지 않으면 미처리
// 프로미스 거부로 콘솔에만 남고, 사용자에겐 아무 설명 없이 소리만 안 난다.
function guarded(action, message) {
  return async () => {
    try {
      await action();
    } catch {
      setNotice(message);
    }
  };
}

el('start').addEventListener('click', startSession);
el('stop').addEventListener('click', finishSession);
el('replay').addEventListener('click', guarded(play, '노래를 다시 틀지 못했어요.'));
el('remix').addEventListener(
  'click',
  guarded(() => {
    seed += 1;
    return play();
  }, '새 멜로디를 만들지 못했어요.'),
);
el('download').addEventListener('click', guarded(save, 'WAV 파일을 만들지 못했어요.'));
el('again').addEventListener('click', () => {
  stopPlayback();
  session = null;
  setNotice('');
  show('idle');
});

el('limit-hint').textContent = `${MAX_RECORD_MS / 1000}초까지 녹음돼요.`;

if (new URLSearchParams(location.search).get('dev') === 'sample') {
  loadDevSample();
} else {
  show('idle');
}
```

- [ ] **Step 2: `index.html` 작성**

```html
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>오늘 이야기로 동요 만들기</title>
<style>
  :root { color-scheme: light; }
  body {
    font-family: system-ui, -apple-system, sans-serif;
    margin: 0 auto;
    padding: 2rem 1.25rem;
    max-width: 34rem;
    color: #1e2430;
  }
  h1 { font-size: 1.4rem; margin-bottom: 0.25rem; }
  p.sub { color: #5a6472; margin-top: 0; }
  button {
    font: inherit;
    padding: 0.7rem 1.1rem;
    border: 0;
    border-radius: 0.6rem;
    background: #3b6fd4;
    color: #fff;
    cursor: pointer;
  }
  button.ghost { background: #eef1f6; color: #1e2430; }
  #start, #stop { font-size: 1.2rem; padding: 1.1rem 2rem; border-radius: 999px; }
  .buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 1rem; }
  #meter { height: 0.75rem; background: #eef1f6; border-radius: 999px; overflow: hidden; margin: 1.5rem 0; }
  #level { height: 100%; width: 0%; background: #3b6fd4; transition: width 0.06s linear; }
  #waveform { width: 100%; height: 120px; border-radius: 0.6rem; }
  #lyrics { font-size: 1.15rem; margin: 0.75rem 0 0; }
  #notice, #result-note, #stt-warning { color: #a3560f; min-height: 1.4em; }
  #live-transcript { font-size: 1.15rem; min-height: 1.6em; color: #3b6fd4; }
</style>

<h1>오늘 이야기로 동요 만들기</h1>
<p class="sub">오늘 있었던 일을 말하면 그 목소리가 그대로 노래가 돼요.</p>
<p id="notice"></p>

<section id="screen-idle" hidden>
  <button id="start">녹음 시작</button>
  <p class="sub" id="limit-hint"></p>
  <p class="sub">또박또박 끊어서 말하면 더 잘 만들어져요. 이야기가 길면 절이 늘어나요.</p>
</section>

<section id="screen-recording" hidden>
  <div id="meter"><div id="level"></div></div>
  <p id="live-transcript"></p>
  <p id="stt-warning" hidden>이 브라우저는 받아쓰기를 지원하지 않아요. 노래는 그대로 만들어져요.</p>
  <button id="stop">그만</button>
</section>

<section id="screen-result" hidden>
  <canvas id="waveform" width="640" height="120"></canvas>
  <p id="lyrics" hidden></p>
  <p id="result-note"></p>
  <div class="buttons">
    <button id="replay">다시 듣기</button>
    <button id="remix" class="ghost">새 멜로디</button>
    <button id="download" class="ghost">WAV 저장</button>
    <button id="again" class="ghost">다시 녹음</button>
  </div>
</section>

<script type="module" src="./src/ui.js"></script>
```

- [ ] **Step 3: 개발 샘플 경로로 검증 (마이크 없이)**

`http://localhost:8000/index.html?dev=sample`을 연다.

**통과 기준:**
- 콘솔 에러 0건
- 결과 화면이 바로 뜨고 파형에 경계선 6쌍이 그려진다
- "다시 듣기"를 누르면 소리가 난다
- "새 멜로디"를 누르면 **다른** 멜로디가 난다
- "WAV 저장"이 `내동요.wav`를 내려받는다
- 스크린샷을 남긴다

- [ ] **Step 4: 마이크 경로 확인 (사용자 확인 필요)**

`http://localhost:8000/`을 열고 실제로 말해서 확인한다. 마이크 입력은 자동 검증이 불가능하므로 **이 스텝은 사용자에게 확인을 요청한다.**

확인 항목: 마이크 권한 요청이 뜨는지, 레벨 미터가 움직이는지, 받아쓰기 글자가 실시간으로 보이는지, 30초에 자동으로 멈추는지, 말 중간에 잠깐 쉬어도 뒷부분 받아쓰기가 이어지는지(음성인식 재시작), 결과가 재생되는지, 절 개수 안내가 맞는지.

- [ ] **Step 5: `README.md` 작성**

```markdown
# melody_child

오늘 있었던 이야기를 말하면, 그 목소리를 음절 단위로 잘라 각 조각을 멜로디 음정으로 옮겨 동요를 만드는 정적 웹페이지.
목소리를 합성하지 않고 실제 녹음을 악기로 재사용한다. 외부 API·백엔드·의존성 없음.

8음 한 절을 만들고 음절 수만큼 절을 반복한다 — 동요가 원래 같은 곡조를 절마다 반복하는 구조라서,
이야기가 길어져도 곡이 산만해지지 않는다. 녹음은 30초까지.

## 실행

ES 모듈을 쓰기 때문에 `file://`로 열면 동작하지 않는다. 정적 서버로 띄운다.

```bash
python3 -m http.server 8000
```

- 앱: http://localhost:8000/
- 마이크 없이 파이프라인 확인: http://localhost:8000/index.html?dev=sample
- 모듈별 로그가 필요할 때: http://localhost:8000/dev.html

## 테스트

```bash
node --test
```

순수 모듈(`devsample`·`slicer`·`pitch`·`composer`·`exporter`)만 자동 테스트한다.
브라우저에 묶인 `recorder`·`synth`·`ui`는 위 개발 경로로 확인한다.

## 브라우저 지원

Chrome·Edge에서 전 기능. Firefox는 Web Speech API를 지원하지 않아 가사 표시만 빠지고 노래는 정상 동작한다.
Safari는 `webkitSpeechRecognition`을 지원하지만 `continuous` 모드에 알려진 문제가 있어 받아쓰기가 불안정할 수 있다 — 노래 생성은 오디오만 쓰므로 영향받지 않는다.

## 배포

GitHub Pages 등 정적 호스팅에 그대로 올리면 된다. 서버 코드는 없다.
HTTPS가 필요하다 — 마이크와 음성인식 모두 보안 컨텍스트를 요구한다.
```

- [ ] **Step 6: 전체 테스트 재확인**

Run: `node --test`
Expected: PASS — 34 tests

- [ ] **Step 7: 커밋 명령 제시 (사용자가 실행)**

```bash
cd /mnt/d/ws/study/melody_child && git add index.html src/ui.js README.md && git commit -m "feat: 녹음부터 저장까지 화면 통합"
```

---

## 최초 push (사용자가 실행)

원격 저장소에 기존 커밋이 있는지 확인되지 않았다. 비어 있으면 첫 줄, 이미 내용이 있으면 두 줄을 순서대로 실행한다.

```bash
cd /mnt/d/ws/study/melody_child && git push -u origin HEAD
```

```bash
cd /mnt/d/ws/study/melody_child && git pull --rebase origin main && git push -u origin HEAD
```

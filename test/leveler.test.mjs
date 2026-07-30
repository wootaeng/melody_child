import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ridePlan, applyRide, RIDE_HOP_MS, RIDE_MAX_DB, RIDE_SLOPE_DB_PER_SEC } from '../src/leveler.js';
import { makeDevSample } from '../src/devsample.js';

const SR = 48000;
const db = (x) => 20 * Math.log10(x);

// 어절마다 레벨이 다른 발화. 실기에서 안 들리는 부분은 "녹음 전체가 작다"가 아니라
// **어절 사이 격차**이므로(녹음 AGC는 초 단위로 움직여 그 격차를 남긴다) 픽스처가
// 그 격차를 가져야 한다. 기존 synth 테스트의 speechLike는 레벨이 균일해 못 잡는다.
//
// 마지막에 파열음 한 방을 넣는다: 피크는 최대치에 가깝지만 0.2ms뿐이라 프레임 RMS는
// 낮다 — 부스트를 요구하면서 올릴 여유가 없는 프레임이고, 피크 상한이 없으면 여기서
// 클리핑한다. 슬라이서가 RETRY_FACTORS로 우회한 "마이크를 탁 친 한 프레임"과 같은 부류다.
const WORD_SEC = 0.4;
const GAP_SEC = 0.2;
const WORD_DB = [0, -6, -15, -24];
const NOISE = 0.001;

function speechWithDynamics() {
  const step = Math.round((WORD_SEC + GAP_SEC) * SR);
  const out = new Float32Array(step * (WORD_DB.length + 1));
  for (const [w, level] of WORD_DB.entries()) {
    const amp = 0.5 * Math.pow(10, level / 20);
    let phase = 0;
    for (let i = 0; i < Math.round(WORD_SEC * SR); i++) {
      phase += (2 * Math.PI * 150) / SR;
      let s = 0;
      for (let k = 1; k <= 8; k++) s += Math.sin(k * phase) / k;
      const env = Math.min(1, i / (0.01 * SR), (Math.round(WORD_SEC * SR) - i) / (0.01 * SR));
      out[w * step + i] = amp * env * (s / 2.1);
    }
  }
  // 파열음: 0.2ms
  const burstAt = WORD_DB.length * step + Math.round(0.1 * SR);
  for (let i = 0; i < Math.round(0.0002 * SR); i++) out[burstAt + i] = 0.48;
  // 상시 잡음 바닥(결정적)
  for (let i = 0; i < out.length; i++) out[i] += NOISE * Math.sin((2 * Math.PI * 3000 * i) / SR);
  return out;
}

// 프레임 RMS(dB). ridePlan과 같은 hop을 쓴다.
function frameDbs(samples, from = 0, length = samples.length) {
  const hop = Math.round((SR * RIDE_HOP_MS) / 1000);
  const out = [];
  for (let f = 0; (f + 1) * hop <= length; f++) {
    let sum = 0;
    for (let i = from + f * hop; i < from + (f + 1) * hop; i++) sum += samples[i] * samples[i];
    out.push(db(Math.sqrt(sum / hop)));
  }
  return out;
}

const percentile = (values, p) => {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

// 유성 프레임만 본 동적 범위. 잡음 바닥까지 넣으면 그것이 10분위를 정해버린다.
function spread(samples) {
  const all = frameDbs(samples);
  const top = Math.max(...all);
  const voiced = all.filter((d) => d > top - 40);
  return percentile(voiced, 0.9) - percentile(voiced, 0.1);
}

const peakOf = (s) => s.reduce((m, x) => Math.max(m, Math.abs(x)), 0);

test('조용한 어절이 올라와 동적 범위가 좁아진다', () => {
  const src = speechWithDynamics();
  const plan = ridePlan(src, SR, 0, src.length);
  const rid = applyRide(src, plan);
  const before = spread(src);
  const after = spread(rid);
  assert.ok(before - after >= 5, `동적 범위 ${before.toFixed(1)} → ${after.toFixed(1)}dB`);
  assert.ok(plan.meanBoostDb > 0, `평균 부스트 ${plan.meanBoostDb}`);
});

test('피크가 올라가지 않는다 (클리핑 여유를 건드리지 않는다)', () => {
  // 이 성질이 있어야 mixLevels·master를 한 줄도 고치지 않고 라이드를 얹을 수 있다.
  // 파열음 프레임이 이 단정을 지킨다 — 피크 상한이 없으면 0.48 × 부스트가 1을 넘는다.
  const src = speechWithDynamics();
  const rid = applyRide(src, ridePlan(src, SR, 0, src.length));
  assert.ok(
    peakOf(rid) <= peakOf(src) + 1e-6,
    `피크 ${peakOf(src).toFixed(4)} → ${peakOf(rid).toFixed(4)}`,
  );
});

test('큰 어절은 비트 단위로 그대로다 (목소리를 균일하게 뭉개지 않는다)', () => {
  const src = speechWithDynamics();
  const rid = applyRide(src, ridePlan(src, SR, 0, src.length));
  // 첫 어절(가장 큼)의 중앙 50%. 경계 부근은 이웃 프레임 게인이 보간으로 새어 든다 —
  // 그건 급변을 막기 위한 설계이고, "손대지 않는다"는 어절 본체에 대한 주장이다.
  const step = Math.round((WORD_SEC + GAP_SEC) * SR);
  const from = Math.round(WORD_SEC * 0.25 * SR);
  const to = Math.round(WORD_SEC * 0.75 * SR);
  for (let i = from; i < to; i++) {
    assert.equal(rid[i], src[i], `${(i / SR).toFixed(3)}초 샘플이 바뀌었다`);
  }
  assert.ok(step > 0);
});

test('잡음 바닥은 증폭하지 않는다', () => {
  const src = speechWithDynamics();
  const rid = applyRide(src, ridePlan(src, SR, 0, src.length));
  // 가장 조용한 어절(-24dB) 뒤의 쉼 — 여기가 가장 위험하다. 양 끝 한 프레임은
  // 이웃과의 보간 구간이므로 중앙만 본다.
  const step = Math.round((WORD_SEC + GAP_SEC) * SR);
  const gapFrom = 3 * step + Math.round((WORD_SEC + 0.04) * SR);
  const gapTo = 3 * step + Math.round((WORD_SEC + GAP_SEC - 0.04) * SR);
  const rms = (a) => {
    let sum = 0;
    for (let i = gapFrom; i < gapTo; i++) sum += a[i] * a[i];
    return Math.sqrt(sum / (gapTo - gapFrom));
  };
  assert.ok(db(rms(rid) / rms(src)) < 0.5, `쉼이 ${db(rms(rid) / rms(src)).toFixed(2)}dB 올라갔다`);
});

test('게인이 급변하지 않는다 (게인 변화가 파형에 실리지 않는다)', () => {
  const src = speechWithDynamics();
  const { gains } = ridePlan(src, SR, 0, src.length);
  const step = (RIDE_SLOPE_DB_PER_SEC * RIDE_HOP_MS) / 1000;
  for (let i = 1; i < gains.length; i++) {
    const jump = Math.abs(db(gains[i]) - db(gains[i - 1]));
    assert.ok(jump <= step + 1e-6, `프레임 ${i}에서 ${jump.toFixed(2)}dB 점프 (상한 ${step})`);
  }
});

test('부스트 상한을 넘지 않는다', () => {
  const src = speechWithDynamics();
  const { gains, maxBoostDb } = ridePlan(src, SR, 0, src.length);
  assert.ok(maxBoostDb <= RIDE_MAX_DB + 1e-9, `${maxBoostDb}dB`);
  // 여유는 Float32 저장 오차 몫이다(게인 배열이 Float32Array다) — 1e-9로는 부족하다
  for (const g of gains) assert.ok(db(g) <= RIDE_MAX_DB + 1e-5 && g >= 1 - 1e-6, `게인 ${g}`);
});

test('이웃 프레임의 부스트가 보간으로 새어 피크를 넘기지 않는다 (±1프레임 창)', () => {
  // 피크 상한의 창을 ±1프레임으로 잡는 이유를 픽스처로 못 박는다. 자기 프레임만 보면
  // 이 입력에서 실제로 깨진다: 프레임 끝에 붙은 큰 임펄스 바로 다음이 아주 조용해서
  // 그 조용한 프레임이 최대 부스트를 요구하고, 게인은 프레임 중심 사이를 보간하므로
  // **그 부스트가 임펄스에 새어 든다**.
  const hop = Math.round((SR * RIDE_HOP_MS) / 1000);
  const src = new Float32Array(Math.round(0.7 * SR));
  // 0~0.4초: 기준 레벨을 정하는 발성
  for (let i = 0; i < Math.round(0.4 * SR); i++) src[i] = 0.3 * Math.sin((2 * Math.PI * 180 * i) / SR);
  // 임펄스를 프레임 경계 바로 앞에 둔다 — 다음 프레임 중심 쪽으로 보간이 향하는 자리
  const impulseAt = 20 * hop + hop - 20;
  src[impulseAt] = 0.85;
  // 그 뒤는 아주 조용하게(부스트를 요구하되 잡음 바닥보다는 위)
  for (let i = 21 * hop; i < src.length; i++) src[i] = 0.01 * Math.sin((2 * Math.PI * 180 * i) / SR);

  const plan = ridePlan(src, SR, 0, src.length);
  const rid = applyRide(src, plan);
  assert.ok(plan.meanBoostDb > 0, '픽스처가 부스트를 요구하지 않는다');
  assert.ok(
    peakOf(rid) <= peakOf(src) + 1e-6,
    `임펄스가 ${db(peakOf(rid) / peakOf(src)).toFixed(2)}dB 커졌다 — 이웃 프레임의 부스트가 새어 들었다`,
  );
});

test('게인 보간이 프레임 중심을 잇는다 (독립으로 세운 곡선과 일치)', () => {
  // applyRide의 인덱스 계산을 프로덕션과 다른 식으로 다시 세워 비교한다 — 같은 식을
  // 두 번 쓰면 off-by-one이 양쪽에 똑같이 들어가 검증되지 않는다.
  const src = speechWithDynamics();
  const plan = ridePlan(src, SR, 0, src.length);
  const rid = applyRide(src, plan);
  const { gains, hop } = plan;
  const center = (f) => f * hop + hop / 2;
  for (let i = 0; i < gains.length * hop; i++) {
    if (Math.abs(src[i]) < 1e-4) continue; // 0 나눗셈 회피
    let want;
    if (i <= center(0)) want = gains[0];
    else if (i >= center(gains.length - 1)) want = gains[gains.length - 1];
    else {
      const f = Math.floor((i - hop / 2) / hop) + 1; // i가 속한 구간의 오른쪽 프레임
      const t = (i - center(f - 1)) / hop;
      want = gains[f - 1] + (gains[f] - gains[f - 1]) * t;
    }
    const got = rid[i] / src[i];
    assert.ok(Math.abs(got - want) < 2e-4, `샘플 ${i}: 게인 ${got.toFixed(6)} ≠ 기대 ${want.toFixed(6)}`);
  }
});

test('상한 0이면 원본을 그대로 돌려준다 (폰에서의 A/B가 비트 단위여야 한다)', () => {
  const src = speechWithDynamics();
  const plan = ridePlan(src, SR, 0, src.length, { maxBoostDb: 0 });
  assert.equal(plan.meanBoostDb, 0);
  assert.equal(applyRide(src, plan), src, '같은 배열이 아니다 — 복사조차 하지 않아야 한다');
});

test('동적 범위가 이미 좁으면 아무 일도 하지 않는다', () => {
  // 레벨이 균일한 신호를 "무조건 부스트"하지 않는다.
  const src = makeDevSample(SR);
  const plan = ridePlan(src, SR, 0, src.length);
  assert.equal(plan.meanBoostDb, 0, `평균 부스트 ${plan.meanBoostDb}dB`);
  assert.equal(applyRide(src, plan), src);
});

test('길이와 인덱스를 보존한다', () => {
  // 조각 오프셋(chunk.from)이 그대로 유효해야 정렬·스케줄 코드를 안 건드린다.
  const src = speechWithDynamics();
  const from = Math.round(0.15 * SR);
  const len = Math.round(2.0 * SR);
  const rid = applyRide(src, ridePlan(src, SR, from, len));
  assert.equal(rid.length, src.length);
  // 분석 구간 밖은 손대지 않는다 — 앞뒤 침묵이라 올릴 이유가 없다
  for (let i = 0; i < from; i++) assert.equal(rid[i], src[i], `구간 앞 ${i}`);
  for (let i = from + len; i < src.length; i++) assert.equal(rid[i], src[i], `구간 뒤 ${i}`);
});

test('구간 경계에서 게인이 튀지 않는다', () => {
  // 구간 밖은 게인 1이므로 첫·마지막 프레임이 큰 부스트를 받으면 경계가 딱 소리를 낸다.
  // 침식이 양 끝을 0dB로 끌어내려야 한다.
  const src = speechWithDynamics();
  const { gains } = ridePlan(src, SR, 0, src.length);
  const step = (RIDE_SLOPE_DB_PER_SEC * RIDE_HOP_MS) / 1000;
  assert.ok(db(gains[0]) <= step + 1e-6, `첫 프레임 ${db(gains[0]).toFixed(2)}dB`);
  assert.ok(db(gains[gains.length - 1]) <= step + 1e-6, `마지막 프레임 ${db(gains.at(-1)).toFixed(2)}dB`);
});

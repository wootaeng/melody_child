import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  progressAt, voiceSpan, alignToBeats, chunkTiming, mixLevels, PRESET_RESONANCE,
} from '../src/synth.js';
import { ridePlan, applyRide } from '../src/leveler.js';

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

// 쉼 없이 이어 말한 녹음. 자연 간격이 격자와 맞아떨어져 배정이 재료와 같아진다.
// **이 픽스처만 보고 이음매를 판정하면 안 된다** — beatSec 0.6에서 격자가 정확히
// 0.300 = 간격이 되도록 만든 칼날이고, 실제 녹음은 그 점에 앉지 않는다. 예전
// 병합 함수가 "테스트는 초록인데 실기에서는 12개 시나리오 중 1개만 동작"했던 것이
// 이 픽스처만으로 판정했기 때문이다. 그래서 아래 이음매 절은 FIXTURES × BPMS를 훑는다.
const CONTIGUOUS = [
  { start: at(0.0), end: at(0.3) },
  { start: at(0.3), end: at(0.6) },
  { start: at(0.6), end: at(0.9) },
];

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

// ── 조각 이음매 ────────────────────────────────────────────────────────────
//
// 조각마다 페이드 인·아웃을 걸면 출력에서 조각이 붙어 있는 자리에서도 진폭이 0까지
// 떨어졌다 올라온다(실측: 이웃 게인 합 최소 0.000, 경계 40ms 창 RMS -4.8dB).
// 내림 편향 때문에 재료를 건너뛴 경계가 흔해 원본이 불연속이므로, "원본에서도
// 연속일 때만 합친다"는 방식으로는 그 자리를 구제할 수 없었다.
//
// 그래서 모든 조각이 `dur` **뒤로** fade만큼 더 읽으며 내려간다. 뒤 조각은 정확히
// `dur`에서 올라오므로 두 램프가 상보가 되어 합이 1로 유지되고, 원본에서도 이어지는
// 경계라면 두 조각이 **같은 샘플**을 읽어 합이 원본과 정확히 같아진다.
//
// 픽스처 하나·bpm 하나로는 판정할 수 없다. 예전 병합 함수를 통과시킨 것이 정확히
// 그 방식이었다 — 아래는 픽스처 4종 × bpm 3종을 전부 훑는다.

// 또박또박 말한 녹음(간격 0.37초). 격자가 0.3125로 뽑혀 매 조각이 재료를 건너뛴다.
const SYL6 = Array.from({ length: 6 }, (_, i) => ({ start: at(i * 0.37), end: at(i * 0.37 + 0.25) }));
// 실기에서 관측된 7.3초 문장.
const SENTENCE = [
  [0.2, 1.1], [1.25, 2.3], [2.5, 3.15], [3.3, 4.4], [4.6, 5.2], [5.35, 6.4], [6.55, 7.3],
].map(([s, e]) => ({ start: at(s), end: at(e) }));

const FIXTURES = { PHRASES, SYL6, CONTIGUOUS, SENTENCE };
const BPMS = [96, 108, 120];
const eachPlacement = (fn) => {
  for (const bpm of BPMS) {
    for (const [name, bounds] of Object.entries(FIXTURES)) {
      fn(alignToBeats(bounds, SR, 60 / bpm), `${name}@${bpm}bpm`, bounds);
    }
  }
};

// scheduleVoiceChunk가 GainNode에 넣는 automation과 같은 점들. 브라우저 없이
// "경계에서 진폭이 0으로 떨어지는가"를 보려면 이 곡선의 합이 필요하다.
//
// 이 복제가 프로덕션과 갈라질 수 있다는 것이 이 하네스의 한계다(node에는
// OfflineAudioContext가 없다). 실제 스케줄러가 만드는 게인 합과 샘플 단위로 같은지는
// 스펙 문서의 DC ±1 렌더 절차로 브라우저에서 확인한다.
const gainAt = (c, t) => {
  if (t <= 0 || t >= c.readSec) return 0;
  if (t < c.fadeSec) return t / c.fadeSec;
  if (t <= c.plateauSec) return 1;
  return (c.readSec - t) / c.fadeSec;
};
const mixGainAt = (placed, t) => placed.reduce((sum, c) => sum + gainAt(c, t - c.at), 0);

// 고원이 끝나는 시각에 뒤 조각이 바로 올라오는 경계. `joinsNext`가 곧 그 판정이므로
// 둘이 일치하는지도 함께 못 박는다 — 갈라지면 크로스페이드가 엉뚱한 자리에 걸린다.
const joints = (placed) => {
  const out = [];
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1];
    const continues = Math.abs(prev.at + prev.plateauSec - placed[i].at) < 1e-9;
    assert.equal(prev.joinsNext, continues, `조각 ${i - 1}의 joinsNext가 실제 배치와 다르다`);
    if (continues) out.push({ prev, next: placed[i] });
  }
  return out;
};

test('출력이 이어지는 경계에서 게인 합이 1이다 (진폭이 0으로 떨어지지 않는다)', () => {
  let checked = 0;
  eachPlacement(({ placed }, label) => {
    for (const { prev, next } of joints(placed)) {
      const t0 = next.at;
      for (let t = t0; t <= t0 + prev.fadeSec + 1e-12; t += 0.0005) {
        const sum = mixGainAt(placed, t);
        assert.ok(Math.abs(sum - 1) < 1e-9, `${label} 경계 ${t0.toFixed(3)}초: 게인 합 ${sum.toFixed(3)}`);
      }
      checked++;
    }
  });
  assert.ok(checked >= 20, `검사한 경계가 ${checked}개뿐이다 — 픽스처가 이음매를 만들지 못한다`);
});

test('뒤가 이어지는 조각은 페이드 아웃이 음절 위에 걸리지 않는다', () => {
  eachPlacement(({ placed }, label) => {
    for (const [i, c] of placed.entries()) {
      if (!c.joinsNext) continue;
      // 페이드 인은 온셋 위에 걸릴 수밖에 없다(from = 음절 시작) — 출력이 이어지는
      // 경계에서는 앞 조각의 꼬리가 그걸 보상한다. 여기서 보는 것은 뒤쪽뿐이다.
      assert.ok(
        c.plateauSec >= c.syllableSec - 1e-9,
        `${label} 조각 ${i}: 고원 끝 ${c.plateauSec.toFixed(3)}초 < 음절 ${c.syllableSec.toFixed(3)}초`,
      );
      assert.equal(gainAt(c, c.syllableSec), 1, `${label} 조각 ${i}: 음절이 끝나기 전에 게인이 내려간다`);
    }
  });
});

test('뒤에 침묵이 있는 조각은 페이드 아웃이 음절 뒤 쉼을 먼저 쓴다', () => {
  // 이쪽은 재료를 더 읽을 수 없다(더 읽으면 다음 음절 머리를 앞당겨 재생한다) —
  // 그래서 페이드 아웃이 자기 재료 안으로 들어온다. 그 마지막 20ms가 음절 뒤 쉼이면
  // 무해하고, 쉼이 그보다 짧으면 부족분만큼 꼬리가 감쇠한다. **그 부족분이 정확히
  // 쉼의 부족분과 같다**는 것이 이 방식의 대가를 숨기지 않는 단정이다.
  let worstMs = 0;
  eachPlacement(({ placed }, label) => {
    for (const [i, c] of placed.entries()) {
      if (c.joinsNext) continue;
      const tailRoom = c.dur - c.syllableSec; // 재료 안에 남은 쉼
      const eaten = Math.max(0, c.syllableSec - c.plateauSec);
      assert.ok(
        Math.abs(eaten - Math.max(0, c.fadeSec - tailRoom)) < 1e-9,
        `${label} 조각 ${i}: 먹힌 양 ${eaten} ≠ 쉼 부족분 ${Math.max(0, c.fadeSec - tailRoom)}`,
      );
      assert.ok(eaten <= c.fadeSec + 1e-9, `${label} 조각 ${i}: 페이드보다 많이 먹었다`);
      worstMs = Math.max(worstMs, eaten * 1000);
    }
  });
  // 최악값을 드러내 둔다. 20ms(=XFADE_SEC)는 쉼이 전혀 없는 음절에서 페이드 전체가
  // 꼬리에 걸린 경우이고 그것이 이 방식의 상한이다 — 이 값을 넘으면 페이드 길이 계산이
  // 깨진 것이다. 상한이 거슬리면 손댈 곳은 XFADE_SEC 하나다.
  assert.ok(worstMs <= 20 + 1e-6, `음절 꼬리가 최대 ${worstMs.toFixed(1)}ms 감쇠한다 (상한 20ms)`);
});

test('보고하는 길이가 마지막 조각의 꼬리를 포함한다', () => {
  // 이 값을 네 곳이 읽는다 — synth.js의 buildChantGraph·songSeconds, ui.js의
  // 멜로디 음 개수 결정과 진단 칩. 스케줄러에서 +fade하면 나머지 세 곳이 조용히
  // 20ms 틀리므로 생산자를 alignToBeats 하나로 유지한다.
  eachPlacement(({ placed, totalSec }, label) => {
    const last = placed[placed.length - 1];
    assert.ok(
      totalSec >= last.at + last.readSec - 1e-9,
      `${label}: 보고 ${totalSec.toFixed(3)}초 < 마지막 꼬리 ${(last.at + last.readSec).toFixed(3)}초`,
    );
  });
});

test('원본에서도 이어지는 경계는 크로스페이드가 원본을 정확히 복원한다', () => {
  // 출력 샘플마다 어느 원본 샘플이 얼마의 가중치로 들리는지. 이음매에서 두 조각이
  // **같은 샘플**을 읽고 가중치 합이 1이면 x(1-a) + x·a = x — 병합이 사려던 것과
  // 같은 것을 조건 없이 산다.
  const { placed } = alignToBeats(CONTIGUOUS, SR, 0.6);
  const seams = placed.slice(1).map((c, i) => ({ prev: placed[i], next: c }))
    .filter(({ prev, next }) =>
      Math.abs(prev.at + prev.dur - next.at) < 1e-9 && Math.abs(prev.from + prev.dur - next.from) < 1e-9);
  assert.ok(seams.length >= 2, `이음매가 ${seams.length}개뿐이다 — 픽스처를 확인할 것`);

  for (const { prev, next } of seams) {
    for (let t = next.at; t <= next.at + prev.fadeSec + 1e-12; t += 0.0005) {
      const contributions = placed
        .map((c) => ({ w: gainAt(c, t - c.at), src: c.from + (t - c.at) }))
        .filter((x) => x.w > 0);
      const srcs = new Set(contributions.map((x) => +x.src.toFixed(9)));
      assert.equal(srcs.size, 1, `${t.toFixed(4)}초에 서로 다른 원본 지점 ${[...srcs]}가 섞인다`);
      const sum = contributions.reduce((s, x) => s + x.w, 0);
      assert.ok(Math.abs(sum - 1) < 1e-9, `${t.toFixed(4)}초: 가중치 합 ${sum}`);
    }
  }
});

test('겹침은 크로스페이드 길이를 넘지 않는다', () => {
  // dur = spans[i]로 두면(재료를 건너뛰지 않고 겹쳐 더하는 OLA 압축) 겹침이 57~100ms가
  // 되어 자기 자신과의 시간차 합성 = 플랜징·이중 발화가 된다. 의도된 겹침은 readSec뿐이다.
  eachPlacement(({ placed }, label) => {
    for (let i = 1; i < placed.length; i++) {
      assert.ok(
        placed[i - 1].at + placed[i - 1].readSec <= placed[i].at + placed[i].fadeSec + 1e-9,
        `${label} 조각 ${i - 1}이 ${i}을 크로스페이드보다 깊게 덮는다`,
      );
    }
  });
});

test('다음 음절의 머리를 제자리보다 이르게 재생하지 않는다 (말이 이중으로 들리지 않는다)', () => {
  // 조각 i는 출력 시각 `at + τ`에 원본 `from + τ`를 낸다. 따라서 다음 음절 재료
  // (`from ≥ next.from`)에 닿는 것은 `τ ≥ next.from - from`부터이고, 그 출력 시각이
  // 다음 조각의 시작(`next.at`)보다 이르면 **같은 소리가 두 번** 난다 — 앞당겨진 사본이
  // 페이드 아웃 시작점이라 거의 풀 게인이다(리뷰 실측: 앞당긴 사본 0.98 / 제자리 0.0002,
  // 최대 256ms 앞당김). 이 단정이 그 결함을 직접 막는다.
  //
  // 예전 버전은 "건너뛴 양이 페이드보다 작으면 건너뛴다"는 가드를 뒀는데, 정작 위험한
  // 케이스(배정 칸이 재료보다 길어 건너뛴 양이 0인 자리)가 그 가드에 전부 걸려 빠졌다.
  eachPlacement(({ placed }, label) => {
    for (let i = 0; i + 1 < placed.length; i++) {
      const c = placed[i];
      const reachesNext = placed[i + 1].from - c.from; // 다음 음절 재료에 닿는 경과
      if (c.readSec <= reachesNext + 1e-9) continue; // 닿지 않는다
      const early = placed[i + 1].at - (c.at + reachesNext);
      assert.ok(
        early <= 1e-9,
        `${label} 조각 ${i}: 다음 음절 머리를 ${(early * 1000).toFixed(0)}ms 앞당겨 재생한다`,
      );
    }
  });
});

test('배정 칸이 재료보다 길면 그 자리에 침묵이 남는다 (크로스페이드가 없애는 것이 아니다)', () => {
  // 크로스페이드는 **출력이 이어지는** 경계의 딥만 없앤다. 배정 칸이 재료보다 긴 자리는
  // 쉼이고 거기서 소리가 없는 것은 정상이다 — 다만 그런 자리가 얼마나 되는지 드러내
  // 두어야 "이음매를 고쳤으니 끊김이 다 사라졌다"로 읽히지 않는다(실측 51개 경계 중 15개).
  let joined = 0;
  let gapped = 0;
  let maxGapMs = 0;
  eachPlacement(({ placed }) => {
    for (let i = 0; i + 1 < placed.length; i++) {
      const gap = placed[i + 1].at - (placed[i].at + placed[i].dur);
      if (gap < 1e-9) joined++;
      else {
        gapped++;
        maxGapMs = Math.max(maxGapMs, gap * 1000);
      }
    }
  });
  assert.ok(joined > gapped, `이어지는 경계 ${joined}개 vs 빈틈 ${gapped}개 — 침묵이 우세해졌다`);
  // 이 값이 커지면 정렬이 말을 다시 늘리고 있다는 뜻이다(격자·편향 회귀 감시)
  assert.ok(maxGapMs <= 260, `최대 빈틈 ${maxGapMs.toFixed(0)}ms`);
});

test('봉투 시각이 단조 증가하고 readSec = plateauSec + fadeSec이다', () => {
  eachPlacement(({ placed }, label) => {
    for (const [i, c] of placed.entries()) {
      assert.ok(c.fadeSec > 0, `${label} 조각 ${i}: fadeSec ${c.fadeSec}`);
      assert.ok(c.fadeSec <= c.plateauSec + 1e-9, `${label} 조각 ${i}: 페이드 인이 고원 끝을 넘는다`);
      assert.ok(
        Math.abs(c.readSec - (c.plateauSec + c.fadeSec)) < 1e-9,
        `${label} 조각 ${i}: readSec ${c.readSec} ≠ 고원 ${c.plateauSec} + 페이드 ${c.fadeSec}`,
      );
      // 재료를 더 읽는 것은 뒤가 이어질 때만이다
      assert.equal(c.readSec > c.dur + 1e-9, c.joinsNext, `${label} 조각 ${i}: 재료 초과 읽기와 joinsNext가 어긋난다`);
    }
  });
  assert.deepEqual(chunkTiming(1), { fadeSec: 0.02, plateauSec: 1, readSec: 1.02 });
  assert.deepEqual(chunkTiming(1, 0.02, false), { fadeSec: 0.02, plateauSec: 0.98, readSec: 1 });
  // 페이드보다 짧은 조각에서는 클램프한다 — 시각 역순을 막는다
  assert.deepEqual(chunkTiming(0.005), { fadeSec: 0.005, plateauSec: 0.005, readSec: 0.01 });
  assert.deepEqual(chunkTiming(0.005, 0.02, false), { fadeSec: 0.0025, plateauSec: 0.0025, readSec: 0.005 });
});

test('아주 짧은 조각에서도 게인이 1을 넘지 않는다', () => {
  // 슬라이서는 minSegMs 80으로 이런 조각을 뽑지 않지만 alignToBeats는 받는다.
  // 짧은 조각은 페이드가 클램프되어 이웃과 상보성이 깨질 수 있다 — 그때도 게인 합이
  // 1을 넘지 않는다는 **약한 보장**만 있다는 사실을 숨기지 않고 못 박는다.
  const dense = Array.from({ length: 8 }, (_, i) => ({ start: at(i * 0.025), end: at(i * 0.025 + 0.02) }));
  const { placed, totalSec } = alignToBeats(dense, SR, 0.5);
  for (const [i, c] of placed.entries()) {
    assert.ok(c.fadeSec > 0 && c.fadeSec <= c.dur + 1e-9, `조각 ${i}: fade ${c.fadeSec} / dur ${c.dur}`);
  }
  for (let t = 0; t <= totalSec; t += 0.0005) {
    assert.ok(mixGainAt(placed, t) <= 1 + 1e-9, `${t.toFixed(4)}초에서 게인 합이 1을 넘는다`);
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

test('클리핑 여유가 프리셋 피크 배수의 실측 최댓값을 덮는다', () => {
  // melodyLevel은 **엔벨로프 피크 게인**이고 실제 파형 피크는 프리셋이 더 키운다.
  // 아래는 오프라인 렌더로 잰 `실제 피크 / (melodyLevel × preset.level)`의 악기별
  // 최댓값이다(midi 48~72 — 공진 몫이 음정에 따라 커지므로 한 음으로 재면 모자란다.
  // 처음 f0 311Hz에서 잰 1.024를 썼다가 높은 음이 든 절에서 렌더 피크 1.03이 나왔다).
  //
  // **기대값을 하드코딩한다** — PRESET_RESONANCE를 참조하면 상수를 바꿀 때 기대값이
  // 함께 움직여 아무것도 검증하지 않는다.
  const MEASURED = { piano: 1.255, orgel: 1.240, marimba: 1.242, synth: 1.166 };
  for (const [name, measured] of Object.entries(MEASURED)) {
    assert.ok(
      PRESET_RESONANCE >= measured,
      `${name}: 여유 ${PRESET_RESONANCE} < 실측 ${measured} — 그 악기의 높은 음에서 클리핑한다`,
    );
  }
});

test('멜로디 피크 배수를 넘기면 마스터만 내려간다 (균형은 그대로)', () => {
  // 이 인자가 master에만 들어가야 한다. melodyLevel이 함께 움직이면 클리핑을 막으려다
  // 멜로디 음량이 바뀌어 8차 지적("멜로디가 작다")으로 되돌아간다.
  for (const amp of [0.05, 0.2, 0.6, 0.99]) {
    for (const signal of [speechLike(amp), tonePeak(amp)]) {
      const naive = mixLevels(signal, 0, SR, undefined, 1);
      const real = mixLevels(signal, 0, SR, undefined, PRESET_RESONANCE * 1.2);
      assert.equal(real.melodyLevel, naive.melodyLevel, `amp ${amp}: melodyLevel이 움직였다`);
      assert.equal(real.voiceGain, naive.voiceGain, `amp ${amp}: voiceGain이 움직였다`);
      assert.ok(real.master <= naive.master, `amp ${amp}: 마스터가 오히려 커졌다`);
      const peak =
        (Math.min(0.89, amp * real.voiceGain) + real.melodyLevel * PRESET_RESONANCE * 1.2) * real.master;
      assert.ok(peak <= 0.98, `amp ${amp}: 최악 피크 ${peak.toFixed(3)}`);
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

test('멜로디 균형은 라이드 전 원본에서 재야 한다 (순서가 계약이다)', () => {
  // 조용한 음절을 끌어올린 샘플로 mixLevels를 부르면 rms가 올라가 **멜로디가 함께
  // 커진다** — 조용한 부분을 들리게 하려는 목적과 정반대다. buildChantGraph가 원본을
  // 먼저 재고 그 다음 라이드하는 이유가 이것이고, 순서를 뒤집으면 이 테스트가 그
  // 이유를 말해준다.
  const twoLevels = () => {
    const s = new Float32Array(SR * 2);
    for (let i = 0; i < s.length; i++) {
      const amp = i < SR ? 0.5 : 0.05; // 뒤 절반을 -20dB로 말했다
      const speaking = i % Math.round(SR * 0.25) < Math.round(SR * 0.05);
      s[i] = speaking ? amp * Math.sin((2 * Math.PI * 200 * i) / SR) : 0;
    }
    return s;
  };
  const src = twoLevels();
  const plan = ridePlan(src, SR, 0, src.length);
  assert.ok(plan.meanBoostDb > 0, '픽스처가 라이드 대상이 아니다');
  const rid = applyRide(src, plan);
  const onSource = mixLevels(src, 0, src.length);
  const onRidden = mixLevels(rid, 0, rid.length);
  assert.ok(
    onRidden.melodyLevel > onSource.melodyLevel,
    `라이드된 샘플로 재면 멜로디가 ${onSource.melodyLevel.toFixed(3)} → ${onRidden.melodyLevel.toFixed(3)}로 커진다`,
  );
  // 피크는 그대로이므로 목소리 증폭과 클리핑 여유는 라이드와 무관하다
  assert.equal(onRidden.voiceGain, onSource.voiceGain);
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

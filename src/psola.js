// TD-PSOLA 간이 구현 — 음절 파형을 유지한 채 음정만 목표로 고정한다.
//
// 그레인 루프(synth.js의 폴백 경로)는 음정은 정확하지만 짧은 조각을 반복하므로
// 비브라토·감쇠 없는 정상상태 톤이 되고 모음의 변화가 사라진다 — 실사용 지적
// "비프음 / 가사가 안 들림"의 뿌리. 여기서는 피치 주기마다 마크를 찍고 마크
// 중심의 Hann 창을 목표 주기 간격으로 겹쳐 더해(overlap-add) 파형 자체를
// 살린다. 단어가 들리고, 음정도 고정된다.
//
// 순수 모듈: 브라우저 API를 모른다. node --test로 직접 검증한다.

// 마크 보정 탐색 창(주기 대비 비율). 좁으면 활강을 못 따라가고, 넓으면 이웃
// 주기의 피크로 건너뛴다.
const SEARCH_SHARE = 0.25;
// 마크 5개 = 유지음 4주기. 이보다 적으면 음절을 대표하지 못하므로 실패로 보고
// 그레인 경로에 넘긴다.
const MIN_MARKS = 5;
// 무음 판정 문턱 — 구간에서 가장 큰 창 에너지 대비 비율.
const GATE_SHARE = 0.02;
// 씨앗이 구간의 이 지점보다 뒤에서만 잡히면 마크가 음절 꼬리에만 몰린다는 뜻이다.
const SEED_LIMIT = 0.6;

// 음절 안에 피치 마크(각 주기의 대응점)를 찍는다.
//
// periodHint는 findGrain이 이미 구한 음절 대표 f0에서 온다 — 프레임마다
// 자기상관을 다시 돌리면 음 하나에 수십만 연산이라 분석이 몇 초 걸린다.
// 대신 힌트 주기로 걷되 매 걸음을 ±25% 창의 실제 대응점에 붙여 활강을 따라간다.
export function findPitchMarks(samples, sampleRate, seg, { periodHint } = {}) {
  if (!periodHint || periodHint <= 0) return null;
  if (seg.end - seg.start < periodHint * (MIN_MARKS + 1)) return null;

  const half = Math.round(periodHint / 2);
  const first = seg.start + half;
  const last = seg.end - half - 1;
  if (last - first < periodHint * MIN_MARKS) return null;

  const energy = (center) => {
    let sum = 0;
    for (let d = -half; d <= half; d++) sum += samples[center + d] * samples[center + d];
    return sum;
  };

  // 소리가 있는 구간만 다룬다. 조각 경계는 슬라이서 프레임(20ms) 단위라 실제
  // 발성 앞뒤로 무음이 딸려 오고, 무음에서는 상호상관이 의미가 없어 마크가
  // 아무 곳에나 붙는다(실측: 간격이 예측−탐색폭에 고정되어 진짜 주기의 -31%).
  let loudest = 0;
  for (let c = first; c <= last; c += half) loudest = Math.max(loudest, energy(c));
  if (loudest <= 0) return null;
  const gate = loudest * GATE_SHARE;

  // 씨앗: 게이트를 넘는 첫 창 안의 |진폭| 최대점.
  //
  // 탐색 상한을 먼저 고정한다. 상한이 씨앗과 함께 전진하면 진폭이 계속 커지는
  // 음절(강세, AGC 게인 상승, 크레셴도)에서 씨앗이 음절 끝까지 걸어가고, 그러면
  // 마크 몇 개가 꼬리 3%에 몰린 채 "성공"으로 반환돼 폴백도 걸리지 않는다.
  // 그 결과가 정확히 이번에 없애려던 정상상태 비프음이다(리뷰에서 실측).
  let seed = -1;
  for (let c = first; c <= last && seed < 0; c++) {
    if (energy(c) >= gate) seed = c;
  }
  if (seed < 0 || seed > first + (last - first) * SEED_LIMIT) return null;
  const seedEnd = Math.min(last, seed + Math.round(periodHint));
  for (let i = seed; i < seedEnd; i++) {
    if (Math.abs(samples[i]) > Math.abs(samples[seed])) seed = i;
  }

  // 다음 마크 = 예측 위치 ±25% 창에서 이전 마크 주변 파형과 가장 닮은 지점.
  // 진폭 피크를 쫓으면 배음이 강한 파형에서 이웃 주기의 배음 피크로 건너뛰어
  // 간격이 요동친다(실측: 220Hz 조각에서 간격 280샘플). 파형 유사도로 붙이면
  // 위상 일관성이 템플릿에서 나와 극성 추적도 필요 없다.
  const similarity = (prev, cand, candEnergy) => {
    let dot = 0;
    let prevEnergy = 0;
    for (let d = -half; d <= half; d++) {
      const a = samples[prev + d];
      dot += a * samples[cand + d];
      prevEnergy += a * a;
    }
    const norm = Math.sqrt(prevEnergy * candEnergy);
    return norm > 0 ? dot / norm : -1;
  };

  const marks = [seed];
  const search = Math.max(2, Math.round(periodHint * SEARCH_SHARE));
  let cursor = seed;
  while (true) {
    const predicted = cursor + Math.round(periodHint);
    if (predicted + search > last) break;
    let best = -1;
    let bestScore = -Infinity;
    for (let i = predicted - search; i <= predicted + search; i++) {
      const e = energy(i);
      if (e < gate) continue;
      const score = similarity(cursor, i, e);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    marks.push(best);
    cursor = best;
  }
  if (marks.length < MIN_MARKS) return null;

  // 마크 k의 주기 = 이웃 마크와의 실측 간격. 창 크기가 이 값을 따라가므로
  // 활강 중에도 창이 국소 주기에 맞는다.
  const periods = marks.map((m, k) =>
    k < marks.length - 1 ? marks[k + 1] - m : m - marks[k - 1],
  );
  // 조각 경계를 함께 돌려준다 — 창이 음절 밖(무음·이웃 음절)을 읽지 않게.
  return { marks, periods, from: seg.start, to: seg.end };
}

// 유지음을 채울 때 왕복할 꼬리 길이(마크 구간 대비). 짧으면 제자리 루프에
// 가까워져 정상상태 톤이 되고, 길면 음절 앞부분(자음)까지 되돌아가 말이 겹친다.
const TAIL_SHARE = 0.4;

// 출력 경과 t(샘플)를 입력 오프셋으로 옮긴다.
//
// 음절을 음 길이에 맞춰 균일하게 늘리지 않는다. 늘리면 자음→모음 전이가 함께
// 늘어나 말이 뭉개지고(실기 지적 "가사가 안 들림"), 느린 모프가 신디사이저 패드처럼
// 들린다(실기 지적 "신디사이저음이 크다"). 그래서 자연 속도(1:1)로 읽고, 재료가
// 끝나면 끝부분만 왕복해 남은 길이를 채운다 — 고정 루프가 아니라 계속 움직이므로
// 정상상태 톤이 되지 않는다.
export function readOffset(t, inSpan, tailLen) {
  if (t <= inSpan) return t;
  if (!(tailLen > 0)) return inSpan;
  const over = (t - inSpan) % (2 * tailLen);
  return inSpan - (over <= tailLen ? over : 2 * tailLen - over);
}

// 음 하나를 렌더한다. 출력은 항상 정확히 outLength — 길이 계산은 호출자(synth)
// 한 곳에만 있어야 재생과 저장이 갈라지지 않는다.
//
// attackFrom..+attackLength(자음·성문 어택)는 원음을 그대로 복사한다. 단어를
// 알아듣게 하는 흔적이 여기 남는다. 이 구간은 음정을 옮기지 않으므로 길이 상한은
// 호출자가 정한다(synth.js의 ATTACK_MAX_SEC).
export function renderNote(samples, sampleRate, { targetHz, outLength, attackFrom, attackLength = 0, pitchMarks }) {
  if (!pitchMarks || !(targetHz > 0) || !(outLength > 0)) return null;
  const { marks, periods, from, to } = pitchMarks;
  const targetPeriod = sampleRate / targetHz;

  const attack = Math.max(0, Math.min(attackLength, outLength, samples.length - attackFrom));
  // 유지음이 두 주기도 안 되면 이 방식으로 낼 음이 아니다 — 무음 버퍼를 성공으로
  // 돌려주면 폴백이 걸리지 않아 그 음이 조용히 사라진다.
  if (outLength - attack < targetPeriod * 2) return null;

  const out = new Float32Array(outLength);
  for (let i = 0; i < attack; i++) out[i] = samples[attackFrom + i];

  // 어택과 유지음을 짧게 겹쳐 섞는다. 위상이 다른 두 신호를 그대로 맞대면 음마다
  // 딱 소리가 난다(리뷰 실측: 이음매 진폭 점프 0.16~0.59 = 원음 최대 기울기의
  // 5~22배). 그레인 경로에는 있던 겹침이라 없으면 그쪽보다 나빠진다.
  const xfade = Math.min(attack, Math.round(0.005 * sampleRate));
  const mixFrom = attack - xfade;

  // 어택으로 이미 들려준 구간은 유지음 재료에서 뺀다 — 같은 음절 앞부분이 두 번
  // 들리면 말을 더듬는 것처럼 된다. 남는 마크가 둘 미만이면 전체를 쓴다.
  let head = marks.findIndex((m) => m >= attackFrom + attack);
  if (head < 0 || marks.length - head < 2) head = 0;
  const inSpan = marks[marks.length - 1] - marks[head];

  const acc = new Float32Array(outLength);
  const overlap = new Float32Array(outLength);
  // 왕복 주기가 짧으면 그 자체가 떨림음이 된다 — 12ms 왕복은 약 40Hz 버즈다.
  // 50ms 아래로는 내려가지 않게 해서 비브라토 영역(10Hz 이하)에 둔다.
  const tailLen = Math.min(inSpan, Math.max(inSpan * TAIL_SHARE, sampleRate * 0.05));
  for (let t = 0; ; t++) {
    const center = mixFrom + t * targetPeriod;
    if (center >= outLength) break;
    const inPos = marks[head] + readOffset(center - mixFrom, inSpan, tailLen);
    let k = head;
    for (let i = head + 1; i < marks.length; i++) {
      if (Math.abs(marks[i] - inPos) < Math.abs(marks[k] - inPos)) k = i;
    }
    // 창 반폭은 국소 주기와 목표 주기 중 큰 쪽. 국소 주기만 쓰면 음을 크게 내릴 때
    // (목표 주기 > 2×국소 주기) 창이 서로 닿지 않아 주기 사이가 비고, 규칙적인
    // 구멍이라 자기상관 지표로는 안 보인다(리뷰 실측: 0인 샘플 22%).
    const halfWin = Math.round(Math.max(periods[k], targetPeriod));
    const c = Math.round(center);
    for (let d = -halfWin; d <= halfWin; d++) {
      const o = c + d;
      if (o < mixFrom || o >= outLength) continue;
      const s = marks[k] + d;
      if (s < from || s >= to || s < 0 || s >= samples.length) continue;
      const w = 0.5 * (1 + Math.cos((Math.PI * d) / halfWin));
      acc[o] += samples[s] * w;
      overlap[o] += w;
    }
  }

  // 창 가중치로 나눠 진폭을 고른다. 하한을 두는 이유: 가장자리에서 가중치가 0에
  // 가까우면 나눗셈이 한 샘플만 수백 배로 키워 그 자체가 딸깍 소리가 된다.
  for (let i = mixFrom; i < outLength; i++) {
    const body = acc[i] / Math.max(overlap[i], 0.25);
    const mix = i < attack && xfade > 0 ? (i - mixFrom) / xfade : 1;
    out[i] = out[i] * (1 - mix) + body * mix;
  }
  return out;
}

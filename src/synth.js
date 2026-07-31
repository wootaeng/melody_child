import { midiToHz } from './composer.js';
import { renderNote } from './psola.js';
import { pickInstrument } from './instruments.js';
import { ridePlan, applyRide } from './leveler.js';

// 마지막 음이 끝난 뒤 남기는 여유. 재생 길이 보고와 오프라인 렌더 버퍼 할당이
// 같은 값을 써야 한다 — 따로 두면 한쪽만 고쳤을 때 꼬리가 잘린다.
const TAIL_SEC = 0.5;

const NOTE_GAP = 0.12; // 음 사이 여백 비율 — 없으면 음이 붙어 박자가 안 들린다
// 자음을 이 비율까지 원음 속도로 들려준다. 너무 짧게 자르면 단어가 중간에
// 끊겨 들린다(사용자 지적: "말이 끊겨서 나옴").
const ATTACK_SHARE = 0.5;
// 어택 길이 상한. 이 구간은 음정을 옮기지 않으므로 길면 음의 앞부분이 원래
// 목소리 음높이로 들린다(리뷰 실측: 상한이 없을 때 음의 15~40%가 목표에서
// -577~-1077센트). grain.start만으로 정하면 pitch.js의 skipHead(0.35)가 곧
// 어택 분량이 되어, 음정 검출 튜닝을 건드리면 소리가 함께 바뀐다.
const ATTACK_MAX_SEC = 0.045;

// 음 하나가 실제로 소리 나는 길이. 남는 여백(NOTE_GAP)이 박자를 만든다 —
// 반주가 없으므로 이게 유일한 박자 장치다.
function soundingSec(noteSec) {
  return Math.max(0.06, noteSec * (1 - NOTE_GAP));
}

// 이 음에서 원음 속도로 들려줄 앞머리 길이(샘플). 테스트가 같은 식을 다시 쓰면
// 프로덕션과 어긋난 값만 검증하게 되므로 여기서 한 번만 정한다.
export function attackSamples(seg, grain, noteSec, sampleRate) {
  const limit = Math.min(
    (grain.start - seg.start) / sampleRate,
    soundingSec(noteSec) * ATTACK_SHARE,
    ATTACK_MAX_SEC,
  );
  return Math.max(0, Math.round(limit * sampleRate));
}

// 음별 목소리 버퍼를 미리 만든다.
//
// 순수 함수다(ctx를 모른다) — 그래서 node --test로 프로덕션과 같은 파라미터로
// 검증할 수 있다. buildGraph 안에서 만들면 (1) 재생·리믹스·저장마다 다시 만들고
// (2) 시작 시각을 확정한 뒤 수십 ms를 먹어 lead 100ms를 잠식한다(실측 77ms).
export function renderVoices(samples, sampleRate, { segments, grains, pitchMarks, melody }) {
  const secPerBeat = 60 / melody.bpm;
  return melody.notes.map((note, i) => {
    const grain = grains[i];
    const marks = pitchMarks ? pitchMarks[i] : null;
    if (!grain || !marks) return null;
    const noteSec = note.beats * secPerBeat;
    return renderNote(samples, sampleRate, {
      targetHz: midiToHz(note.midi),
      outLength: Math.round(soundingSec(noteSec) * sampleRate),
      attackFrom: segments[i].start,
      attackLength: attackSamples(segments[i], grain, noteSec, sampleRate),
      pitchMarks: marks,
    });
  });
}

function scheduleSegment(ctx, dest, buffer, seg, grain, voice, targetHz, when, noteSec) {
  const sr = buffer.sampleRate;
  const sounding = soundingSec(noteSec);

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

  // 음절 파형을 살려 음정만 고정한 버퍼(renderVoices가 미리 만든 것)
  if (voice) {
    const voiceBuffer = ctx.createBuffer(1, voice.length, sr);
    voiceBuffer.copyToChannel(voice, 0);
    const src = ctx.createBufferSource();
    src.buffer = voiceBuffer;
    src.connect(gain);
    src.start(when);
    return;
  }

  // 폴백: 마크를 못 찍은 음절(주기가 불안정하거나 너무 짧다). 음정은 맞지만
  // 짧은 그레인의 반복이라 정상상태 톤이 된다 — 그래서 위 경로를 우선한다.
  const rate = targetHz / grain.f0;
  const attack = attackSamples(seg, grain, noteSec, sr) / sr;
  const hasAttack = attack > 0.015;

  // 자음은 원음 속도로 — 단어의 흔적이 여기 남는다
  if (hasAttack) {
    const head = ctx.createBufferSource();
    head.buffer = buffer;
    head.connect(gain);
    head.start(when, seg.start / sr, attack);
  }

  // 유지음: 주기의 정수배 그레인을 루프해 음정을 고정한다
  const body = ctx.createBufferSource();
  body.buffer = buffer;
  body.playbackRate.value = rate;
  body.loop = true;
  body.loopStart = grain.start / sr;
  body.loopEnd = grain.end / sr;
  body.connect(gain);
  body.start(when + (hasAttack ? attack * 0.8 : 0), grain.start / sr);
  body.stop(when + sounding);
}

// 배음 세기는 tone으로 한꺼번에 조절한다 — 0이면 순수 사인파다. 기본음(i<=1)은
// 건드리지 않아야 tone을 올려도 음정과 기준 음량이 그대로 남는다.
// createPeriodicWave가 피크를 정규화하므로 클리핑 계산(mixLevels)도 그대로 유효하다.
function melodyWave(ctx, preset, tone = 1) {
  const imag = Float32Array.from(preset.harmonics, (amp, i) =>
    i <= 1 ? amp : Math.min(1, amp * tone),
  );
  return ctx.createPeriodicWave(new Float32Array(imag.length), imag);
}

// 필터가 목표 차단 주파수에 닿는 시점(음 길이 대비). 감쇠가 끝나기 전에 닿아야
// 고배음이 "먼저" 죽은 것으로 들린다.
const FILTER_SHARE = 0.5;

// 멜로디 한 음. 감산 합성의 표준 순서(osc → 필터 → 게인)로 한 벌을 만든다.
//
// **샘플 내장(CC0 악기 녹음)으로 갈 때 교체할 지점이 여기다.** 프리셋의 octave·level·
// 엔벨로프는 그대로 쓰이고 파형 생성만 AudioBufferSourceNode로 바뀐다.
function createMelodyVoice(ctx, dest, { wave, preset, hz, when, durSec, level }) {
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.value = hz;

  // 차단 주파수를 음이 울리는 동안 내린다 — **고배음이 기본음보다 먼저 죽는 것**이
  // 피아노다움의 핵심이다. filterTo가 없는 프리셋은 고정 필터(예전 소리)다.
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(preset.filterFrom, when);
  if (preset.filterTo !== undefined) {
    filter.frequency.exponentialRampToValueAtTime(preset.filterTo, when + durSec * FILTER_SHARE);
  }

  // 엔벨로프 시각이 역순이면 스케줄이 꼬인다 — 짧은 음에서는 attackSec이
  // durSec*holdShare보다 클 수 있으므로 순서를 산술로 보장한다.
  const attackSec = Math.min(preset.attackSec, durSec * 0.25);
  const holdSec = Math.max(attackSec, durSec * preset.holdShare);
  const decaySec = Math.max(holdSec + 1e-3, durSec * 0.9);
  const peak = level * preset.level;

  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(peak, when + attackSec);
  if (holdSec > attackSec) gain.gain.setValueAtTime(peak, when + holdSec);
  // exponentialRamp는 0에 닿을 수 없다 — 감쇠 목표는 0보다 커야 한다
  gain.gain.exponentialRampToValueAtTime(Math.max(peak * preset.sustain, 1e-4), when + decaySec);
  gain.gain.linearRampToValueAtTime(0, when + durSec);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(dest);
  osc.start(when);
  osc.stop(when + durSec);
}

// 멜로디를 악기로 연주한다. 악기 성격은 전부 프리셋 데이터가 정한다(src/instruments.js).
//
// 음 시각을 돌려주는 쪽이 이 함수다 — 화면 구슬이 이 시각을 그대로 쓴다.
// 음역은 프리셋의 octave로 옮기되 **melody.notes의 midi는 건드리지 않는다**:
// 구슬 높이가 그 값을 쓰므로 함께 움직이면 화면과 소리가 어긋난다.
function scheduleMelody(ctx, dest, melody, startTime, level, preset, tone) {
  const secPerBeat = 60 / melody.bpm;
  const wave = melodyWave(ctx, preset, tone); // 프리셋당 한 번 — 음마다 만들면 낭비다
  const noteTimes = [];
  let when = startTime;
  for (const note of melody.notes) {
    const durSec = note.beats * secPerBeat;
    noteTimes.push(when);
    createMelodyVoice(ctx, dest, {
      wave,
      preset,
      hz: midiToHz(note.midi + preset.octave * 12),
      when,
      durSec,
      level,
    });
    when += durSec;
  }
  return { noteTimes, endTime: when };
}

// 녹음에서 목소리가 실제로 있는 구간. 앞뒤 침묵만 잘라내고 **음절 사이는 건드리지
// 않는다** — 조각을 잘라 이어붙이면 그 사이의 자연스러운 이음새가 사라져 말이
// 뚝뚝 끊긴다(실기 지적).
//
// 범위의 **끝**은 bounds가 이미 정해서 온다(slicer.coverQuietEdges가 조각 밖의 조용한
// 발화를 양 끝에서 흡수한다). 여기서는 그것을 초 단위 span으로 파생할 뿐이고, 파생을
// 한 곳에 두는 이유는 챈트 렌더와 화면이 같은 값을 봐야 하기 때문이다.
export function voiceSpan(audioBuffer, bounds) {
  const sr = audioBuffer.sampleRate;
  if (!bounds || bounds.length === 0) return { from: 0, sec: audioBuffer.duration };
  const from = bounds[0].start / sr;
  const to = Math.min(audioBuffer.duration, bounds[bounds.length - 1].end / sr + 0.25);
  return { from, sec: Math.max(0.1, to - from) };
}

// 음절 시작을 박에 맞추되 **음절 자체는 자르지 않는다**.
//
// 목소리를 통째로 흘려보내면 말은 안 끊기지만 박에 안 맞아 거슬린다(실기 지적).
// 음절을 늘리거나 자르면 다시 기계음·끊김이 된다. 그래서 손대는 것은 **음절 뒤의
// 쉼**뿐이다 — 쉼은 길이를 바꿔도 아티팩트가 없는 유일한 재료다.
//
// 격자는 박이 아니라 **자연스러운 음절 간격**에 맞춰 고른다. 4분음표 격자에 한
// 음절씩 놓으면 말이 실제 속도보다 훨씬 느려져 사이가 벌어진다(실측: 2.2초 발화가
// 3.75초로 늘어나고 음절마다 0.26초 침묵). 사람은 초당 4~5음절을 말하는데 96bpm의
// 한 박은 0.63초다 — 8분·16분음표까지 후보에 두고 중앙값 간격에 가장 가까운 것을 쓴다.
//
// 각 음절이 차지하는 칸 수는 자연 간격을 격자로 반올림한 값이다. 그래서 원래 리듬이
// 유지되고(빠르게 말한 곳은 붙어 있다) 총 길이도 거의 그대로다.
// 후보 격자의 상·하한. 상한이 없으면 4분음표 격자(96bpm에서 625ms)가 뽑히는데,
// 실측에서 그 격자는 2.2초 발화를 3.75초로 늘려 다시 끊기게 만들었다. 실기에서도
// 격자가 625ms까지 올라간 것이 관측됐다 — 쉼이 중앙값을 끌어올리기 때문이다
// (실제 녹음은 음절 사이에 무음이 없어 슬라이서가 어절 덩이를 잡고, 그 간격에 쉼이 섞인다).
const GRID_MIN_SEC = 0.12;
// 상한을 400 → 200ms로 내렸다. 격자가 굵으면 `ceil(음절/격자)` 하한이 한 칸을 크게
// 넘겨 그 차이가 전부 침묵이 된다 — 실측에서 침묵의 최대 공급원이었다(무음 없이 이어
// 말한 녹음 @108bpm: 조각마다 256ms, 1.45초 발화가 2.22초로). 격자를 잘게 하면
// 초과분도 작아진다: 평균 침묵 189 → 23ms.
const GRID_MAX_SEC = 0.2;
const DIVISIONS = [1, 2, 4, 8];
// 배정 칸 수를 정할 때의 반올림 편향. 0.5면 보통 반올림이고, 낮출수록 내림이 잦아져
// 삽입 침묵이 줄고 쉼이 짧아진다. 실기에서 "말이 살짝 끊긴다"의 원인이 그 침묵이라
// 내림 쪽으로 둔다.
//
// 0.5로 되돌려도 이음매는 좋아지지 않는다(실측: 픽스처 4종 × bpm 3종에서 조각 수가
// 6→6·5→5로 그대로이고 침묵만 37→288ms로 8배 늘었다). 격자가 자연 간격과 소수점까지
// 같아지는 일이 실제 녹음에서 없기 때문이다 — 이음매는 아래 크로스페이드가 담당하고
// 이 값은 침묵 총량만 담당한다. 두 관심사가 섞여 있던 것이 9차의 버그였다.
const GRID_ROUND_BIAS = 0.25;

// 음절 끝을 이만큼까지는 잘라도 좋다고 본다.
//
// 9차까지의 원칙은 "음절 불가침"이었고 `units`의 하한 `ceil(음절/격자)`가 그것을
// 지켰다. 그런데 **그 하한이 곧 침묵의 최대 공급원**이었다: 음절이 격자보다 8%만 길어도
// 두 칸을 먹고 재료가 없는 나머지가 전부 무음이 된다(실측 최대 256ms). 실기 판정이
// "여전히 말이 뚝뚝 끊긴다"였고 그 뚝뚝이 이것이다.
//
// 잘리는 곳은 음절 **끝의 감쇠부**이고 뒤 조각과 크로스페이드로 이어진다. 50ms 감쇠부가
// 사라지는 것과 256ms 무음이 들어가는 것 중에서는 앞쪽이 낫다고 보고 원칙을 바꿨다.
// 실측: 이 허용치와 격자 상한을 함께 두면 최대 침묵 256 → 33ms, 잘린 음절은 15개 배치
// 중 7개(최대 50ms).
//
// URL 손잡이로 빼지 않았다 — `alignToBeats`를 부르는 네 곳(buildChantGraph·songSeconds·
// ui.js 두 곳)에 같은 값을 넘겨야 하고, 그 제약은 이미 totalSec 하나로 충분히 무겁다.
// 실기 비교군으로는 `?align=0`(정렬 자체를 끔 → 침묵도 잘림도 0)이 더 확실하고,
// trimSec 인자는 테스트가 예전 원칙(0)을 검증하는 데 쓴다.
const SYLLABLE_TRIM_MAX = 0.08;

// 조각 이음매 크로스페이드 길이.
//
// 앞 조각을 `dur` 뒤로 이만큼 더 읽으며 level→0으로 내리고, 뒤 조각은 같은 시각에
// 0→level로 올린다. 상보 램프라 합이 1로 유지되고, **원본에서도 이어지는 경계라면
// 두 조각이 같은 샘플을 읽어** 합이 원본과 정확히 같다(실측 복원 오차 0).
//
// 예전에는 페이드를 `dur` 안쪽에 걸었다. 그래서 (1) 출력이 붙어 있는 경계에서도
// 진폭이 0까지 떨어졌고(실측: 이웃 게인 합 최소 0.000, 경계 40ms 창 RMS -4.8dB),
// (2) 배정 칸이 음절 길이에 딱 맞은 조각에서는 페이드 아웃이 음절 꼬리를 직접
// 먹었다(실측: 120bpm·음절 6개에서 6조각 중 5개). 둘 다 "말이 살짝 끊긴다"였다.
//
// 20ms는 예전 페이드 값을 그대로 쓴 것이다 — 실기 판정에 변수를 하나만 남긴다.
// 경계에서 겹침이 "이중으로 들린다"로 판정되면 10ms까지 내리는 것이 첫 손잡이다.
const XFADE_SEC = 0.02;

// 한 덩이의 재생 계약. 게인은 `0 →(fadeSec)→ level`, `plateauSec`까지 고원,
// `plateauSec → readSec`에서 `level → 0`이고 소스는 `readSec`만큼 읽는다.
// 봉투 시각과 재생 길이의 관계를 여기 한 곳에서만 정한다 — 스케줄러(src.start의 길이)와
// 길이 계산(totalSec)이 갈라지면 마지막 조각의 꼬리가 잘리거나 버퍼가 짧게 잡힌다.
//
// **재료를 `dur` 뒤로 더 읽는 것은 뒤 조각이 바로 이어질 때만이다.** 그때는 더 읽는
// 20ms가 다음 조각이 같은 시각에 페이드 인으로 내는 것과 (거의) 같은 지점이라 시간차
// 블렌드가 되고, 원본에서도 이어지는 경계라면 **정확히 같은 샘플**이라 합이 원본과 같다.
//
// 뒤에 침묵이 있으면(배정 칸이 재료보다 길다) 사정이 반대다. 그 자리에서 더 읽는 20ms는
// **다음 음절의 머리**인데 다음 조각은 침묵만큼 뒤에 시작하므로, 그 머리가 최대 250ms
// 앞당겨 거의 풀 게인으로 한 번 더 들린다 — 말을 더듬는 소리다(리뷰 실측: 임펄스 픽스처
// 에서 앞당겨진 사본 0.98 vs 제자리 사본 0.0002). 그래서 그쪽은 페이드 아웃을 재료 안에
// 둔다. 그 마지막 20ms는 음절 뒤 쉼이라 보통 무해하고, 쉼이 그보다 짧으면 꼬리 몇 ms가
// 감쇠하는데 — 앞당긴 복제보다는 그게 낫다.
export function chunkTiming(dur, fadeSec = XFADE_SEC, joinsNext = true) {
  if (joinsNext) {
    const fade = Math.min(fadeSec, dur);
    return { fadeSec: fade, plateauSec: dur, readSec: dur + fade };
  }
  // 절반으로 클램프해 고원이 페이드 인보다 앞서지 않게 한다(봉투 시각 단조성)
  const fade = Math.min(fadeSec, dur / 2);
  return { fadeSec: fade, plateauSec: dur - fade, readSec: dur };
}

// 격자는 화자의 말 속도에서 고른다. 긴 쉼은 통계에서 빼고(쉼은 격자가 아니라
// 배정 칸 수로 표현된다), 후보는 위 상·하한 안에서만 고른다.
function pickGrid(spans, beatSec) {
  const inPhrase = spans.filter((s) => s <= GRID_MAX_SEC * 1.5);
  const pool = (inPhrase.length >= 2 ? inPhrase : spans).slice().sort((a, b) => a - b);
  const target = pool[Math.floor(pool.length / 2)] || beatSec;

  let grid = null;
  for (const div of DIVISIONS) {
    const candidate = beatSec / div;
    if (candidate < GRID_MIN_SEC || candidate > GRID_MAX_SEC) continue;
    if (grid === null || Math.abs(candidate - target) < Math.abs(grid - target)) grid = candidate;
  }
  return grid === null ? Math.min(GRID_MAX_SEC, Math.max(GRID_MIN_SEC, beatSec)) : grid;
}

export function alignToBeats(
  bounds,
  sampleRate,
  beatSec,
  tailSec = 0.25,
  fadeSec = XFADE_SEC,
  trimSec = SYLLABLE_TRIM_MAX,
) {
  const onsets = bounds.map((seg) => seg.start / sampleRate);
  // 이 음절이 쓸 수 있는 재료 = 다음 음절 시작까지(사이의 숨·이음새 포함)
  const spans = bounds.map(
    (seg, i) => (i + 1 < bounds.length ? onsets[i + 1] : seg.end / sampleRate + tailSec) - onsets[i],
  );
  const gridSec = pickGrid(spans, beatSec);

  const placed = [];
  let at = 0;
  for (const [i, seg] of bounds.entries()) {
    const syllableSec = (seg.end - seg.start) / sampleRate;
    // 자연 간격을 격자에 맞추되 **내림으로 편향**한다. 배정 칸이 재료보다 길면 그
    // 차이가 침묵이 되고(실기에서 7.3초가 7.8초로 늘어난 0.5초가 그것이다), 짧으면
    // 음절 뒤의 쉼만 건너뛴다. 둘은 같은 반올림 오차의 두 방향이라 총량은 보존되므로
    // 어디로 보낼지만 고를 수 있고, 소리가 사라지는 쪽보다 쉼이 짧아지는 쪽이 낫다.
    //
    // 음절 하한에서 trimSec을 뺀다 — 이 하한이 곧 침묵의 최대 공급원이었다
    // (SYLLABLE_TRIM_MAX 주석에 근거가 있다). 음절 끝 trimSec까지는 잘려도 좋다고 보고,
    // 그 덕에 두 칸을 먹던 조각이 한 칸에 들어와 침묵이 사라진다.
    const units = Math.max(
      1,
      Math.floor(spans[i] / gridSec + GRID_ROUND_BIAS),
      Math.ceil(Math.max(0, syllableSec - trimSec) / gridSec),
    );
    const allotted = units * gridSec;
    const dur = Math.min(spans[i], allotted);
    // 뒤 조각이 이 조각의 고원이 끝나는 시각에 바로 올라오는가. 배정 칸이 재료보다
    // 길면(삽입 침묵) 그렇지 않고, 마지막 조각은 뒤가 없다 — 두 경우 모두 페이드
    // 아웃을 재료 안에 둔다(chunkTiming의 주석에 이유가 있다).
    const joinsNext = i + 1 < bounds.length && allotted - dur < 1e-9;
    placed.push({
      at,
      from: onsets[i],
      dur,
      joinsNext,
      ...chunkTiming(dur, fadeSec, joinsNext),
      syllableSec,
      units,
    });
    at += allotted;
  }
  // 마지막 조각은 뒤에 이어질 조각이 없어 페이드 아웃이 배정 칸 밖으로 나갈 수 있다.
  // 그 꼬리까지 곡 길이에 넣어야 한다 — **이 값을 네 곳이 읽는다**(buildChantGraph,
  // songSeconds, ui.js의 멜로디 음 개수 결정과 진단 칩). 스케줄러 쪽에서 fade를
  // 더하면 나머지 세 곳이 조용히 20ms 틀리므로 생산자를 여기 하나로 둔다.
  const last = placed[placed.length - 1];
  return { placed, totalSec: last ? Math.max(at, last.at + last.readSec) : at, gridSec };
}

// 목소리를 먼저 정규화하고 그 위에서 멜로디 비율을 잡는다.
//
// 절대 RMS에 비례시키면 작게 녹음한 날은 멜로디가 하한에 붙고 전체가 작아진다
// (실기 지적: "멜로디가 작다 / 내 녹음이 작아서인가" — 그렇다). 목소리 피크를
// 먼저 기준선까지 올려 두면 마이크 레벨과 무관하게 둘의 균형이 같아진다.
const VOICE_PEAK = 0.89; // 정규화 목표 피크
// 무음·잡음만 있는 녹음을 증폭하지 않기 위한 상한.
//
// 8이었고 그것이 "목소리가 좀 작으면 아예 사라진다"의 절반이었다 — 조용히 말한 녹음은
// 8배로도 목표 피크에 못 닿아 목소리 피크가 0.037까지 떨어졌다(실측). 24면 진폭 0.037
// 녹음까지 목표에 닿는다. 대가는 잡음도 24배가 되는 것인데, 실측에서 목소리 대비
// -18dB이라 들리긴 해도 묻히는 편이 낫다. 진단 칩의 `증폭 24.0배`가 "더 크게 말하라"는
// 신호다(예전 8.0배와 같은 역할).
const VOICE_GAIN_MAX = 24;
// 마스터가 천장 여유를 쓸 수 있는 상한. 거의 무음인 녹음에서 잡음만 폭주하는 것을 막는다 —
// 이 값에 걸리면 아무리 눌러도 소리가 작다는 뜻이고, 그때는 실제로 더 크게 말해야 한다.
const MASTER_MAX = 4;
// 정규화된 목소리 RMS 대비 멜로디 진폭. 실기 청취로 정했다(1 → 작다, 2.2 → 여전히
// 작다, 3 → 적당, 9차에서 3 → "조금 줄였으면"). 배음을 얹어 지각 음량이 함께 올랐으므로
// 이 숫자만의 결과는 아니다. 화면 버튼으로 조절하므로(ui.js의 MELODY_LEVELS) 이 값은
// 그 중 "보통" 단계이자 손잡이가 없을 때의 기본이다.
//
// **단위 주의**: 이 값은 RMS 비가 아니라 **엔벨로프 피크 비**다. 실효 RMS로 환산하는
// 계수는 피아노에서 0.396이다(정규화 파형 RMS 0.519 × level 1.2 × 엔벨로프·필터 0.635 —
// 한 음 오프라인 렌더 실측). 즉 실효 음량을 정하는 세 번째 자리가 `createMelodyVoice`의
// 엔벨로프·필터인데 거기엔 "level"이라는 이름이 없어 레벨 결정으로 세어지지 않는다.
// 이 주석이 없어서 9차 진단이 +5.4dB로 출발했다(실제 +1.5dB).
export const MELODY_TO_VOICE = 2.4;

// biquad 저역통과(Q=1)가 차단 부근 성분을 키우는 몫. 프리셋 level과 곱해 클리핑 여유에
// 들어간다.
//
// **음정에 따라 변한다** — 배음이 차단 주파수에 어떻게 앉는지에 달려 음이 올라갈수록
// 커진다. 그래서 한 음에서 잰 값을 쓰면 안 된다. 처음 1.024(f0 311Hz = midi 51)를 썼다가
// 리뷰 실측에서 높은 음이 든 절이 여전히 클리핑하는 것이 잡혔다(렌더 피크 1.03).
//
// 오프라인 렌더로 잰 `실제 파형 피크 / (melodyLevel × preset.level)`의 악기별 최댓값
// (midi 48~72):  piano 1.255 · orgel 1.240 · marimba 1.242 · synth 1.166.
// 전부를 덮는 1.26을 쓴다. 대가는 절대 음량 약 0.7dB이고, 그건 왜곡을 없애는 값이다.
export const PRESET_RESONANCE = 1.26;

// melodyPeakFactor: melodyLevel(엔벨로프 피크 게인)에서 실제 파형 피크로 가는 배수.
// 기본 1은 "프리셋을 모른다"는 뜻이고, 챈트 경로는 preset.level × 공진을 넘긴다 —
// 빼먹으면 melodyLevel > 0.14에서 최악 피크가 1을 넘어 exporter의 ±1 클램프에
// 걸린다(실기 관측 melodyLevel 0.23~0.73이므로 사실상 항상).
export function mixLevels(samples, fromSample, lengthSamples, ratio = MELODY_TO_VOICE, melodyPeakFactor = 1) {
  let sum = 0;
  let peak = 0;
  let n = 0;
  const end = Math.min(samples.length, fromSample + lengthSamples);
  for (let i = Math.max(0, fromSample); i < end; i++) {
    const a = samples[i];
    sum += a * a;
    n++;
    if (Math.abs(a) > peak) peak = Math.abs(a);
  }
  const rms = n ? Math.sqrt(sum / n) : 0;
  const voiceGain = Math.min(VOICE_GAIN_MAX, Math.max(1, VOICE_PEAK / Math.max(0.02, peak)));
  const voicePeak = Math.min(VOICE_PEAK, peak * voiceGain);
  // 상한은 실질적으로 걸리지 않게 둔다. 0.6으로 두니 보통 음량 녹음에서 걸려
  // 비율이 아니라 상한이 음량을 결정했다(테스트에서 0.445 vs 0.6으로 갈렸다).
  // 합이 1을 넘는 문제는 아래 마스터가 비율을 유지한 채 눌러서 해결한다.
  //
  // **하한을 목소리 피크에 연동한다.** 고정 0.08은 작게 녹음한 날 목소리보다 커졌다
  // (실측: 목소리 피크 0.037 대 멜로디 0.121 — 멜로디가 3.3배로 목소리를 덮었다.
  // 실기 지적 "목소리가 좀 작으면 아예 사라진다"가 이것이다). 하한의 목적은 멜로디가
  // 아예 안 들리지 않게 하는 것인데, 목소리가 그보다 작으면 목적이 뒤집힌다.
  const melodyLevel = Math.min(1, Math.max(Math.min(0.08, voicePeak * 0.5), rms * voiceGain * ratio));
  // 목소리 피크와 멜로디가 겹쳐도 천장을 넘지 않게 맞춘다. **1로 클램프하지 않는다** —
  // 예전에는 min(1, …)이라 작게 녹음한 날 천장에 68%가 남아도 쓰지 못했다(실측: 목소리
  // 피크가 0.32까지 떨어지는데 마스터는 1). 비율은 그대로이므로 이건 볼륨 손잡이다.
  // MASTER_MAX가 없으면 거의 무음인 녹음에서 잡음만 폭주한다.
  const predicted = voicePeak + melodyLevel * melodyPeakFactor;
  const master = predicted > 0 ? Math.min(MASTER_MAX, 0.97 / predicted) : 1;
  return { voiceGain, melodyLevel, master };
}

// 한 덩이의 목소리를 얹는다.
//
// 페이드 아웃은 `dur` **이후**의 재료에 걸린다(chunkTiming의 readSec). 뒤 조각이
// 정확히 `when + dur`에 0→level로 올라오므로 두 램프가 상보가 되어 합이 1로 유지되고,
// 원본에서도 이어지는 경계라면 두 조각이 같은 샘플을 읽어 합이 원본과 정확히 같다.
// 원본이 끊긴 경계에서도 진폭이 0에 닿지 않는다(실측: 경계 구간 RMS -1.1dB 상관
// ~ -2.0dB 무상관. 예전에는 40ms 동안 0까지 떨어졌다).
//
// **선형 램프를 쓴다.** 등전력(√) 램프는 무상관 구간의 전력을 평탄하게 만드는 대신
// 원본이 이어지는 경계에서 합을 최대 +3dB 밀어올려 "정확히 원본"을 깨뜨린다. 이음매
// 정확성이 이 설계의 핵심 자산이다. psola.js의 xfade도 선형이라 리포 안에서 일관된다.
function scheduleVoiceChunk(ctx, dest, buffer, { when, from, fadeSec, plateauSec, readSec, level }) {
  const gain = ctx.createGain();
  // 기본값을 먼저 0으로 내린다. AudioParam은 **첫 automation 이벤트 이전 구간에
  // intrinsic value(기본 1)를 쓴다** — 여기서는 소스가 첫 이벤트와 같은 시각에
  // 시작하므로 도달할 수 없는 경로지만, 정수 샘플 경계에서 이벤트가 한 샘플 늦게
  // 잡히면 그 한 샘플이 게인 1로 새고 조각이 겹치는 이음매에서 합이 2가 된다
  // (Chrome 헤드리스에서 when이 정수 샘플일 때 실측 2.0). 한 줄짜리 보험이고,
  // 서브샘플 start 반올림이 다를 수 있는 Safari가 실제 대상 브라우저다.
  gain.gain.value = 0;
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(level, when + fadeSec);
  gain.gain.setValueAtTime(level, when + plateauSec); // 고원 끝 = 뒤 조각의 램프 시작
  gain.gain.linearRampToValueAtTime(0, when + readSec);
  gain.connect(dest);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(gain);
  src.start(when, from, readSec);
}

// 라이드를 먹인 버퍼. 채널 수·길이·샘플레이트를 보존하므로 조각 오프셋(초)이 그대로
// 유효하다 — alignToBeats·scheduleVoiceChunk·songSeconds는 라이드를 몰라도 된다.
//
// 분석은 채널 0으로 하고 게인은 전 채널에 같이 먹인다(좌우 균형이 어긋나지 않게).
// 대가: **피크 보장이 채널 0에서만 성립한다** — 채널 1이 더 큰 스테레오 입력에서는
// 그쪽이 자기 피크를 넘을 수 있다. mixLevels도 채널 0만 재므로 기존 설계와 일관되고,
// 마이크 녹음은 사실상 모노다(recorder.js).
function rideBuffer(ctx, audioBuffer, plan) {
  const out = ctx.createBuffer(audioBuffer.numberOfChannels, audioBuffer.length, audioBuffer.sampleRate);
  for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
    out.copyToChannel(applyRide(audioBuffer.getChannelData(c), plan), c);
  }
  return out;
}

// 챈트: 목소리를 자르지 않고 멜로디를 아래에 깐다.
//
// 음절을 늘리거나 잘라 박자에 맞추면 (1) 조각 사이 이음새가 사라지고 (2) 음보다
// 짧은 음절 뒤에 침묵이 들어가 말이 끊긴다. 그래서 두 방식만 둔다:
//   align=true(기본)  음절 시작만 박에 맞추고 뒤의 쉼으로 흡수한다 — 음절은 온전
//   align=false        녹음을 통째로 흘려보낸다 — 박에 안 맞는 대신 완전히 자연스럽다
function buildChantGraph(
  ctx,
  { audioBuffer, bounds, melody, align = true, melodyRatio, melodyTone, instrument, rideDb },
  startTime,
) {
  const { from, sec } = voiceSpan(audioBuffer, bounds);
  const sr = audioBuffer.sampleRate;
  const preset = pickInstrument(instrument);
  const samples = audioBuffer.getChannelData(0);
  const fromSample = Math.round(from * sr);
  const lengthSamples = Math.round(sec * sr);

  // **순서가 계약이다: 균형은 원본에서 잰다.** 라이드된 샘플을 mixLevels에 넣으면
  // rms가 올라가 melodyLevel이 함께 커진다 — 조용한 부분을 들리게 하려는 목적과
  // 정반대다. 그래서 멜로디 레벨·마스터·프리셋은 라이드와 무관하게 결정된다.
  //
  // test/synth.test.mjs의 `멜로디 균형은 라이드 전 원본에서 재야 한다`가 그 **이유**를
  // (뒤집으면 melodyLevel이 커진다는 것을) 증명하지만, 이 함수의 호출 순서 자체는
  // 브라우저 경로라 node 테스트가 관측하지 못한다 — 여기 두 줄의 순서가 유일한 보장이다.
  const { voiceGain, melodyLevel, master: masterGain } = mixLevels(
    samples,
    fromSample,
    lengthSamples,
    melodyRatio,
    preset.level * PRESET_RESONANCE,
  );

  // 조용한 음절을 프레임 단위로 끌어올린다. 피크를 올리지 않으므로 위 클리핑 여유가
  // 그대로 유효하고, 길이·인덱스를 보존하므로 아래 조각 오프셋도 그대로 쓴다.
  const ride = ridePlan(samples, sr, fromSample, lengthSamples, { maxBoostDb: rideDb });
  const voiceBuffer = ride.meanBoostDb > 0 ? rideBuffer(ctx, audioBuffer, ride) : audioBuffer;

  const master = ctx.createGain();
  master.gain.value = masterGain;
  master.connect(ctx.destination);

  let voiceSec = sec;
  if (align && bounds.length) {
    const { placed, totalSec } = alignToBeats(bounds, sr, 60 / melody.bpm);
    for (const chunk of placed) {
      scheduleVoiceChunk(ctx, master, voiceBuffer, {
        ...chunk,
        when: startTime + chunk.at,
        level: voiceGain,
      });
    }
    voiceSec = totalSec;
  } else {
    // 통째로 흘려보내는 경로는 뒤에 이어질 조각이 없다 — joinsNext=false가 곧
    // "페이드 아웃을 자기 재료 안에서 한다"이고, voiceSpan이 녹음 끝으로 클램프하므로
    // 더 읽을 재료가 없을 수도 있다는 사정이 정렬 경로의 마지막 조각과 같다.
    scheduleVoiceChunk(ctx, master, voiceBuffer, {
      when: startTime,
      from,
      ...chunkTiming(sec, XFADE_SEC, false),
      level: voiceGain,
    });
  }

  const { noteTimes, endTime } = scheduleMelody(
    ctx,
    master,
    melody,
    startTime,
    melodyLevel,
    preset,
    melodyTone,
  );
  return {
    durationSec: Math.max(voiceSec, endTime - startTime) + TAIL_SEC,
    master,
    noteTimes,
  };
}

export function buildGraph(ctx, spec, startTime = 0) {
  if (spec.chant) return buildChantGraph(ctx, spec, startTime);
  const { audioBuffer, segments, grains, voices, melody, pad } = spec;
  if (segments.length !== melody.notes.length) {
    throw new RangeError(
      `segments(${segments.length})와 notes(${melody.notes.length}) 개수가 다르다 — 호출 전에 정규화할 것`,
    );
  }
  // voices를 빼먹으면 전 음이 조용히 그레인 경로로 떨어진다 — 그건 이 프로젝트가
  // 벗어나려는 소리라서, 침묵보다 실패가 낫다.
  if (!voices || voices.length !== melody.notes.length) {
    throw new RangeError(`voices가 없거나 개수가 다르다 — renderVoices의 결과를 그대로 넘길 것`);
  }

  const secPerBeat = 60 / melody.bpm;

  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  if (pad) {
    scheduleMelody(ctx, master, melody, startTime, 0.1, pickInstrument(spec.instrument), spec.melodyTone);
  }

  // 각 음이 언제 울리는지 함께 돌려준다. 화면에서 음절 구슬을 소리에 맞춰 켜려면
  // 이 시각이 필요하고, UI가 따로 계산하면 타이밍 로직이 두 곳으로 갈라진다.
  const noteTimes = [];

  let when = startTime;
  melody.notes.forEach((note, i) => {
    noteTimes.push(when);
    const noteSec = note.beats * secPerBeat;
    scheduleSegment(
      ctx,
      master,
      audioBuffer,
      segments[i],
      grains[i],
      voices[i],
      midiToHz(note.midi),
      when,
      noteSec,
    );
    when += noteSec;
  });

  return { durationSec: when - startTime + TAIL_SEC, master, noteTimes };
}

// 곡 안의 재생 위치를 0~1로 준다. 음 사이를 시간으로 보간하되 단위는 "몇 번째
// 음"이라 화면이 구슬의 x 매핑을 그대로 쓸 수 있다 — 선이 구슬에 닿는 순간이
// 그 구슬이 켜지는 순간과 같아진다. 시각 계산은 noteTimes를 만든 이 모듈에만
// 둔다(화면이 따로 계산하면 소리와 어긋난다).
export function progressAt(noteTimes, t) {
  if (noteTimes.length < 2 || t <= noteTimes[0]) return 0;
  const span = noteTimes.length - 1;
  for (let i = 0; i < span; i++) {
    if (t < noteTimes[i + 1]) {
      return (i + (t - noteTimes[i]) / (noteTimes[i + 1] - noteTimes[i])) / span;
    }
  }
  // 마지막 구슬이 이미 캔버스 오른쪽 끝이라 그 뒤로 갈 자리가 없다 —
  // 마지막 음이 울리는 동안 선은 끝에 머문다.
  return 1;
}

// 곡 전체를 버퍼로 렌더한다. 재생도 저장도 이 결과를 쓴다 — 들리는 소리와
// 내려받는 파일이 같은 바이트여야 하고, 경로가 갈라지면 한쪽만 고쳐진다.
// noteTimes를 함께 돌려주는 이유: 화면이 박자를 다시 계산하면 소리와 어긋난다.
// 곡 길이. 버퍼 할당(여기)과 그래프(buildChantGraph)가 같은 값을 봐야 하므로
// 목소리 길이 계산을 두 곳에 적지 않는다.
export function songSeconds(spec) {
  const beatSec = 60 / spec.melody.bpm;
  const melodySec = spec.melody.notes.reduce((sum, n) => sum + n.beats, 0) * beatSec;
  if (!spec.chant) return melodySec;
  const voiceSec =
    spec.align !== false && spec.bounds && spec.bounds.length
      ? alignToBeats(spec.bounds, spec.audioBuffer.sampleRate, beatSec).totalSec
      : voiceSpan(spec.audioBuffer, spec.bounds).sec;
  return Math.max(voiceSec, melodySec);
}

export async function renderOffline(spec) {
  const sampleRate = spec.audioBuffer.sampleRate;
  const songSec = songSeconds(spec);
  const ctx = new OfflineAudioContext(2, Math.ceil((songSec + TAIL_SEC) * sampleRate), sampleRate);
  const { noteTimes, durationSec } = buildGraph(ctx, spec);
  const buffer = await ctx.startRendering();
  return { buffer, noteTimes, durationSec };
}

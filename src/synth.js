import { midiToHz } from './composer.js';
import { renderNote } from './psola.js';

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

// 멜로디 악기의 배음 구성(기본음·2·3·4배음). 순수 사인파는 진폭이 같아도 말소리보다
// 훨씬 작게 들린다 — 화자 음높이대(200~400Hz)에 에너지가 전부 몰려 있고 **귀가 가장
// 민감한 1~3kHz 대역이 비기 때문**이다(실기 지적: "멜로디가 여전히 작다"). 배음을
// 얹으면 진폭을 키우지 않고도 지각 음량이 올라간다. createPeriodicWave가 피크를
// 정규화하므로 클리핑 계산(mixLevels)도 그대로 유효하다.
// 실기 청취로 한 단계 더 올렸다(2·3배음 0.45·0.22 → 0.75·0.55, 5·6배음 추가).
// tone으로 기본음 위 배음만 한꺼번에 조절한다 — 0이면 순수 사인파다.
const MELODY_HARMONICS = [0, 1, 0.75, 0.55, 0.38, 0.24, 0.14];

function melodyWave(ctx, tone = 1) {
  const imag = Float32Array.from(MELODY_HARMONICS, (amp, i) =>
    i <= 1 ? amp : Math.min(1, amp * tone),
  );
  return ctx.createPeriodicWave(new Float32Array(imag.length), imag);
}

// 멜로디를 악기로 연주한다. 저역 삼각파 패드가 화자 음높이가 낮을 때 웅웅거려
// 사용자가 "비프음"으로 들었으므로 저역통과로 거친 배음을 깎아 순하게 남긴다.
//
// 음 시각을 돌려주는 쪽이 이 함수다 — 화면 구슬이 이 시각을 그대로 쓴다.
function scheduleMelody(ctx, dest, melody, startTime, level, tone) {
  const secPerBeat = 60 / melody.bpm;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  // 1400Hz로 막으면 배음이 통째로 잘려 다시 사인파가 된다. 3.5kHz까지 열어 두되
  // 그 위는 깎는다 — 거친 고역이 남으면 예전의 "비프음" 인상으로 돌아간다.
  lowpass.frequency.value = 3500;
  lowpass.connect(dest);

  const wave = melodyWave(ctx, tone);
  const noteTimes = [];
  let when = startTime;
  for (const note of melody.notes) {
    const noteSec = note.beats * secPerBeat;
    noteTimes.push(when);
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave);
    osc.frequency.value = midiToHz(note.midi);
    const gain = ctx.createGain();
    // 감쇠를 얕게 둔다(0.4배 → 0.75배). 목소리는 감쇠가 없으므로 깊게 감쇠하면
    // 평균 음량이 목소리보다 훨씬 낮아져 "멜로디가 작다"로 들린다.
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + 0.02);
    gain.gain.setValueAtTime(level, when + noteSec * 0.6);
    gain.gain.exponentialRampToValueAtTime(level * 0.75, when + noteSec * 0.9);
    gain.gain.linearRampToValueAtTime(0, when + noteSec);
    osc.connect(gain);
    gain.connect(lowpass);
    osc.start(when);
    osc.stop(when + noteSec);
    when += noteSec;
  }
  return { noteTimes, endTime: when };
}

// 녹음에서 목소리가 실제로 있는 구간. 앞뒤 침묵만 잘라내고 **음절 사이는 건드리지
// 않는다** — 조각을 잘라 이어붙이면 그 사이의 자연스러운 이음새가 사라져 말이
// 뚝뚝 끊긴다(실기 지적). 챈트 렌더와 화면이 같은 값을 봐야 하므로 여기 한 곳에서만 정한다.
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
const GRID_MAX_SEC = 0.4;
const DIVISIONS = [1, 2, 4, 8];

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

export function alignToBeats(bounds, sampleRate, beatSec, tailSec = 0.25) {
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
    // 자연 간격을 격자로 반올림하되, 음절이 잘리지 않을 만큼은 반드시 준다
    const units = Math.max(1, Math.round(spans[i] / gridSec), Math.ceil(syllableSec / gridSec));
    const allotted = units * gridSec;
    placed.push({
      at,
      from: onsets[i],
      dur: Math.min(spans[i], allotted),
      syllableSec,
      units,
    });
    at += allotted;
  }
  return { placed, totalSec: at, gridSec };
}

// 목소리를 먼저 정규화하고 그 위에서 멜로디 비율을 잡는다.
//
// 절대 RMS에 비례시키면 작게 녹음한 날은 멜로디가 하한에 붙고 전체가 작아진다
// (실기 지적: "멜로디가 작다 / 내 녹음이 작아서인가" — 그렇다). 목소리 피크를
// 먼저 기준선까지 올려 두면 마이크 레벨과 무관하게 둘의 균형이 같아진다.
const VOICE_PEAK = 0.89; // 정규화 목표 피크
const VOICE_GAIN_MAX = 8; // 무음·잡음만 있는 녹음을 증폭하지 않기 위한 상한
// 정규화된 목소리 RMS 대비 멜로디 진폭. 실기 청취로 정했다(1 → 작다, 2.2 → 여전히
// 작다, 3 → 적당). 배음을 얹어 지각 음량이 함께 올랐으므로 이 숫자만의 결과는 아니다.
const MELODY_TO_VOICE = 3;

export function mixLevels(samples, fromSample, lengthSamples, ratio = MELODY_TO_VOICE) {
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
  // 상한은 실질적으로 걸리지 않게 둔다. 0.6으로 두니 보통 음량 녹음에서 걸려
  // 비율이 아니라 상한이 음량을 결정했다(테스트에서 0.445 vs 0.6으로 갈렸다).
  // 합이 1을 넘는 문제는 아래 마스터가 비율을 유지한 채 눌러서 해결한다.
  const melodyLevel = Math.min(1, Math.max(0.08, rms * voiceGain * ratio));
  // 정규화한 목소리 피크와 멜로디가 겹쳐도 1을 넘지 않게 눌러 둔다(비율은 유지)
  const master = Math.min(1, 0.97 / (Math.min(VOICE_PEAK, peak * voiceGain) + melodyLevel));
  return { voiceGain, melodyLevel, master };
}

const FADE_SEC = 0.02; // 조각 경계에서 딱 소리가 나지 않을 만큼만

// 한 덩이의 목소리를 페이드 인·아웃으로 얹는다. 잘린 자리는 쉼 구간이므로
// 이 페이드가 말을 건드리지 않는다.
function scheduleVoiceChunk(ctx, dest, buffer, when, from, dur, level) {
  const fade = Math.min(FADE_SEC, dur / 3);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, when);
  gain.gain.linearRampToValueAtTime(level, when + fade);
  gain.gain.setValueAtTime(level, when + dur - fade);
  gain.gain.linearRampToValueAtTime(0, when + dur);
  gain.connect(dest);

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(gain);
  src.start(when, from, dur);
}

// 챈트: 목소리를 자르지 않고 멜로디를 아래에 깐다.
//
// 음절을 늘리거나 잘라 박자에 맞추면 (1) 조각 사이 이음새가 사라지고 (2) 음보다
// 짧은 음절 뒤에 침묵이 들어가 말이 끊긴다. 그래서 두 방식만 둔다:
//   align=true(기본)  음절 시작만 박에 맞추고 뒤의 쉼으로 흡수한다 — 음절은 온전
//   align=false        녹음을 통째로 흘려보낸다 — 박에 안 맞는 대신 완전히 자연스럽다
function buildChantGraph(
  ctx,
  { audioBuffer, bounds, melody, align = true, melodyRatio, melodyTone },
  startTime,
) {
  const { from, sec } = voiceSpan(audioBuffer, bounds);
  const sr = audioBuffer.sampleRate;
  const { voiceGain, melodyLevel, master: masterGain } = mixLevels(
    audioBuffer.getChannelData(0),
    Math.round(from * sr),
    Math.round(sec * sr),
    melodyRatio,
  );

  const master = ctx.createGain();
  master.gain.value = masterGain;
  master.connect(ctx.destination);

  let voiceSec = sec;
  if (align && bounds.length) {
    const { placed, totalSec } = alignToBeats(bounds, sr, 60 / melody.bpm);
    for (const chunk of placed) {
      scheduleVoiceChunk(ctx, master, audioBuffer, startTime + chunk.at, chunk.from, chunk.dur, voiceGain);
    }
    voiceSec = totalSec;
  } else {
    scheduleVoiceChunk(ctx, master, audioBuffer, startTime, from, sec, voiceGain);
  }

  const { noteTimes, endTime } = scheduleMelody(ctx, master, melody, startTime, melodyLevel, melodyTone);
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

  if (pad) scheduleMelody(ctx, master, melody, startTime, 0.1, spec.melodyTone);

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

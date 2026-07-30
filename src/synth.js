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

// 멜로디를 악기로 연주한다. 사인파 + 저역통과에 으뜸음 위 옥타브 — 예전 저역
// 삼각파 패드가 화자 음높이가 낮을 때 웅웅거려 사용자가 "비프음"으로 들었기
// 때문에 위로 올리고 순한 파형을 쓴다. 목소리가 위에 얹히도록 작게 깐다.
//
// 음 시각을 돌려주는 쪽이 이 함수다 — 화면 구슬이 이 시각을 그대로 쓴다.
function scheduleMelody(ctx, dest, melody, startTime, level) {
  const secPerBeat = 60 / melody.bpm;
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 1400;
  lowpass.connect(dest);

  const noteTimes = [];
  let when = startTime;
  for (const note of melody.notes) {
    const noteSec = note.beats * secPerBeat;
    noteTimes.push(when);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = midiToHz(note.midi);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(level * 0.4, when + noteSec * 0.85);
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

// 챈트: 목소리를 자르지 않고 통째로 흘려보내고 멜로디를 아래에 깐다.
//
// 음절을 박자에 맞춰 재배치하면 (1) 조각 사이 이음새가 사라지고 (2) 음보다 짧은
// 음절 뒤에 침묵이 들어가 말이 끊긴다. 목소리를 그대로 두면 둘 다 사라지는 대신
// 목소리가 박에 정렬되지 않는다 — 랩·챈트 트랙이 쓰는 교환이다.
function buildChantGraph(ctx, { audioBuffer, bounds, melody }, startTime) {
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);

  const { from, sec } = voiceSpan(audioBuffer, bounds);
  const gain = ctx.createGain();
  // 20ms 페이드 — 잘린 자리에서 딱 소리가 나지 않게. 그 사이는 손대지 않는다.
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(1, startTime + 0.02);
  gain.gain.setValueAtTime(1, startTime + sec - 0.02);
  gain.gain.linearRampToValueAtTime(0, startTime + sec);
  gain.connect(master);

  const src = ctx.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(gain);
  src.start(startTime, from, sec);

  const { noteTimes, endTime } = scheduleMelody(ctx, master, melody, startTime, 0.16);
  return {
    durationSec: Math.max(sec, endTime - startTime) + TAIL_SEC,
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

  if (pad) scheduleMelody(ctx, master, melody, startTime, 0.1);

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
export async function renderOffline(spec) {
  const sampleRate = spec.audioBuffer.sampleRate;
  const melodySec = spec.melody.notes.reduce((sum, n) => sum + n.beats, 0) * (60 / spec.melody.bpm);
  // 챈트는 목소리를 자르지 않으므로 목소리와 멜로디 중 긴 쪽이 곡 길이다
  const songSec = spec.chant ? Math.max(voiceSpan(spec.audioBuffer, spec.bounds).sec, melodySec) : melodySec;
  const ctx = new OfflineAudioContext(2, Math.ceil((songSec + TAIL_SEC) * sampleRate), sampleRate);
  const { noteTimes, durationSec } = buildGraph(ctx, spec);
  const buffer = await ctx.startRendering();
  return { buffer, noteTimes, durationSec };
}

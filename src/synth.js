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

// 반주(아르페지오)는 기본으로 두지 않는다 — 예전 저역 삼각파 패드가 화자 음높이가
// 낮을 때 웅웅거려 사용자가 "비프음"으로 들었다. 그래서 사인파 + 저역통과에
// 으뜸음 **위** 옥타브로 올려 한 박씩 짚는 형태로만 되살렸고, 켜는 건 선택이다.
// 목소리를 그대로 두고(챈트) 반주가 멜로디를 담당하는 조합을 청취 비교하기 위한 것.
function schedulePad(ctx, dest, melody, startTime) {
  const secPerBeat = 60 / melody.bpm;
  const totalBeats = melody.notes.reduce((sum, n) => sum + n.beats, 0);
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.value = 1200;
  lowpass.connect(dest);

  const steps = [0, 4, 7, 4]; // 으뜸 3화음을 오르내린다
  for (let beat = 0; beat < Math.floor(totalBeats); beat++) {
    const when = startTime + beat * secPerBeat;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = midiToHz(melody.tonicMidi + 12 + steps[beat % steps.length]);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(0.12, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + secPerBeat * 0.9);
    osc.connect(gain);
    gain.connect(lowpass);
    osc.start(when);
    osc.stop(when + secPerBeat);
  }
}

export function buildGraph(ctx, { audioBuffer, segments, grains, voices, melody, pad }, startTime = 0) {
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

  if (pad) schedulePad(ctx, master, melody, startTime);

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
  const secPerBeat = 60 / spec.melody.bpm;
  const totalBeats = spec.melody.notes.reduce((s, n) => s + n.beats, 0);
  const sampleRate = spec.audioBuffer.sampleRate;
  const length = Math.ceil((totalBeats * secPerBeat + TAIL_SEC) * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const { noteTimes, durationSec } = buildGraph(ctx, spec);
  const buffer = await ctx.startRendering();
  return { buffer, noteTimes, durationSec };
}

import { midiToHz } from './composer.js';

const ACCOMP_GAIN = 0.5; // 목소리보다 약 6dB 낮게 — 가사가 묻히지 않게
// 마지막 음이 끝난 뒤 남기는 여유. 재생 길이 보고와 오프라인 렌더 버퍼 할당이
// 같은 값을 써야 한다 — 따로 두면 한쪽만 고쳤을 때 꼬리가 잘린다.
const TAIL_SEC = 0.5;

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

function scheduleAccompaniment(ctx, dest, melody, chords, secPerBeat, startTime) {
  for (const chord of chords) {
    const when = startTime + chord.startBeat * secPerBeat;
    const dur = chord.beats * secPerBeat;
    for (const semitone of chord.semitones) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = midiToHz(chord.rootMidi + semitone);
      const gain = ctx.createGain();
      // 패드는 마디를 다 채우지 않는다 — 목소리 사이 여백이 들려야 박자가 생긴다
      const padDur = dur * 0.6;
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(0.1, when + 0.04);
      gain.gain.linearRampToValueAtTime(0, when + padDur);
      osc.connect(gain);
      gain.connect(dest);
      osc.start(when);
      osc.stop(when + padDur);
    }
  }

  // 8분음표 셰이커 — 정박을 조금 세게
  const totalBeats = melody.notes.reduce((s, n) => s + n.beats, 0);
  const noise = makeNoiseBuffer(ctx);
  for (let beat = 0; beat < totalBeats; beat += 0.5) {
    const when = startTime + beat * secPerBeat;
    const src = ctx.createBufferSource();
    src.buffer = noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 6000;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(beat % 1 === 0 ? 0.16 : 0.09, when);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    src.connect(hp);
    hp.connect(gain);
    gain.connect(dest);
    src.start(when);
    src.stop(when + 0.06);
  }
}

export function buildGraph(ctx, { audioBuffer, segments, grains, melody, chords }, startTime = 0) {
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

  // 각 음이 언제 울리는지 함께 돌려준다. 화면에서 음절 구슬을 소리에 맞춰 켜려면
  // 이 시각이 필요하고, UI가 따로 계산하면 타이밍 로직이 두 곳으로 갈라진다.
  const noteTimes = [];

  let when = startTime;
  melody.notes.forEach((note, i) => {
    noteTimes.push(when);
    const noteSec = note.beats * secPerBeat;
    scheduleSegment(ctx, voiceBus, audioBuffer, segments[i], grains[i], midiToHz(note.midi), when, noteSec);
    when += noteSec;
  });

  scheduleAccompaniment(ctx, accompBus, melody, chords, secPerBeat, startTime);

  return { durationSec: when - startTime + TAIL_SEC, master, noteTimes };
}

// resume 직후 currentTime이 0에 머물다가 오디오 스레드가 돌기 시작할 때 크게 앞으로
// 점프한다(실측 약 1초). 점프 전에 스케줄하면 곡 앞부분이 과거에 걸려 첫 음이 뭉친다.
export async function safeStartTime(ctx, lead = 0.1) {
  await ctx.resume();
  if (ctx.currentTime === 0) {
    await new Promise((resolve) => {
      const tick = () => (ctx.currentTime > 0 ? resolve() : requestAnimationFrame(tick));
      tick();
    });
  }
  return ctx.currentTime + lead;
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

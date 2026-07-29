import { midiToHz } from './composer.js';

const ACCOMP_GAIN = 0.5; // 목소리보다 약 6dB 낮게 — 가사가 묻히지 않게

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

  return { durationSec: when + 0.3 };
}

export async function renderOffline(spec) {
  const secPerBeat = 60 / spec.melody.bpm;
  const totalBeats = spec.melody.notes.reduce((s, n) => s + n.beats, 0);
  const sampleRate = spec.audioBuffer.sampleRate;
  const length = Math.ceil((totalBeats * secPerBeat + 0.5) * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  buildGraph(ctx, spec);
  return ctx.startRendering();
}

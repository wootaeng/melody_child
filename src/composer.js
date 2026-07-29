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

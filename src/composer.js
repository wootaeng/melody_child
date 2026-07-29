// 장5음계 8음 한 절을 만들어 절마다 반복한다 — 동요의 실제 구조.
// 5음계만 쓰는 이유: 어떤 순서로 나열해도 불협이 생기지 않는다.
//
// 단 음을 매번 무작위로 뽑으면 곡조가 아니라 음렬이 된다(실측: 사용자가
// "동요 멜로디가 아니다"라고 지적). 동요는 인접한 음으로 걷고, 같은 음을
// 반복하고, 프레이즈 끝을 안정된 음으로 닫는다. 그래서 음 자체가 아니라
// 5음계 위의 걸음(-1·0·+1)을 뽑는다.

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

export function composeMelody(noteCount, seed, referenceHz) {
  if (!Number.isInteger(noteCount) || noteCount < 1) {
    throw new RangeError(`noteCount는 1 이상의 정수여야 한다: ${noteCount}`);
  }
  const rnd = mulberry32(seed);
  let tonicMidi = 60 + Math.floor(rnd() * 5); // C4~E4
  const bpm = 96 + Math.floor(rnd() * 25); // 96~120

  // 화자의 음높이에 맞춰 곡 전체를 옥타브 단위로 옮긴다. 조각마다 따로 접으면
  // 음의 옥타브가 무작위로 튀어 멜로디 윤곽이 사라지므로 전곡을 한 번만 옮긴다.
  // 화음도 tonicMidi에서 파생되므로 반주가 함께 따라온다.
  if (referenceHz > 0) {
    tonicMidi += 12 * Math.round(Math.log2(referenceHz / midiToHz(tonicMidi)));
  }

  // 5음계 위를 걷는다. 대부분 인접 음(±1)이나 제자리(0)로 움직여 부를 수 있는
  // 선을 만들고, 옥타브 점프는 쓰지 않는다 — 점프가 음역을 넓혀 재생 속도까지
  // 극단으로 밀어 목소리를 망가뜨렸다.
  const STEPS = [-1, 0, 1, 1, -1, 1, -1, 0, 2, -2];
  let degree = Math.floor(rnd() * PENTATONIC.length);

  const nextDegree = () => {
    const step = STEPS[Math.floor(rnd() * STEPS.length)];
    degree = Math.min(PENTATONIC.length - 1, Math.max(0, degree + step));
    return degree;
  };

  // 프레이즈는 4음. 앞 프레이즈는 열어 두고(으뜸음 아님), 뒤 프레이즈는
  // 으뜸음으로 닫는다 — 묻고 답하는 동요의 기본 골격이다.
  const makePhrase = (closing) => {
    const phrase = Array.from({ length: PHRASE_LEN }, () => ({
      midi: tonicMidi + PENTATONIC[nextDegree()],
      beats: 1,
    }));

    if (closing) {
      degree = 0;
      phrase[PHRASE_LEN - 1] = { midi: tonicMidi, beats: 1 };
    } else if (phrase[PHRASE_LEN - 1].midi === tonicMidi) {
      degree = 2; // 앞 프레이즈가 으뜸음으로 닫히면 답할 것이 없어진다
      phrase[PHRASE_LEN - 1] = { midi: tonicMidi + PENTATONIC[2], beats: 1 };
    }

    // 리듬은 4분음표 위주이고 8분음표는 둘씩 붙인다. 마지막 음을 확정한 뒤에
    // 얹어야 한다 — 먼저 얹으면 닫는 음이 짝의 뒤쪽을 덮어 8분음표 하나가
    // 홀로 남고 걸음이 절뚝인다.
    if (rnd() < 0.4) {
      const i = Math.floor(rnd() * (PHRASE_LEN - 2));
      phrase[i].beats = 0.5;
      phrase[i + 1].beats = 0.5;
    }
    return phrase;
  };

  // 한 절 = 프레이즈 여러 개, 마지막 프레이즈가 닫는다. VERSE_LEN에서 개수를
  // 끌어내므로 절 길이를 바꿀 때 고칠 곳이 한 군데다.
  const phraseCount = VERSE_LEN / PHRASE_LEN;
  const verse = Array.from({ length: phraseCount }, (_, i) =>
    makePhrase(i === phraseCount - 1),
  ).flat();

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

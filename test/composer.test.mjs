import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMelody, midiToHz, PENTATONIC, VERSE_LEN } from '../src/composer.js';

test('음계를 좁히면 음역도 그만큼 좁아진다 (목소리 왜곡 조절 손잡이)', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const melody = composeMelody(8, seed, 220, { degrees: [0, 2, 4] });
    const offsets = melody.notes.map((n) => n.midi - melody.tonicMidi);
    for (const off of offsets) {
      assert.ok([0, 2, 4].includes(off), `seed ${seed}: 음계 밖 음 ${off}`);
    }
    assert.ok(Math.max(...offsets) - Math.min(...offsets) <= 4, `seed ${seed}: 음역이 넓다`);
  }
  assert.throws(() => composeMelody(8, 1, 220, { degrees: [0] }), RangeError);
});

test('요청한 개수만큼 음을 만든다', () => {
  for (const count of [1, 3, 8, 17, 24, 60, 137]) {
    assert.equal(composeMelody(count, 1).notes.length, count, `count=${count}`);
  }
});

test('한 절이 그대로 반복된다 (마지막 음 제외)', () => {
  const m = composeMelody(35, 5);
  const verse = m.notes.slice(0, VERSE_LEN);
  for (let i = 0; i < m.notes.length - 1; i++) {
    assert.deepEqual(m.notes[i], verse[i % VERSE_LEN], `음 ${i}이 절 패턴과 다르다`);
  }
});

test('절 개수와 절 길이를 보고한다', () => {
  assert.equal(composeMelody(35, 5).verseLen, VERSE_LEN);
  assert.equal(composeMelody(35, 5).verseCount, Math.ceil(35 / VERSE_LEN));
  assert.equal(composeMelody(8, 5).verseCount, 1);
  assert.equal(composeMelody(9, 5).verseCount, 2);
});

test('모든 음이 으뜸음 기준 5음계에 속한다', () => {
  for (let seed = 0; seed < 20; seed++) {
    const m = composeMelody(40, seed);
    for (const note of m.notes) {
      const degree = ((note.midi - m.tonicMidi) % 12 + 12) % 12;
      assert.ok(PENTATONIC.includes(degree), `seed=${seed} midi=${note.midi} degree=${degree}`);
    }
  }
});

test('마지막 음은 으뜸음이다', () => {
  for (let seed = 0; seed < 20; seed++) {
    const m = composeMelody(9, seed);
    assert.equal(m.notes.at(-1).midi, m.tonicMidi, `seed=${seed}`);
  }
});

test('멜로디는 인접한 음으로 걷는다 — 옥타브 점프 없음', () => {
  for (let seed = 0; seed < 20; seed++) {
    const m = composeMelody(16, seed);
    for (const note of m.notes) {
      const offset = note.midi - m.tonicMidi;
      assert.ok(offset >= 0 && offset <= 9, `seed=${seed} 음역 이탈: ${offset}`);
    }
    const degrees = m.notes
      .slice(0, m.verseLen)
      .map((n) => PENTATONIC.indexOf(n.midi - m.tonicMidi));
    const steps = degrees.slice(1).map((d, i) => Math.abs(d - degrees[i]));
    const small = steps.filter((s) => s <= 1).length;
    assert.ok(small / steps.length >= 0.5, `seed=${seed} 도약이 너무 많다: ${steps.join(',')}`);
  }
});

test('절은 으뜸음으로 닫고 앞 프레이즈는 열어 둔다', () => {
  for (let seed = 0; seed < 20; seed++) {
    const m = composeMelody(16, seed);
    const verse = m.notes.slice(0, m.verseLen);
    assert.equal(verse.at(-1).midi, m.tonicMidi, `seed=${seed} 절이 으뜸음으로 닫히지 않았다`);
    assert.notEqual(
      verse[m.verseLen / 2 - 1].midi,
      m.tonicMidi,
      `seed=${seed} 앞 프레이즈가 으뜸음으로 닫혀 답할 것이 없다`,
    );
  }
});

test('리듬은 4분음표 위주이고 8분음표는 반드시 짝으로 붙는다', () => {
  for (let seed = 0; seed < 20; seed++) {
    const verse = composeMelody(16, seed).notes.slice(0, 8);
    const isHalf = verse.map((n) => n.beats === 0.5);
    assert.ok(
      isHalf.filter(Boolean).length % 2 === 0,
      `seed=${seed} 8분음표가 홀수 개다: ${verse.map((n) => n.beats).join(',')}`,
    );
    // 홀로 있는 8분음표가 없어야 한다 — 걸음이 절뚝인다
    isHalf.forEach((half, i) => {
      if (!half) return;
      const paired = isHalf[i - 1] === true || isHalf[i + 1] === true;
      assert.ok(paired, `seed=${seed} ${i}번째 8분음표가 홀로 있다`);
    });
    assert.ok(
      verse.filter((n) => n.beats === 1).length >= 4,
      `seed=${seed} 4분음표가 절반도 안 된다`,
    );
  }
});

test('BPM은 96~120 범위', () => {
  for (let seed = 0; seed < 20; seed++) {
    const { bpm } = composeMelody(8, seed);
    assert.ok(bpm >= 96 && bpm <= 120, `bpm=${bpm}`);
  }
});

test('같은 시드는 같은 결과 (결정적)', () => {
  assert.deepEqual(composeMelody(12, 7), composeMelody(12, 7));
});

test('다른 시드는 다른 결과', () => {
  const a = composeMelody(12, 1);
  const b = composeMelody(12, 2);
  assert.notDeepEqual(a.notes, b.notes);
});

test('noteCount가 1 미만이면 예외', () => {
  assert.throws(() => composeMelody(0, 1), RangeError);
  assert.throws(() => composeMelody(-3, 1), RangeError);
  assert.throws(() => composeMelody(2.5, 1), RangeError);
});

test('midiToHz: A4(69)는 440Hz, 한 옥타브 위는 두 배', () => {
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.ok(Math.abs(midiToHz(81) - 880) < 1e-6);
});

test('referenceHz를 주면 곡 전체를 옥타브 단위로 이조한다', () => {
  for (let seed = 0; seed < 10; seed++) {
    const plain = composeMelody(16, seed);
    const low = composeMelody(16, seed, 120);
    // Math.abs를 거치는 이유: `-12 % 12`는 `-0`이고 assert/strict는 Object.is로
    // 비교하므로 `-0 === 0`이 아니다. 아래로 이조될 때 그냥 `% 12`를 쓰면 실패한다.
    assert.equal(Math.abs(low.tonicMidi - plain.tonicMidi) % 12, 0, '옥타브 단위가 아니다');
    const shape = (m) => m.notes.map((n) => n.midi - m.tonicMidi);
    assert.deepEqual(shape(low), shape(plain), '멜로디 윤곽이 바뀌었다');
  }
});

test('이조하면 으뜸음이 화자 음높이 근처로 온다', () => {
  for (let seed = 0; seed < 10; seed++) {
    const ratio = midiToHz(composeMelody(16, seed, 120).tonicMidi) / 120;
    assert.ok(ratio > 0.7 && ratio < 1.5, `seed=${seed} 비율 ${ratio}`);
  }
});

test('referenceHz가 없으면 이조하지 않는다', () => {
  assert.deepEqual(composeMelody(12, 3), composeMelody(12, 3, undefined));
});

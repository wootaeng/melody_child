import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeMelody, chordsFor, midiToHz, PENTATONIC, VERSE_LEN } from '../src/composer.js';

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

test('화성은 멜로디 전체 길이를 덮는다 (긴 곡도)', () => {
  const m = composeMelody(53, 3);
  const totalBeats = m.notes.reduce((s, n) => s + n.beats, 0);
  const chords = chordsFor(m);
  assert.ok(chords.length > 0);
  assert.equal(chords[0].startBeat, 0);
  const covered = chords.reduce((s, c) => s + c.beats, 0);
  assert.ok(Math.abs(covered - totalBeats) < 1e-9, `덮인 박 ${covered}, 전체 ${totalBeats}`);
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

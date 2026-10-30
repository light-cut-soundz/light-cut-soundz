import { describe, it, expect } from 'vitest'
import {
  mergeCuts,
  keptSegments,
  keptDuration,
  realToVirtual,
  virtualToReal,
  cutRanges,
  parseTimeInput,
  fmtPrecise,
} from './cuts.js'

const cut = (id, start, end) => ({ id, start, end })

describe('mergeCuts', () => {
  it('returns nothing for nothing', () => {
    expect(mergeCuts([])).toEqual([])
  })

  it('sorts the cuts', () => {
    expect(mergeCuts([cut('b', 5, 6), cut('a', 1, 2)]).map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('merges overlapping and touching cuts, keeping the earliest id', () => {
    expect(mergeCuts([cut('b', 3, 6), cut('a', 1, 4), cut('c', 6, 7)])).toEqual([cut('a', 1, 7)])
  })

  it('keeps a cut that lies inside another one inside it', () => {
    expect(mergeCuts([cut('a', 1, 9), cut('b', 2, 3)])).toEqual([cut('a', 1, 9)])
  })

  it('does not change what it is given', () => {
    const input = [cut('b', 3, 6), cut('a', 1, 4)]
    mergeCuts(input)
    expect(input[0]).toEqual(cut('b', 3, 6))
  })
})

describe('keptSegments', () => {
  it('keeps everything when nothing is cut', () => {
    expect(keptSegments([], 10)).toEqual([{ start: 0, end: 10 }])
  })

  it('keeps what lies between the cuts', () => {
    expect(keptSegments([cut('a', 2, 4), cut('b', 6, 8)], 10)).toEqual([
      { start: 0, end: 2 },
      { start: 4, end: 6 },
      { start: 8, end: 10 },
    ])
  })

  it('drops the edge when a cut starts at 0 or ends at the end', () => {
    expect(keptSegments([cut('a', 0, 3), cut('b', 8, 10)], 10)).toEqual([{ start: 3, end: 8 }])
  })

  it('clamps a cut past the end, and keeps nothing when all is cut', () => {
    expect(keptSegments([cut('a', 5, 99)], 10)).toEqual([{ start: 0, end: 5 }])
    expect(keptSegments([cut('a', 0, 10)], 10)).toEqual([])
  })

  it('keeps nothing of a file with no length', () => {
    expect(keptSegments([], 0)).toEqual([])
  })
})

describe('virtual time', () => {
  const kept = keptSegments([cut('a', 2, 4), cut('b', 6, 8)], 10) // 0–2, 4–6, 8–10

  it('adds up what is kept', () => {
    expect(keptDuration(kept)).toBe(6)
  })

  it('counts time along the kept segments', () => {
    expect(realToVirtual(1, kept)).toBe(1)
    expect(realToVirtual(5, kept)).toBe(3)
    expect(realToVirtual(9, kept)).toBe(5)
    expect(realToVirtual(10, kept)).toBe(6)
  })

  it('puts a time inside a cut at the cut', () => {
    expect(realToVirtual(3, kept)).toBe(2)
    expect(realToVirtual(7, kept)).toBe(4)
  })

  it('goes back from virtual to real', () => {
    expect(virtualToReal(1, kept)).toBe(1)
    expect(virtualToReal(3, kept)).toBe(5)
    expect(virtualToReal(5, kept)).toBe(9)
  })

  it('stays in the file past the ends', () => {
    expect(virtualToReal(99, kept)).toBe(10)
    expect(virtualToReal(-1, kept)).toBe(0)
    expect(virtualToReal(1, [])).toBe(0)
  })

  it('round-trips a time that is kept', () => {
    for (const t of [0, 0.5, 1.9, 4.2, 5.9, 8.1, 10]) {
      expect(virtualToReal(realToVirtual(t, kept), kept)).toBeCloseTo(t)
    }
  })
})

describe('cutRanges', () => {
  it('turns the cuts into merged [start, end] pairs inside the file', () => {
    expect(cutRanges([cut('b', 3, 6), cut('a', 1, 4), cut('c', 9, 15)], 10)).toEqual([
      [1, 6],
      [9, 10],
    ])
  })

  it('leaves out what falls outside the file', () => {
    expect(cutRanges([cut('a', 11, 12)], 10)).toEqual([])
  })
})

describe('parseTimeInput', () => {
  it('reads seconds, minutes and hours', () => {
    expect(parseTimeInput('83.4')).toBeCloseTo(83.4)
    expect(parseTimeInput('1:23.4')).toBeCloseTo(83.4)
    expect(parseTimeInput(' 1:02:03 ')).toBe(3723)
  })

  it('refuses what is not a time', () => {
    for (const bad of ['', 'abc', '1:', ':5', '1:2:3:4', '-3', '1:x']) {
      expect(parseTimeInput(bad), bad).toBeNull()
    }
  })
})

describe('fmtPrecise', () => {
  it('shows a tenth of a second', () => {
    expect(fmtPrecise(83.44)).toBe('1:23.4')
    expect(fmtPrecise(0)).toBe('0:00.0')
  })

  it('carries into the minute instead of printing 60 seconds', () => {
    expect(fmtPrecise(59.96)).toBe('1:00.0')
  })

  it('answers 0:00.0 for anything invalid', () => {
    expect(fmtPrecise(NaN)).toBe('0:00.0')
    expect(fmtPrecise(-1)).toBe('0:00.0')
  })
})

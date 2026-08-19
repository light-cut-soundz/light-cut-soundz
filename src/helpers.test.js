import { describe, it, expect } from 'vitest'
import {
  fmtTime,
  defaultTrimEnd,
  fadeGainAt,
  bandpassQ,
  clampFilterFreq,
  buildFilterSpecs,
  buildProcessOptions,
} from './helpers.js'

describe('fmtTime', () => {
  it('formats seconds as m:ss', () => {
    expect(fmtTime(0)).toBe('0:00')
    expect(fmtTime(9)).toBe('0:09')
    expect(fmtTime(65)).toBe('1:05')
    expect(fmtTime(3600)).toBe('60:00')
  })

  it('truncates rather than rounds', () => {
    expect(fmtTime(59.9)).toBe('0:59')
  })

  it('falls back to zero for invalid input', () => {
    expect(fmtTime(NaN)).toBe('0:00')
    expect(fmtTime(-5)).toBe('0:00')
    expect(fmtTime(undefined)).toBe('0:00')
  })
})

describe('defaultTrimEnd', () => {
  it('never exceeds the real duration', () => {
    // The old toFixed(1) returned 12.4 here, which the backend rejected.
    expect(defaultTrimEnd(12.36)).toBeLessThanOrEqual(12.36)
    expect(defaultTrimEnd(12.36)).toBe(12.36)
    expect(defaultTrimEnd(12.999)).toBe(12.99)
    expect(defaultTrimEnd(0.058)).toBe(0.05)
  })

  it('rounds down for every duration in a sweep', () => {
    for (let i = 1; i <= 2000; i++) {
      const d = i * 0.017
      expect(defaultTrimEnd(d)).toBeLessThanOrEqual(d)
    }
  })

  it('handles degenerate durations', () => {
    expect(defaultTrimEnd(0)).toBe(0)
    expect(defaultTrimEnd(-1)).toBe(0)
    expect(defaultTrimEnd(NaN)).toBe(0)
  })
})

describe('fadeGainAt', () => {
  const region = { start: 10, end: 20, fadeIn: 2, fadeOut: 2 }

  it('opens at silence and closes at silence, relative to the trim region', () => {
    expect(fadeGainAt(10, region)).toBeCloseTo(0)
    expect(fadeGainAt(20, region)).toBeCloseTo(0)
  })

  it('is at full gain in the middle', () => {
    expect(fadeGainAt(15, region)).toBe(1)
  })

  it('ramps linearly', () => {
    expect(fadeGainAt(11, region)).toBeCloseTo(0.5)
    expect(fadeGainAt(19, region)).toBeCloseTo(0.5)
  })

  it('ignores fades when the region is empty', () => {
    expect(fadeGainAt(5, { start: 10, end: 10, fadeIn: 2, fadeOut: 2 })).toBe(1)
  })

  it('stays inside [0, 1] outside the region', () => {
    expect(fadeGainAt(0, region)).toBe(0)
    expect(fadeGainAt(100, region)).toBe(0)
  })

  it('handles overlapping fades without going negative', () => {
    const tight = { start: 0, end: 1, fadeIn: 10, fadeOut: 10 }
    for (let t = 0; t <= 1; t += 0.1) {
      const g = fadeGainAt(t, tight)
      expect(g).toBeGreaterThanOrEqual(0)
      expect(g).toBeLessThanOrEqual(1)
    }
  })

  it('defaults to full gain without options', () => {
    expect(fadeGainAt(3)).toBe(1)
  })
})

describe('bandpassQ', () => {
  it('is centre over bandwidth', () => {
    expect(bandpassQ(1000, 200)).toBe(5)
  })

  it('falls back to 1 for a non-positive bandwidth', () => {
    expect(bandpassQ(1000, 0)).toBe(1)
    expect(bandpassQ(1000, -5)).toBe(1)
  })
})

describe('clampFilterFreq', () => {
  it('keeps the frequency below Nyquist', () => {
    expect(clampFilterFreq(30000, 44100)).toBe(44100 / 2 - 1)
  })

  it('keeps the frequency above zero', () => {
    expect(clampFilterFreq(0, 44100)).toBe(1)
    expect(clampFilterFreq(-100, 44100)).toBe(1)
  })

  it('passes valid frequencies through', () => {
    expect(clampFilterFreq(1000, 44100)).toBe(1000)
  })

  it('falls back to 1000 for invalid input', () => {
    expect(clampFilterFreq(NaN, 44100)).toBe(1000)
  })
})

describe('buildFilterSpecs', () => {
  it('builds the specs the Rust parser accepts', () => {
    expect(buildFilterSpecs({ type: 'lowpass', freq: 4000 })).toEqual(['lowpass:4000'])
    expect(buildFilterSpecs({ type: 'highpass', freq: 200 })).toEqual(['highpass:200'])
    expect(buildFilterSpecs({ type: 'bandpass', freq: 1000, bandwidth: 200 }))
      .toEqual(['bandpass:1000:200'])
  })

  it('emits nothing when no filter is selected', () => {
    expect(buildFilterSpecs({ type: '' })).toEqual([])
  })
})

describe('buildProcessOptions', () => {
  const ui = {
    filePath: '/tmp/in.wav',
    format: 'wav',
    duration: 12.36,
    trimEnabled: true,
    trimStart: 1,
    trimEnd: 12.4,
    fadeIn: 0,
    fadeOut: 0,
    normalize: false,
    speed: 1.0,
    filterType: '',
    filterFreq: 1000,
    filterBandwidth: 500,
  }

  it('clamps a trim end past the real duration', () => {
    // Regression: a rounded-up field value made the backend reject the export.
    const opts = buildProcessOptions(ui, '/tmp/out.wav')
    expect(opts.trim_end).toBe(12.36)
  })

  it('clamps a negative trim start', () => {
    const opts = buildProcessOptions({ ...ui, trimStart: -3 }, '/tmp/out.wav')
    expect(opts.trim_start).toBe(0)
  })

  it('keeps the end at or after the start', () => {
    const opts = buildProcessOptions({ ...ui, trimStart: 10, trimEnd: 2 }, '/tmp/out.wav')
    expect(opts.trim_end).toBeGreaterThanOrEqual(opts.trim_start)
  })

  it('sends null bounds when trim is off', () => {
    const opts = buildProcessOptions({ ...ui, trimEnabled: false }, '/tmp/out.wav')
    expect(opts.trim_start).toBeNull()
    expect(opts.trim_end).toBeNull()
  })

  it('omits a neutral speed', () => {
    expect(buildProcessOptions(ui, '/o').speed).toBeNull()
    expect(buildProcessOptions({ ...ui, speed: 1.5 }, '/o').speed).toBe(1.5)
  })

  it('omits zero-length fades', () => {
    expect(buildProcessOptions(ui, '/o').fade_in).toBeNull()
    expect(buildProcessOptions({ ...ui, fadeIn: 1.5 }, '/o').fade_in).toBe(1.5)
  })

  it('carries the input, output and format through', () => {
    const opts = buildProcessOptions({ ...ui, format: 'mp3' }, '/tmp/out.mp3')
    expect(opts.input).toBe('/tmp/in.wav')
    expect(opts.output).toBe('/tmp/out.mp3')
    expect(opts.format).toBe('mp3')
  })

  it('includes the selected filter', () => {
    const opts = buildProcessOptions(
      { ...ui, filterType: 'bandpass', filterFreq: 800, filterBandwidth: 100 },
      '/o',
    )
    expect(opts.filters).toEqual(['bandpass:800:100'])
  })

  it('tolerates a missing duration', () => {
    const opts = buildProcessOptions({ ...ui, duration: NaN }, '/o')
    expect(opts.trim_start).toBe(0)
    expect(opts.trim_end).toBe(0)
  })
})

describe('buildProcessOptions — falsy field fallbacks', () => {
  const base = {
    filePath: '/in.wav',
    format: 'wav',
    duration: 30,
    trimEnabled: true,
    trimStart: 5,
    trimEnd: 20,
    fadeIn: 0,
    fadeOut: 0,
    normalize: false,
    speed: 1,
    filterType: 'none',
    filterFreq: '',
    filterBandwidth: '',
  }

  it('treats a NaN trim start as 0', () => {
    const opts = buildProcessOptions({ ...base, trimStart: NaN }, '/out.wav')
    expect(opts.trim_start).toBe(0)
  })

  it('treats a NaN trim end as the full duration', () => {
    const opts = buildProcessOptions({ ...base, trimEnd: NaN }, '/out.wav')
    expect(opts.trim_end).toBe(30)
  })

  it('treats a zero trim end as the full duration', () => {
    const opts = buildProcessOptions({ ...base, trimStart: 0, trimEnd: 0 }, '/out.wav')
    expect(opts.trim_end).toBe(30)
  })

  it('nulls out a NaN fade in', () => {
    const opts = buildProcessOptions({ ...base, fadeIn: NaN }, '/out.wav')
    expect(opts.fade_in).toBeNull()
  })

  it('keeps a positive fade out and nulls a negative one', () => {
    expect(buildProcessOptions({ ...base, fadeOut: 2 }, '/out.wav').fade_out).toBe(2)
    expect(buildProcessOptions({ ...base, fadeOut: -1 }, '/out.wav').fade_out).toBeNull()
  })

  it('falls back to a zero duration when it is not a finite number', () => {
    const opts = buildProcessOptions({ ...base, duration: undefined }, '/out.wav')
    expect(opts.trim_start).toBe(0)
    expect(opts.trim_end).toBe(0)
  })
})

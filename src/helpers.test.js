import { describe, it, expect } from 'vitest'
import {
  fmtTime,
  defaultTrimEnd,
  fadeGainAt,
  bandpassQ,
  clampFilterFreq,
  buildFilterSpecs,
  buildProcessOptions,
  TARGET_PEAK,
  fadeEnvelopePoints,
  validateSettings,
  describeError,
  baseName,
  butterworthQ,
  qToDb,
  DEFAULT_Q,
  SLOPES,
  defaultOutputPath,
  waveformPeak,
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

describe('TARGET_PEAK', () => {
  it('is −1 dBFS, the peak the backend normalises to', () => {
    expect(TARGET_PEAK).toBeCloseTo(10 ** (-1 / 20), 6)
  })
})

describe('fadeGainAt — overlapping fades', () => {
  it('multiplies the two ramps, as the backend applies them one after the other', () => {
    // 0.8 s fades on a 1 s region: at the middle each ramp is at 0.625.
    const region = { start: 0, end: 1, fadeIn: 0.8, fadeOut: 0.8 }
    expect(fadeGainAt(0.5, region)).toBeCloseTo(0.625 * 0.625, 6)
  })

  it('is not the minimum of the two', () => {
    const region = { start: 0, end: 1, fadeIn: 0.8, fadeOut: 0.8 }
    expect(fadeGainAt(0.5, region)).toBeLessThan(0.625)
  })
})

describe('fadeEnvelopePoints', () => {
  const region = { start: 2, end: 10, fadeIn: 1, fadeOut: 2 }

  it('starts at the requested time with the gain there', () => {
    expect(fadeEnvelopePoints(region, 2)[0]).toEqual([2, 0])
    expect(fadeEnvelopePoints(region, 2.5)[0]).toEqual([2.5, 0.5])
  })

  it('has a breakpoint at each corner of the envelope', () => {
    const points = fadeEnvelopePoints(region, 2)
    expect(points).toEqual([
      [2, 0],
      [3, 1],
      [8, 1],
      [10, 0],
    ])
  })

  it('leaves out the corners already behind the start', () => {
    expect(fadeEnvelopePoints(region, 9)).toEqual([
      [9, 0.5],
      [10, 0],
    ])
  })

  it('samples the parabola where the fades overlap', () => {
    const points = fadeEnvelopePoints({ start: 0, end: 1, fadeIn: 0.8, fadeOut: 0.8 }, 0)
    expect(points.length).toBeGreaterThan(20)
    for (const [time, gain] of points) {
      expect(gain).toBeCloseTo(fadeGainAt(time, { start: 0, end: 1, fadeIn: 0.8, fadeOut: 0.8 }), 9)
    }
    const times = points.map(([t]) => t)
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('is flat without fades', () => {
    expect(fadeEnvelopePoints({ start: 0, end: 5 }, 1)).toEqual([
      [1, 1],
      [5, 1],
    ])
  })

  it('is a single point for an empty region', () => {
    expect(fadeEnvelopePoints({ start: 3, end: 3, fadeIn: 1 }, 3)).toEqual([[3, 1]])
  })

  it('is a single point once past the end', () => {
    expect(fadeEnvelopePoints({ start: 0, end: 5, fadeOut: 1 }, 7)).toEqual([[7, 0]])
  })
})

describe('validateSettings', () => {
  const ok = {
    duration: 10,
    sampleRate: 44100,
    trimEnabled: false,
    trimStart: 0,
    trimEnd: 10,
    fadeIn: 0,
    fadeOut: 0,
    filterType: '',
    filterFreq: '1000',
    filterBandwidth: '500',
  }

  it('accepts neutral settings', () => {
    expect(validateSettings(ok)).toBeNull()
  })

  it('accepts a sound trim range', () => {
    expect(validateSettings({ ...ok, trimEnabled: true, trimStart: 2, trimEnd: 8 })).toBeNull()
  })

  it('rejects a trim whose end is not after its start', () => {
    const p = validateSettings({ ...ok, trimEnabled: true, trimStart: 5, trimEnd: 5 })
    expect(p).toMatchObject({ code: 'trim_range', field: 'trim-end' })
    expect(p.params).toEqual({ start: '5.00', end: '5.00', total: '10.00' })
  })

  it('quotes the range as the user typed it, not as it was clamped', () => {
    const p = validateSettings({ ...ok, trimEnabled: true, trimStart: 9, trimEnd: 3 })
    expect(p.params).toEqual({ start: '9.00', end: '3.00', total: '10.00' })
  })

  it('rejects a trim starting at the very end of the file', () => {
    const p = validateSettings({ ...ok, trimEnabled: true, trimStart: 10, trimEnd: 12 })
    expect(p.code).toBe('trim_range')
  })

  it('judges the trim as the export would send it, clamped to the duration', () => {
    expect(validateSettings({ ...ok, trimEnabled: true, trimStart: 2, trimEnd: 99 })).toBeNull()
  })

  it('ignores the trim fields when trim is off', () => {
    expect(validateSettings({ ...ok, trimStart: 9, trimEnd: 1 })).toBeNull()
  })

  it('rejects a fade longer than the whole file', () => {
    const p = validateSettings({ ...ok, fadeIn: 11 })
    expect(p).toMatchObject({ code: 'fade_too_long', field: 'fadein', params: { which: 'in', secs: '11.00' } })
  })

  it('measures the fade against the trimmed region', () => {
    const trimmed = { ...ok, trimEnabled: true, trimStart: 4, trimEnd: 6 }
    expect(validateSettings({ ...trimmed, fadeOut: 2 })).toBeNull()
    expect(validateSettings({ ...trimmed, fadeOut: 3 })).toMatchObject({
      code: 'fade_too_long',
      field: 'fadeout',
      params: { which: 'out' },
    })
  })

  it('rejects a filter frequency that is not a number', () => {
    for (const filterFreq of ['', '  ', 'abc', 'NaN', 'Infinity']) {
      const p = validateSettings({ ...ok, filterType: 'lowpass', filterFreq })
      expect(p, filterFreq).toMatchObject({ code: 'filter_value', field: 'filter-freq' })
    }
  })

  it('rejects a frequency outside (0, Nyquist) for the file, not for the audio context', () => {
    const slow = { ...ok, sampleRate: 22050, filterType: 'lowpass' }
    expect(validateSettings({ ...slow, filterFreq: '15000' })).toMatchObject({
      code: 'filter_range',
      params: { hz: '15000', max: '11025' },
    })
    expect(validateSettings({ ...slow, filterFreq: '0' }).code).toBe('filter_range')
    expect(validateSettings({ ...slow, filterFreq: '-5' }).code).toBe('filter_range')
    expect(validateSettings({ ...slow, filterFreq: '11025' }).code).toBe('filter_range')
    expect(validateSettings({ ...slow, filterFreq: '11024' })).toBeNull()
  })

  it('checks the bandwidth only for a band-pass', () => {
    const lowpass = { ...ok, filterType: 'lowpass', filterBandwidth: '' }
    expect(validateSettings(lowpass)).toBeNull()
    const band = { ...ok, filterType: 'bandpass' }
    expect(validateSettings({ ...band, filterBandwidth: '' })).toMatchObject({
      code: 'filter_value',
      field: 'filter-bw',
    })
    expect(validateSettings({ ...band, filterBandwidth: '0' })).toMatchObject({
      code: 'filter_bandwidth',
      field: 'filter-bw',
    })
    expect(validateSettings({ ...band, filterBandwidth: '-3' }).code).toBe('filter_bandwidth')
    expect(validateSettings({ ...band, filterBandwidth: '200' })).toBeNull()
  })

  it('reports the first problem in the order the fields appear', () => {
    const p = validateSettings({
      ...ok,
      trimEnabled: true,
      trimStart: 5,
      trimEnd: 5,
      fadeIn: 50,
      filterType: 'lowpass',
      filterFreq: '',
    })
    expect(p.code).toBe('trim_range')
  })

  it('copes with a file whose duration is unknown', () => {
    expect(validateSettings({ ...ok, duration: NaN })).toBeNull()
  })
})

describe('describeError', () => {
  const t = (key, vars = {}) => {
    const table = {
      'err.trim_range': 'range {start}-{end}',
      'err.fade_too_long.in': 'fade in {secs}',
    }
    const s = table[key]
    return s ? s.replace('{start}', vars.start).replace('{end}', vars.end).replace('{secs}', vars.secs) : key
  }

  it('translates a coded backend error with its parameters', () => {
    expect(describeError({ code: 'trim_range', params: { start: '1', end: '2' }, message: 'x' }, t)).toBe(
      'range 1-2',
    )
  })

  it('prefers the variant named by `which`', () => {
    expect(describeError({ code: 'fade_too_long', params: { which: 'in', secs: '3' }, message: 'x' }, t)).toBe(
      'fade in 3',
    )
  })

  it('falls back to the English message for a code with no translation', () => {
    expect(describeError({ code: 'brand_new', params: {}, message: 'Something new' }, t)).toBe('Something new')
  })

  it('shows the message of a generic error as is', () => {
    expect(describeError({ code: 'generic', params: {}, message: 'raw text' }, t)).toBe('raw text')
  })

  it('falls back to the code itself when there is no message either', () => {
    expect(describeError({ code: 'brand_new' }, t)).toBe('brand_new')
    expect(describeError({ code: 'generic' }, t)).toBe('generic')
  })

  it('unwraps a JS Error to its message, without the "Error:" prefix', () => {
    expect(describeError(new Error('boom'), t)).toBe('boom')
  })

  it('reads the message of any error-like object', () => {
    expect(describeError({ message: 'from a plugin' }, t)).toBe('from a plugin')
  })

  it('stringifies anything else', () => {
    expect(describeError('plain', t)).toBe('plain')
    expect(describeError(42, t)).toBe('42')
    expect(describeError(undefined, t)).toBe('undefined')
  })
})

describe('path helpers', () => {
  it('baseName takes the last component whatever the separator', () => {
    expect(baseName('/a/b/song.mp3')).toBe('song.mp3')
    expect(baseName('C:\\Music\\song.mp3')).toBe('song.mp3')
    expect(baseName('song.mp3')).toBe('song.mp3')
  })

  it('defaultOutputPath puts <name>-edit.<ext> next to the source', () => {
    expect(defaultOutputPath('/home/me/music/song.mp3', 'wav')).toBe('/home/me/music/song-edit.wav')
  })

  it('defaultOutputPath drops only the last extension', () => {
    expect(defaultOutputPath('/m/live.2024.flac', 'ogg')).toBe('/m/live.2024-edit.ogg')
  })

  it('defaultOutputPath copes with a hidden or extension-less name and a bare file name', () => {
    expect(defaultOutputPath('/m/.hidden', 'wav')).toBe('/m/.hidden-edit.wav')
    expect(defaultOutputPath('/m/noext', 'wav')).toBe('/m/noext-edit.wav')
    expect(defaultOutputPath('song.mp3', 'wav')).toBe('song-edit.wav')
  })

  it('defaultOutputPath understands Windows separators', () => {
    expect(defaultOutputPath('C:\\Music\\song.mp3', 'wav')).toBe('C:\\Music\\song-edit.wav')
  })
})

describe('waveformPeak', () => {
  const wave = [0.1, 0.5, 0.2, 0.9, 0.3, 0.4, 0.05, 0.6, 0.7, 0.8]

  it('is the loudest bucket of the whole file for the full range', () => {
    expect(waveformPeak(wave, 10, 0, 10)).toBe(0.9)
  })

  it('looks only at the buckets of the region', () => {
    expect(waveformPeak(wave, 10, 4, 7)).toBe(0.4)
  })

  it('includes a bucket the region only touches', () => {
    expect(waveformPeak(wave, 10, 3.5, 3.6)).toBe(0.9)
  })

  it('is 0 without data or duration', () => {
    expect(waveformPeak([], 10, 0, 10)).toBe(0)
    expect(waveformPeak(null, 10, 0, 10)).toBe(0)
    expect(waveformPeak(wave, 0, 0, 10)).toBe(0)
  })

  it('stays inside the array for a region that overshoots', () => {
    expect(waveformPeak(wave, 10, -5, 50)).toBe(0.9)
  })
})

describe('fade curves', () => {
  const linear = { start: 0, end: 10, fadeIn: 2, fadeOut: 2 }
  const equal = { ...linear, curve: 'equal-power' }

  it('default to a straight ramp', () => {
    expect(fadeGainAt(1, linear)).toBeCloseTo(0.5, 9)
    expect(fadeGainAt(1, { ...linear, curve: 'linear' })).toBeCloseTo(0.5, 9)
  })

  it('equal-power is a quarter sine: louder than linear halfway', () => {
    expect(fadeGainAt(1, equal)).toBeCloseTo(Math.SQRT1_2, 9)
    expect(fadeGainAt(9, equal)).toBeCloseTo(Math.SQRT1_2, 9)
  })

  it('equal-power keeps the same endpoints', () => {
    expect(fadeGainAt(0, equal)).toBeCloseTo(0, 9)
    expect(fadeGainAt(2, equal)).toBeCloseTo(1, 9)
    expect(fadeGainAt(10, equal)).toBeCloseTo(0, 9)
  })

  it('an unknown curve name is treated as linear, like an absent one', () => {
    expect(fadeGainAt(1, { ...linear, curve: 'bogus' })).toBeCloseTo(0.5, 9)
  })

  it('is sampled finely by the envelope, which is no longer a straight line', () => {
    const points = fadeEnvelopePoints(equal, 0)
    expect(points.length).toBeGreaterThan(40)
    for (const [time, gain] of points) expect(gain).toBeCloseTo(fadeGainAt(time, equal), 9)
  })

  it('stays four corners for a linear fade', () => {
    expect(fadeEnvelopePoints(linear, 0)).toHaveLength(4)
  })

  it('mirrors the backend: the same formula, frame by frame', () => {
    // The Rust fade-in is gain(i) = rising(i / (N - 1)) over N frames; the
    // preview's is rising(t / fadeIn). They agree to within one frame.
    const sr = 1000
    const frames = 800
    for (const curve of ['linear', 'equal-power']) {
      let worst = 0
      for (let i = 0; i < frames; i++) {
        const x = i / (frames - 1)
        const backend = curve === 'linear' ? x : Math.sin((x * Math.PI) / 2)
        const preview = fadeGainAt(i / sr, { start: 0, end: 10, fadeIn: frames / sr, curve })
        worst = Math.max(worst, Math.abs(backend - preview))
      }
      expect(worst, curve).toBeLessThan(2 / frames)
    }
  })
})

describe('Butterworth Q and Web Audio units', () => {
  it('has the textbook values', () => {
    expect(butterworthQ(1, 1)).toBeCloseTo(Math.SQRT1_2, 9)
    expect(butterworthQ(2, 1)).toBeCloseTo(0.541196, 5)
    expect(butterworthQ(2, 2)).toBeCloseTo(1.306563, 5)
    // 6th order: 0.5176, 0.7071 and 1.9319.
    expect(butterworthQ(3, 1)).toBeCloseTo(0.517638, 5)
    expect(butterworthQ(3, 2)).toBeCloseTo(Math.SQRT1_2, 9)
    expect(butterworthQ(3, 3)).toBeCloseTo(1.931852, 5)
  })

  it('converts a linear Q to the decibels a low-pass node expects', () => {
    expect(qToDb(Math.SQRT1_2)).toBeCloseTo(-3.0103, 4)
    expect(qToDb(1)).toBe(0)
    expect(qToDb(10)).toBeCloseTo(20, 9)
  })

  it('offers the four slopes and a default Q of 1/√2', () => {
    expect(SLOPES).toEqual([12, 24, 36, 48])
    expect(DEFAULT_Q).toBeCloseTo(0.70710678, 7)
  })
})

describe('buildFilterSpecs — slope and Q', () => {
  const base = { type: 'lowpass', freq: 1000, bandwidth: 500 }

  it('keeps the short form for the default filter', () => {
    expect(buildFilterSpecs({ ...base, slope: 12, q: 0.707 })).toEqual(['lowpass:1000'])
    expect(buildFilterSpecs({ ...base })).toEqual(['lowpass:1000'])
  })

  it('adds the slope when it is not 12', () => {
    expect(buildFilterSpecs({ ...base, slope: 24 })).toEqual(['lowpass:1000:24'])
    expect(buildFilterSpecs({ ...base, type: 'highpass', slope: 48 })).toEqual(['highpass:1000:48'])
  })

  it('adds a Q that is not the default, on a 12 dB/octave filter only', () => {
    expect(buildFilterSpecs({ ...base, slope: 12, q: 2.5 })).toEqual(['lowpass:1000:12:2.5'])
    expect(buildFilterSpecs({ ...base, slope: 24, q: 2.5 })).toEqual(['lowpass:1000:24'])
  })

  it('has no slope or Q on a band-pass', () => {
    expect(buildFilterSpecs({ ...base, type: 'bandpass', slope: 24, q: 3 })).toEqual(['bandpass:1000:500'])
  })
})

describe('buildProcessOptions — fade curve and WAV depth', () => {
  const ui = {
    filePath: '/a.wav', format: 'wav', duration: 10, fadeIn: 0, fadeOut: 0, speed: 1,
    filterType: '', filterFreq: 1000, filterBandwidth: 500,
  }

  it('sends the curve, linear unless equal-power was chosen', () => {
    expect(buildProcessOptions(ui, '/o.wav').fade_curve).toBe('linear')
    expect(buildProcessOptions({ ...ui, fadeCurve: 'equal-power' }, '/o.wav').fade_curve).toBe('equal-power')
    expect(buildProcessOptions({ ...ui, fadeCurve: 'bogus' }, '/o.wav').fade_curve).toBe('linear')
  })

  it('sends the sample format for a WAV only', () => {
    expect(buildProcessOptions({ ...ui, wavDepth: 'pcm16' }, '/o.wav').wav_depth).toBe('pcm16')
    expect(buildProcessOptions(ui, '/o.wav').wav_depth).toBe('float32')
    expect(buildProcessOptions({ ...ui, format: 'mp3', wavDepth: 'pcm16' }, '/o.mp3').wav_depth).toBeNull()
  })

  it('passes the slope and Q on to the filter spec', () => {
    const opts = buildProcessOptions(
      { ...ui, filterType: 'highpass', filterSlope: 36 },
      '/o.wav',
    )
    expect(opts.filters).toEqual(['highpass:1000:36'])
  })
})

describe('validateSettings — slope and Q', () => {
  const ok = {
    duration: 10, sampleRate: 44100, trimEnabled: false, trimStart: 0, trimEnd: 10,
    fadeIn: 0, fadeOut: 0, filterType: 'lowpass', filterFreq: '1000', filterBandwidth: '500',
    filterSlope: '12', filterQ: '0.707',
  }

  it('accepts every offered slope', () => {
    for (const filterSlope of ['12', '24', '36', '48']) {
      expect(validateSettings({ ...ok, filterSlope })).toBeNull()
    }
  })

  it('refuses a slope that is not offered', () => {
    expect(validateSettings({ ...ok, filterSlope: '18' })).toMatchObject({
      code: 'filter_slope',
      field: 'filter-slope',
    })
  })

  it('refuses a Q that is not a positive number, on a single stage', () => {
    for (const filterQ of ['', '0', '-1', 'abc']) {
      expect(validateSettings({ ...ok, filterQ }), filterQ).toMatchObject({
        code: 'filter_q',
        field: 'filter-q',
      })
    }
  })

  it('ignores Q when the slope fixes it, and for a band-pass', () => {
    expect(validateSettings({ ...ok, filterSlope: '24', filterQ: '' })).toBeNull()
    expect(validateSettings({ ...ok, filterType: 'bandpass', filterSlope: '18', filterQ: '' })).toBeNull()
  })

  it('does not require the new fields at all', () => {
    const { filterSlope, filterQ, ...legacy } = ok
    void filterSlope
    void filterQ
    expect(validateSettings(legacy)).toBeNull()
  })
})

// Pure helpers shared by the editor UI. Kept free of DOM access so they can be
// unit-tested without a browser.

/** Formats seconds as m:ss. */
export function fmtTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) secs = 0
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

/**
 * Default value for the trim-end field.
 *
 * Rounding up here is what used to make every export fail: the backend rejects
 * any end bound past the real duration, so this always rounds down.
 */
export function defaultTrimEnd(duration) {
  if (!Number.isFinite(duration) || duration <= 0) return 0
  return Math.floor(duration * 100) / 100
}

/** Gain of the fade envelope at time `t`, relative to the trimmed region. */
export function fadeGainAt(t, { start = 0, end = 0, fadeIn = 0, fadeOut = 0 } = {}) {
  if (!(end > start)) return 1
  let gain = 1
  if (fadeIn > 0 && t < start + fadeIn) gain = Math.min(gain, (t - start) / fadeIn)
  if (fadeOut > 0 && t > end - fadeOut) gain = Math.min(gain, (end - t) / fadeOut)
  return Math.max(0, Math.min(1, gain))
}

/** Biquad Q for a band-pass of the given centre frequency and bandwidth. */
export function bandpassQ(freq, bandwidth) {
  return bandwidth > 0 ? freq / bandwidth : 1.0
}

/** Clamps a filter frequency inside the range a BiquadFilterNode accepts. */
export function clampFilterFreq(freq, sampleRate) {
  const nyquist = sampleRate / 2 - 1
  if (!Number.isFinite(freq)) return 1000
  return Math.max(1, Math.min(freq, nyquist))
}

/** Filter spec strings understood by the Rust `FilterSpec::parse`. */
export function buildFilterSpecs({ type, freq, bandwidth }) {
  if (type === 'lowpass' || type === 'highpass') return [`${type}:${freq}`]
  if (type === 'bandpass') return [`bandpass:${freq}:${bandwidth}`]
  return []
}

/**
 * Payload for the `process_audio` command.
 *
 * Both trim bounds are clamped to the real duration: the field values are
 * rounded for display and must never claim more audio than the file holds.
 */
export function buildProcessOptions(ui, outputPath) {
  const duration = Number.isFinite(ui.duration) ? ui.duration : 0
  let trimStart = null
  let trimEnd = null
  if (ui.trimEnabled) {
    trimStart = Math.max(0, Math.min(ui.trimStart || 0, duration))
    trimEnd = Math.max(trimStart, Math.min(ui.trimEnd || duration, duration))
  }
  return {
    input: ui.filePath,
    output: outputPath,
    format: ui.format,
    trim_start: trimStart,
    trim_end: trimEnd,
    fade_in: ui.fadeIn > 0 ? ui.fadeIn : null,
    fade_out: ui.fadeOut > 0 ? ui.fadeOut : null,
    normalize: !!ui.normalize,
    speed: Math.abs(ui.speed - 1.0) > 1e-6 ? ui.speed : null,
    filters: buildFilterSpecs({
      type: ui.filterType,
      freq: ui.filterFreq,
      bandwidth: ui.filterBandwidth,
    }),
  }
}

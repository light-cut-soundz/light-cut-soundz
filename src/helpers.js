// Pure helpers shared by the editor UI. Kept free of DOM access so they can be
// unit-tested without a browser.

import { cutRanges, keptSegments, keptDuration } from './cuts.js'

/** −1 dBFS, the peak the backend normalises to (`normalize::TARGET_PEAK`). */
export const TARGET_PEAK = 0.8912509

/** Formats seconds as m:ss. */
export function fmtTime(secs) {
  if (!Number.isFinite(secs) || secs < 0) secs = 0
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

/** Gain of a fade-in `x` of the way through (0 → 1), for a curve name. */
function rising(x, curve) {
  x = Math.max(0, Math.min(1, x))
  return curve === 'equal-power' ? Math.sin((x * Math.PI) / 2) : x
}

/**
 * Gain of the fade envelope at time `time`, relative to the trimmed region.
 *
 * The backend applies the fade-in and the fade-out one after the other, so where
 * they overlap the gains multiply — they do not take the smaller of the two.
 */
export function fadeGainAt(time, { start = 0, end = 0, fadeIn = 0, fadeOut = 0, curve = 'linear' } = {}) {
  if (!(end > start)) return 1
  let gain = 1
  if (fadeIn > 0 && time < start + fadeIn) gain *= rising((time - start) / fadeIn, curve)
  if (fadeOut > 0 && time > end - fadeOut) gain *= rising((end - time) / fadeOut, curve)
  return Math.max(0, Math.min(1, gain))
}

const OVERLAP_STEPS = 24
const CURVE_STEPS = 24

/**
 * Breakpoints `[time, gain]` of the fade envelope from `from` to the end of the
 * region, for a piecewise-linear automation of a `GainNode`. The product of two
 * overlapping ramps is a parabola, so that stretch is sampled finely.
 */
export function fadeEnvelopePoints(region, from) {
  const { start = 0, end = 0, fadeIn = 0, fadeOut = 0 } = region
  if (!(end > start)) return [[from, 1]]
  const times = new Set([from, end])
  const add = (t) => { if (t > from && t < end) times.add(t) }
  add(start)
  if (fadeIn > 0) add(start + fadeIn)
  if (fadeOut > 0) add(end - fadeOut)
  const overlapFrom = end - fadeOut
  const overlapTo = start + fadeIn
  if (fadeIn > 0 && fadeOut > 0 && overlapFrom < overlapTo) {
    for (let i = 1; i < OVERLAP_STEPS; i++) {
      add(overlapFrom + ((overlapTo - overlapFrom) * i) / OVERLAP_STEPS)
    }
  }
  // A curved ramp is not a straight line between its ends: sample it.
  if (region.curve === 'equal-power') {
    for (let i = 1; i < CURVE_STEPS; i++) {
      if (fadeIn > 0) add(start + (fadeIn * i) / CURVE_STEPS)
      if (fadeOut > 0) add(end - fadeOut + (fadeOut * i) / CURVE_STEPS)
    }
  }
  return [...times]
    .filter((t) => t >= from)
    .sort((a, b) => a - b)
    .map((t) => [t, fadeGainAt(t, region)])
}

/** Linear Q of stage `k` (1-based) of an `n`-stage Butterworth cascade — the
 * values the backend uses, so the preview filter has the same shape. */
export function butterworthQ(stages, k) {
  return 1 / (2 * Math.cos((Math.PI * (2 * k - 1)) / (4 * stages)))
}

/** Q as a BiquadFilterNode wants it for low-pass and high-pass: in decibels. */
export function qToDb(q) {
  return 20 * Math.log10(q)
}

export const DEFAULT_Q = Math.SQRT1_2

export const SLOPES = [12, 24, 36, 48]

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
export function buildFilterSpecs({ type, freq, bandwidth, slope = 12, q = null }) {
  if (type === 'lowpass' || type === 'highpass') {
    const parts = [type, freq]
    // Q only exists on a single 12 dB/octave stage, and only matters when it
    // is not the default.
    const customQ = slope === 12 && q != null && Math.abs(q - DEFAULT_Q) > 1e-3
    if (slope !== 12 || customQ) parts.push(slope)
    if (customQ) parts.push(q)
    return [parts.join(':')]
  }
  if (type === 'bandpass') return [`bandpass:${freq}:${bandwidth}`]
  return []
}

/** Payload for the `process_audio` command. */
export function buildProcessOptions(ui, outputPath) {
  return {
    input: ui.filePath,
    output: outputPath,
    format: ui.format,
    cuts: cutRanges(ui.cuts ?? [], Number.isFinite(ui.duration) ? ui.duration : 0),
    fade_in: ui.fadeIn > 0 ? ui.fadeIn : null,
    fade_out: ui.fadeOut > 0 ? ui.fadeOut : null,
    fade_curve: ui.fadeCurve === 'equal-power' ? 'equal-power' : 'linear',
    wav_depth: ui.format === 'wav' ? ui.wavDepth || 'float32' : null,
    normalize: !!ui.normalize,
    speed: Math.abs(ui.speed - 1.0) > 1e-6 ? ui.speed : null,
    filters: buildFilterSpecs({
      type: ui.filterType,
      freq: ui.filterFreq,
      bandwidth: ui.filterBandwidth,
      slope: ui.filterSlope ?? 12,
      q: ui.filterQ ?? null,
    }),
  }
}

/**
 * What would make the backend refuse these settings, or `null` if nothing does.
 *
 * Returned in the shape of a backend error — `{ code, params, field }` — so the
 * same `err.<code>` translations serve both, and the export is refused before a
 * round trip rather than after.
 */
export function validateSettings(ui) {
  const duration = Number.isFinite(ui.duration) ? ui.duration : 0

  // Whatever the cuts leave is what is exported.
  const region = duration > 0 ? keptDuration(keptSegments(ui.cuts ?? [], duration)) : 0
  if (duration > 0 && !(region > 0)) return { code: 'trim_empty', field: 'tl-track', params: {} }

  for (const [which, secs, field] of [
    ['in', ui.fadeIn, 'fadein'],
    ['out', ui.fadeOut, 'fadeout'],
  ]) {
    // The backend measures fades in whole frames; the tolerance covers the
    // rounding of a slider value against the same region.
    if (secs > 0 && secs > region + 0.0005) {
      return { code: 'fade_too_long', field, params: { which, secs: secs.toFixed(2) } }
    }
  }

  if (ui.filterType) {
    const nyquist = ui.sampleRate / 2
    const freq = Number(ui.filterFreq)
    if (String(ui.filterFreq).trim() === '' || !Number.isFinite(freq)) {
      return { code: 'filter_value', field: 'filter-freq', params: { value: String(ui.filterFreq) } }
    }
    if (!(freq > 0 && freq < nyquist)) {
      return {
        code: 'filter_range',
        field: 'filter-freq',
        params: { kind: ui.filterType, hz: String(freq), max: String(nyquist) },
      }
    }
    if (ui.filterType !== 'bandpass') {
      if (!SLOPES.includes(Number(ui.filterSlope ?? 12))) {
        return { code: 'filter_slope', field: 'filter-slope', params: { value: String(ui.filterSlope) } }
      }
      // Q is only a setting on a single stage: steeper filters fix it.
      if (Number(ui.filterSlope ?? 12) === 12 && ui.filterQ !== undefined) {
        const q = Number(ui.filterQ)
        if (String(ui.filterQ).trim() === '' || !(q > 0) || !Number.isFinite(q)) {
          return { code: 'filter_q', field: 'filter-q', params: { value: String(ui.filterQ) } }
        }
      }
    }
    if (ui.filterType === 'bandpass') {
      const bw = Number(ui.filterBandwidth)
      if (String(ui.filterBandwidth).trim() === '' || !Number.isFinite(bw)) {
        return { code: 'filter_value', field: 'filter-bw', params: { value: String(ui.filterBandwidth) } }
      }
      if (!(bw > 0)) {
        return { code: 'filter_bandwidth', field: 'filter-bw', params: { hz: String(bw) } }
      }
    }
  }
  return null
}

/**
 * Human text for whatever a failed `invoke` rejected with: a structured backend
 * error (`{ code, params, message }`), a plain string, or a JS `Error`.
 */
export function describeError(err, t) {
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    // Backend errors with no dedicated wording carry their English message.
    if (err.code === 'generic') return err.message ?? err.code
    // `which` picks between variants of one code (fade in / fade out).
    const keys = [`err.${err.code}.${err.params?.which}`, `err.${err.code}`]
    for (const key of keys) {
      const text = t(key, err.params)
      if (text !== key) return text
    }
    return err.message ?? err.code
  }
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message
  return String(err)
}

/** Last component of a path, whichever separator it uses. */
export function baseName(path) {
  return String(path).split(/[\\/]/).pop()
}

/** Suggested export name: `<source name>-edit.<ext>`, next to the source. */
export function defaultOutputPath(sourcePath, ext) {
  const name = baseName(sourcePath)
  const dir = sourcePath.slice(0, sourcePath.length - name.length)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${dir}${stem}-edit.${ext}`
}

/** Peak of the waveform buckets overlapping `[start, end]` seconds. */
export function waveformPeak(waveform, duration, start, end) {
  if (!waveform?.length || !(duration > 0)) return 0
  const n = waveform.length
  const from = Math.max(0, Math.floor((start / duration) * n))
  const to = Math.min(n, Math.ceil((end / duration) * n))
  let peak = 0
  for (let i = from; i < to; i++) if (waveform[i] > peak) peak = waveform[i]
  return peak
}

// ─── Changelog ───────────────────────────────────────────────────────────────

/** Link and emphasis markers removed; backticks are left for the renderer. */
function plainMarkdown(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .trim()
}

/**
 * `### Title` headings and the `- item` lines under them, as
 * `[{ title, items }]`. A line that is neither is taken as an item of its own,
 * so a note written as plain text is not lost.
 */
export function parseSections(markdown) {
  const sections = []
  let current = null
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const heading = /^#{3,}\s+(.*)$/.exec(line)
    if (heading) {
      current = { title: plainMarkdown(heading[1]), items: [] }
      sections.push(current)
      continue
    }
    if (!current) {
      current = { title: '', items: [] }
      sections.push(current)
    }
    current.items.push(plainMarkdown(line.replace(/^[-*]\s+/, '')))
  }
  return sections
}

/**
 * A changelog file as `[{ version, date, sections }]`, newest first as written.
 * Entries are the `## [version] - date` headings; what comes before the first
 * one (title, introduction) is ignored.
 */
export function parseChangelog(markdown) {
  const entries = []
  let current = null
  let body = []
  const flush = () => {
    if (current) entries.push({ ...current, sections: parseSections(body.join('\n')) })
    body = []
  }
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+\[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line)
    if (heading) {
      flush()
      current = { version: heading[1], date: heading[2] ?? null }
    } else if (current) {
      body.push(line)
    }
  }
  flush()
  return entries
}

/**
 * The sections of a release's notes in `lang`. The notes come from the updater
 * as one block per language, introduced by `<!-- en -->` / `<!-- fr -->`; without
 * markers the whole text is taken, and a language that is missing falls back to
 * the first block. Anything after a `---` rule (the download table the release
 * page adds) is dropped.
 */
export function releaseNotesSections(notes, lang) {
  if (typeof notes !== 'string' || !notes.trim()) return []
  const parts = notes.split(/<!--\s*([a-z]{2})\s*-->/i)
  let text = notes
  if (parts.length > 1) {
    const blocks = {}
    for (let i = 1; i < parts.length; i += 2) blocks[parts[i].toLowerCase()] = parts[i + 1]
    text = blocks[lang] ?? blocks.en ?? Object.values(blocks)[0]
  }
  return parseSections(text.split(/^\s*---+\s*$/m)[0])
}

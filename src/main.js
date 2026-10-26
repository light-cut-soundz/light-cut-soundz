import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import changelogEn from '../CHANGELOG.md?raw'
import changelogFr from '../CHANGELOG.fr.md?raw'
import { applyLang, loadLang, saveLang } from './i18n.js'
import {
  TARGET_PEAK,
  fmtTime,
  defaultTrimEnd,
  fadeEnvelopePoints,
  bandpassQ,
  butterworthQ,
  clampFilterFreq,
  qToDb,
  DEFAULT_Q,
  buildProcessOptions,
  validateSettings,
  describeError,
  baseName,
  defaultOutputPath,
  waveformPeak,
  parseChangelog,
  releaseNotesSections,
} from './helpers.js'

const WAVEFORM_POINTS = 900
const FILTER_STAGES = 4 // the steepest slope: four 12 dB/octave biquads in series
const NORMALIZE_DEBOUNCE_MS = 150

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  filePath: null,
  info: null,
  waveform: null,
  format: 'wav',
  processing: false,
  /** What the export would be refused for right now, or null. */
  problem: null,
  lang: loadLang(),
}

// Applied before anything else so the markup's initial text never shows through.
let tr = applyLang(state.lang)

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)
const dropZone      = $('drop-zone')
const editor        = $('editor')
const canvas        = $('waveform')
const openBtn       = $('open-btn')
const openBtnHeader = $('open-btn-header')
const exportBtn     = $('export-btn')
const cancelBtn     = $('cancel-btn')
const playBtn       = $('play-btn')
const toast         = $('toast')

const num = (id) => parseFloat($(id).value)

/** The region the export keeps: the trim range, or the whole file. */
function keptRegion() {
  const duration = state.info?.duration ?? 0
  if (!$('trim-enabled').checked) return { start: 0, end: duration }
  return { start: num('trim-start') || 0, end: num('trim-end') || duration }
}

// ─── Audio playback (Web Audio API) ─────────────────────────────────────────
//
// Graph: source → fades → filter stages → normalise → output, the order in which
// the backend applies them (the source's playbackRate stands for the speed
// change). Steep filters are several biquads in series, as in the backend; the
// stages a filter does not use are exact identities.

let audioCtx          = null
let audioBuffer       = null
let audioSource       = null
let fadeGainNode      = null
let filterNodes       = []
let normalizeGainNode = null
let playStartCtxTime  = 0
let playStartOffset   = 0
let playRate          = 1.0
let playRaf           = null

function ensureAudioContext() {
  if (audioCtx) return audioCtx
  audioCtx = new AudioContext()
  fadeGainNode      = audioCtx.createGain()
  normalizeGainNode = audioCtx.createGain()
  filterNodes = Array.from({ length: FILTER_STAGES }, () => audioCtx.createBiquadFilter())
  let previous = fadeGainNode
  for (const node of filterNodes) {
    previous.connect(node)
    previous = node
  }
  previous.connect(normalizeGainNode)
  normalizeGainNode.connect(audioCtx.destination)
  return audioCtx
}

/** Decodes the file for the preview. The preview is optional: a WebView without
 * the matching codec must not stop the file from being opened and exported. */
async function decodePreview(path) {
  const ctx = ensureAudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
  const resp = await fetch(convertFileSrc(path))
  if (!resp.ok) throw new Error(tr('msg.unreachable', { status: resp.status }))
  return ctx.decodeAudioData(await resp.arrayBuffer())
}

const validRate = (rate) => (Number.isFinite(rate) && rate > 0 ? rate : 1.0)

function currentPlaybackTime() {
  if (!audioCtx || !audioSource) return playStartOffset
  // Elapsed context time is wall-clock; the source consumes the buffer
  // `playRate` times faster, so the playhead has to scale with it.
  const end = $('trim-enabled').checked ? keptRegion().end : (audioBuffer?.duration ?? 0)
  return Math.min(
    playStartOffset + (audioCtx.currentTime - playStartCtxTime) * playRate,
    end
  )
}

// Re-anchors the timeline before changing rate, so time already elapsed keeps
// the speed it was played at.
function setPlaybackRate(rate) {
  rate = validRate(rate)
  if (audioCtx && audioSource) {
    playStartOffset  = currentPlaybackTime()
    playStartCtxTime = audioCtx.currentTime
    audioSource.playbackRate.value = rate
    playRate = rate
    rescheduleFades()
  }
  playRate = rate
}

function isPlaying() { return audioSource !== null }

function fadeRegion() {
  return {
    ...keptRegion(),
    fadeIn: num('fadein') || 0,
    fadeOut: num('fadeout') || 0,
    curve: $('fade-curve').value,
  }
}

/** Automates the fade gain on the audio clock, from buffer time `from`, so it
 * stays right when the window is hidden and has no zipper noise. */
function scheduleFades(param, now, from, rate) {
  const [first, ...rest] = fadeEnvelopePoints(fadeRegion(), from)
  param.cancelScheduledValues(now)
  param.setValueAtTime(first[1], now)
  for (const [time, gain] of rest) {
    param.linearRampToValueAtTime(gain, now + (time - from) / rate)
  }
}

function rescheduleFades() {
  if (!audioCtx || !audioSource) return
  scheduleFades(fadeGainNode.gain, audioCtx.currentTime, currentPlaybackTime(), playRate)
}

function startPlayback(offset) {
  if (!audioCtx || !audioBuffer) return
  stopPlayback()
  audioSource = audioCtx.createBufferSource()
  audioSource.buffer = audioBuffer
  audioSource.connect(fadeGainNode)
  playStartOffset  = Math.max(0, Math.min(offset, audioBuffer.duration))
  playStartCtxTime = audioCtx.currentTime
  playRate         = validRate(num('speed'))
  audioSource.playbackRate.value = playRate
  configureFilter(filterNodes, audioCtx.sampleRate)

  scheduleFades(fadeGainNode.gain, audioCtx.currentTime, playStartOffset, playRate)
  // The end of the trim is part of the schedule, not of the animation loop.
  const { end } = keptRegion()
  if ($('trim-enabled').checked && end > playStartOffset) {
    audioSource.start(0, playStartOffset, end - playStartOffset)
  } else {
    audioSource.start(0, playStartOffset)
  }
  audioSource.onended = () => {
    audioSource = null
    playStartOffset = $('trim-enabled').checked ? keptRegion().start : 0
    cancelAnimationFrame(playRaf)
    setPlaying(false)
    $('time-current').textContent = fmtTime(playStartOffset)
    renderWaveform()
  }
}

function stopPlayback() {
  if (!audioSource) return
  playStartOffset = currentPlaybackTime()
  audioSource.onended = null
  audioSource.stop()
  audioSource.disconnect()
  audioSource = null
  fadeGainNode.gain.cancelScheduledValues(audioCtx.currentTime)
}

/** Plays again from where it is, picking up changed trim bounds or fades. */
function restartIfPlaying() {
  if (!isPlaying()) return
  startPlayback(currentPlaybackTime())
}

function seekTo(time) {
  if (!audioBuffer || !state.info) return
  const wasPlaying = isPlaying()
  if (wasPlaying) { cancelAnimationFrame(playRaf); stopPlayback() }
  playStartOffset = Math.max(0, Math.min(time, state.info.duration))
  if (wasPlaying) { startPlayback(playStartOffset); setPlaying(true); tickPlayhead() }
  renderWaveform()
  $('time-current').textContent = fmtTime(playStartOffset)
}

/** The slope control, in dB/octave (12 for a band-pass, which has none). */
const filterSlope = () => Number($('filter-slope').value) || 12

/** The Q field, only meaningful on a single 12 dB/octave stage. The field shows
 * the default rounded (0.707); the backend is only told about a Q that differs
 * from it, so the preview treats the rounded value as the default too. */
function filterQ() {
  const q = num('filter-q')
  if (!Number.isFinite(q) || q <= 0 || Math.abs(q - DEFAULT_Q) <= 1e-3) return DEFAULT_Q
  return q
}

/** Filter stages (live or offline) set up from the filter controls. */
function configureFilter(nodes, sampleRate) {
  const type = $('filter-type').value
  const freq = clampFilterFreq(num('filter-freq') || 1000, sampleRate)
  const stages = type === '' ? 0 : type === 'bandpass' ? 1 : filterSlope() / 12
  nodes.forEach((node, i) => {
    if (i >= stages) {
      // A peaking filter with no gain changes nothing at all.
      node.type = 'peaking'
      node.gain.value = 0
      return
    }
    node.type = type
    node.frequency.value = freq
    if (type === 'bandpass') {
      // Linear Q.
      node.Q.value = bandpassQ(freq, num('filter-bw') || 500)
    } else {
      // Low-pass and high-pass Q are in decibels in Web Audio.
      const q = stages === 1 ? filterQ() : butterworthQ(stages, i + 1)
      node.Q.value = qToDb(q)
    }
  })
}

// Apply the speed and filter controls to the live node chain
function applyPreviewSettings() {
  if (!audioCtx) return
  setPlaybackRate(num('speed'))
  configureFilter(filterNodes, audioCtx.sampleRate)
}

// ─── Preview normalisation ───────────────────────────────────────────────────
//
// The backend normalises the file it writes: kept region, after fades and
// filter. The preview measures that same signal, so the gain it applies is the
// export's.

let normToken = 0
let normTimer = null

const setNormalizeGain = (gain) => {
  if (normalizeGainNode) normalizeGainNode.gain.value = gain
}

/** Peak of the kept region once fades and filter are applied, rendered offline. */
async function renderedPeak() {
  const { start, end } = keptRegion()
  const rate = audioBuffer.sampleRate
  const length = Math.max(1, Math.ceil((end - start) * rate))
  const offline = new OfflineAudioContext(audioBuffer.numberOfChannels, length, rate)
  const source = offline.createBufferSource()
  const fades = offline.createGain()
  const filters = Array.from({ length: FILTER_STAGES }, () => offline.createBiquadFilter())
  source.buffer = audioBuffer
  source.connect(fades)
  let previous = fades
  for (const node of filters) {
    previous.connect(node)
    previous = node
  }
  previous.connect(offline.destination)
  configureFilter(filters, rate)
  scheduleFades(fades.gain, 0, start, 1)
  source.start(0, start, end - start)

  const rendered = await offline.startRendering()
  let peak = 0
  for (let ch = 0; ch < rendered.numberOfChannels; ch++) {
    const data = rendered.getChannelData(ch)
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i])
      if (a > peak) peak = a
    }
  }
  return peak
}

async function regionPeak() {
  if (typeof OfflineAudioContext === 'function') return renderedPeak()
  // No offline rendering: the waveform's peak over the region, fades and filter
  // ignored — still no pass over the raw samples.
  const { start, end } = keptRegion()
  return waveformPeak(state.waveform, state.info.duration, start, end)
}

async function updateNormalization() {
  clearTimeout(normTimer)
  const token = ++normToken
  if (!audioBuffer || !$('normalize').checked) { setNormalizeGain(1); return }
  try {
    const peak = await regionPeak()
    if (token !== normToken) return
    setNormalizeGain(peak > 1e-8 ? TARGET_PEAK / peak : 1)
  } catch (e) {
    console.warn('Normalisation preview failed:', e)
    if (token === normToken) setNormalizeGain(1)
  }
}

/** Debounced: sliders and number fields fire a burst of events. */
function scheduleNormalization() {
  if (!$('normalize').checked) return
  clearTimeout(normTimer)
  normTimer = setTimeout(updateNormalization, NORMALIZE_DEBOUNCE_MS)
}

// ─── Play / pause ────────────────────────────────────────────────────────────

function togglePlay() {
  if (!audioBuffer) return
  if (!isPlaying()) {
    const { start, end } = keptRegion()
    let from = playStartOffset
    if ($('trim-enabled').checked && (from < start || from >= end)) from = start
    startPlayback(from)
    setPlaying(true)
    tickPlayhead()
  } else {
    stopPlayback()
    setPlaying(false)
    cancelAnimationFrame(playRaf)
  }
}

// Only draws: what plays, and when it stops, is on the audio clock.
function tickPlayhead() {
  cancelAnimationFrame(playRaf)
  function frame() {
    if (!isPlaying()) return
    $('time-current').textContent = fmtTime(currentPlaybackTime())
    renderWaveform()
    playRaf = requestAnimationFrame(frame)
  }
  playRaf = requestAnimationFrame(frame)
}

function setPlaying(playing) {
  $('play-icon').innerHTML = playing
    ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>'
    : '<polygon points="5 3 19 12 5 21 5 3"/>'
}

playBtn.addEventListener('click', togglePlay)

/** Space types in text and number fields and toggles checkboxes and selects;
 * anywhere else — buttons included — it plays and pauses. */
function spaceBelongsTo(el) {
  if (!el) return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  return el.tagName === 'INPUT' && el.type !== 'range'
}
const aboutIsOpen = () => !!document.querySelector('.about-backdrop')

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || spaceBelongsTo(e.target) || aboutIsOpen()) return
  e.preventDefault()
  togglePlay()
})
// A button would otherwise be clicked when Space is released.
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && !spaceBelongsTo(e.target) && !aboutIsOpen()) e.preventDefault()
})

/** Puts the start or the end of the trim at the playhead: the keyboard's way of
 * moving the handles, which are otherwise mouse-only. */
function setTrimFromPlayhead(which) {
  if (!state.info) return
  const duration = state.info.duration
  const time = currentPlaybackTime()
  $('trim-enabled').checked = true
  if (which === 'start') {
    const end = num('trim-end') || duration
    $('trim-start').value = Math.max(0, Math.min(time, end - 0.1)).toFixed(2)
  } else {
    const start = num('trim-start') || 0
    $('trim-end').value = Math.min(duration, Math.max(time, start + 0.1)).toFixed(2)
  }
  onRegionChanged()
}

canvas.addEventListener('keydown', (e) => {
  if (e.key === 'i' || e.key === 'o') {
    e.preventDefault()
    setTrimFromPlayhead(e.key === 'i' ? 'start' : 'end')
    return
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const step = (e.shiftKey ? 5 : 1) * (e.key === 'ArrowLeft' ? -1 : 1)
  seekTo(currentPlaybackTime() + step)
})

// ─── Waveform render ─────────────────────────────────────────────────────────

const cssVar = (name, fallback) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
const COLORS = {
  bg:     cssVar('--card', '#1a1a2e'),
  on:     cssVar('--accent', '#7c3aed'),
  off:    cssVar('--wave-off', '#24243e'),
  handle: cssVar('--accent-light', '#9d5cf6'),
}

// The bars and the trim shading only change with the file, the trim or the
// canvas size, so they are drawn once into an offscreen layer; each animation
// frame then costs one `drawImage` plus the playhead.
let waveLayer = null
let waveLayerKey = ''
let waveformVersion = 0

function waveformLayer(W, H, pw, ph, trimEnabled, trimStart, trimEnd) {
  const key = [waveformVersion, pw, ph, trimEnabled, trimStart, trimEnd].join('|')
  if (waveLayer && key === waveLayerKey) return waveLayer
  waveLayer ??= document.createElement('canvas')
  waveLayer.width  = pw
  waveLayer.height = ph
  const ctx = waveLayer.getContext('2d')
  ctx.setTransform(pw / W, 0, 0, ph / H, 0, 0)
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, W, H)

  const data = state.waveform
  const duration = state.info?.duration || 1
  const barW = W / data.length
  for (let i = 0; i < data.length; i++) {
    const amp  = Math.min(data[i], 1.0)
    const barH = Math.max(amp * H * 0.85, 1)
    const time = (i / data.length) * duration
    const active = !trimEnabled || (time >= trimStart && time <= trimEnd)
    ctx.fillStyle = active ? COLORS.on : COLORS.off
    ctx.fillRect(i * barW, (H - barH) / 2, Math.max(barW - 0.5, 0.5), barH)
  }
  waveLayerKey = key
  return waveLayer
}

/** Tab hanging from the top edge, rounded at the bottom (`roundRect` is missing
 * from the older WebKit builds the app targets). */
function tabPath(ctx, x, y, w, h, r) {
  ctx.moveTo(x, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y + h - r)
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
  ctx.lineTo(x + r, y + h)
  ctx.arcTo(x, y + h, x, y + h - r, r)
  ctx.closePath()
}

function renderWaveform() {
  if (!state.waveform) return
  const dpr = window.devicePixelRatio || 1
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  const pw = Math.round(W * dpr)
  const ph = Math.round(H * dpr)
  // Assigning a size clears the bitmap and reallocates it: only when it changed.
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width  = pw
    canvas.height = ph
  }
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  const trimEnabled = $('trim-enabled').checked
  const trimStart   = num('trim-start') || 0
  const trimEnd     = num('trim-end')   || state.info?.duration || 0
  const duration    = state.info?.duration || 1

  ctx.drawImage(waveformLayer(W, H, pw, ph, trimEnabled, trimStart, trimEnd), 0, 0, W, H)

  // Playhead
  if (audioBuffer && duration > 0) {
    const px = (currentPlaybackTime() / duration) * W
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
    ctx.restore()
  }

  // Trim handles
  if (trimEnabled && duration > 0) {
    for (const [time, label] of [[trimStart, 'start'], [trimEnd, 'end']]) {
      const hx = Math.round((time / duration) * W)
      ctx.strokeStyle = COLORS.handle
      ctx.lineWidth = 2
      ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke()
      ctx.fillStyle = COLORS.on
      const tabW = 12, tabH = 20
      const tabX = label === 'start' ? hx : hx - tabW
      ctx.beginPath()
      tabPath(ctx, tabX, 0, tabW, tabH, 4)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.8)'
      ctx.beginPath()
      if (label === 'start') {
        ctx.moveTo(tabX + 3, tabH / 2); ctx.lineTo(tabX + tabW - 3, tabH / 2 - 4); ctx.lineTo(tabX + tabW - 3, tabH / 2 + 4)
      } else {
        ctx.moveTo(tabX + tabW - 3, tabH / 2); ctx.lineTo(tabX + 3, tabH / 2 - 4); ctx.lineTo(tabX + 3, tabH / 2 + 4)
      }
      ctx.fill()
    }
  }
}

// ─── Trim handle drag ─────────────────────────────────────────────────────────

const HANDLE_HIT = 12
let dragging = null

function canvasXToTime(clientX) {
  const rect = canvas.getBoundingClientRect()
  const x = clientX - rect.left
  return Math.max(0, Math.min((x / rect.width) * (state.info?.duration || 1), state.info?.duration || 1))
}

function getHandleAtX(clientX) {
  if (!$('trim-enabled').checked || !state.info) return null
  const rect = canvas.getBoundingClientRect()
  const x = clientX - rect.left
  const W = rect.width
  const duration = state.info.duration
  const x1 = (num('trim-start') / duration) * W
  const x2 = (num('trim-end')   / duration) * W
  if (Math.abs(x - x1) < HANDLE_HIT) return 'start'
  if (Math.abs(x - x2) < HANDLE_HIT) return 'end'
  return null
}

canvas.addEventListener('mousemove', (e) => {
  if (dragging) return
  canvas.classList.toggle('cursor-resize', !!getHandleAtX(e.clientX))
})

canvas.addEventListener('mouseleave', () => {
  if (!dragging) canvas.classList.remove('cursor-resize')
})

canvas.addEventListener('mousedown', (e) => {
  e.preventDefault()
  const handle = getHandleAtX(e.clientX)
  if (handle) {
    dragging = handle
    canvas.classList.add('cursor-resize')
    return
  }
  seekTo(canvasXToTime(e.clientX))
})

window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  const time = canvasXToTime(e.clientX)
  if (dragging === 'start') {
    const end = num('trim-end') || state.info?.duration || 0
    $('trim-start').value = Math.min(time, end - 0.1).toFixed(2)
  } else {
    const start = num('trim-start') || 0
    $('trim-end').value = Math.max(time, start + 0.1).toFixed(2)
  }
  $('trim-enabled').checked = true
  onRegionChanged({ restart: false })
})

window.addEventListener('mouseup', () => {
  if (!dragging) return
  dragging = null
  canvas.classList.remove('cursor-resize')
  restartIfPlaying()
})

// ─── Controls wiring ──────────────────────────────────────────────────────────

/** The kept region changed: redraw, re-check, re-measure, and re-aim playback. */
function onRegionChanged({ restart = true } = {}) {
  renderWaveform()
  refreshValidity()
  scheduleNormalization()
  if (restart) restartIfPlaying()
}

function onFadesChanged() {
  rescheduleFades()
  refreshValidity()
  scheduleNormalization()
}

function onFilterChanged() {
  if (audioCtx) configureFilter(filterNodes, audioCtx.sampleRate)
  refreshValidity()
  scheduleNormalization()
}

$('trim-enabled').addEventListener('change', () => onRegionChanged())
$('trim-start').addEventListener('input', () => onRegionChanged())
$('trim-end').addEventListener('input', () => onRegionChanged())

$('fadein').addEventListener('input', () => {
  $('fadein-val').textContent = parseFloat($('fadein').value).toFixed(1) + 's'
  onFadesChanged()
})
$('fadeout').addEventListener('input', () => {
  $('fadeout-val').textContent = parseFloat($('fadeout').value).toFixed(1) + 's'
  onFadesChanged()
})

const presets = () => document.querySelectorAll('.preset')

/** Shows speed `v` on the slider, its label and the preset buttons. */
function showSpeed(v) {
  $('speed').value = v
  $('speed-val').textContent = v.toFixed(2) + '×'
  presets().forEach((b) => {
    const on = parseFloat(b.dataset.v) === v
    b.classList.toggle('active', on)
    b.setAttribute('aria-pressed', String(on))
  })
  applyPreviewSettings()
}

$('speed').addEventListener('input', () => showSpeed(num('speed')))
presets().forEach((btn) => {
  btn.addEventListener('click', () => showSpeed(parseFloat(btn.dataset.v)))
})

$('normalize').addEventListener('change', () => { void updateNormalization() })

/** Shows the rows that go with the chosen filter type, and the Q field only
 * where it can act (a single 12 dB/octave stage). */
function syncFilterRows() {
  const type = $('filter-type').value
  const band = type === 'bandpass'
  $('filter-params').classList.toggle('hidden', type === '')
  $('filter-bw-row').style.display = band ? 'flex' : 'none'
  $('filter-slope-row').style.display = band ? 'none' : 'flex'
  $('filter-q-row').style.display = band ? 'none' : 'flex'
  $('filter-q').disabled = filterSlope() !== 12
}

$('filter-type').addEventListener('change', () => {
  syncFilterRows()
  setKey($('filter-freq-label'), $('filter-type').value === 'bandpass' ? 'filter.centre' : 'filter.cutoff')
  onFilterChanged()
})
$('filter-slope').addEventListener('change', () => {
  syncFilterRows()
  onFilterChanged()
})
$('filter-freq').addEventListener('input', onFilterChanged)
$('filter-q').addEventListener('input', onFilterChanged)
$('filter-bw').addEventListener('input', onFilterChanged)
$('fade-curve').addEventListener('change', onFadesChanged)

document.querySelectorAll('.fmt').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fmt').forEach((b) => {
      b.classList.remove('active')
      b.setAttribute('aria-pressed', 'false')
    })
    btn.classList.add('active')
    btn.setAttribute('aria-pressed', 'true')
    state.format = btn.dataset.fmt
    // The sample format is a WAV-only choice: the others pick their own.
    $('wav-depth').classList.toggle('hidden', state.format !== 'wav')
  })
})

// ─── Validation ──────────────────────────────────────────────────────────────

function readSettings() {
  return {
    duration:        state.info?.duration ?? 0,
    sampleRate:      state.info?.sample_rate ?? 0,
    trimEnabled:     $('trim-enabled').checked,
    trimStart:       num('trim-start'),
    trimEnd:         num('trim-end'),
    fadeIn:          num('fadein'),
    fadeOut:         num('fadeout'),
    filterType:      $('filter-type').value,
    filterFreq:      $('filter-freq').value,
    filterBandwidth: $('filter-bw').value,
    filterSlope:     $('filter-slope').value,
    filterQ:         $('filter-q').value,
  }
}

function updateExportState() {
  exportBtn.disabled = state.processing || !state.filePath || !!state.problem
}

/** Flags the field the export would be refused for, and says why, before the
 * user has pressed anything. */
function refreshValidity() {
  document.querySelectorAll('[aria-invalid]').forEach((el) => el.removeAttribute('aria-invalid'))
  state.problem = state.info ? validateSettings(readSettings()) : null
  if (state.problem) $(state.problem.field).setAttribute('aria-invalid', 'true')
  $('export-hint').textContent = state.problem ? describeError(state.problem, tr) : ''
  updateExportState()
}

// ─── File loading ─────────────────────────────────────────────────────────────

let loadSeq = 0

/** Opens a file. Everything is gathered first and only then applied, so a
 * failure — or a newer load overtaking this one — leaves the editor as it was. */
async function loadFile(path) {
  const seq = ++loadSeq
  try {
    showToast(tr('msg.loading'))
    // The preview is fetched through the `asset:` protocol, which only serves
    // files the backend has been told about; it decodes while the backend does.
    const preview = invoke('allow_asset', { path })
      .then(() => decodePreview(path))
      .then((buffer) => ({ buffer }), (error) => ({ error }))
    const info = await invoke('load_audio', { path, points: WAVEFORM_POINTS })
    const { buffer, error } = await preview
    if (seq !== loadSeq) return
    commitLoaded(path, info, buffer ?? null)
    if (error) {
      console.warn('Preview unavailable:', error)
      showToast(tr('msg.previewUnavailable'), 'warning')
    } else {
      hideToast()
    }
  } catch (e) {
    if (seq !== loadSeq) return
    showToast(tr('msg.error', { error: describeError(e, tr) }), 'error')
  }
}

function commitLoaded(path, info, buffer) {
  stopPlayback()
  cancelAnimationFrame(playRaf)
  setPlaying(false)

  state.filePath = path
  state.info     = info
  state.waveform = info.waveform
  waveformVersion++
  audioBuffer     = buffer
  playStartOffset = 0
  playBtn.disabled = !buffer
  setNormalizeGain(1)

  $('badge-name').textContent = baseName(path)
  renderBadge()
  $('file-badge').classList.remove('hidden')
  $('time-total').textContent = fmtTime(info.duration)
  $('time-current').textContent = '0:00'
  $('trim-start').value = '0'
  $('trim-start').max = info.duration
  $('trim-end').value = defaultTrimEnd(info.duration)
  $('trim-end').max   = info.duration

  dropZone.classList.add('hidden')
  editor.classList.remove('hidden')
  openBtnHeader.classList.remove('hidden')
  applyPreviewSettings()
  renderWaveform()
  refreshValidity()
  void updateNormalization()
}

function renderBadge() {
  const info = state.info
  if (!info) return
  $('badge-meta').textContent = tr('badge.meta', {
    channels: info.channels,
    rate: info.sample_rate,
    duration: fmtTime(info.duration),
  })
}

/** The native file picker, run by the backend: only a file it returns (or one
 * dropped on the window) is a file the app will open. */
async function pickAndLoad() {
  let path
  try {
    path = await invoke('pick_audio_file')
  } catch (e) {
    showToast(tr('msg.error', { error: describeError(e, tr) }), 'error')
    return
  }
  if (path) await loadFile(path)
}

openBtn.addEventListener('click', pickAndLoad)
openBtnHeader.addEventListener('click', pickAndLoad)

getCurrentWindow().onDragDropEvent(async (event) => {
  if (event.payload.type === 'enter')       dropZone.classList.add('drag-over')
  else if (event.payload.type === 'leave')  dropZone.classList.remove('drag-over')
  else if (event.payload.type === 'drop') {
    dropZone.classList.remove('drag-over')
    const paths = event.payload.paths
    if (paths?.length > 0) await loadFile(paths[0])
  }
})

// ─── Export ───────────────────────────────────────────────────────────────────

/** Settles when the running export has — the updater must not restart the app
 * in the middle of one. */
let exportInFlight = null

function showExportProgress(percent) {
  const label = $('export-label')
  label.removeAttribute('data-i18n')
  label.textContent = tr('export.progress', { percent })
}

exportBtn.addEventListener('click', async () => {
  if (!state.filePath || state.processing || state.problem) return
  const ext = state.format
  let outputPath
  try {
    // The backend adds the extension of the chosen format if it was left off:
    // the container is decided by the format tab, so the name has to agree.
    outputPath = await invoke('pick_output_file', {
      defaultPath: defaultOutputPath(state.filePath, ext),
      ext,
    })
  } catch (e) {
    showToast(tr('msg.error', { error: describeError(e, tr) }), 'error')
    return
  }
  if (!outputPath) return

  if (isPlaying()) { stopPlayback(); setPlaying(false); cancelAnimationFrame(playRaf) }
  exportInFlight = runExport(outputPath)
  await exportInFlight
})

async function runExport(outputPath) {
  state.processing = true
  updateExportState()
  exportBtn.classList.add('processing')
  cancelBtn.disabled = false
  cancelBtn.classList.remove('hidden')
  showExportProgress(0)

  try {
    await invoke('process_audio', { opts: buildOptions(outputPath) })
    showToast(tr('export.done', { name: baseName(outputPath) }), 'success')
  } catch (e) {
    if (e?.code === 'cancelled') showToast(tr('export.cancelled'), 'warning')
    else showToast(tr('msg.error', { error: describeError(e, tr) }), 'error')
  } finally {
    state.processing = false
    exportBtn.classList.remove('processing')
    cancelBtn.classList.add('hidden')
    setKey($('export-label'), 'export.run')
    updateExportState()
    exportInFlight = null
  }
}

cancelBtn.addEventListener('click', () => {
  cancelBtn.disabled = true
  void invoke('cancel_export')
})

listen('export-progress', (e) => {
  if (state.processing) showExportProgress(e.payload)
})

function buildOptions(outputPath) {
  return buildProcessOptions({
    filePath:        state.filePath,
    format:          state.format,
    duration:        state.info?.duration ?? 0,
    trimEnabled:     $('trim-enabled').checked,
    trimStart:       num('trim-start'),
    trimEnd:         num('trim-end'),
    fadeIn:          num('fadein'),
    fadeOut:         num('fadeout'),
    fadeCurve:       $('fade-curve').value,
    normalize:       $('normalize').checked,
    speed:           num('speed'),
    filterType:      $('filter-type').value,
    filterFreq:      parseFloat($('filter-freq').value),
    filterBandwidth: parseFloat($('filter-bw').value),
    filterSlope:     Number($('filter-slope').value),
    filterQ:         parseFloat($('filter-q').value),
    wavDepth:        $('wav-depth').value,
  }, outputPath)
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let toastTimer
function showToast(msg, type = '') {
  toast.textContent = msg
  toast.className = 'toast' + (type ? ' ' + type : '')
  clearTimeout(toastTimer)
  if (type && type !== 'error') toastTimer = setTimeout(hideToast, 3500)
}
function hideToast() { toast.classList.add('hidden') }

window.addEventListener('resize', renderWaveform)
if (typeof ResizeObserver === 'function') new ResizeObserver(() => renderWaveform()).observe(canvas)

// ─── Language ────────────────────────────────────────────────────────────────

/** Sets an element's text while keeping its key, so that a later change of
 * language finds it again. */
function setKey(el, key) {
  el.dataset.i18n = key
  el.textContent = tr(key)
}

async function setLang(lang) {
  state.lang = lang
  saveLang(lang)
  tr = applyLang(lang)
  renderBadge()
  refreshValidity()
  renderUpdateBanner()
  // The menu bar is drawn by the system: only Rust can translate it again.
  await invoke('set_menu_language', { lang }).catch(() => {})
}

// ─── About ───────────────────────────────────────────────────────────────────

let closeAbout = null

/** A modal box over the editor: one at a time, closed by Escape, its own button
 * or a click outside; Tab cycles inside it, and focus goes back to where it was. */
function openDialog(id, html) {
  closeAbout?.()

  const opener = document.activeElement
  const dialog = document.createElement('div')
  dialog.id = id
  dialog.className = 'about-backdrop'
  dialog.innerHTML = html

  const onKey = (e) => {
    if (e.key === 'Escape') {
      close()
    } else if (e.key === 'Tab') {
      e.preventDefault()
      const stops = [...dialog.querySelectorAll('button, [tabindex="0"]')]
      const at = stops.indexOf(document.activeElement)
      const next = e.shiftKey ? at - 1 : at + 1
      stops[(next + stops.length) % stops.length].focus()
    }
  }
  const close = () => {
    dialog.remove()
    document.removeEventListener('keydown', onKey)
    closeAbout = null
    opener?.focus?.()
  }
  closeAbout = close
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close() })
  dialog.querySelector('button').addEventListener('click', close)
  document.addEventListener('keydown', onKey)

  document.body.appendChild(dialog)
  dialog.querySelector('button').focus()
  return dialog
}

function showAbout(version) {
  openDialog('about-dialog', `
    <div class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
      <div class="about-title" id="about-title" data-i18n="about.title">${tr('about.title')}</div>
      <div class="about-tagline" data-i18n="about.tagline">${tr('about.tagline')}</div>
      <div class="about-version mono">${tr('about.version', { version })}</div>
      <div class="about-licenses" data-i18n="about.licenses">${tr('about.licenses')}</div>
      <button class="btn-ghost" data-i18n="about.close">${tr('about.close')}</button>
    </div>`)
}

// ─── Changelog ───────────────────────────────────────────────────────────────

/** Text with `code` spans, built as DOM nodes: changelog text is never parsed as HTML. */
function appendInline(parent, text) {
  text.split('`').forEach((piece, i) => {
    if (!piece) return
    if (i % 2 === 1) {
      const code = document.createElement('code')
      code.textContent = piece
      parent.append(code)
    } else {
      parent.append(piece)
    }
  })
}

/** `[{ title, items }]` as headings and lists. */
function renderSections(container, sections) {
  for (const { title, items } of sections) {
    if (title) {
      const h = document.createElement('h4')
      h.textContent = title
      container.append(h)
    }
    const list = document.createElement('ul')
    for (const item of items) {
      const li = document.createElement('li')
      appendInline(li, item)
      list.append(li)
    }
    container.append(list)
  }
}

/** The bundled changelog of the interface language, falling back to English. */
function changelogEntries() {
  // An empty Unreleased heading (just after a release) has nothing to show.
  const parse = (md) => parseChangelog(md).filter((e) => e.sections.length)
  const own = parse(state.lang === 'fr' ? changelogFr : changelogEn)
  return own.length ? own : parse(changelogEn)
}

function showChangelog() {
  const dialog = openDialog('changelog-dialog', `
    <div class="about-card changelog-card" role="dialog" aria-modal="true" aria-labelledby="changelog-title">
      <div class="about-title" id="changelog-title" data-i18n="changelog.title">${tr('changelog.title')}</div>
      <div class="changelog-body" tabindex="0"></div>
      <button class="btn-ghost" data-i18n="about.close">${tr('about.close')}</button>
    </div>`)
  const body = dialog.querySelector('.changelog-body')
  const entries = changelogEntries()
  if (!entries.length) {
    body.textContent = tr('changelog.empty')
    return
  }
  for (const { version, date, sections } of entries) {
    const h = document.createElement('h3')
    const unreleased = version.toLowerCase() === 'unreleased'
    h.textContent = unreleased ? tr('changelog.unreleased') : `v${version}`
    if (date) {
      const small = document.createElement('small')
      small.textContent = date
      h.append(small)
    }
    body.append(h)
    renderSections(body, sections)
  }
}

// ─── Native menu ─────────────────────────────────────────────────────────────

listen('menu-open', () => { void pickAndLoad() })
listen('menu-about', (e) => showAbout(e.payload))
listen('menu-changelog', () => showChangelog())
listen('menu-set-language', (e) => { void setLang(e.payload) })
listen('menu-check-updates', () => { void checkForUpdates(true) })
// "Open with…", or a second launch with a file while the app is running.
listen('open-file', (e) => { void loadFile(e.payload) })

// ─── Auto-updater ─────────────────────────────────────────────────────────────
//
// An update is only announced: installing it restarts the app, which the user
// decides — never in the middle of their work, never in the middle of an export.

let pendingUpdate = null
let updateUi = null
let showUpdateNotes = false
let updateInFlight = null

function renderUpdateBanner() {
  let banner = $('update-banner')
  if (!updateUi) { banner?.remove(); return }
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'update-banner'
    banner.setAttribute('role', 'status')
    $('app').prepend(banner)
  }

  const { phase, version, percent } = updateUi
  const text = document.createElement('span')
  text.textContent = {
    available:   () => tr('update.available', { version }),
    downloading: () => tr('update.downloading', { version, percent }),
    restarting:  () => tr('update.restarting'),
    waiting:     () => tr('update.waitingForExport'),
  }[phase]()
  banner.textContent = ''
  banner.append(text)

  if (phase === 'available') {
    const install = document.createElement('button')
    install.id = 'update-install'
    install.className = 'btn-ghost'
    install.textContent = tr('update.install')
    install.addEventListener('click', () => { void installUpdate() })
    const later = document.createElement('button')
    later.id = 'update-later'
    later.className = 'btn-ghost'
    later.textContent = tr('update.later')
    later.addEventListener('click', () => { updateUi = null; renderUpdateBanner() })
    banner.append(install, later)

    // What the update contains, from the release notes the updater received.
    const sections = releaseNotesSections(pendingUpdate?.body, state.lang)
    if (sections.length) {
      const toggle = document.createElement('button')
      toggle.id = 'update-notes-toggle'
      toggle.className = 'btn-ghost'
      toggle.setAttribute('aria-expanded', String(showUpdateNotes))
      toggle.textContent = tr(showUpdateNotes ? 'update.hideNotes' : 'update.notes')
      toggle.addEventListener('click', () => {
        showUpdateNotes = !showUpdateNotes
        renderUpdateBanner()
      })
      banner.insertBefore(toggle, install)
      if (showUpdateNotes) {
        const notes = document.createElement('div')
        notes.id = 'update-notes'
        notes.className = 'update-notes'
        renderSections(notes, sections)
        banner.append(notes)
      }
    }
  }
}

/** `fromMenu` tells the check at startup — silent, so the screen does not stir at
 * every launch — from the one asked for in the menu, which has to answer
 * something even when there is nothing to install. Two simultaneous checks are
 * one. */
function checkForUpdates(fromMenu = false) {
  updateInFlight ??= runUpdateCheck(fromMenu).finally(() => { updateInFlight = null })
  return updateInFlight
}

async function runUpdateCheck(fromMenu) {
  if (fromMenu) showToast(tr('update.checking'))
  try {
    const update = await check()
    if (!update) {
      if (fromMenu) showToast(tr('update.upToDate'), 'success')
      return
    }
    if (fromMenu) hideToast()
    pendingUpdate = update
    showUpdateNotes = false
    updateUi = { phase: 'available', version: update.version, percent: 0 }
    renderUpdateBanner()
  } catch (e) {
    // No network, or running in dev where no updater endpoint is served.
    if (fromMenu) showToast(tr('update.failed', { error: describeError(e, tr) }), 'error')
    else console.warn('Update check failed:', e)
  }
}

async function installUpdate() {
  const update = pendingUpdate
  if (!update || updateUi?.phase !== 'available') return
  updateUi = { phase: 'downloading', version: update.version, percent: 0 }
  renderUpdateBanner()
  try {
    let total = 0
    let received = 0
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') total = event.data.contentLength ?? 0
      else if (event.event === 'Progress') received += event.data.chunkLength
      else return
      updateUi.percent = total ? Math.min(100, Math.round((received / total) * 100)) : 0
      renderUpdateBanner()
    })
    if (exportInFlight) {
      updateUi = { phase: 'waiting', version: update.version, percent: 100 }
      renderUpdateBanner()
      await exportInFlight
    }
    updateUi = { phase: 'restarting', version: update.version, percent: 100 }
    renderUpdateBanner()
    await relaunch()
  } catch (e) {
    // Back to a clean screen: a banner stuck on "downloading" helps nobody.
    updateUi = null
    renderUpdateBanner()
    showToast(tr('update.failed', { error: describeError(e, tr) }), 'error')
  }
}

void setLang(state.lang)
void checkForUpdates()
// A file given on the command line before the window could listen for it.
invoke('take_pending_file')
  .then((path) => { if (path) return loadFile(path) })
  .catch(() => {})

import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import changelogEn from '../CHANGELOG.md?raw'
import changelogFr from '../CHANGELOG.fr.md?raw'
import { applyLang, loadLang, saveLang, loadTheme, saveTheme } from './i18n.js'
import {
  TARGET_PEAK,
  fmtTime,
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
import {
  MIN_CUT,
  mergeCuts,
  keptSegments,
  keptDuration,
  realToVirtual,
  virtualToReal,
  parseTimeInput,
  fmtPrecise,
} from './cuts.js'

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
  theme: loadTheme(),
}

// Applied before anything else so the markup's initial text never shows through.
let tr = applyLang(state.lang)

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)
const dropZone      = $('drop-zone')
const editor        = $('editor')
const canvas        = $('waveform')
const spectrum      = $('spectrum')
const openBtn       = $('open-btn')
const openBtnHeader = $('open-btn-header')
const exportBtn     = $('export-btn')
const cancelBtn     = $('cancel-btn')
const exportModal   = $('export-modal')
const undoBtn       = $('undo-btn')
const redoBtn       = $('redo-btn')
const playBtn       = $('play-btn')
const toast         = $('toast')
const recentBox     = $('recent')
const recentList    = $('recent-list')

const num = (id) => parseFloat($(id).value)

// ─── Cuts ────────────────────────────────────────────────────────────────────
//
// The parts of the file that are removed. What plays, and what the seek bar
// counts, is what is left: the "virtual" time, along the kept segments. The
// waveform and the timeline show the whole file ("real" time).

let cuts = []
let kept = []
let selectedCut = null
let cutDraft = null
let pendingCutStart = null

const realDuration = () => state.info?.duration ?? 0
const virtualDuration = () => keptDuration(kept)

/** The region the preview plays and the fades are measured on: all of what the
 * cuts leave. */
function keptRegion() {
  return { start: 0, end: playBuffer?.duration ?? virtualDuration() }
}

// ─── Audio playback (Web Audio API) ─────────────────────────────────────────
//
// Graph: source → fades → filter stages → normalise → output, the order in which
// the backend applies them (the source's playbackRate stands for the speed
// change). Steep filters are several biquads in series, as in the backend; the
// stages a filter does not use are exact identities.

let audioCtx          = null
let audioBuffer       = null
let playBuffer        = null // `audioBuffer` without the cuts
let audioSource       = null
let fadeGainNode      = null
let filterNodes       = []
let normalizeGainNode = null
let analyserNode      = null
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
  // Only listens, for the visualisation; the sound goes on to the output.
  analyserNode = audioCtx.createAnalyser?.() ?? null
  if (analyserNode) {
    analyserNode.fftSize = 512
    analyserNode.smoothingTimeConstant = 0.8
    normalizeGainNode.connect(analyserNode)
  }
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
  const end = playBuffer?.duration ?? 0
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
  if (!audioCtx || !playBuffer) return
  stopPlayback()
  audioSource = audioCtx.createBufferSource()
  audioSource.buffer = playBuffer
  audioSource.connect(fadeGainNode)
  playStartOffset  = Math.max(0, Math.min(offset, playBuffer.duration))
  playStartCtxTime = audioCtx.currentTime
  playRate         = validRate(currentSpeed())
  audioSource.playbackRate.value = playRate
  configureFilter(filterNodes, audioCtx.sampleRate)

  scheduleFades(fadeGainNode.gain, audioCtx.currentTime, playStartOffset, playRate)
  audioSource.start(0, playStartOffset)
  audioSource.onended = () => {
    audioSource = null
    playStartOffset = 0
    cancelAnimationFrame(playRaf)
    setPlaying(false)
    showPosition()
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

/** Plays again from where it is, picking up changed cuts or fades. */
function restartIfPlaying() {
  if (!isPlaying()) return
  startPlayback(currentPlaybackTime())
}

/** Moves the playhead to `time`, counted along what the cuts leave. */
function seekTo(time) {
  if (!playBuffer || !state.info) return
  const wasPlaying = isPlaying()
  if (wasPlaying) { cancelAnimationFrame(playRaf); stopPlayback() }
  playStartOffset = Math.max(0, Math.min(time, virtualDuration()))
  if (wasPlaying) { startPlayback(playStartOffset); setPlaying(true); tickPlayhead() }
  showPosition()
}

/** Moves the playhead to a time of the file; inside a cut, it lands on the cut. */
const seekToReal = (time) => seekTo(realToVirtual(time, kept))

/** Redraws everything that shows where the playhead is. */
function showPosition() {
  const time = currentPlaybackTime()
  const total = virtualDuration()
  $('time-current').textContent = fmtTime(time)
  const pct = total > 0 ? Math.min(100, (time / total) * 100) : 0
  $('seekbar-fill').style.width = `${pct}%`
  $('seekbar-thumb').style.left = `${pct}%`
  $('seekbar').setAttribute('aria-valuenow', String(Math.round(time)))
  $('seekbar-tooltip').textContent = fmtTime(time)
  renderWaveform()
  drawSpectrum()
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
  setPlaybackRate(currentSpeed())
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
  const rate = playBuffer.sampleRate
  const length = Math.max(1, Math.ceil((end - start) * rate))
  const offline = new OfflineAudioContext(playBuffer.numberOfChannels, length, rate)
  const source = offline.createBufferSource()
  const fades = offline.createGain()
  const filters = Array.from({ length: FILTER_STAGES }, () => offline.createBiquadFilter())
  source.buffer = playBuffer
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
  return Math.max(0, ...kept.map(({ start, end }) => waveformPeak(state.waveform, state.info.duration, start, end)))
}

async function updateNormalization() {
  clearTimeout(normTimer)
  const token = ++normToken
  if (!playBuffer || !$('normalize').checked) { setNormalizeGain(1); return }
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
  if (!playBuffer) return
  if (!isPlaying()) {
    // From the start again once the end was reached.
    const from = playStartOffset >= virtualDuration() - 0.01 ? 0 : playStartOffset
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
    showPosition()
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

/** The keyboard's way of marking a cut: I puts its start at the playhead, O its
 * end, which makes the cut. */
function markCutFromPlayhead(which) {
  if (!state.info) return
  const time = virtualToReal(currentPlaybackTime(), kept)
  if (which === 'start') {
    pendingCutStart = time
    return
  }
  if (pendingCutStart === null || time - pendingCutStart < MIN_CUT) return
  addCut(pendingCutStart, time)
  pendingCutStart = null
}

canvas.addEventListener('keydown', (e) => {
  if (e.key === 'i' || e.key === 'o') {
    e.preventDefault()
    markCutFromPlayhead(e.key === 'i' ? 'start' : 'end')
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
const readColors = () => ({
  bg:     cssVar('--card', '#2a2a2a'),
  on:     cssVar('--accent', '#7c3aed'),
  off:    cssVar('--wave-off', '#242424'),
  handle: cssVar('--accent-light', '#9d5cf6'),
})
let COLORS = readColors()

// A change of theme (View → Theme, or the system's) repaints the waveform.
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  COLORS = readColors()
  waveformVersion++
  renderWaveform()
})

// The bars only change with the file or the canvas size, so they are drawn
// once into an offscreen layer; each animation frame then costs one `drawImage`
// plus the playhead.
let waveLayer = null
let waveLayerKey = ''
let waveformVersion = 0

function waveformLayer(W, H, pw, ph) {
  const key = [waveformVersion, pw, ph].join('|')
  if (waveLayer && key === waveLayerKey) return waveLayer
  waveLayer ??= document.createElement('canvas')
  waveLayer.width  = pw
  waveLayer.height = ph
  const ctx = waveLayer.getContext('2d')
  ctx.setTransform(pw / W, 0, 0, ph / H, 0, 0)
  ctx.fillStyle = COLORS.bg
  ctx.fillRect(0, 0, W, H)

  const data = state.waveform
  const barW = W / data.length
  for (let i = 0; i < data.length; i++) {
    const amp  = Math.min(data[i], 1.0)
    const barH = Math.max(amp * H * 0.85, 1)
    ctx.fillStyle = COLORS.on
    ctx.fillRect(i * barW, (H - barH) / 2, Math.max(barW - 0.5, 0.5), barH)
  }
  waveLayerKey = key
  return waveLayer
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

  const duration = state.info?.duration || 1

  ctx.drawImage(waveformLayer(W, H, pw, ph), 0, 0, W, H)

  // Playhead, at the place of the file the sound is at
  if (playBuffer && duration > 0) {
    const px = (virtualToReal(currentPlaybackTime(), kept) / duration) * W
    ctx.save()
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'
    ctx.lineWidth = 1.5
    ctx.setLineDash([3, 3])
    ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke()
    ctx.restore()
  }
}

// ─── Cuts: the timeline ──────────────────────────────────────────────────────
//
// As in LightCutVidz: dragging on the track marks a part to remove; the edges of
// a cut resize it, its middle moves it, and a press without a drag moves the
// playhead.

const HANDLE_PX = 8
const track = $('tl-track')
const cutLayer = $('tl-cuts')
let drag = { type: 'none' }

const newCutId = () => `cut-${Date.now()}-${Math.round(Math.random() * 1e6)}`
const trackRect = () => cutLayer.getBoundingClientRect()

function xToTime(clientX) {
  const rect = trackRect()
  const duration = realDuration()
  if (!rect.width || duration <= 0) return 0
  return Math.max(0, Math.min(duration, ((clientX - rect.left) / rect.width) * duration))
}

const pct = (time) => (realDuration() > 0 ? (time / realDuration()) * 100 : 0)

function renderCuts() {
  const nodes = cuts.map((cut) => {
    const node = document.createElement('div')
    node.className = 'tl-cut' + (cut.id === selectedCut ? ' selected' : '')
    node.dataset.id = cut.id
    node.style.left = `${pct(cut.start)}%`
    node.style.width = `${pct(cut.end - cut.start)}%`
    const left = document.createElement('div')
    left.className = 'tl-cut-handle left'
    left.title = tr('cut.resize')
    const right = document.createElement('div')
    right.className = 'tl-cut-handle right'
    right.title = tr('cut.resize')
    const info = document.createElement('div')
    info.className = 'tl-cut-info'
    const length = document.createElement('span')
    length.className = 'tl-cut-duration'
    length.textContent = fmtTime(cut.end - cut.start)
    const del = document.createElement('button')
    del.className = 'tl-cut-delete'
    del.textContent = '×'
    del.title = tr('cut.delete')
    del.setAttribute('aria-label', tr('cut.delete'))
    del.addEventListener('pointerdown', (e) => e.stopPropagation())
    del.addEventListener('click', (e) => { e.stopPropagation(); removeCut(cut.id) })
    info.append(length, del)
    node.append(left, info, right)
    return node
  })
  if (cutDraft && cutDraft.end > cutDraft.start) {
    const node = document.createElement('div')
    node.className = 'tl-cut tl-cut-draft'
    node.style.left = `${pct(cutDraft.start)}%`
    node.style.width = `${pct(cutDraft.end - cutDraft.start)}%`
    nodes.push(node)
  }
  cutLayer.replaceChildren(...nodes)

  const n = cuts.length
  $('cut-count').textContent = tr(n === 1 ? 'cut.countOne' : 'cut.countMany', { n })
  $('cut-count').classList.toggle('hidden', n === 0)
  $('side-cut-count').textContent = $('cut-count').textContent
  $('side-cut-count').classList.toggle('hidden', n === 0)
  $('cut-clear').classList.toggle('hidden', n === 0)
  renderCutEditor()
}

/** The fields of the selected cut, or the line that says to select one. */
function renderCutEditor() {
  const cut = cuts.find((c) => c.id === selectedCut)
  $('cut-fields').classList.toggle('hidden', !cut)
  $('cut-placeholder').classList.toggle('hidden', !!cut)
  if (!cut) return
  for (const [id, value] of [['cut-start', cut.start], ['cut-end', cut.end]]) {
    // A field being typed in is left alone.
    if (document.activeElement !== $(id)) $(id).value = fmtPrecise(value)
  }
  $('cut-length').textContent = `(${fmtPrecise(cut.end - cut.start)})`
}

/** Keeps `cuts` sorted and merged, rebuilds what plays and redraws. */
function applyCuts({ restart = true, record = true } = {}) {
  cuts = mergeCuts(cuts)
  if (!cuts.some((c) => c.id === selectedCut)) selectedCut = null
  kept = keptSegments(cuts, realDuration())
  rebuildPlayBuffer()
  playStartOffset = Math.min(playStartOffset, virtualDuration())
  $('time-total').textContent = fmtTime(virtualDuration())
  $('seekbar').setAttribute('aria-valuemax', String(Math.round(virtualDuration())))
  renderCuts()
  showPosition()
  refreshValidity()
  scheduleNormalization()
  if (restart) restartIfPlaying()
  if (record) recordEdit()
}

function addCut(start, end) {
  const merged = mergeCuts([...cuts, { id: newCutId(), start, end }])
  cuts = merged
  // The new cut may have been absorbed by an earlier one: select what covers it.
  selectedCut = merged.find((c) => c.start <= start && c.end >= end)?.id ?? null
  applyCuts()
}

function removeCut(id) {
  cuts = cuts.filter((c) => c.id !== id)
  applyCuts()
}

/** What plays: the file without the cuts. Built once per edit, not per frame. */
function rebuildPlayBuffer() {
  if (!audioBuffer) { playBuffer = null; return }
  if (!cuts.length) { playBuffer = audioBuffer; return }
  const rate = audioBuffer.sampleRate
  const segments = kept.map(({ start, end }) => [Math.round(start * rate), Math.round(end * rate)])
  const length = Math.max(1, segments.reduce((sum, [a, b]) => sum + Math.max(0, b - a), 0))
  const out = audioCtx.createBuffer(audioBuffer.numberOfChannels, length, rate)
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const source = audioBuffer.getChannelData(ch)
    const target = out.getChannelData(ch)
    let at = 0
    for (const [a, b] of segments) {
      target.set(source.subarray(a, b), at)
      at += Math.max(0, b - a)
    }
  }
  playBuffer = out
}

track.addEventListener('pointerdown', (e) => {
  if (!state.info || e.button > 0) return
  e.preventDefault()
  track.setPointerCapture?.(e.pointerId)
  canvas.focus({ preventScroll: true })
  const time = xToTime(e.clientX)
  const rect = trackRect()
  const duration = realDuration()
  for (const cut of cuts) {
    const left = rect.left + (cut.start / duration) * rect.width
    const right = rect.left + (cut.end / duration) * rect.width
    const tiny = right - left <= HANDLE_PX * 2
    if (!tiny && Math.abs(e.clientX - left) < HANDLE_PX) {
      drag = { type: 'resize', id: cut.id, edge: 'left' }
    } else if (!tiny && Math.abs(e.clientX - right) < HANDLE_PX) {
      drag = { type: 'resize', id: cut.id, edge: 'right' }
    } else if (tiny ? e.clientX >= left && e.clientX <= right : e.clientX > left + HANDLE_PX && e.clientX < right - HANDLE_PX) {
      // A cut too narrow for a middle can only be moved, never resized.
      drag = { type: 'move', id: cut.id, offsetStart: time - cut.start, offsetEnd: cut.end - time }
    } else {
      continue
    }
    selectedCut = cut.id
    renderCuts()
    return
  }
  drag = { type: 'new', startTime: time }
  selectedCut = null
  renderCuts()
})

track.addEventListener('pointermove', (e) => {
  if (drag.type === 'none') return
  const time = xToTime(e.clientX)
  const duration = realDuration()
  if (drag.type === 'new') {
    cutDraft = { start: Math.min(drag.startTime, time), end: Math.max(drag.startTime, time) }
  } else {
    const cut = cuts.find((c) => c.id === drag.id)
    if (!cut) return
    if (drag.type === 'move') {
      const length = cut.end - cut.start
      let start = Math.max(0, time - drag.offsetStart)
      let end = start + length
      if (end > duration) { end = duration; start = Math.max(0, duration - length) }
      cut.start = start
      cut.end = end
    } else if (drag.edge === 'left') {
      cut.start = Math.max(0, Math.min(cut.end - MIN_CUT, time))
    } else {
      cut.end = Math.min(duration, Math.max(cut.start + MIN_CUT, time))
    }
  }
  renderCuts()
})

function endDrag(e, cancelled = false) {
  const current = drag
  drag = { type: 'none' }
  cutDraft = null
  if (current.type === 'none') return
  if (current.type === 'new') {
    const time = e && !cancelled ? xToTime(e.clientX) : current.startTime
    const start = Math.min(current.startTime, time)
    const end = Math.max(current.startTime, time)
    if (!cancelled && end - start > MIN_CUT) addCut(start, end)
    else {
      renderCuts()
      if (!cancelled) seekToReal(current.startTime)
    }
    return
  }
  // A drag can push a cut over another one: merged, still one gesture.
  applyCuts()
}
track.addEventListener('pointerup', (e) => endDrag(e))
track.addEventListener('pointercancel', () => endDrag(null, true))

$('cut-clear').addEventListener('click', () => {
  cuts = []
  selectedCut = null
  applyCuts()
})
$('cut-delete').addEventListener('click', () => { if (selectedCut) removeCut(selectedCut) })

for (const [id, edge] of [['cut-start', 'start'], ['cut-end', 'end']]) {
  const field = $(id)
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') field.blur() })
  field.addEventListener('blur', () => {
    const cut = cuts.find((c) => c.id === selectedCut)
    if (!cut) return
    // Leaving a field untouched hands back its rounded text: not an edit.
    if (field.value === fmtPrecise(cut[edge])) return
    const parsed = parseTimeInput(field.value)
    if (parsed === null) { renderCutEditor(); return }
    if (edge === 'start') cut.start = Math.max(0, Math.min(cut.end - MIN_CUT, parsed))
    else cut.end = Math.min(realDuration(), Math.max(cut.start + MIN_CUT, parsed))
    const { start, end } = cut
    cuts = mergeCuts(cuts)
    selectedCut = cuts.find((c) => c.start <= start && c.end >= end)?.id ?? null
    applyCuts()
  })
}

// Delete or Backspace removes the selected cut, unless something is being typed.
document.addEventListener('keydown', (e) => {
  if (!selectedCut || (e.key !== 'Delete' && e.key !== 'Backspace')) return
  const el = e.target
  if (el?.tagName === 'INPUT' || el?.tagName === 'TEXTAREA' || el?.tagName === 'SELECT' || el?.isContentEditable) return
  e.preventDefault()
  removeCut(selectedCut)
})

/** Time marks above the track: about every 60 px, on round numbers. */
const RULER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600]
function renderRuler() {
  const duration = realDuration()
  const ruler = $('tl-ruler')
  if (!(duration > 0)) { ruler.replaceChildren(); return }
  const step = RULER_STEPS.find((s) => duration / s <= 14) ?? 3600
  const ticks = []
  for (let t = 0; t <= duration; t += step) {
    const tick = document.createElement('div')
    tick.className = 'tl-tick'
    tick.style.left = `${(t / duration) * 100}%`
    const label = document.createElement('span')
    label.className = 'tl-tick-label'
    label.textContent = fmtTime(t)
    tick.append(label)
    ticks.push(tick)
  }
  ruler.replaceChildren(...ticks)
}

// ─── Seek bar ────────────────────────────────────────────────────────────────

const seekbar = $('seekbar')
let seeking = false

function seekbarTime(clientX) {
  const rect = seekbar.getBoundingClientRect()
  if (!rect.width) return 0
  return Math.max(0, Math.min(virtualDuration(), ((clientX - rect.left) / rect.width) * virtualDuration()))
}

seekbar.addEventListener('pointerdown', (e) => {
  if (!playBuffer || e.button > 0) return
  seeking = true
  seekbar.setPointerCapture?.(e.pointerId)
  seekTo(seekbarTime(e.clientX))
})
seekbar.addEventListener('pointermove', (e) => {
  $('seekbar-tooltip').textContent = fmtTime(seekbarTime(e.clientX))
  seekbar.classList.add('hover')
  if (seeking) seekTo(seekbarTime(e.clientX))
})
seekbar.addEventListener('pointerleave', () => seekbar.classList.remove('hover'))
const endSeek = () => { seeking = false }
seekbar.addEventListener('pointerup', endSeek)
seekbar.addEventListener('pointercancel', endSeek)
seekbar.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  seekTo(currentPlaybackTime() + (e.shiftKey ? 5 : 1) * (e.key === 'ArrowLeft' ? -1 : 1))
})

// ─── Visualisation ───────────────────────────────────────────────────────────
//
// Frequency bars, live from the sound that reaches the output; a flat line of
// short bars when nothing plays.

const BARS = 48
let freqData = null

function drawSpectrum() {
  if (!spectrum.isConnected || editor.classList.contains('hidden')) return
  const dpr = window.devicePixelRatio || 1
  const W = spectrum.clientWidth
  const H = spectrum.clientHeight
  if (!W || !H) return
  const pw = Math.round(W * dpr)
  const ph = Math.round(H * dpr)
  if (spectrum.width !== pw || spectrum.height !== ph) {
    spectrum.width = pw
    spectrum.height = ph
  }
  const ctx = spectrum.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  let levels = null
  if (analyserNode && isPlaying()) {
    freqData ??= new Uint8Array(analyserNode.frequencyBinCount)
    analyserNode.getByteFrequencyData(freqData)
    // Bars spread on a log scale: the low end is where the sound is.
    levels = Array.from({ length: BARS }, (_, i) => {
      const from = Math.floor(Math.pow(freqData.length, i / BARS)) - 1
      const to = Math.max(from + 1, Math.floor(Math.pow(freqData.length, (i + 1) / BARS)) - 1)
      let peak = 0
      for (let k = Math.max(0, from); k < Math.min(freqData.length, to); k++) peak = Math.max(peak, freqData[k])
      return peak / 255
    })
  }

  const gap = 4
  const barW = Math.max(2, (W - gap * (BARS + 1)) / BARS)
  const base = H * 0.9
  const gradient = ctx.createLinearGradient(0, base, 0, H * 0.1)
  gradient.addColorStop(0, COLORS.on)
  gradient.addColorStop(1, COLORS.handle)
  ctx.fillStyle = gradient
  for (let i = 0; i < BARS; i++) {
    const level = levels ? levels[i] : 0
    const h = Math.max(3, level * H * 0.8)
    ctx.fillRect(gap + i * (barW + gap), base - h, barW, h)
  }
}

window.addEventListener('resize', () => { renderWaveform(); drawSpectrum() })

// ─── Controls wiring ──────────────────────────────────────────────────────────

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

$('fadein').addEventListener('input', () => {
  $('fadein-val').textContent = parseFloat($('fadein').value).toFixed(1) + 's'
  onFadesChanged()
})
$('fadeout').addEventListener('input', () => {
  $('fadeout-val').textContent = parseFloat($('fadeout').value).toFixed(1) + 's'
  onFadesChanged()
})

const presets = () => document.querySelectorAll('.preset')

/** The speeds the slider steps through, as in LightCutVidz. */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
const currentSpeed = () => SPEEDS[Number($('speed').value)] ?? 1

/** Shows speed `v` on the slider, its label and the preset buttons. */
function showSpeed(v) {
  const step = SPEEDS.indexOf(v)
  $('speed').value = step === -1 ? 3 : step
  $('speed-val').textContent = `${v}x`
  presets().forEach((b) => {
    const on = parseFloat(b.dataset.v) === v
    b.classList.toggle('active', on)
    b.setAttribute('aria-pressed', String(on))
  })
  applyPreviewSettings()
}

$('speed').addEventListener('input', () => showSpeed(currentSpeed()))
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

/** The buttons stand for a select, which the rest of the app reads: whichever
 * changes it, they follow. */
function syncChoiceButtons(selectId) {
  document.querySelectorAll(`.stab-btn[data-for="${selectId}"]`).forEach((b) => {
    const on = b.dataset.value === $(selectId).value
    b.classList.toggle('active', on)
    b.setAttribute('aria-pressed', String(on))
  })
}
const syncFilterButtons = () => syncChoiceButtons('filter-type')
document.querySelectorAll('.stab-btn').forEach((b) => {
  b.addEventListener('click', () => {
    const select = $(b.dataset.for)
    select.value = b.dataset.value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
})

$('filter-type').addEventListener('change', () => {
  syncFilterButtons()
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
$('fade-curve').addEventListener('change', () => {
  syncChoiceButtons('fade-curve')
  onFadesChanged()
})

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
    $('depth-row').classList.toggle('hidden', state.format !== 'wav')
    $('wav-depth').classList.toggle('hidden', state.format !== 'wav')
  })
})

// ─── Validation ──────────────────────────────────────────────────────────────

function readSettings() {
  return {
    duration:        state.info?.duration ?? 0,
    sampleRate:      state.info?.sample_rate ?? 0,
    cuts,
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
  cuts            = []
  kept            = keptSegments(cuts, info.duration)
  selectedCut     = null
  pendingCutStart = null
  playBuffer      = buffer
  playStartOffset = 0
  playBtn.disabled = !buffer
  setNormalizeGain(1)

  $('badge-name').textContent = baseName(path)
  renderBadge()
  $('file-badge').classList.remove('hidden')
  $('time-total').textContent = fmtTime(info.duration)
  $('seekbar').setAttribute('aria-valuemax', String(Math.round(info.duration)))

  dropZone.classList.add('hidden')
  document.querySelector('header').classList.remove('hidden')
  editor.classList.remove('hidden')
  openBtnHeader.classList.remove('hidden')
  applyPreviewSettings()
  renderRuler()
  renderCuts()
  showPosition()
  refreshValidity()
  void updateNormalization()
  resetHistory()
  void refreshRecent()
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

/** The home screen's list of recently opened files. The backend keeps it and
 * approves each entry, so a click can open it without the file dialog. */
async function refreshRecent() {
  let items = []
  try {
    items = await invoke('get_recent')
  } catch (e) {
    console.warn('Recent files unavailable:', e)
  }
  if (!Array.isArray(items)) items = []
  recentList.replaceChildren(...items.slice(0, 5).map(recentItem))
  recentBox.classList.toggle('hidden', items.length === 0)
}

function recentItem({ path, name, dir }) {
  const li = document.createElement('li')
  li.className = 'recent-item'
  const open = document.createElement('button')
  open.className = 'recent-open'
  open.title = path
  for (const [cls, text] of [
    ['recent-kind', name.split('.').pop().toUpperCase()],
    ['recent-name', name],
    ['recent-dir', dir],
  ]) {
    const span = document.createElement('span')
    span.className = cls
    span.textContent = text
    open.append(span)
  }
  open.addEventListener('click', () => { void loadFile(path) })
  const remove = document.createElement('button')
  remove.className = 'recent-remove'
  remove.textContent = '×'
  remove.title = tr('recent.remove')
  remove.setAttribute('aria-label', tr('recent.remove'))
  remove.addEventListener('click', () => forgetRecent(path))
  li.append(open, remove)
  return li
}

async function forgetRecent(path) {
  try {
    await invoke('forget_recent', { path })
  } catch (e) {
    console.warn('Could not update the recent files:', e)
  }
  await refreshRecent()
}

$('recent-clear').addEventListener('click', () => forgetRecent(null))
void refreshRecent()

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

// ─── Undo / redo ─────────────────────────────────────────────────────────────
//
// What the editor holds is the controls: each step is a snapshot of them, taken
// when a gesture ends (a drag, a slider release, a field left, a preset).

const HISTORY_FIELDS = [
  'fadein', 'fadeout', 'fade-curve',
  'normalize', 'speed', 'filter-type', 'filter-freq', 'filter-slope', 'filter-q', 'filter-bw',
]
const HISTORY_LIMIT = 100
let history = []
let historyIndex = -1
let restoring = false

/** A control's value; numbers as numbers, so "1.0" and "1" are the same step. */
function controlValue(el) {
  if (el.type === 'checkbox') return el.checked
  const numeric = (el.type === 'range' || el.type === 'number') && el.value !== ''
  return numeric ? Number(el.value) : el.value
}

/** The cuts go in a snapshot as text, so that two of them compare with `===`. */
function readControls() {
  return {
    ...Object.fromEntries(HISTORY_FIELDS.map((id) => [id, controlValue($(id))])),
    cuts: JSON.stringify(cuts),
  }
}

const sameControls = (a, b) => a.cuts === b.cuts && HISTORY_FIELDS.every((id) => a[id] === b[id])

function syncUndoRedo() {
  undoBtn.disabled = historyIndex <= 0
  redoBtn.disabled = historyIndex >= history.length - 1
  void invoke('set_undo_redo', {
    canUndo: historyIndex > 0,
    canRedo: historyIndex < history.length - 1,
  }).catch(() => {})
}

/** The controls as they are now become the starting point (a file was opened). */
function resetHistory() {
  history = [readControls()]
  historyIndex = 0
  syncUndoRedo()
}

function recordEdit() {
  if (restoring || !state.info) return
  const snapshot = readControls()
  if (sameControls(snapshot, history[historyIndex])) return
  history = [...history.slice(0, historyIndex + 1), snapshot].slice(-HISTORY_LIMIT)
  historyIndex = history.length - 1
  syncUndoRedo()
}

function restoreControls(snapshot) {
  restoring = true
  try {
    cuts = JSON.parse(snapshot.cuts)
    selectedCut = null
    applyCuts({ restart: false, record: false })
    for (const id of HISTORY_FIELDS) {
      const el = $(id)
      if (el.type === 'checkbox') el.checked = snapshot[id]
      else el.value = snapshot[id]
      // The handlers of each control bring the preview and the checks up to date.
      el.dispatchEvent(new Event('input'))
      el.dispatchEvent(new Event('change'))
    }
  } finally {
    restoring = false
  }
  void updateNormalization()
}

function undo() {
  if (historyIndex <= 0) return
  restoreControls(history[--historyIndex])
  syncUndoRedo()
}

function redo() {
  if (historyIndex >= history.length - 1) return
  restoreControls(history[++historyIndex])
  syncUndoRedo()
}

/** In a text field Undo belongs to the typing, not to the editor's history. */
const inTextField = () => {
  const el = document.activeElement
  return el?.tagName === 'INPUT' && ['text', 'number'].includes(el.type)
}
const undoOrTextUndo = () => (inTextField() ? document.execCommand('undo') : undo())
const redoOrTextRedo = () => (inTextField() ? document.execCommand('redo') : redo())

editor.addEventListener('change', recordEdit)
editor.addEventListener('click', (e) => { if (e.target.closest?.('.preset')) recordEdit() })

// ─── Export ───────────────────────────────────────────────────────────────────

/** Settles when the running export has — the updater must not restart the app
 * in the middle of one. */
let exportInFlight = null

function showExportProgress(percent) {
  $('export-progress').classList.remove('hidden')
  $('export-progress-fill').style.width = `${percent}%`
  const label = $('export-label')
  label.removeAttribute('data-i18n')
  label.textContent = tr('export.progress', { percent })
}

/** The export options live in a dialog, as in LightCutVidz. */
function openExportModal() {
  if (!state.filePath) return
  if (isPlaying()) { stopPlayback(); setPlaying(false); cancelAnimationFrame(playRaf) }
  exportModal.classList.remove('hidden')
  exportBtn.focus()
}

function closeExportModal() {
  // An export in progress is stopped with its own button, not by hiding it.
  if (state.processing) return
  exportModal.classList.add('hidden')
  $('export-progress').classList.add('hidden')
}

$('export-open-btn').addEventListener('click', openExportModal)
$('export-close').addEventListener('click', closeExportModal)
$('export-dismiss').addEventListener('click', closeExportModal)
exportModal.addEventListener('click', (e) => { if (e.target === exportModal) closeExportModal() })
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !exportModal.classList.contains('hidden')) closeExportModal()
})
undoBtn.addEventListener('click', undo)
redoBtn.addEventListener('click', redo)

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
  $('export-dismiss').classList.add('hidden')
  $('export-close').disabled = true
  showExportProgress(0)

  try {
    await invoke('process_audio', { opts: buildOptions(outputPath) })
    exportModal.classList.add('hidden')
    showToast(tr('export.done', { name: baseName(outputPath) }), 'success')
  } catch (e) {
    if (e?.code === 'cancelled') showToast(tr('export.cancelled'), 'warning')
    else showToast(tr('msg.error', { error: describeError(e, tr) }), 'error')
  } finally {
    state.processing = false
    exportBtn.classList.remove('processing')
    cancelBtn.classList.add('hidden')
    $('export-dismiss').classList.remove('hidden')
    $('export-close').disabled = false
    $('export-progress').classList.add('hidden')
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
    cuts,
    fadeIn:          num('fadein'),
    fadeOut:         num('fadeout'),
    fadeCurve:       $('fade-curve').value,
    normalize:       $('normalize').checked,
    speed:           currentSpeed(),
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

if (typeof ResizeObserver === 'function') new ResizeObserver(() => { renderWaveform(); drawSpectrum() }).observe(document.querySelector('.editor'))

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
  renderCuts()
  refreshValidity()
  renderUpdateBanner()
  // The menu bar is drawn by the system: only Rust can translate it again.
  await invoke('set_menu_language', { lang }).catch(() => {})
}

async function setTheme(theme) {
  state.theme = theme
  saveTheme(theme)
  // The stylesheet follows the chosen theme; "system" leaves it to `prefers-color-scheme`.
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
  COLORS = readColors()
  waveformVersion++
  renderWaveform()
  drawSpectrum()
  await invoke('set_theme', { theme }).catch(() => {})
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
  dialog.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close))
  document.addEventListener('keydown', onKey)

  document.body.appendChild(dialog)
  dialog.querySelector('.btn-primary').focus()
  return dialog
}

function showAbout(version) {
  openDialog('about-dialog', `
    <div class="about-card" role="dialog" aria-modal="true" aria-labelledby="about-title">
      <div class="about-title" id="about-title" data-i18n="about.title">${tr('about.title')}</div>
      <div class="about-tagline" data-i18n="about.tagline">${tr('about.tagline')}</div>
      <div class="about-version mono">${tr('about.version', { version })}</div>
      <div class="about-licenses" data-i18n="about.licenses">${tr('about.licenses')}</div>
      <button class="btn-primary" data-close data-i18n="about.close">${tr('about.close')}</button>
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
      <div class="changelog-header">
        <div class="about-title" id="changelog-title" data-i18n="changelog.title">${tr('changelog.title')}</div>
        <button class="dialog-close" data-close aria-label="${tr('about.close')}">×</button>
      </div>
      <div class="changelog-body" tabindex="0"></div>
      <div class="changelog-actions">
        <button class="btn-primary" data-close data-i18n="about.close">${tr('about.close')}</button>
      </div>
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
listen('menu-set-theme', (e) => { void setTheme(e.payload) })
listen('menu-undo', () => undoOrTextUndo())
listen('menu-redo', () => redoOrTextRedo())
listen('menu-check-updates', () => { void checkForUpdates(true) })
// "Open with…", or a second launch with a file while the app is running.
listen('recent-changed', () => { void refreshRecent() })
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
void setTheme(state.theme)
void checkForUpdates()
// A file given on the command line before the window could listen for it.
invoke('take_pending_file')
  .then((path) => { if (path) return loadFile(path) })
  .catch(() => {})

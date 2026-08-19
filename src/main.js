import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { check } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { applyLang, getT, loadLang, saveLang } from './i18n.js'
import {
  fmtTime,
  defaultTrimEnd,
  fadeGainAt,
  bandpassQ,
  clampFilterFreq,
  buildProcessOptions,
} from './helpers.js'

const WAVEFORM_POINTS = 900

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  filePath: null,
  info: null,
  waveform: null,
  format: 'wav',
  processing: false,
  lang: loadLang(),
}

let t = getT(state.lang)

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)
const dropZone     = $('drop-zone')
const editor       = $('editor')
const canvas       = $('waveform')
const openBtn      = $('open-btn')
const openBtnHeader = $('open-btn-header')
const exportBtn    = $('export-btn')
const playBtn      = $('play-btn')
const toast        = $('toast')

// ─── Audio playback (Web Audio API) ─────────────────────────────────────────

let audioCtx         = null
let audioBuffer      = null
let audioPeak        = 1.0   // cached peak amplitude
let audioSource      = null
let fadeGainNode     = null
let filterNode       = null
let normalizeGainNode = null
let playStartCtxTime = 0
let playStartOffset  = 0
let playRate         = 1.0
let playRaf          = null

async function setupAudio(path) {
  stopPlayback()
  audioBuffer = null
  audioPeak   = 1.0
  playStartOffset = 0

  if (!audioCtx) {
    audioCtx = new AudioContext()
    fadeGainNode      = audioCtx.createGain()
    normalizeGainNode = audioCtx.createGain()
    filterNode        = audioCtx.createBiquadFilter()
    // Same order as process_audio: fade, then normalize, then filter.
    fadeGainNode.connect(normalizeGainNode)
    normalizeGainNode.connect(filterNode)
    filterNode.connect(audioCtx.destination)
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume()

  const url = convertFileSrc(path)
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(t('msg.unreachable', { status: resp.status }))
  const arrayBuffer = await resp.arrayBuffer()
  const ab = await audioCtx.decodeAudioData(arrayBuffer)
  audioBuffer = ab

  audioPeak = 0
  for (let ch = 0; ch < ab.numberOfChannels; ch++) {
    const d = ab.getChannelData(ch)
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i])
      if (a > audioPeak) audioPeak = a
    }
  }

  applyPreviewSettings()
}

function currentPlaybackTime() {
  if (!audioCtx || !audioSource) return playStartOffset
  // Elapsed context time is wall-clock; the source consumes the buffer
  // `playRate` times faster, so the playhead has to scale with it.
  return Math.min(
    playStartOffset + (audioCtx.currentTime - playStartCtxTime) * playRate,
    audioBuffer?.duration ?? 0
  )
}

// Re-anchors the timeline before changing rate, so time already elapsed keeps
// the speed it was played at.
function setPlaybackRate(rate) {
  if (!Number.isFinite(rate) || rate <= 0) rate = 1.0
  if (audioCtx && audioSource) {
    playStartOffset  = currentPlaybackTime()
    playStartCtxTime = audioCtx.currentTime
    audioSource.playbackRate.value = rate
  }
  playRate = rate
}

function isPlaying() { return audioSource !== null }

function startPlayback(offset) {
  if (!audioCtx || !audioBuffer) return
  stopPlayback()
  audioSource = audioCtx.createBufferSource()
  audioSource.buffer = audioBuffer
  audioSource.connect(fadeGainNode)
  playStartOffset  = Math.max(0, Math.min(offset, audioBuffer.duration))
  playStartCtxTime = audioCtx.currentTime
  playRate         = 1.0
  applyPreviewSettings()
  audioSource.start(0, playStartOffset)
  audioSource.onended = () => {
    audioSource = null
    playStartOffset = 0
    setPlaying(false)
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
}

// Apply all preview effects to the Web Audio node chain
function applyPreviewSettings() {
  if (!audioCtx) return

  // Speed
  setPlaybackRate(parseFloat($('speed').value))

  // Normalize
  if (normalizeGainNode) {
    normalizeGainNode.gain.value =
      ($('normalize').checked && audioPeak > 1e-8) ? 1.0 / audioPeak : 1.0
  }

  // Filter
  if (filterNode) {
    const ft = $('filter-type').value
    if (ft === '') {
      filterNode.type = 'allpass'
    } else {
      const freq = clampFilterFreq(parseFloat($('filter-freq').value) || 1000, audioCtx.sampleRate)
      filterNode.frequency.value = freq
      if (ft === 'lowpass') {
        filterNode.type = 'lowpass'
        filterNode.Q.value = 0.7071
      } else if (ft === 'highpass') {
        filterNode.type = 'highpass'
        filterNode.Q.value = 0.7071
      } else if (ft === 'bandpass') {
        const bw = parseFloat($('filter-bw').value) || 500
        filterNode.type = 'bandpass'
        filterNode.Q.value = bandpassQ(freq, bw)
      }
    }
  }
}

// Update fade gain in the animation loop based on current playback position
function updateFadeGain(t) {
  if (!fadeGainNode || !state.info) return
  const duration    = state.info.duration
  const trimEnabled = $('trim-enabled').checked
  // The backend trims first, so the fades sit at the edges of the trimmed
  // region — not at the edges of the file.
  fadeGainNode.gain.value = fadeGainAt(t, {
    start:   trimEnabled ? (parseFloat($('trim-start').value) || 0) : 0,
    end:     trimEnabled ? (parseFloat($('trim-end').value) || duration) : duration,
    fadeIn:  parseFloat($('fadein').value)  || 0,
    fadeOut: parseFloat($('fadeout').value) || 0,
  })
}

function togglePlay() {
  if (!audioBuffer) return
  if (!isPlaying()) {
    const trimEnabled = $('trim-enabled').checked
    const start = parseFloat($('trim-start').value) || 0
    const end   = parseFloat($('trim-end').value)   || state.info?.duration || 0
    let from = playStartOffset
    if (trimEnabled && (from < start || from >= end)) from = start
    startPlayback(from)
    setPlaying(true)
    tickPlayhead()
  } else {
    stopPlayback()
    setPlaying(false)
    cancelAnimationFrame(playRaf)
  }
}

function tickPlayhead() {
  function frame() {
    if (!isPlaying()) return
    const t = currentPlaybackTime()
    updateFadeGain(t)
    const trimEnabled = $('trim-enabled').checked
    const end = parseFloat($('trim-end').value) || state.info?.duration || 0
    if (trimEnabled && t >= end) {
      stopPlayback()
      playStartOffset = parseFloat($('trim-start').value) || 0
      setPlaying(false)
      renderWaveform()
      return
    }
    $('time-current').textContent = fmtTime(t)
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
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); togglePlay() }
})

// ─── Waveform render ─────────────────────────────────────────────────────────

function renderWaveform() {
  if (!state.waveform) return
  const data = state.waveform
  const dpr = window.devicePixelRatio || 1
  const W = canvas.clientWidth
  const H = canvas.clientHeight
  canvas.width  = W * dpr
  canvas.height = H * dpr
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)

  ctx.fillStyle = '#1a1a2e'
  ctx.fillRect(0, 0, W, H)

  const trimEnabled = $('trim-enabled').checked
  const trimStart   = parseFloat($('trim-start').value) || 0
  const trimEnd     = parseFloat($('trim-end').value)   || state.info?.duration || 0
  const duration    = state.info?.duration || 1
  const barW = W / data.length

  for (let i = 0; i < data.length; i++) {
    const amp  = Math.min(data[i], 1.0)
    const barH = Math.max(amp * H * 0.85, 1)
    const x    = i * barW
    const t    = (i / data.length) * duration
    const active = !trimEnabled || (t >= trimStart && t <= trimEnd)
    ctx.fillStyle = active ? '#7c3aed' : '#24243e'
    ctx.fillRect(x, (H - barH) / 2, Math.max(barW - 0.5, 0.5), barH)
  }

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
    for (const [t, label] of [[trimStart, 'start'], [trimEnd, 'end']]) {
      const hx = Math.round((t / duration) * W)
      ctx.strokeStyle = '#9d5cf6'
      ctx.lineWidth = 2
      ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke()
      ctx.fillStyle = '#7c3aed'
      const tabW = 12, tabH = 20
      const tabX = label === 'start' ? hx : hx - tabW
      ctx.beginPath()
      ctx.roundRect(tabX, 0, tabW, tabH, [0, 0, 4, 4])
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
  const x1 = (parseFloat($('trim-start').value) / duration) * W
  const x2 = (parseFloat($('trim-end').value)   / duration) * W
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
  // Seek on click
  if (audioBuffer && state.info) {
    const t = canvasXToTime(e.clientX)
    const wasPlaying = isPlaying()
    if (wasPlaying) { cancelAnimationFrame(playRaf); stopPlayback() }
    playStartOffset = t
    if (wasPlaying) { startPlayback(t); setPlaying(true); tickPlayhead() }
    renderWaveform()
    $('time-current').textContent = fmtTime(t)
  }
})

window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  const t = canvasXToTime(e.clientX)
  if (dragging === 'start') {
    const end = parseFloat($('trim-end').value) || state.info?.duration || 0
    $('trim-start').value = Math.min(t, end - 0.1).toFixed(2)
  } else {
    const start = parseFloat($('trim-start').value) || 0
    $('trim-end').value = Math.max(t, start + 0.1).toFixed(2)
  }
  $('trim-enabled').checked = true
  renderWaveform()
})

window.addEventListener('mouseup', () => {
  if (dragging) { dragging = null; canvas.classList.remove('cursor-resize') }
})

// ─── Controls wiring ──────────────────────────────────────────────────────────

$('trim-enabled').addEventListener('change', renderWaveform)
$('trim-start').addEventListener('input', renderWaveform)
$('trim-end').addEventListener('input', renderWaveform)

$('fadein').addEventListener('input', () => {
  $('fadein-val').textContent = parseFloat($('fadein').value).toFixed(1) + 's'
})
$('fadeout').addEventListener('input', () => {
  $('fadeout-val').textContent = parseFloat($('fadeout').value).toFixed(1) + 's'
})

$('speed').addEventListener('input', () => {
  const v = parseFloat($('speed').value)
  $('speed-val').textContent = v.toFixed(2) + '×'
  document.querySelectorAll('.preset').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.v) === v))
  applyPreviewSettings()
})
document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = parseFloat(btn.dataset.v)
    $('speed').value = v
    $('speed-val').textContent = v.toFixed(2) + '×'
    document.querySelectorAll('.preset').forEach(b => b.classList.toggle('active', b === btn))
    applyPreviewSettings()
  })
})

$('normalize').addEventListener('change', applyPreviewSettings)

$('filter-type').addEventListener('change', () => {
  const tp = $('filter-type').value
  $('filter-params').classList.toggle('hidden', tp === '')
  $('filter-bw-row').style.display = tp === 'bandpass' ? 'flex' : 'none'
  setKey($('filter-freq-label'), tp === 'bandpass' ? 'filter.centre' : 'filter.cutoff')
  applyPreviewSettings()
})
$('filter-freq').addEventListener('input', applyPreviewSettings)
$('filter-bw').addEventListener('input', applyPreviewSettings)

document.querySelectorAll('.fmt').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.fmt').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    state.format = btn.dataset.fmt
  })
})

// ─── File loading ─────────────────────────────────────────────────────────────

async function loadFile(path) {
  try {
    showToast(t('msg.loading'))
    const info = await invoke('load_audio', { path, points: WAVEFORM_POINTS })
    state.filePath = path
    state.info     = info
    state.waveform = info.waveform

    $('badge-name').textContent = path.split('/').pop()
    $('badge-meta').textContent = `${info.channels}ch · ${info.sample_rate}Hz · ${fmtTime(info.duration)}`
    $('file-badge').classList.remove('hidden')
    $('time-total').textContent = fmtTime(info.duration)
    $('time-current').textContent = '0:00'
    $('trim-start').value = '0'
    $('trim-start').max = info.duration
    $('trim-end').value = defaultTrimEnd(info.duration)
    $('trim-end').max   = info.duration

    await setupAudio(path)
    setPlaying(false)

    dropZone.classList.add('hidden')
    editor.classList.remove('hidden')
    openBtnHeader.classList.remove('hidden')
    renderWaveform()
    hideToast()
  } catch (e) {
    showToast(t('msg.error', { error: e }), 'error')
  }
}

async function pickAndLoad() {
  const path = await open({
    multiple: false,
    filters: [{ name: 'Audio', extensions: ['mp3','wav','flac','ogg','aac','m4a'] }],
  })
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

exportBtn.addEventListener('click', async () => {
  if (!state.filePath || state.processing) return
  const ext = state.format
  const outputPath = await save({
    defaultPath: `output.${ext}`,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  })
  if (!outputPath) return

  if (isPlaying()) { stopPlayback(); setPlaying(false); cancelAnimationFrame(playRaf) }

  state.processing = true
  exportBtn.disabled = true
  exportBtn.classList.add('processing')
  exportBtn.innerHTML = `<span>${t('export.working')}</span>`

  try {
    await invoke('process_audio', { opts: buildOptions(outputPath) })
    showToast(t('export.done', { name: outputPath.split('/').pop() }), 'success')
  } catch (e) {
    showToast(t('msg.error', { error: e }), 'error')
  } finally {
    state.processing = false
    exportBtn.disabled = false
    exportBtn.classList.remove('processing')
    exportBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg><span data-i18n="export.run">${t('export.run')}</span>`
  }
})

function buildOptions(outputPath) {
  return buildProcessOptions({
    filePath:        state.filePath,
    format:          state.format,
    duration:        state.info?.duration ?? 0,
    trimEnabled:     $('trim-enabled').checked,
    trimStart:       parseFloat($('trim-start').value),
    trimEnd:         parseFloat($('trim-end').value),
    fadeIn:          parseFloat($('fadein').value),
    fadeOut:         parseFloat($('fadeout').value),
    normalize:       $('normalize').checked,
    speed:           parseFloat($('speed').value),
    filterType:      $('filter-type').value,
    filterFreq:      $('filter-freq').value,
    filterBandwidth: $('filter-bw').value,
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

// ─── Language ────────────────────────────────────────────────────────────────

/** Change le texte d'un élément en gardant sa clé, pour qu'un changement de langue
 * ultérieur le retrouve. */
function setKey(el, key) {
  el.dataset.i18n = key
  el.textContent = t(key)
}

async function setLang(lang) {
  state.lang = lang
  saveLang(lang)
  t = applyLang(lang)
  // La barre de menu est dessinée par le système : seul Rust peut la retraduire.
  await invoke('set_menu_language', { lang }).catch(() => {})
}

// ─── About ───────────────────────────────────────────────────────────────────

function showAbout(version) {
  document.getElementById('about-dialog')?.remove()

  const dialog = document.createElement('div')
  dialog.id = 'about-dialog'
  dialog.className = 'about-backdrop'
  dialog.innerHTML = `
    <div class="about-card" role="dialog" aria-modal="true">
      <div class="about-title" data-i18n="about.title">${t('about.title')}</div>
      <div class="about-tagline" data-i18n="about.tagline">${t('about.tagline')}</div>
      <div class="about-version mono">${t('about.version', { version })}</div>
      <button class="btn-ghost" data-i18n="about.close">${t('about.close')}</button>
    </div>`

  const close = () => dialog.remove()
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close() })
  dialog.querySelector('button').addEventListener('click', close)
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onEsc) }
  })

  document.body.appendChild(dialog)
  dialog.querySelector('button').focus()
}

// ─── Native menu ─────────────────────────────────────────────────────────────

listen('menu-open', () => { void pickAndLoad() })
listen('menu-about', (e) => showAbout(e.payload))
listen('menu-set-language', (e) => { void setLang(e.payload) })
listen('menu-check-updates', () => { void checkForUpdates(true) })

// ─── Auto-updater ─────────────────────────────────────────────────────────────

/** `fromMenu` distingue la vérification au démarrage — silencieuse, pour ne pas
 * agiter l'écran à chaque lancement — de celle demandée depuis le menu, qui doit
 * répondre quelque chose même quand il n'y a rien à installer. */
async function checkForUpdates(fromMenu = false) {
  if (fromMenu) showToast(t('update.checking'))
  try {
    const update = await check()
    if (!update) {
      if (fromMenu) showToast(t('update.upToDate'), 'success')
      return
    }
    showUpdateBanner(t('update.found', { version: update.version }))
    await update.downloadAndInstall()
    await relaunch()
  } catch (e) {
    // No network, or running in dev where no updater endpoint is served.
    if (fromMenu) showToast(t('update.failed', { error: e }), 'error')
    else console.warn('Update check failed:', e)
  }
}

function showUpdateBanner(msg) {
  let banner = document.getElementById('update-banner')
  if (!banner) {
    banner = document.createElement('div')
    banner.id = 'update-banner'
    document.getElementById('app').prepend(banner)
  }
  banner.textContent = msg
}

void setLang(state.lang)
void checkForUpdates()

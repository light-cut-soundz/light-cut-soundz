import { invoke } from '@tauri-apps/api/core'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'
import { getCurrentWindow } from '@tauri-apps/api/window'

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  filePath: null,
  info: null,
  waveform: null,
  format: 'wav',
  processing: false,
}

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id)
const dropZone  = $('drop-zone')
const editor    = $('editor')
const canvas    = $('waveform')
const openBtn   = $('open-btn')
const exportBtn = $('export-btn')
const playBtn   = $('play-btn')
const toast     = $('toast')

// ─── Audio playback ──────────────────────────────────────────────────────────

let audioEl = null
let playRaf = null

function setupAudio(path) {
  if (audioEl) { audioEl.pause(); cancelAnimationFrame(playRaf) }
  const url = convertFileSrc(path)
  audioEl = new Audio(url)
  audioEl.addEventListener('ended', () => { setPlaying(false); renderWaveform() })
  audioEl.addEventListener('error', () => {
    const msg = audioEl.error?.message || 'format non supporté'
    showToast(`Erreur audio : ${msg}`, 'error')
    setPlaying(false)
  })
}

async function togglePlay() {
  if (!audioEl) return
  if (audioEl.paused) {
    const trimEnabled = $('trim-enabled').checked
    const start = parseFloat($('trim-start').value) || 0
    const end   = parseFloat($('trim-end').value)   || state.info?.duration || 0
    if (trimEnabled && (audioEl.currentTime < start || audioEl.currentTime >= end)) {
      audioEl.currentTime = start
    }
    try {
      await audioEl.play()
      setPlaying(true)
      tickPlayhead()
    } catch (err) {
      showToast('Lecture impossible : ' + err.message, 'error')
    }
  } else {
    audioEl.pause()
    setPlaying(false)
    cancelAnimationFrame(playRaf)
  }
}

function tickPlayhead() {
  function frame() {
    if (!audioEl || audioEl.paused) return
    const trimEnabled = $('trim-enabled').checked
    const end = parseFloat($('trim-end').value) || state.info?.duration || 0
    if (trimEnabled && audioEl.currentTime >= end) {
      audioEl.pause()
      audioEl.currentTime = parseFloat($('trim-start').value) || 0
      setPlaying(false)
      renderWaveform()
      return
    }
    $('time-current').textContent = fmtTime(audioEl.currentTime)
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
  if (audioEl && duration > 0) {
    const px = (audioEl.currentTime / duration) * W
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
      // line
      ctx.strokeStyle = '#9d5cf6'
      ctx.lineWidth = 2
      ctx.setLineDash([])
      ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, H); ctx.stroke()
      // grab tab at top
      ctx.fillStyle = '#7c3aed'
      const tabW = 12, tabH = 20
      const tabX = label === 'start' ? hx : hx - tabW
      ctx.beginPath()
      ctx.roundRect(tabX, 0, tabW, tabH, [0, 0, 4, 4])
      ctx.fill()
      // arrow hint inside tab
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
  const handle = getHandleAtX(e.clientX)
  canvas.classList.toggle('cursor-resize', !!handle)
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
  if (audioEl && state.info) {
    audioEl.currentTime = canvasXToTime(e.clientX)
    renderWaveform()
    $('time-current').textContent = fmtTime(audioEl.currentTime)
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

$('fadein').addEventListener('input',  () => { $('fadein-val').textContent  = parseFloat($('fadein').value).toFixed(1) + 's' })
$('fadeout').addEventListener('input', () => { $('fadeout-val').textContent = parseFloat($('fadeout').value).toFixed(1) + 's' })

$('speed').addEventListener('input', () => {
  const v = parseFloat($('speed').value)
  $('speed-val').textContent = v.toFixed(2) + '×'
  document.querySelectorAll('.preset').forEach(b => b.classList.toggle('active', parseFloat(b.dataset.v) === v))
})
document.querySelectorAll('.preset').forEach(btn => {
  btn.addEventListener('click', () => {
    const v = parseFloat(btn.dataset.v)
    $('speed').value = v
    $('speed-val').textContent = v.toFixed(2) + '×'
    document.querySelectorAll('.preset').forEach(b => b.classList.toggle('active', b === btn))
  })
})

$('filter-type').addEventListener('change', () => {
  const t = $('filter-type').value
  $('filter-params').classList.toggle('hidden', t === '')
  $('filter-bw-row').style.display = t === 'bandpass' ? 'flex' : 'none'
  $('filter-freq-label').textContent = t === 'bandpass' ? 'Centre' : 'Coupure'
})

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
    showToast('Chargement…')
    const [info, waveform] = await Promise.all([
      invoke('load_audio', { path }),
      invoke('get_waveform', { path, points: 900 }),
    ])
    state.filePath = path
    state.info     = info
    state.waveform = waveform

    $('badge-name').textContent = path.split('/').pop()
    $('badge-meta').textContent = `${info.channels}ch · ${info.sample_rate}Hz · ${fmtTime(info.duration)}`
    $('file-badge').classList.remove('hidden')
    $('time-total').textContent = fmtTime(info.duration)
    $('time-current').textContent = '0:00'
    $('trim-start').value = '0'
    $('trim-start').max = info.duration
    $('trim-end').value = info.duration.toFixed(1)
    $('trim-end').max   = info.duration

    setupAudio(path)
    setPlaying(false)

    dropZone.classList.add('hidden')
    editor.classList.remove('hidden')
    renderWaveform()
    hideToast()
  } catch (e) {
    showToast('Erreur : ' + e, 'error')
  }
}

openBtn.addEventListener('click', async () => {
  const path = await open({
    multiple: false,
    filters: [{ name: 'Audio', extensions: ['mp3','wav','flac','ogg','aac','m4a','opus'] }],
  })
  if (path) await loadFile(path)
})

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

  if (audioEl) { audioEl.pause(); setPlaying(false); cancelAnimationFrame(playRaf) }

  state.processing = true
  exportBtn.disabled = true
  exportBtn.classList.add('processing')
  exportBtn.innerHTML = '<span>Traitement…</span>'

  try {
    await invoke('process_audio', { opts: buildOptions(outputPath) })
    showToast('Export réussi : ' + outputPath.split('/').pop(), 'success')
  } catch (e) {
    showToast('Erreur : ' + e, 'error')
  } finally {
    state.processing = false
    exportBtn.disabled = false
    exportBtn.classList.remove('processing')
    exportBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
    </svg>Exporter`
  }
})

function buildOptions(outputPath) {
  const trimEnabled = $('trim-enabled').checked
  const filters = []
  const ft = $('filter-type').value
  if (ft === 'lowpass')  filters.push(`lowpass:${$('filter-freq').value}`)
  if (ft === 'highpass') filters.push(`highpass:${$('filter-freq').value}`)
  if (ft === 'bandpass') filters.push(`bandpass:${$('filter-freq').value}:${$('filter-bw').value}`)
  return {
    input:      state.filePath,
    output:     outputPath,
    format:     state.format,
    trim_start: trimEnabled ? parseFloat($('trim-start').value) : null,
    trim_end:   trimEnabled ? parseFloat($('trim-end').value)   : null,
    fade_in:    parseFloat($('fadein').value)  || null,
    fade_out:   parseFloat($('fadeout').value) || null,
    normalize:  $('normalize').checked,
    speed:      parseFloat($('speed').value) !== 1.0 ? parseFloat($('speed').value) : null,
    filters,
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtTime(secs) {
  const m = Math.floor(secs / 60)
  const s = Math.floor(secs % 60).toString().padStart(2, '0')
  return `${m}:${s}`
}

let toastTimer
function showToast(msg, type = '') {
  toast.textContent = msg
  toast.className = 'toast' + (type ? ' ' + type : '')
  clearTimeout(toastTimer)
  if (type) toastTimer = setTimeout(hideToast, 3500)
}
function hideToast() { toast.classList.add('hidden') }

window.addEventListener('resize', renderWaveform)

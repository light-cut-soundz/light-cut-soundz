import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The real `index.html`, minus its `<script>`, rather than a copy of the markup:
 * a copy always ends up diverging, and the `data-i18n` attributes are exactly
 * where the divergence would go unnoticed. */
const APP_MARKUP = readFileSync(join(HERE, '..', 'index.html'), 'utf8')
  .replace(/[\s\S]*<body>/, '')
  .replace(/<\/body>[\s\S]*/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim()

// `main.js` reaches for the Tauri APIs and the DOM the moment it is imported.
/** The backend commands, minus the two native dialogs. */
const invoke = vi.fn()
const convertFileSrc = vi.fn((p) => `asset://${p}`)
/** The native file picker (`pick_audio_file`) and save dialog (`pick_output_file`). */
const open = vi.fn()
const save = vi.fn()
const check = vi.fn()
const relaunch = vi.fn()
let dragDropHandler
/** The event listeners registered by `main.js` (menu, export progress, open-file). */
let menuHandlers = {}

// The dialogs are commands too, but they get their own mocks so that a test can
// replace what `invoke` answers without losing them.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd, ...args) => {
    if (cmd === 'pick_audio_file') return open()
    if (cmd === 'pick_output_file') return save(...args)
    return invoke(cmd, ...args)
  },
  convertFileSrc,
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: (h) => {
      dragDropHandler = h
      return Promise.resolve(() => {})
    },
  }),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (name, handler) => {
    menuHandlers[name] = handler
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/plugin-updater', () => ({ check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch }))

const $ = (id) => document.getElementById(id)

const AUDIO_INFO = {
  channels: 2,
  sample_rate: 44100,
  duration: 12.5,
  waveform: Array.from({ length: 900 }, (_, i) => (i % 10) / 10),
}

/** A decoded buffer with one quiet channel. */
function fakeAudioBuffer() {
  return {
    numberOfChannels: 1,
    duration: 12.5,
    sampleRate: 44100,
    getChannelData: vi.fn(() => new Float32Array([0, 0.5, -0.25])),
  }
}

/** The node chain `main.js` built, so tests can inspect what the preview applied.
 * `main.js` creates the fade gain, then the normalise gain, then the filter, and
 * wires them as fade -> filter -> normalise. */
let audio

function installAudioContext() {
  const node = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: {
      value: 1,
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      cancelScheduledValues: vi.fn(),
    },
    frequency: { value: 0 },
    Q: { value: 0 },
    type: '',
    start: vi.fn(),
    stop: vi.fn(),
    playbackRate: { value: 1 },
    buffer: null,
    onended: null,
  })
  audio = { ctx: null, gains: [], filters: [], sources: [] }
  const track = (list) => () => {
    const n = node()
    list.push(n)
    return n
  }
  class FakeAudioContext {
    constructor() {
      this.state = 'running'
      this.currentTime = 0
      this.sampleRate = 44100
      this.destination = node()
      audio.ctx = this
    }
    createGain = track(audio.gains)
    createBiquadFilter = track(audio.filters)
    createBufferSource = track(audio.sources)
    decodeAudioData = vi.fn(() => {
      audio.lastBuffer = fakeAudioBuffer()
      return Promise.resolve(audio.lastBuffer)
    })
    resume = vi.fn(() => Promise.resolve())
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

const fadeNode = () => audio.gains[0]
const normalizeNode = () => audio.gains[1]
/** The filter stages, in signal order; stage 0 is the one a 12 dB/octave filter uses. */
const filterNode = (i = 0) => audio.filters[i]
const lastSource = () => audio.sources[audio.sources.length - 1]

// ─── Animation frames ────────────────────────────────────────────────────────

/** `main.js` drives the playhead with rAF; queue the callbacks so a test can run
 * exactly one frame at a time instead of racing a real clock. */
let frames
function installRaf() {
  frames = []
  vi.stubGlobal('requestAnimationFrame', (cb) => frames.push(cb))
  vi.stubGlobal('cancelAnimationFrame', vi.fn(() => frames.splice(0)))
}
/** Runs the frame that is currently pending, if any. */
function runFrame() {
  const cb = frames.shift()
  if (cb) cb()
}

// ─── Canvas ──────────────────────────────────────────────────────────────────

/** jsdom has no 2D context and reports a zero-sized canvas; both are needed by
 * `renderWaveform` and by the hit-testing of the trim handles. */
let ctx2d
const CANVAS_W = 400
const CANVAS_H = 100

function installCanvas() {
  ctx2d = {
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    arcTo: vi.fn(),
    closePath: vi.fn(),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
  }
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctx2d)
}

/** Gives the mounted canvas a real size (jsdom leaves everything at 0). The
 * per-element `getContext` spy tells this boot's drawing apart from that of the
 * modules imported by earlier tests, whose window listeners jsdom keeps alive. */
function sizeCanvas() {
  const canvas = $('waveform')
  Object.defineProperty(canvas, 'clientWidth', { value: CANVAS_W, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: CANVAS_H, configurable: true })
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: CANVAS_W, height: CANVAS_H })
  canvas.getContext = vi.fn(() => ctx2d)
  return canvas
}

/** clientX for a given time on the waveform, using the fixture's 12.5 s duration. */
const xForTime = (t) => (t / AUDIO_INFO.duration) * CANVAS_W

/** Mounts the real markup and imports `main.js` fresh. */
async function bootApp() {
  document.body.innerHTML = APP_MARKUP
  sizeCanvas()
  vi.resetModules()
  await import('./main.js')
  // let the auto-updater's floating promise settle
  await Promise.resolve()
}

/** Loads a file through the header button and waits for the editor to appear. */
async function loadAudio(path = '/home/me/song.wav') {
  open.mockResolvedValue(path)
  $('open-btn').click()
  await vi.waitFor(() => expect($('editor').classList.contains('hidden')).toBe(false))
}

function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** A WebView without the codec: `decodeAudioData` rejects, the backend is fine. */
function makeDecodeFail() {
  const Original = globalThis.AudioContext
  vi.stubGlobal(
    'AudioContext',
    class extends Original {
      decodeAudioData = vi.fn(() => Promise.reject(new DOMException('EncodingError')))
    },
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  dragDropHandler = undefined
  menuHandlers = {}
  installAudioContext()
  installCanvas()
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) })),
  )
  installRaf()
  invoke.mockImplementation((cmd) =>
    cmd === 'load_audio' ? Promise.resolve(AUDIO_INFO) : Promise.resolve(undefined),
  )
  check.mockResolvedValue(null)
  open.mockResolvedValue(null)
  save.mockResolvedValue(null)
})

afterEach(() => {
  // Every bootApp leaves the `window` listeners of its module behind; a global
  // mouseup releases any drag still in progress in a past instance.
  window.dispatchEvent(new MouseEvent('mouseup'))
  vi.unstubAllGlobals()
})

describe('main — startup', () => {
  it('starts on the drop zone with the editor hidden', async () => {
    await bootApp()

    expect($('drop-zone').classList.contains('hidden')).toBe(false)
    expect($('editor').classList.contains('hidden')).toBe(true)
  })

  it('checks for updates on launch', async () => {
    await bootApp()
    expect(check).toHaveBeenCalled()
  })

  it('announces an available update without installing it', async () => {
    const downloadAndInstall = vi.fn(() => Promise.resolve())
    check.mockResolvedValue({ version: '9.9.9', downloadAndInstall })
    await bootApp()

    await vi.waitFor(() => expect($('update-banner')).not.toBeNull())
    expect($('update-banner').textContent).toContain('9.9.9')
    expect($('update-install')).not.toBeNull()
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('stays quiet when the update check fails', async () => {
    check.mockRejectedValue(new Error('offline'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await bootApp()

    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect($('update-banner')).toBeNull()
    warn.mockRestore()
  })
})

describe('main — loading a file', () => {
  it('asks the backend for the waveform and reveals the editor', async () => {
    await bootApp()

    await loadAudio()

    expect(invoke).toHaveBeenCalledWith('load_audio', {
      path: '/home/me/song.wav',
      points: 900,
    })
    expect($('drop-zone').classList.contains('hidden')).toBe(true)
    expect($('open-btn-header').classList.contains('hidden')).toBe(false)
  })

  it('fills in the file badge and the durations', async () => {
    await bootApp()

    await loadAudio()

    expect($('badge-name').textContent).toBe('song.wav')
    expect($('badge-meta').textContent).toBe('2ch · 44100Hz · 0:12')
    expect($('time-total').textContent).toBe('0:12')
    expect($('time-current').textContent).toBe('0:00')
  })

  it('seeds the trim fields from the duration', async () => {
    await bootApp()

    await loadAudio()

    expect($('trim-start').value).toBe('0')
    expect($('trim-end').value).toBe('12.5')
    expect($('trim-end').max).toBe('12.5')
  })

  it('loads nothing when the picker is dismissed', async () => {
    await bootApp()

    $('open-btn').click()
    await Promise.resolve()

    expect(invoke).not.toHaveBeenCalledWith('load_audio', expect.anything())
  })

  it('reports a backend failure in the toast', async () => {
    invoke.mockRejectedValue(new Error('unsupported codec'))
    await bootApp()
    open.mockResolvedValue('/home/me/bad.wav')

    $('open-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toContain('unsupported codec'))
    expect($('toast').className).toContain('error')
  })
})

describe('main — drag and drop', () => {
  it('highlights the drop zone while a file hovers', async () => {
    await bootApp()

    await dragDropHandler({ payload: { type: 'enter' } })
    expect($('drop-zone').classList.contains('drag-over')).toBe(true)

    await dragDropHandler({ payload: { type: 'leave' } })
    expect($('drop-zone').classList.contains('drag-over')).toBe(false)
  })

  it('loads the first dropped file', async () => {
    await bootApp()

    await dragDropHandler({ payload: { type: 'drop', paths: ['/home/me/dropped.wav'] } })

    expect(invoke).toHaveBeenCalledWith('load_audio', {
      path: '/home/me/dropped.wav',
      points: 900,
    })
    expect($('drop-zone').classList.contains('drag-over')).toBe(false)
  })

  it('ignores an empty drop', async () => {
    await bootApp()

    await dragDropHandler({ payload: { type: 'drop', paths: [] } })

    expect(invoke).not.toHaveBeenCalledWith('load_audio', expect.anything())
  })
})

describe('main — format and speed controls', () => {
  it('marks the chosen export format', async () => {
    await bootApp()
    const [, second] = document.querySelectorAll('.fmt')

    second.click()

    expect(second.classList.contains('active')).toBe(true)
    expect(document.querySelectorAll('.fmt.active')).toHaveLength(1)
  })

  it('moves the speed slider to the chosen preset', async () => {
    await bootApp()
    const preset = document.querySelector('.preset[data-v="2"]') ?? document.querySelectorAll('.preset')[1]

    preset.click()

    expect(preset.classList.contains('active')).toBe(true)
    expect(parseFloat($('speed').value)).toBe(parseFloat(preset.dataset.v))
  })
})

describe('main — exporting', () => {
  it('does nothing before a file is loaded', async () => {
    await bootApp()

    $('export-btn').click()
    await Promise.resolve()

    expect(save).not.toHaveBeenCalled()
  })

  it('sends the current settings to the backend', async () => {
    await bootApp()
    await loadAudio()
    save.mockResolvedValue('/home/me/out.wav')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ input: '/home/me/song.wav', output: '/home/me/out.wav' }),
      }),
    )
    expect($('toast').textContent).toContain('out.wav')
  })

  it('exports nothing when the save dialog is dismissed', async () => {
    await bootApp()
    await loadAudio()

    $('export-btn').click()
    await Promise.resolve()

    expect(invoke).not.toHaveBeenCalledWith('process_audio', expect.anything())
  })

  it('reports an export failure and re-enables the button', async () => {
    await bootApp()
    await loadAudio()
    save.mockResolvedValue('/home/me/out.wav')
    invoke.mockImplementation((cmd) =>
      cmd === 'process_audio'
        ? Promise.reject(new Error('ffmpeg missing'))
        : Promise.resolve(AUDIO_INFO),
    )

    $('export-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toContain('ffmpeg missing'))
    expect($('export-btn').disabled).toBe(false)
  })
})

describe('main — waveform rendering', () => {
  it('draws the bars once a file is loaded', async () => {
    await bootApp()

    await loadAudio()

    // Background + one bar per waveform point, drawn once into the offscreen layer.
    expect(ctx2d.fillRect.mock.calls.length).toBeGreaterThan(AUDIO_INFO.waveform.length)
    expect($('waveform').width).toBe(CANVAS_W)
    expect(ctx2d.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0)
    expect(ctx2d.drawImage).toHaveBeenCalled()
  })

  it('honours the device pixel ratio', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    await bootApp()

    await loadAudio()

    expect($('waveform').width).toBe(CANVAS_W * 2)
    expect(ctx2d.setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0)
  })

  it('greys out what falls outside the trim range', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.fillRect.mockClear()
    const colours = []
    ctx2d.fillRect.mockImplementation(() => colours.push(ctx2d.fillStyle))

    $('trim-enabled').checked = true
    $('trim-start').value = '5'
    $('trim-end').value = '6'
    $('trim-enabled').dispatchEvent(new Event('change'))

    expect(colours).toContain('#7c3aed') // inside the selection
    expect(colours).toContain('#24243e') // outside the selection
  })

  it('draws a handle at each end of the trim range', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    ctx2d.arcTo.mockClear()

    $('trim-start').dispatchEvent(new Event('input'))

    // Each tab is rounded at its two bottom corners, with no `roundRect`.
    expect(ctx2d.arcTo).toHaveBeenCalledTimes(4)
  })

  it('redraws on window resize', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.fillRect.mockClear()

    window.dispatchEvent(new Event('resize'))

    expect(ctx2d.fillRect).toHaveBeenCalled()
  })

  it('draws nothing before a file is loaded', async () => {
    await bootApp()

    window.dispatchEvent(new Event('resize'))

    expect($('waveform').getContext).not.toHaveBeenCalled()
  })
})

describe('main — playback', () => {
  it('starts the source and shows the pause icon', async () => {
    await bootApp()
    await loadAudio()

    $('play-btn').click()

    expect(lastSource().start).toHaveBeenCalledWith(0, 0)
    expect($('play-icon').innerHTML).toContain('rect')
  })

  it('stops on a second press and shows the play icon again', async () => {
    await bootApp()
    await loadAudio()
    $('play-btn').click()
    const source = lastSource()

    $('play-btn').click()

    expect(source.stop).toHaveBeenCalled()
    expect($('play-icon').innerHTML).toContain('polygon')
  })

  it('toggles playback with the space bar', async () => {
    await bootApp()
    await loadAudio()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))

    expect($('play-icon').innerHTML).toContain('rect')
  })

  it('leaves the space bar alone while typing in a field', async () => {
    await bootApp()
    await loadAudio()

    $('trim-start').dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))

    expect($('play-icon').innerHTML).toContain('polygon')
  })

  it('does nothing without a decoded buffer', async () => {
    await bootApp()

    $('play-btn').click()

    expect(audio.sources).toHaveLength(0)
  })

  it('advances the playhead with the audio clock', async () => {
    await bootApp()
    await loadAudio()

    $('play-btn').click()
    audio.ctx.currentTime = 3
    runFrame()

    expect($('time-current').textContent).toBe('0:03')
  })

  it('scales the playhead with the playback rate', async () => {
    await bootApp()
    await loadAudio()
    $('play-btn').click()

    document.querySelector('.preset[data-v="2.0"]').click() // re-anchors at t=0, then ×2
    audio.ctx.currentTime = 3
    runFrame()

    expect($('time-current').textContent).toBe('0:06')
  })

  it('starts from the trim start when the playhead sits outside the range', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '4'
    $('trim-end').value = '8'

    $('play-btn').click()

    // The end of the range is scheduled on the audio clock: 4 s to play.
    expect(lastSource().start).toHaveBeenCalledWith(0, 4, 4)
  })

  it('plays the whole file, with no duration, when trim is off', async () => {
    await bootApp()
    await loadAudio()

    $('play-btn').click()

    expect(lastSource().start.mock.calls[0]).toEqual([0, 0])
  })

  it('stops at the trim end by itself and rewinds to the trim start', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '1'
    $('trim-end').value = '2'
    $('play-btn').click()
    const source = lastSource()

    // Nothing in the animation loop is needed: the source ends on its own.
    source.onended()

    expect($('play-icon').innerHTML).toContain('polygon')
    $('play-btn').click()
    expect(lastSource().start).toHaveBeenCalledWith(0, 1, 1)
  })

  it('keeps the playhead inside the trim range even if no frame ran', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '1'
    $('trim-end').value = '2'
    $('play-btn').click()

    audio.ctx.currentTime = 50 // a hidden window: no frame, the clock moves on
    $('play-btn').click() // pause

    $('play-btn').click()
    expect(lastSource().start).toHaveBeenCalledWith(0, 1, 1)
  })

  it('rewinds to the beginning when the source ends on its own', async () => {
    await bootApp()
    await loadAudio()
    $('play-btn').click()
    const source = lastSource()

    source.onended()

    expect($('play-icon').innerHTML).toContain('polygon')
    $('play-btn').click()
    expect(lastSource().start).toHaveBeenCalledWith(0, 0)
  })

  it('schedules the fade envelope on the audio clock, not per frame', async () => {
    await bootApp()
    await loadAudio()
    $('fadein').value = '4'
    $('fadeout').value = '2'

    $('play-btn').click()

    const { setValueAtTime, linearRampToValueAtTime } = fadeNode().gain
    expect(setValueAtTime).toHaveBeenCalledWith(0, 0) // silent at the very first sample
    expect(linearRampToValueAtTime).toHaveBeenCalledWith(1, 4) // full after 4 s
    const last = linearRampToValueAtTime.mock.calls.at(-1)
    expect(last).toEqual([0, 12.5]) // silent at the end of the file
  })

  it('schedules the fades relative to the trimmed region', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '2'
    $('trim-end').value = '10'
    $('fadein').value = '1'

    $('play-btn').click()

    const { setValueAtTime, linearRampToValueAtTime } = fadeNode().gain
    expect(setValueAtTime).toHaveBeenCalledWith(0, 0)
    expect(linearRampToValueAtTime).toHaveBeenCalledWith(1, 1)
  })

  it('multiplies two overlapping fades instead of taking the smaller', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '0'
    $('trim-end').value = '1'
    $('fadein').value = '0.8'
    $('fadeout').value = '0.8'

    $('play-btn').click()

    const ramps = fadeNode().gain.linearRampToValueAtTime.mock.calls
    const atHalf = ramps.find(([, t]) => Math.abs(t - 0.5) < 1e-9)
    // 0.625 * 0.625: the backend applies one fade after the other.
    expect(atHalf[0]).toBeCloseTo(0.625 * 0.625, 5)
  })

  it('re-aims the fades when the speed changes during playback', async () => {
    await bootApp()
    await loadAudio()
    $('fadein').value = '4'
    $('play-btn').click()
    const { linearRampToValueAtTime } = fadeNode().gain
    linearRampToValueAtTime.mockClear()

    document.querySelector('.preset[data-v="2.0"]').click()

    // 4 s of audio now take 2 s of clock.
    expect(linearRampToValueAtTime).toHaveBeenCalledWith(1, 2)
  })

  it('picks up a changed fade slider while playing', async () => {
    await bootApp()
    await loadAudio()
    $('play-btn').click()
    fadeNode().gain.setValueAtTime.mockClear()

    $('fadein').value = '3'
    $('fadein').dispatchEvent(new Event('input'))

    expect(fadeNode().gain.cancelScheduledValues).toHaveBeenCalled()
    expect(fadeNode().gain.setValueAtTime).toHaveBeenCalled()
  })

  it('restarts from where it is when the trim end moves during playback', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '1'
    $('trim-end').value = '9'
    $('play-btn').click()
    const first = lastSource()

    $('trim-end').value = '5'
    $('trim-end').dispatchEvent(new Event('input'))

    expect(first.stop).toHaveBeenCalled()
    expect(lastSource()).not.toBe(first)
    expect(lastSource().start).toHaveBeenCalledWith(0, 1, 4)
  })
})

describe('main — preview settings', () => {
  it('aims at −1 dBFS, like the export, when normalising', async () => {
    await bootApp()
    await loadAudio()

    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))

    // The fixture waveform peaks at 0.9; the export targets 0.8912509.
    await vi.waitFor(() => expect(normalizeNode().gain.value).toBeCloseTo(0.8912509 / 0.9, 5))
  })

  it('measures the peak of the trimmed region only', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    // Buckets 0-89 (0 s – 1.25 s) only reach 0.9 at their 10th element: take a
    // stretch whose loudest bucket is 0.5.
    const duration = AUDIO_INFO.duration
    const bucket = (i) => (i / AUDIO_INFO.waveform.length) * duration
    $('trim-start').value = String(bucket(10) + 0.001)
    $('trim-end').value = String(bucket(15) - 0.001)

    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))

    const expectedPeak = Math.max(...AUDIO_INFO.waveform.slice(10, 15))
    await vi.waitFor(() =>
      expect(normalizeNode().gain.value).toBeCloseTo(0.8912509 / expectedPeak, 5),
    )
  })

  it('never walks over the raw samples of the decoded buffer on the UI thread', async () => {
    await bootApp()
    await loadAudio()

    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(normalizeNode().gain.value).not.toBe(1))

    expect(audio.lastBuffer.getChannelData).not.toHaveBeenCalled()
  })

  it('renders the region offline, fades and filter included, when it can', async () => {
    const rendered = {
      numberOfChannels: 1,
      getChannelData: () => new Float32Array([0, 0.4, -0.2]),
    }
    const offline = {
      createBufferSource: vi.fn(() => ({ connect: vi.fn(), start: vi.fn(), buffer: null })),
      createGain: vi.fn(() => ({
        connect: vi.fn(),
        gain: {
          setValueAtTime: vi.fn(),
          linearRampToValueAtTime: vi.fn(),
          cancelScheduledValues: vi.fn(),
        },
      })),
      createBiquadFilter: vi.fn(() => ({
        connect: vi.fn(),
        type: '',
        gain: { value: 0 },
        frequency: { value: 0 },
        Q: { value: 0 },
      })),
      destination: {},
      startRendering: vi.fn(() => Promise.resolve(rendered)),
    }
    const OfflineAudioContext = vi.fn(function () {
      return offline
    })
    vi.stubGlobal('OfflineAudioContext', OfflineAudioContext)
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '2'
    $('trim-end').value = '4'
    $('filter-type').value = 'lowpass'

    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))

    await vi.waitFor(() => expect(normalizeNode().gain.value).toBeCloseTo(0.8912509 / 0.4, 5))
    // Two seconds at the buffer's rate, one channel.
    expect(OfflineAudioContext).toHaveBeenCalledWith(1, 88200, 44100)
    // Four stages in series, as in the live chain; only the first is in use.
    expect(offline.createBiquadFilter).toHaveBeenCalledTimes(4)
    expect(offline.createBufferSource().start).toBeDefined()
  })

  it('falls back to a neutral gain when the offline render fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal(
      'OfflineAudioContext',
      vi.fn(function () {
        throw new Error('no offline')
      }),
    )
    await bootApp()
    await loadAudio()

    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))

    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    expect(normalizeNode().gain.value).toBe(1)
    warn.mockRestore()
  })

  it('re-measures, debounced, when the trim changes with normalise on', async () => {
    await bootApp()
    await loadAudio()
    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(normalizeNode().gain.value).not.toBe(1))
    vi.useFakeTimers()

    $('trim-enabled').checked = true
    $('trim-start').value = '0'
    $('trim-end').value = '0.1'
    $('trim-end').dispatchEvent(new Event('input'))
    $('trim-end').dispatchEvent(new Event('input'))
    const before = normalizeNode().gain.value
    await vi.advanceTimersByTimeAsync(200)
    vi.useRealTimers()

    expect(normalizeNode().gain.value).not.toBe(before)
  })

  it('goes back to a neutral gain without normalisation', async () => {
    await bootApp()
    await loadAudio()
    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))

    $('normalize').checked = false
    $('normalize').dispatchEvent(new Event('change'))

    expect(normalizeNode().gain.value).toBe(1)
  })

  it('leaves the filter transparent when no type is chosen', async () => {
    await bootApp()
    await loadAudio()

    // Every stage is an exact identity: a peaking filter with no gain.
    for (let i = 0; i < 4; i++) {
      expect(filterNode(i).type).toBe('peaking')
      expect(filterNode(i).gain.value).toBe(0)
    }
    expect($('filter-params').classList.contains('hidden')).toBe(true)
  })

  it('sets up a low-pass', async () => {
    await bootApp()
    await loadAudio()

    $('filter-type').value = 'lowpass'
    $('filter-type').dispatchEvent(new Event('change'))

    expect(filterNode().type).toBe('lowpass')
    expect(filterNode().frequency.value).toBe(1000)
    // Web Audio takes the Q of a low-pass in dB: 20·log10(1/√2).
    expect(filterNode().Q.value).toBeCloseTo(-3.0103, 3)
    expect($('filter-params').classList.contains('hidden')).toBe(false)
    expect($('filter-bw-row').style.display).toBe('none')
    expect($('filter-freq-label').textContent).toBe('Cutoff')
  })

  it('sets up a high-pass', async () => {
    await bootApp()
    await loadAudio()

    $('filter-type').value = 'highpass'
    $('filter-type').dispatchEvent(new Event('change'))

    expect(filterNode().type).toBe('highpass')
  })

  it('sets up a band-pass and reveals the bandwidth', async () => {
    await bootApp()
    await loadAudio()

    $('filter-type').value = 'bandpass'
    $('filter-type').dispatchEvent(new Event('change'))

    expect(filterNode().type).toBe('bandpass')
    expect(filterNode().Q.value).toBeCloseTo(2, 5) // 1000 Hz / 500 Hz
    expect($('filter-bw-row').style.display).toBe('flex')
    expect($('filter-freq-label').textContent).toBe('Centre')
  })

  it('follows changes of frequency and bandwidth', async () => {
    await bootApp()
    await loadAudio()
    $('filter-type').value = 'bandpass'
    $('filter-type').dispatchEvent(new Event('change'))

    $('filter-freq').value = '2000'
    $('filter-freq').dispatchEvent(new Event('input'))
    $('filter-bw').value = '250'
    $('filter-bw').dispatchEvent(new Event('input'))

    expect(filterNode().frequency.value).toBe(2000)
    expect(filterNode().Q.value).toBeCloseTo(8, 5)
  })

  it('caps the frequency at half the sample rate', async () => {
    await bootApp()
    await loadAudio()

    $('filter-type').value = 'lowpass'
    $('filter-freq').value = '99999'
    $('filter-type').dispatchEvent(new Event('change'))

    expect(filterNode().frequency.value).toBeLessThan(audio.ctx.sampleRate / 2)
  })
})

describe('main — slider labels', () => {
  it('shows the value of the fade in', async () => {
    await bootApp()

    $('fadein').value = '2.5'
    $('fadein').dispatchEvent(new Event('input'))

    expect($('fadein-val').textContent).toBe('2.5s')
  })

  it('shows the value of the fade out', async () => {
    await bootApp()

    $('fadeout').value = '1.2'
    $('fadeout').dispatchEvent(new Event('input'))

    expect($('fadeout-val').textContent).toBe('1.2s')
  })

  it('shows the speed and deselects the presets when off the grid', async () => {
    await bootApp()

    $('speed').value = '1.25'
    $('speed').dispatchEvent(new Event('input'))

    expect($('speed-val').textContent).toBe('1.25×')
    expect(document.querySelectorAll('.preset.active')).toHaveLength(0)
  })

  it('reselects the matching preset', async () => {
    await bootApp()

    $('speed').value = '2.0'
    $('speed').dispatchEvent(new Event('input'))

    expect(document.querySelector('.preset[data-v="2.0"]').classList.contains('active')).toBe(true)
  })
})

describe('main — trim handles', () => {
  const mouse = (type, clientX, target = $('waveform')) =>
    target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true, cancelable: true }))

  async function withTrim() {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '2'
    $('trim-end').value = '10'
    return $('waveform')
  }

  it('flags the handle under the cursor', async () => {
    const canvas = await withTrim()

    mouse('mousemove', xForTime(2))
    expect(canvas.classList.contains('cursor-resize')).toBe(true)

    mouse('mousemove', xForTime(6))
    expect(canvas.classList.contains('cursor-resize')).toBe(false)
  })

  it('clears the cursor when leaving the canvas', async () => {
    const canvas = await withTrim()
    mouse('mousemove', xForTime(2))

    canvas.dispatchEvent(new MouseEvent('mouseleave'))

    expect(canvas.classList.contains('cursor-resize')).toBe(false)
  })

  it('offers no handle when trim is off', async () => {
    await bootApp()
    await loadAudio()
    const canvas = $('waveform')

    mouse('mousemove', xForTime(0))

    expect(canvas.classList.contains('cursor-resize')).toBe(false)
  })

  it('moves the start handle', async () => {
    await withTrim()

    mouse('mousedown', xForTime(2))
    mouse('mousemove', xForTime(5), window)
    mouse('mouseup', 0, window)

    expect(parseFloat($('trim-start').value)).toBeCloseTo(5, 1)
    expect($('waveform').classList.contains('cursor-resize')).toBe(false)
  })

  it('moves the end handle', async () => {
    await withTrim()

    mouse('mousedown', xForTime(10))
    mouse('mousemove', xForTime(7), window)
    mouse('mouseup', 0, window)

    expect(parseFloat($('trim-end').value)).toBeCloseTo(7, 1)
  })

  it('keeps the handles from crossing', async () => {
    await withTrim()

    mouse('mousedown', xForTime(2))
    mouse('mousemove', xForTime(12), window) // past the end
    mouse('mouseup', 0, window)

    expect(parseFloat($('trim-start').value)).toBeCloseTo(9.9, 2)
  })

  it('ignores moves when no drag is under way', async () => {
    await withTrim()

    mouse('mousemove', xForTime(5), window)

    expect($('trim-start').value).toBe('2')
  })

  it('moves the playhead on a click away from the handles', async () => {
    await withTrim()

    mouse('mousedown', xForTime(6))

    expect($('time-current').textContent).toBe('0:06')
  })

  it('resumes playback at the new point when it was playing', async () => {
    await withTrim()
    $('play-btn').click()

    mouse('mousedown', xForTime(6))

    // Trim is on, so the end of the range comes along: 10 s − 6 s.
    expect(lastSource().start).toHaveBeenLastCalledWith(0, expect.closeTo(6, 1), expect.closeTo(4, 1))
    expect($('play-icon').innerHTML).toContain('rect')
  })
})

describe('main — audio setup failures', () => {
  it('still opens a file whose preview cannot be fetched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 403 })))
    await bootApp()

    await loadAudio('/home/me/hidden.wav')

    // The backend decoded it: the editor opens, only the preview is off.
    expect($('badge-name').textContent).toBe('hidden.wav')
    expect($('toast').className).toContain('warning')
    expect($('toast').textContent).toContain('Preview unavailable')
    expect($('play-btn').disabled).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('still opens a file the WebView cannot decode', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await bootApp()
    makeDecodeFail()

    await loadAudio('/home/me/song.m4a')

    expect($('editor').classList.contains('hidden')).toBe(false)
    expect($('play-btn').disabled).toBe(true)
    // The export does not depend on the preview.
    save.mockResolvedValue('/home/me/out.wav')
    $('export-btn').click()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ input: '/home/me/song.m4a' }),
      }),
    )
  })

  it('asks the backend to allow the file before fetching it', async () => {
    await bootApp()

    await loadAudio('/tmp/odd place/.hidden/song.wav')

    expect(invoke).toHaveBeenCalledWith('allow_asset', { path: '/tmp/odd place/.hidden/song.wav' })
    expect(fetch).toHaveBeenCalledWith('asset:///tmp/odd place/.hidden/song.wav')
    const allowed = invoke.mock.calls.findIndex(([cmd]) => cmd === 'allow_asset')
    expect(invoke.mock.invocationCallOrder[allowed]).toBeLessThan(fetch.mock.invocationCallOrder[0])
  })

  it('keeps the previous state when the new file fails to load', async () => {
    await bootApp()
    await loadAudio('/home/me/first.wav')
    invoke.mockImplementation((cmd) =>
      cmd === 'load_audio' ? Promise.reject(new Error('unsupported codec')) : Promise.resolve(undefined),
    )

    open.mockResolvedValue('/home/me/second.bin')
    $('open-btn-header').click()
    await vi.waitFor(() => expect($('toast').className).toContain('error'))

    expect($('badge-name').textContent).toBe('first.wav')
    save.mockResolvedValue('/home/me/out.wav')
    $('export-btn').click()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ input: '/home/me/first.wav' }),
      }),
    )
  })

  it('ignores a load overtaken by a newer one', async () => {
    await bootApp()
    const slow = deferred()
    invoke.mockImplementation((cmd, args) => {
      if (cmd !== 'load_audio') return Promise.resolve(undefined)
      return args.path.endsWith('slow.wav') ? slow.promise : Promise.resolve(AUDIO_INFO)
    })

    open.mockResolvedValue('/home/me/slow.wav')
    $('open-btn').click()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('load_audio', expect.objectContaining({ path: '/home/me/slow.wav' })),
    )
    await loadAudio('/home/me/fast.wav')
    slow.resolve({ ...AUDIO_INFO, duration: 99 })
    await new Promise((r) => setTimeout(r, 20))

    expect($('badge-name').textContent).toBe('fast.wav')
    expect($('time-total').textContent).toBe('0:12')
  })

  it('does not show the error of an overtaken load', async () => {
    await bootApp()
    const slow = deferred()
    invoke.mockImplementation((cmd, args) => {
      if (cmd !== 'load_audio') return Promise.resolve(undefined)
      return args.path.endsWith('slow.wav') ? slow.promise : Promise.resolve(AUDIO_INFO)
    })
    open.mockResolvedValue('/home/me/slow.wav')
    $('open-btn').click()
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('load_audio', expect.objectContaining({ path: '/home/me/slow.wav' })),
    )
    await loadAudio('/home/me/fast.wav')

    slow.reject(new Error('too late'))
    await new Promise((r) => setTimeout(r, 20))

    expect($('toast').textContent).not.toContain('too late')
  })

  it('resumes a suspended audio context', async () => {
    await bootApp()
    // The context only exists after the first load; the state is forced for the second.
    await loadAudio()
    audio.ctx.state = 'suspended'

    await loadAudio('/home/me/other.wav')

    expect(audio.ctx.resume).toHaveBeenCalled()
  })
})

describe('language', () => {
  it('starts in English until a choice has been made', async () => {
    await bootApp()

    expect($('open-btn').textContent).toBe('Open a file')
    expect(document.documentElement.lang).toBe('en')
  })

  it('reopens in the language saved at the previous launch', async () => {
    localStorage.setItem('lcs-lang', 'fr')

    await bootApp()

    expect($('open-btn').textContent).toBe('Ouvrir un fichier')
    expect(document.documentElement.lang).toBe('fr')
  })

  it('translates the whole window again from the menu, without a restart', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('open-btn').textContent).toBe('Ouvrir un fichier')
    expect(document.querySelector('.player-hint').textContent).toBe(
      'Glisse les poignées pour trimmer',
    )
  })

  it('remembers the choice for the next launch', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect(localStorage.getItem('lcs-lang')).toBe('fr')
  })

  it('has the system translate the menu bar again', async () => {
    await bootApp()
    invoke.mockClear()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect(invoke).toHaveBeenCalledWith('set_menu_language', { lang: 'fr' })
  })

  it('announces the saved language at startup, so the menu is born in the right one', async () => {
    localStorage.setItem('lcs-lang', 'fr')

    await bootApp()

    expect(invoke).toHaveBeenCalledWith('set_menu_language', { lang: 'fr' })
  })

  it('translates the tooltips too', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('play-btn').title).toBe('Espace pour lire/mettre en pause')
  })

  it('keeps the frequency label in the current language when it changes', async () => {
    await bootApp()
    $('filter-type').value = 'bandpass'
    $('filter-type').dispatchEvent(new Event('change'))
    expect($('filter-freq-label').textContent).toBe('Centre')

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('filter-freq-label').textContent).toBe('Centre')
  })

  it('translates messages, not only the fixed labels', async () => {
    await bootApp()
    await menuHandlers['menu-set-language']({ payload: 'fr' })
    invoke.mockImplementation((cmd) =>
      cmd === 'load_audio' ? Promise.reject('boom') : Promise.resolve(undefined),
    )

    open.mockResolvedValue('/home/me/song.wav')
    $('open-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toBe('Erreur : boom'))
  })
})

describe('menu — File', () => {
  it('opens a file from the menu', async () => {
    await bootApp()
    open.mockResolvedValue('/home/me/song.wav')

    await menuHandlers['menu-open']()

    await vi.waitFor(() => expect($('editor').classList.contains('hidden')).toBe(false))
  })
})

describe('menu — About', () => {
  it('shows the version received from the menu', async () => {
    await bootApp()

    menuHandlers['menu-about']({ payload: '0.1.10' })

    expect(document.querySelector('.about-version').textContent).toBe('Version 0.1.10')
  })

  it('speaks the current language', async () => {
    await bootApp()
    await menuHandlers['menu-set-language']({ payload: 'fr' })

    menuHandlers['menu-about']({ payload: '0.1.10' })

    expect(document.querySelector('.about-title').textContent).toBe(
      'À propos de LightCutSoundz',
    )
  })

  it('closes with its button', async () => {
    await bootApp()
    menuHandlers['menu-about']({ payload: '0.1.10' })

    document.querySelector('.about-card button').click()

    expect(document.getElementById('about-dialog')).toBeNull()
  })

  it('closes with Escape', async () => {
    await bootApp()
    menuHandlers['menu-about']({ payload: '0.1.10' })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.getElementById('about-dialog')).toBeNull()
  })

  it('does not pile up when reopened', async () => {
    await bootApp()

    menuHandlers['menu-about']({ payload: '0.1.10' })
    menuHandlers['menu-about']({ payload: '0.1.10' })

    expect(document.querySelectorAll('.about-card')).toHaveLength(1)
  })
})

describe('menu — update', () => {
  it('says everything is up to date when there is nothing to install', async () => {
    await bootApp()
    check.mockResolvedValue(null)

    await menuHandlers['menu-check-updates']()

    await vi.waitFor(() =>
      expect($('toast').textContent).toBe('LightCutSoundz is up to date'),
    )
  })

  it('offers the update without installing anything', async () => {
    await bootApp()
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    check.mockResolvedValue({ version: '0.2.0', downloadAndInstall })

    await menuHandlers['menu-check-updates']()

    await vi.waitFor(() => expect($('update-install')).not.toBeNull())
    expect($('update-banner').textContent).toContain('Version 0.2.0 is available')
    expect(downloadAndInstall).not.toHaveBeenCalled()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('installs and restarts only once confirmed', async () => {
    await bootApp()
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    check.mockResolvedValue({ version: '0.2.0', downloadAndInstall })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-install')).not.toBeNull())

    $('update-install').click()

    await vi.waitFor(() => expect(relaunch).toHaveBeenCalled())
    expect(downloadAndInstall).toHaveBeenCalled()
    expect($('update-banner').textContent).toContain('restarting')
  })

  it('“Later” removes the banner without downloading anything', async () => {
    await bootApp()
    const downloadAndInstall = vi.fn()
    check.mockResolvedValue({ version: '0.2.0', downloadAndInstall })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-later')).not.toBeNull())

    $('update-later').click()

    expect($('update-banner')).toBeNull()
    expect(downloadAndInstall).not.toHaveBeenCalled()
  })

  it('shows the download progress', async () => {
    await bootApp()
    let report
    const done = deferred()
    const downloadAndInstall = vi.fn((cb) => {
      report = cb
      return done.promise
    })
    check.mockResolvedValue({ version: '0.2.0', downloadAndInstall })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-install')).not.toBeNull())
    $('update-install').click()

    report({ event: 'Started', data: { contentLength: 200 } })
    report({ event: 'Progress', data: { chunkLength: 50 } })
    expect($('update-banner').textContent).toContain('25%')
    report({ event: 'Progress', data: { chunkLength: 150 } })
    expect($('update-banner').textContent).toContain('100%')
    report({ event: 'Finished' })
    done.resolve()
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalled())
  })

  it('does not need the total size to make progress', async () => {
    await bootApp()
    let report
    const done = deferred()
    check.mockResolvedValue({
      version: '0.2.0',
      downloadAndInstall: vi.fn((cb) => {
        report = cb
        return done.promise
      }),
    })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-install')).not.toBeNull())
    $('update-install').click()

    report({ event: 'Started', data: {} })
    report({ event: 'Progress', data: { chunkLength: 50 } })

    expect($('update-banner').textContent).toContain('0%')
    done.resolve()
  })

  it('never restarts during an export, and waits for it to finish', async () => {
    await bootApp()
    await loadAudio()
    save.mockResolvedValue('/home/me/out.wav')
    const exporting = deferred()
    invoke.mockImplementation((cmd) => {
      if (cmd === 'process_audio') return exporting.promise
      return cmd === 'load_audio' ? Promise.resolve(AUDIO_INFO) : Promise.resolve(undefined)
    })
    $('export-btn').click()
    await vi.waitFor(() => expect($('export-btn').classList.contains('processing')).toBe(true))
    check.mockResolvedValue({ version: '0.2.0', downloadAndInstall: vi.fn().mockResolvedValue(undefined) })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-install')).not.toBeNull())

    $('update-install').click()
    await vi.waitFor(() => expect($('update-banner').textContent).toContain('once the export is done'))
    expect(relaunch).not.toHaveBeenCalled()

    exporting.resolve()
    await vi.waitFor(() => expect(relaunch).toHaveBeenCalled())
  })

  it('removes the banner and reports the error when the install fails', async () => {
    await bootApp()
    check.mockResolvedValue({
      version: '0.2.0',
      downloadAndInstall: vi.fn().mockRejectedValue(new Error('disk full')),
    })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-install')).not.toBeNull())

    $('update-install').click()

    await vi.waitFor(() => expect($('toast').textContent).toContain('disk full'))
    expect($('update-banner')).toBeNull()
    expect(relaunch).not.toHaveBeenCalled()
  })

  it('does not run two checks at the same time', async () => {
    await bootApp()
    check.mockClear()
    const pending = deferred()
    check.mockReturnValue(pending.promise)

    const first = menuHandlers['menu-check-updates']()
    const second = menuHandlers['menu-check-updates']()
    pending.resolve(null)
    await Promise.all([first, second])

    expect(check).toHaveBeenCalledTimes(1)
  })

  it('translates the banner when the language changes', async () => {
    await bootApp()
    check.mockResolvedValue({ version: '0.2.0', downloadAndInstall: vi.fn() })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-install')).not.toBeNull())

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('update-banner').textContent).toContain('La version 0.2.0 est disponible')
    expect($('update-install').textContent).toBe('Installer et redémarrer')
  })

  it('reports the failure when the check comes from the menu', async () => {
    await bootApp()
    check.mockRejectedValue('no network')

    await menuHandlers['menu-check-updates']()

    await vi.waitFor(() =>
      expect($('toast').textContent).toBe('Update check failed: no network'),
    )
  })

  it('stays silent when the check at startup fails', async () => {
    check.mockRejectedValue('no network')

    await bootApp()

    expect($('toast').classList.contains('hidden')).toBe(true)
  })
})

describe('main — export settings and validation', () => {
  const type = (id, value) => {
    $(id).value = value
    $(id).dispatchEvent(new Event('input'))
  }

  it('suggests <name>-edit.<ext> next to the source file', async () => {
    await bootApp()
    await loadAudio('/home/me/music/song.mp3')
    $('export-btn').click()
    await vi.waitFor(() => expect(save).toHaveBeenCalled())

    expect(save.mock.calls[0][0].defaultPath).toBe('/home/me/music/song-edit.wav')
  })

  it("suggests the extension of the chosen format", async () => {
    await bootApp()
    await loadAudio('/home/me/song.wav')
    document.querySelector('.fmt[data-fmt="m4a"]').click()
    $('export-btn').click()
    await vi.waitFor(() => expect(save).toHaveBeenCalled())

    expect(save.mock.calls[0][0].defaultPath).toBe('/home/me/song-edit.m4a')
    expect(save.mock.calls[0][0].ext).toBe('m4a')
  })

  it('exports to exactly the path the backend dialog returned', async () => {
    // The backend adds the extension of the chosen format before it approves
    // the destination, so the front end must not touch the name afterwards.
    await bootApp()
    await loadAudio()
    document.querySelector('.fmt[data-fmt="mp3"]').click()
    save.mockResolvedValue('/home/me/chanson.mp3')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ output: '/home/me/chanson.mp3', format: 'mp3' }),
      }),
    )
  })

  it('asks the dialog for the extension of the chosen format', async () => {
    await bootApp()
    await loadAudio()
    document.querySelector('.fmt[data-fmt="flac"]').click()

    $('export-btn').click()
    await vi.waitFor(() => expect(save).toHaveBeenCalled())

    expect(save.mock.calls[0][0]).toEqual({
      defaultPath: '/home/me/song-edit.flac',
      ext: 'flac',
    })
  })

  it('reports a failing save dialog instead of doing nothing', async () => {
    await bootApp()
    await loadAudio()
    save.mockRejectedValue({ code: 'generic', params: {}, message: 'no display' })

    $('export-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toBe('Error: no display'))
    expect(invoke).not.toHaveBeenCalledWith('process_audio', expect.anything())
    expect($('export-btn').disabled).toBe(false)
  })

  it('refuses a trim range that is not a range, and says which field', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-enabled').dispatchEvent(new Event('change'))

    type('trim-start', '8')
    type('trim-end', '8')

    expect($('export-btn').disabled).toBe(true)
    expect($('export-hint').textContent).toContain('Invalid trim range')
    expect($('trim-end').getAttribute('aria-invalid')).toBe('true')
  })

  it('clears the complaint once the value is fixed', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    type('trim-start', '8')
    type('trim-end', '8')

    type('trim-end', '10')

    expect($('export-btn').disabled).toBe(false)
    expect($('export-hint').textContent).toBe('')
    expect(document.querySelector('[aria-invalid]')).toBeNull()
  })

  it('refuses a fade longer than the audio kept', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    type('trim-start', '0')
    type('trim-end', '1')

    type('fadein', '5')

    expect($('export-btn').disabled).toBe(true)
    expect($('export-hint').textContent).toContain('fade in')
    expect($('fadein').getAttribute('aria-invalid')).toBe('true')
  })

  it('refuses a filter frequency past half the file sample rate', async () => {
    await bootApp()
    await loadAudio()
    $('filter-type').value = 'lowpass'
    $('filter-type').dispatchEvent(new Event('change'))

    type('filter-freq', '30000')

    expect($('export-btn').disabled).toBe(true)
    expect($('export-hint').textContent).toContain('30000')
    expect($('export-hint').textContent).toContain('22050')
  })

  it('refuses an emptied filter field instead of sending "lowpass:"', async () => {
    await bootApp()
    await loadAudio()
    $('filter-type').value = 'lowpass'
    $('filter-type').dispatchEvent(new Event('change'))

    type('filter-freq', '')

    expect($('export-btn').disabled).toBe(true)
    expect($('filter-freq').getAttribute('aria-invalid')).toBe('true')
  })

  it('refuses a band-pass without a usable bandwidth', async () => {
    await bootApp()
    await loadAudio()
    $('filter-type').value = 'bandpass'
    $('filter-type').dispatchEvent(new Event('change'))

    type('filter-bw', '0')

    expect($('export-btn').disabled).toBe(true)
    expect($('filter-bw').getAttribute('aria-invalid')).toBe('true')
  })

  it('says it in French when the interface is French', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    type('trim-start', '8')
    type('trim-end', '8')

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('export-hint').textContent).toContain('Plage de trim invalide')
  })

  it('does not nag about settings that are switched off', async () => {
    await bootApp()
    await loadAudio()
    type('trim-start', '8')
    type('trim-end', '2') // trim is off: the fields are ignored

    expect($('export-btn').disabled).toBe(false)
  })

  it('sends numbers, not field text, for the filter', async () => {
    await bootApp()
    await loadAudio()
    $('filter-type').value = 'bandpass'
    $('filter-type').dispatchEvent(new Event('change'))
    type('filter-freq', '2000')
    type('filter-bw', '250')
    save.mockResolvedValue('/home/me/out.wav')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ filters: ['bandpass:2000:250'] }),
      }),
    )
  })
})

describe('main — export feedback', () => {
  async function startExport() {
    await bootApp()
    await loadAudio()
    save.mockResolvedValue('/home/me/out.wav')
    const running = deferred()
    invoke.mockImplementation((cmd) => {
      if (cmd === 'process_audio') return running.promise
      return cmd === 'load_audio' ? Promise.resolve(AUDIO_INFO) : Promise.resolve(undefined)
    })
    $('export-btn').click()
    await vi.waitFor(() => expect($('export-btn').classList.contains('processing')).toBe(true))
    return running
  }

  it('shows the progress sent by the backend', async () => {
    const running = await startExport()

    menuHandlers['export-progress']({ payload: 42 })

    expect($('export-label').textContent).toBe('Processing… 42%')
    running.resolve()
  })

  it('ignores progress events when nothing is exporting', async () => {
    await bootApp()
    await loadAudio()

    menuHandlers['export-progress']({ payload: 42 })

    expect($('export-label').textContent).toBe('Export')
  })

  it('offers to cancel, only while exporting', async () => {
    await bootApp()
    await loadAudio()
    expect($('cancel-btn').classList.contains('hidden')).toBe(true)

    const running = await startExport()
    expect($('cancel-btn').classList.contains('hidden')).toBe(false)

    running.resolve()
    await vi.waitFor(() => expect($('cancel-btn').classList.contains('hidden')).toBe(true))
  })

  it('tells the backend to stop when cancelled', async () => {
    const running = await startExport()

    $('cancel-btn').click()

    expect(invoke).toHaveBeenCalledWith('cancel_export')
    expect($('cancel-btn').disabled).toBe(true)
    running.reject({ code: 'cancelled', params: {}, message: 'Export cancelled' })
    await vi.waitFor(() => expect($('toast').textContent).toBe('Export cancelled'))
    expect($('toast').className).toContain('warning')
    expect($('export-btn').disabled).toBe(false)
  })

  it('puts the label back, in the current language, when done', async () => {
    const running = await startExport()
    await menuHandlers['menu-set-language']({ payload: 'fr' })

    running.resolve()
    await vi.waitFor(() => expect($('export-btn').classList.contains('processing')).toBe(false))

    expect($('export-label').textContent).toBe('Exporter')
  })

  it('translates a structured backend error', async () => {
    await bootApp()
    await loadAudio()
    save.mockResolvedValue('/home/me/out.wav')
    invoke.mockImplementation((cmd) =>
      cmd === 'process_audio'
        ? Promise.reject({
            code: 'fade_too_long',
            params: { which: 'out', secs: '3.00' },
            message: 'Fade out duration (3.00s) exceeds audio length',
          })
        : Promise.resolve(AUDIO_INFO),
    )

    $('export-btn').click()

    await vi.waitFor(() =>
      expect($('toast').textContent).toBe('Error: The fade out (3.00 s) is longer than the audio kept'),
    )
  })

  it('translates it into French too', async () => {
    await bootApp()
    await menuHandlers['menu-set-language']({ payload: 'fr' })
    await loadAudio()
    save.mockResolvedValue('/home/me/out.wav')
    invoke.mockImplementation((cmd) =>
      cmd === 'process_audio'
        ? Promise.reject({ code: 'ffmpeg_missing', params: {}, message: 'ffmpeg not found' })
        : Promise.resolve(AUDIO_INFO),
    )

    $('export-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toContain('ffmpeg est introuvable'))
  })

  it('shows the raw message of an error it has no wording for', async () => {
    await bootApp()
    await loadAudio()
    save.mockResolvedValue('/home/me/out.wav')
    invoke.mockImplementation((cmd) =>
      cmd === 'process_audio'
        ? Promise.reject({ code: 'generic', params: {}, message: 'Channel count changed mid-stream' })
        : Promise.resolve(AUDIO_INFO),
    )

    $('export-btn').click()

    await vi.waitFor(() =>
      expect($('toast').textContent).toBe('Error: Channel count changed mid-stream'),
    )
  })

  it('does not double the "Error:" prefix of a JS error', async () => {
    await bootApp()
    await loadAudio()
    save.mockResolvedValue('/home/me/out.wav')
    invoke.mockImplementation((cmd) =>
      cmd === 'process_audio' ? Promise.reject(new Error('boom')) : Promise.resolve(AUDIO_INFO),
    )

    $('export-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toBe('Error: boom'))
  })
})

describe('main — keyboard', () => {
  const press = (target, init) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

  it('plays with the space bar even when a button has the focus', async () => {
    await bootApp()
    await loadAudio()
    const preset = document.querySelector('.preset[data-v="2.0"]')
    preset.focus()

    const event = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true })
    preset.dispatchEvent(event)

    expect($('play-icon').innerHTML).toContain('rect')
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not let the key release click the focused button', async () => {
    await bootApp()
    const button = document.querySelector('.fmt')
    const event = new KeyboardEvent('keyup', { code: 'Space', bubbles: true, cancelable: true })

    button.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('lets a checkbox keep the space bar', async () => {
    await bootApp()
    await loadAudio()

    press($('normalize'), { code: 'Space' })

    expect($('play-icon').innerHTML).toContain('polygon')
  })

  it('lets a select keep the space bar', async () => {
    await bootApp()
    await loadAudio()

    press($('filter-type'), { code: 'Space' })

    expect($('play-icon').innerHTML).toContain('polygon')
  })

  it('uses the space bar from a slider, which has no use for it', async () => {
    await bootApp()
    await loadAudio()

    press($('speed'), { code: 'Space' })

    expect($('play-icon').innerHTML).toContain('rect')
  })

  it('leaves the space bar alone while the About box is open', async () => {
    await bootApp()
    await loadAudio()
    menuHandlers['menu-about']({ payload: '1.0.0' })

    press(document.querySelector('.about-card button'), { code: 'Space' })

    expect($('play-icon').innerHTML).toContain('polygon')
  })

  it('seeks with the arrow keys on the waveform', async () => {
    await bootApp()
    await loadAudio()
    const canvas = $('waveform')

    press(canvas, { key: 'ArrowRight' })
    press(canvas, { key: 'ArrowRight' })
    expect($('time-current').textContent).toBe('0:02')

    press(canvas, { key: 'ArrowLeft' })
    expect($('time-current').textContent).toBe('0:01')

    press(canvas, { key: 'ArrowRight', shiftKey: true })
    expect($('time-current').textContent).toBe('0:06')
  })

  it('sets the trim start at the playhead with I, enabling trim', async () => {
    await bootApp()
    await loadAudio()
    press($('waveform'), { key: 'ArrowRight', shiftKey: true }) // 5 s

    press($('waveform'), { key: 'i' })

    expect($('trim-enabled').checked).toBe(true)
    expect($('trim-start').value).toBe('5.00')
  })

  it('sets the trim end at the playhead with O', async () => {
    await bootApp()
    await loadAudio()
    for (let i = 0; i < 2; i++) press($('waveform'), { key: 'ArrowRight', shiftKey: true }) // 10 s

    press($('waveform'), { key: 'o' })

    expect($('trim-enabled').checked).toBe(true)
    expect($('trim-end').value).toBe('10.00')
  })

  it('keeps the trim ends apart and inside the file', async () => {
    await bootApp()
    await loadAudio()
    press($('waveform'), { key: 'o' }) // playhead at 0: end cannot sit on the start
    expect($('trim-end').value).toBe('0.10')

    for (let i = 0; i < 4; i++) press($('waveform'), { key: 'ArrowRight', shiftKey: true }) // 12.5 s (the end)
    press($('waveform'), { key: 'i' })
    expect(parseFloat($('trim-start').value)).toBeLessThanOrEqual(0.1 + 1e-9 + parseFloat($('trim-end').value))
    press($('waveform'), { key: 'o' })
    expect(parseFloat($('trim-end').value)).toBeLessThanOrEqual(12.5)
  })

  it('redraws and re-validates after a keyboard trim', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.arcTo.mockClear()

    press($('waveform'), { key: 'i' })

    expect(ctx2d.arcTo).toHaveBeenCalled() // the handles are drawn
    expect($('export-btn').disabled).toBe(false)
  })

  it('ignores other keys on the waveform', async () => {
    await bootApp()
    await loadAudio()

    press($('waveform'), { key: 'a' })

    expect($('time-current').textContent).toBe('0:00')
  })

  it('does not seek past the ends', async () => {
    await bootApp()
    await loadAudio()

    press($('waveform'), { key: 'ArrowLeft' })
    expect($('time-current').textContent).toBe('0:00')
    for (let i = 0; i < 4; i++) press($('waveform'), { key: 'ArrowRight', shiftKey: true })
    expect($('time-current').textContent).toBe('0:12')
  })
})

describe('main — accessibility and markup', () => {
  it('keeps the pressed state of the format tabs and the speed presets', async () => {
    await bootApp()
    const [wav, mp3] = document.querySelectorAll('.fmt')
    expect(wav.getAttribute('aria-pressed')).toBe('true')

    mp3.click()

    expect(wav.getAttribute('aria-pressed')).toBe('false')
    expect(mp3.getAttribute('aria-pressed')).toBe('true')

    document.querySelector('.preset[data-v="2.0"]').click()
    expect(document.querySelector('.preset[data-v="2.0"]').getAttribute('aria-pressed')).toBe('true')
    expect(document.querySelector('.preset[data-v="1.0"]').getAttribute('aria-pressed')).toBe('false')
  })

  it('labels the controls that have no visible text', async () => {
    await bootApp()

    expect($('play-btn').getAttribute('aria-label')).toBe('Space to play/pause')
    expect($('trim-enabled').getAttribute('aria-label')).toBe('Enable trim')
    expect($('waveform').getAttribute('aria-label')).toContain('Waveform')
  })

  it('relabels them in French', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('trim-enabled').getAttribute('aria-label')).toBe('Activer le trim')
  })

  it('ties every label to its field', async () => {
    await bootApp()
    for (const label of document.querySelectorAll('label[for]')) {
      expect(document.getElementById(label.htmlFor), label.htmlFor).not.toBeNull()
    }
  })

  it('translates the filter types', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    const names = [...$('filter-type').options].map((o) => o.textContent)
    expect(names).toEqual(['Aucun', 'Passe-bas', 'Passe-haut', 'Passe-bande'])
  })

  it('starts in English everywhere, with no French left in the markup', async () => {
    document.body.innerHTML = APP_MARKUP
    const visible = document.body.textContent
    for (const word of ['Ouvrir', 'Début', 'Vitesse', 'Fréquence', 'Largeur', 'Aucun', 'Dépose']) {
      expect(visible).not.toContain(word)
    }
  })

  it('offers M4A as an export format', async () => {
    await bootApp()
    expect([...document.querySelectorAll('.fmt')].map((b) => b.dataset.fmt)).toContain('m4a')
  })

  it('localises the file badge', async () => {
    await bootApp()
    await loadAudio()
    expect($('badge-meta').textContent).toBe('2ch · 44100Hz · 0:12')

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('badge-meta').textContent).toBe('2 can. · 44100 Hz · 0:12')
  })

  it('opens files through the backend picker, not a picker of its own', async () => {
    await bootApp()
    open.mockResolvedValue(null)

    $('open-btn').click()
    await Promise.resolve()

    expect(open).toHaveBeenCalledTimes(1)
    // No file was chosen: nothing is loaded.
    expect(invoke).not.toHaveBeenCalledWith('load_audio', expect.anything())
  })

  it('reports a failing file picker', async () => {
    await bootApp()
    open.mockRejectedValue({ code: 'generic', params: {}, message: 'no display' })

    $('open-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toBe('Error: no display'))
    expect($('editor').classList.contains('hidden')).toBe(true)
  })

  it('translates the refusal of a path nobody chose', async () => {
    await bootApp()
    invoke.mockImplementation((cmd) =>
      cmd === 'load_audio'
        ? Promise.reject({ code: 'path_not_approved', params: { path: '/etc/passwd' }, message: 'x' })
        : Promise.resolve(undefined),
    )
    open.mockResolvedValue('/etc/passwd')

    $('open-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toContain('/etc/passwd'))
    expect($('toast').textContent).toContain('file picker')
  })
})

describe('main — About dialog', () => {
  it('does not leak a key listener each time it is opened and closed', async () => {
    await bootApp()
    const add = vi.spyOn(document, 'addEventListener')
    const remove = vi.spyOn(document, 'removeEventListener')

    for (let i = 0; i < 3; i++) {
      menuHandlers['menu-about']({ payload: '1.0.0' })
      document.querySelector('.about-card button').click()
    }

    const keydown = (spy) => spy.mock.calls.filter(([type]) => type === 'keydown').length
    expect(keydown(add)).toBe(3)
    expect(keydown(remove)).toBe(3)
    add.mockRestore()
    remove.mockRestore()
  })

  it('removes the previous key listener when it is reopened', async () => {
    await bootApp()
    const remove = vi.spyOn(document, 'removeEventListener')

    menuHandlers['menu-about']({ payload: '1.0.0' })
    menuHandlers['menu-about']({ payload: '1.0.0' })

    expect(remove.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
    remove.mockRestore()
  })

  it('closes when the backdrop is clicked', async () => {
    await bootApp()
    menuHandlers['menu-about']({ payload: '1.0.0' })

    $('about-dialog').click()

    expect($('about-dialog')).toBeNull()
  })

  it('keeps the focus inside while open', async () => {
    await bootApp()
    menuHandlers['menu-about']({ payload: '1.0.0' })
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })

    document.dispatchEvent(tab)

    expect(tab.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(document.querySelector('.about-card button'))
  })

  it('gives the focus back to where it was', async () => {
    await bootApp()
    $('open-btn').focus()

    menuHandlers['menu-about']({ payload: '1.0.0' })
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.activeElement).toBe($('open-btn'))
  })

  it('credits the bundled encoders and says where their licences are', async () => {
    await bootApp()

    menuHandlers['menu-about']({ payload: '1.0.0' })

    expect(document.querySelector('.about-licenses').textContent).toContain('FFmpeg (LGPL)')
    expect(document.querySelector('.about-licenses').textContent).toContain('THIRD_PARTY_LICENSES.md')
  })

  it('names itself for assistive technology', async () => {
    await bootApp()
    menuHandlers['menu-about']({ payload: '1.0.0' })

    const dialog = document.querySelector('[role="dialog"]')
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')).textContent).toBe(
      'About LightCutSoundz',
    )
  })
})

describe('main — opening from outside', () => {
  it('opens the file the app was launched with', async () => {
    invoke.mockImplementation((cmd) => {
      if (cmd === 'take_pending_file') return Promise.resolve('/home/me/launched.mp3')
      return cmd === 'load_audio' ? Promise.resolve(AUDIO_INFO) : Promise.resolve(undefined)
    })

    await bootApp()

    await vi.waitFor(() => expect($('badge-name').textContent).toBe('launched.mp3'))
  })

  it('starts empty when it was launched with no file', async () => {
    await bootApp()
    await Promise.resolve()

    expect($('editor').classList.contains('hidden')).toBe(true)
  })

  it('opens a file handed over by a second launch', async () => {
    await bootApp()

    menuHandlers['open-file']({ payload: '/home/me/second.flac' })

    await vi.waitFor(() => expect($('badge-name').textContent).toBe('second.flac'))
  })
})

describe('main — fading and filter edge cases', () => {
  it('clears the trim handles and the shading when trim is switched off again', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-enabled').dispatchEvent(new Event('change'))
    ctx2d.arcTo.mockClear()

    $('trim-enabled').checked = false
    $('trim-enabled').dispatchEvent(new Event('change'))

    expect(ctx2d.arcTo).not.toHaveBeenCalled()
  })

  it('redraws the bars only when something that changes them did', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.fillRect.mockClear()

    // Playhead movement alone must not redraw the 900 bars.
    $('play-btn').click()
    audio.ctx.currentTime = 1
    runFrame()
    runFrame()

    expect(ctx2d.fillRect).not.toHaveBeenCalled()
    expect(ctx2d.drawImage).toHaveBeenCalled()
  })

  it('redraws the bars when the trim changes', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.fillRect.mockClear()

    $('trim-enabled').checked = true
    $('trim-start').value = '3'
    $('trim-enabled').dispatchEvent(new Event('change'))

    expect(ctx2d.fillRect).toHaveBeenCalled()
  })

  it('does not resize the canvas bitmap on every frame', async () => {
    await bootApp()
    await loadAudio()
    const canvas = $('waveform')
    const widthSet = vi.fn()
    let width = canvas.width
    Object.defineProperty(canvas, 'width', {
      configurable: true,
      get: () => width,
      set: (v) => { width = v; widthSet(v) },
    })

    $('play-btn').click()
    runFrame()
    runFrame()
    runFrame()

    expect(widthSet).not.toHaveBeenCalled()
  })
})

describe('main — fade curve', () => {
  it('offers linear and equal-power, linear first', async () => {
    await bootApp()
    expect([...$('fade-curve').options].map((o) => o.value)).toEqual(['linear', 'equal-power'])
    expect($('fade-curve').value).toBe('linear')
  })

  it('translates the curve names', async () => {
    await bootApp()
    await menuHandlers['menu-set-language']({ payload: 'fr' })
    expect([...$('fade-curve').options].map((o) => o.textContent)).toEqual(['Linéaire', 'Puissance égale'])
  })

  it('sends the chosen curve to the backend', async () => {
    await bootApp()
    await loadAudio()
    $('fade-curve').value = 'equal-power'
    $('fade-curve').dispatchEvent(new Event('change'))
    save.mockResolvedValue('/home/me/out.wav')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ fade_curve: 'equal-power' }),
      }),
    )
  })

  it('previews the curve it will export', async () => {
    await bootApp()
    await loadAudio()
    $('fadein').value = '4'
    $('fade-curve').value = 'equal-power'
    $('fade-curve').dispatchEvent(new Event('change'))

    $('play-btn').click()

    const ramps = fadeNode().gain.linearRampToValueAtTime.mock.calls
    // Halfway through a 4 s fade-in the gain is sin(π/4), not 0.5.
    const half = ramps.find(([, t]) => Math.abs(t - 2) < 1e-9)
    expect(half[0]).toBeCloseTo(Math.SQRT1_2, 5)
  })

  it('reschedules the fades when the curve changes during playback', async () => {
    await bootApp()
    await loadAudio()
    $('fadein').value = '4'
    $('play-btn').click()
    fadeNode().gain.cancelScheduledValues.mockClear()

    $('fade-curve').value = 'equal-power'
    $('fade-curve').dispatchEvent(new Event('change'))

    expect(fadeNode().gain.cancelScheduledValues).toHaveBeenCalled()
  })
})

describe('main — filter slope and Q', () => {
  const choose = (type) => {
    $('filter-type').value = type
    $('filter-type').dispatchEvent(new Event('change'))
  }
  const slope = (value) => {
    $('filter-slope').value = value
    $('filter-slope').dispatchEvent(new Event('change'))
  }

  it('shows slope and Q for a low-pass, not the bandwidth', async () => {
    await bootApp()
    choose('lowpass')

    expect($('filter-slope-row').style.display).toBe('flex')
    expect($('filter-q-row').style.display).toBe('flex')
    expect($('filter-bw-row').style.display).toBe('none')
  })

  it('shows the bandwidth, not slope and Q, for a band-pass', async () => {
    await bootApp()
    choose('bandpass')

    expect($('filter-slope-row').style.display).toBe('none')
    expect($('filter-q-row').style.display).toBe('none')
    expect($('filter-bw-row').style.display).toBe('flex')
  })

  it('lets Q be set only on a single 12 dB/octave stage', async () => {
    await bootApp()
    choose('lowpass')
    expect($('filter-q').disabled).toBe(false)

    slope('24')
    expect($('filter-q').disabled).toBe(true)

    slope('12')
    expect($('filter-q').disabled).toBe(false)
  })

  it('uses as many preview stages as the slope has', async () => {
    await bootApp()
    await loadAudio()
    choose('lowpass')

    for (const [value, used] of [['12', 1], ['24', 2], ['36', 3], ['48', 4]]) {
      slope(value)
      for (let i = 0; i < 4; i++) {
        expect(filterNode(i).type, `${value} dB: stage ${i}`).toBe(i < used ? 'lowpass' : 'peaking')
      }
    }
  })

  it('gives each stage of a cascade its Butterworth Q, in dB', async () => {
    await bootApp()
    await loadAudio()
    choose('highpass')

    slope('24')

    expect(filterNode(0).type).toBe('highpass')
    expect(filterNode(0).Q.value).toBeCloseTo(20 * Math.log10(0.541196), 3)
    expect(filterNode(1).Q.value).toBeCloseTo(20 * Math.log10(1.306563), 3)
    expect(filterNode(0).frequency.value).toBe(1000)
    expect(filterNode(1).frequency.value).toBe(1000)
  })

  it('applies a custom Q to the single stage, in dB', async () => {
    await bootApp()
    await loadAudio()
    choose('lowpass')

    $('filter-q').value = '4'
    $('filter-q').dispatchEvent(new Event('input'))

    expect(filterNode(0).Q.value).toBeCloseTo(20 * Math.log10(4), 3)
  })

  it('treats the rounded default Q as the default', async () => {
    await bootApp()
    await loadAudio()
    choose('lowpass')

    expect(filterNode(0).Q.value).toBeCloseTo(-3.0103, 3)
  })

  it('keeps the band-pass Q linear', async () => {
    await bootApp()
    await loadAudio()
    choose('bandpass')

    expect(filterNode(0).Q.value).toBeCloseTo(2, 5)
    expect(filterNode(1).type).toBe('peaking')
  })

  it('switches back to transparent stages when the filter is removed', async () => {
    await bootApp()
    await loadAudio()
    choose('lowpass')
    slope('48')

    choose('')

    for (let i = 0; i < 4; i++) expect(filterNode(i).type).toBe('peaking')
  })

  it('sends the slope and Q to the backend', async () => {
    await bootApp()
    await loadAudio()
    choose('lowpass')
    slope('24')
    save.mockResolvedValue('/home/me/out.wav')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ filters: ['lowpass:1000:24'] }),
      }),
    )
  })

  it('sends a custom Q on a 12 dB/octave filter', async () => {
    await bootApp()
    await loadAudio()
    choose('highpass')
    $('filter-q').value = '2.5'
    $('filter-q').dispatchEvent(new Event('input'))
    save.mockResolvedValue('/home/me/out.wav')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ filters: ['highpass:1000:12:2.5'] }),
      }),
    )
  })

  it('refuses an emptied Q field before the export', async () => {
    await bootApp()
    await loadAudio()
    choose('lowpass')

    $('filter-q').value = ''
    $('filter-q').dispatchEvent(new Event('input'))

    expect($('export-btn').disabled).toBe(true)
    expect($('filter-q').getAttribute('aria-invalid')).toBe('true')
    expect($('export-hint').textContent).toContain('Q must be a positive number')
  })

  it('does not mind Q while the slope fixes it', async () => {
    await bootApp()
    await loadAudio()
    choose('lowpass')
    slope('24')

    $('filter-q').value = ''
    $('filter-q').dispatchEvent(new Event('input'))

    expect($('export-btn').disabled).toBe(false)
  })

  it('measures the normalisation peak through the whole cascade', async () => {
    const rendered = { numberOfChannels: 1, getChannelData: () => new Float32Array([0.5]) }
    const stages = []
    const offline = {
      createBufferSource: vi.fn(() => ({ connect: vi.fn(), start: vi.fn(), buffer: null })),
      createGain: vi.fn(() => ({
        connect: vi.fn(),
        gain: { setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() },
      })),
      createBiquadFilter: vi.fn(() => {
        const stage = { connect: vi.fn(), type: '', gain: { value: 0 }, frequency: { value: 0 }, Q: { value: 0 } }
        stages.push(stage)
        return stage
      }),
      destination: {},
      startRendering: vi.fn(() => Promise.resolve(rendered)),
    }
    vi.stubGlobal('OfflineAudioContext', vi.fn(function () { return offline }))
    await bootApp()
    await loadAudio()
    choose('lowpass')
    slope('36')

    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))

    await vi.waitFor(() => expect(stages).toHaveLength(4))
    await vi.waitFor(() => expect(normalizeNode().gain.value).toBeCloseTo(0.8912509 / 0.5, 5))
    expect(stages.map((s) => s.type)).toEqual(['lowpass', 'lowpass', 'lowpass', 'peaking'])
    // Chained one into the next, so the render sees the real cascade.
    for (const stage of stages.slice(0, 3)) expect(stage.connect).toHaveBeenCalled()
  })
})

describe('main — WAV sample format', () => {
  it('is offered on the WAV tab only', async () => {
    await bootApp()
    expect($('wav-depth').classList.contains('hidden')).toBe(false)

    document.querySelector('.fmt[data-fmt="mp3"]').click()
    expect($('wav-depth').classList.contains('hidden')).toBe(true)

    document.querySelector('.fmt[data-fmt="wav"]').click()
    expect($('wav-depth').classList.contains('hidden')).toBe(false)
  })

  it('defaults to 32-bit float', async () => {
    await bootApp()
    expect($('wav-depth').value).toBe('float32')
    expect([...$('wav-depth').options].map((o) => o.value)).toEqual(['float32', 'pcm24', 'pcm16'])
  })

  it('is sent with a WAV export', async () => {
    await bootApp()
    await loadAudio()
    $('wav-depth').value = 'pcm16'
    save.mockResolvedValue('/home/me/out.wav')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ format: 'wav', wav_depth: 'pcm16' }),
      }),
    )
  })

  it('is not sent with the other formats', async () => {
    await bootApp()
    await loadAudio()
    $('wav-depth').value = 'pcm16'
    document.querySelector('.fmt[data-fmt="flac"]').click()
    save.mockResolvedValue('/home/me/out.flac')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ format: 'flac', wav_depth: null }),
      }),
    )
  })

  it('is translated', async () => {
    await bootApp()
    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect([...$('wav-depth').options].map((o) => o.textContent)).toEqual([
      'Flottant 32 bits',
      '24 bits',
      '16 bits (dithering)',
    ])
    expect($('wav-depth').getAttribute('aria-label')).toBe('Format des échantillons WAV')
  })
})

describe('main — changelog', () => {
  const open_ = async () => {
    await bootApp()
    menuHandlers['menu-changelog']()
    return document.querySelector('#changelog-dialog')
  }

  it('opens from the menu with the newest changes first', async () => {
    const dialog = await open_()

    expect(dialog).not.toBeNull()
    expect(dialog.querySelector('#changelog-title').textContent).toBe('What’s new')
    const titles = [...dialog.querySelectorAll('h3')].map((h) => h.textContent)
    // Nothing is unreleased right after a release: the newest entry leads.
    expect(titles[0]).toBe('v1.1.0' + '2026-10-26')
    expect(titles).toContain('v1.0.0' + '2026-08-19')
  })

  it('lists the items of each section', async () => {
    const dialog = await open_()

    expect([...dialog.querySelectorAll('h4')].map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['Added', 'Changed', 'Fixed', 'Security']),
    )
    expect(dialog.querySelectorAll('li').length).toBeGreaterThan(10)
  })

  it('renders `code` spans as code, never as HTML', async () => {
    const dialog = await open_()

    expect(dialog.querySelector('li code')).not.toBeNull()
    expect(dialog.querySelector('script, img')).toBeNull()
  })

  it('speaks French when the interface does', async () => {
    await bootApp()
    await menuHandlers['menu-set-language']({ payload: 'fr' })

    menuHandlers['menu-changelog']()

    const dialog = document.querySelector('#changelog-dialog')
    expect(dialog.querySelector('#changelog-title').textContent).toBe('Nouveautés')
    expect(dialog.querySelector('h3').textContent).toBe('v1.1.0' + '2026-10-26')
    expect([...dialog.querySelectorAll('h4')].map((h) => h.textContent)).toContain('Ajouté')
  })

  it('closes with Escape, its button and the backdrop, and replaces About', async () => {
    await bootApp()
    menuHandlers['menu-about']({ payload: '1.0.0' })
    menuHandlers['menu-changelog']()
    expect(document.querySelectorAll('.about-backdrop')).toHaveLength(1)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('#changelog-dialog')).toBeNull()

    menuHandlers['menu-changelog']()
    document.querySelector('#changelog-dialog button').click()
    expect(document.querySelector('#changelog-dialog')).toBeNull()

    menuHandlers['menu-changelog']()
    document.querySelector('#changelog-dialog').click()
    expect(document.querySelector('#changelog-dialog')).toBeNull()
  })

  it('cycles the focus between the scrolling text and its button', async () => {
    const dialog = await open_()
    const button = dialog.querySelector('button')
    const text = dialog.querySelector('.changelog-body')
    expect(document.activeElement).toBe(button)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(document.activeElement).toBe(text)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    expect(document.activeElement).toBe(button)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }))
    expect(document.activeElement).toBe(text)
  })

  it('leaves the space bar alone while open', async () => {
    await bootApp()
    await loadAudio()
    menuHandlers['menu-changelog']()

    document.querySelector('#changelog-dialog button').dispatchEvent(
      new KeyboardEvent('keydown', { code: 'Space', bubbles: true }),
    )

    expect($('play-icon').innerHTML).toContain('polygon')
  })
})

describe('main — release notes before an update', () => {
  const NOTES = '<!-- en -->\n### Added\n- Brand new `thing`\n\n<!-- fr -->\n### Ajouté\n- Tout nouveau `truc`\n\n---\n\n### Downloads\n- table'

  async function announce(body = NOTES) {
    await bootApp()
    check.mockResolvedValue({ version: '2.0.0', body, downloadAndInstall: vi.fn() })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-install')).not.toBeNull())
  }

  it('offers to show what is new, collapsed by default', async () => {
    await announce()

    expect($('update-notes-toggle').textContent).toBe('What’s new')
    expect($('update-notes-toggle').getAttribute('aria-expanded')).toBe('false')
    expect($('update-notes')).toBeNull()
  })

  it('shows the changes of that version in the interface language', async () => {
    await announce()

    $('update-notes-toggle').click()

    expect($('update-notes').textContent).toContain('Brand new')
    expect($('update-notes').querySelector('code').textContent).toBe('thing')
    expect($('update-notes').textContent).not.toContain('Tout nouveau')
    expect($('update-notes-toggle').textContent).toBe('Hide')
    expect($('update-notes-toggle').getAttribute('aria-expanded')).toBe('true')
  })

  it('leaves out the download table of the release page', async () => {
    await announce()
    $('update-notes-toggle').click()
    expect($('update-notes').textContent).not.toContain('Downloads')
  })

  it('shows them in French after the language changes, and hides them again', async () => {
    await announce()
    $('update-notes-toggle').click()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('update-notes').textContent).toContain('Tout nouveau')
    expect($('update-notes-toggle').textContent).toBe('Masquer')
    $('update-notes-toggle').click()
    expect($('update-notes')).toBeNull()
  })

  it('has no button for an update that came without notes', async () => {
    await announce('')
    expect($('update-notes-toggle')).toBeNull()
    expect($('update-install')).not.toBeNull()
  })

  it('shows notes written as plain text, with no language markers', async () => {
    await announce('### Fixed\n- one thing')
    $('update-notes-toggle').click()
    expect($('update-notes').textContent).toContain('one thing')
  })

  it('does not interpret notes as HTML', async () => {
    await announce('- <img src=x onerror=alert(1)> <b>bold</b>')
    $('update-notes-toggle').click()
    expect($('update-notes').querySelector('img, b')).toBeNull()
    expect($('update-notes').textContent).toContain('<img')
  })

  it('collapses the notes for the next update', async () => {
    await announce()
    $('update-notes-toggle').click()

    check.mockResolvedValue({ version: '3.0.0', body: NOTES, downloadAndInstall: vi.fn() })
    await menuHandlers['menu-check-updates']()
    await vi.waitFor(() => expect($('update-banner').textContent).toContain('3.0.0'))

    expect($('update-notes')).toBeNull()
  })

  it('drops the notes once the install has started', async () => {
    await announce()
    $('update-notes-toggle').click()

    $('update-install').click()

    expect($('update-notes')).toBeNull()
    expect($('update-notes-toggle')).toBeNull()
  })
})

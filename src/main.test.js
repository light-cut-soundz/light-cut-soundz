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
    getChannelData: vi.fn(() => new Float32Array(Math.round(12.5 * 44100)).fill(0.5)),
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
  audio = { ctx: null, gains: [], filters: [], sources: [], analysers: [], builtBuffers: [] }
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
    createAnalyser = () => {
      const a = {
        ...node(),
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 256,
        getByteFrequencyData: vi.fn((data) => data.fill(128)),
      }
      audio.analysers.push(a)
      return a
    }
    createBuffer = vi.fn((channels, length, rate) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length))
      const buffer = {
        numberOfChannels: channels,
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (ch) => data[ch],
      }
      audio.builtBuffers.push(buffer)
      return buffer
    })
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
    clearRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
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
  // The cuts are drawn, and hit-tested, over the same box as the waveform.
  $('tl-cuts').getBoundingClientRect = () => ({ left: 0, top: 0, width: CANVAS_W, height: CANVAS_H })
  $('seekbar').getBoundingClientRect = () => ({ left: 0, top: 0, width: CANVAS_W, height: 12 })
  const viz = $('spectrum')
  Object.defineProperty(viz, 'clientWidth', { value: CANVAS_W, configurable: true })
  Object.defineProperty(viz, 'clientHeight', { value: CANVAS_H, configurable: true })
  return canvas
}

/** clientX for a given time on the waveform, using the fixture's 12.5 s duration. */
const xForTime = (t) => (t / AUDIO_INFO.duration) * CANVAS_W

/** A pointer event on `target`; the app listens to the names, not to the class. */
function pointer(type, x, target = $('tl-track')) {
  target.dispatchEvent(new MouseEvent(type, { clientX: x, bubbles: true, button: 0 }))
}

/** Marks the part from `from` to `to` seconds as cut, by dragging over the track. */
function cutBetween(from, to) {
  pointer('pointerdown', xForTime(from))
  pointer('pointermove', xForTime(to))
  pointer('pointerup', xForTime(to))
}

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

  it('starts with nothing cut, and the whole file on the seek bar', async () => {
    await bootApp()

    await loadAudio()

    expect(document.querySelectorAll('.tl-cut')).toHaveLength(0)
    expect($('cut-count').classList.contains('hidden')).toBe(true)
    expect($('time-total').textContent).toBe('0:12')
    expect($('seekbar').getAttribute('aria-valuemax')).toBe('13')
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

describe('main — home screen', () => {
  const RECENT = [
    { path: '/home/me/music/a.wav', name: 'a.wav', dir: '/home/me/music' },
    { path: '/home/me/music/b.mp3', name: 'b.mp3', dir: '/home/me/music' },
  ]

  /** `invoke` answering `get_recent` with a list that `forget_recent` shortens. */
  function withRecent(list = RECENT) {
    let current = list
    invoke.mockImplementation((cmd, args) => {
      if (cmd === 'load_audio') return Promise.resolve(AUDIO_INFO)
      if (cmd === 'get_recent') return Promise.resolve(current)
      if (cmd === 'forget_recent') {
        current = args.path ? current.filter((i) => i.path !== args.path) : []
      }
      return Promise.resolve(undefined)
    })
  }

  it('hides the header bar until a file is open', async () => {
    await bootApp()
    expect(document.querySelector('header').classList.contains('hidden')).toBe(true)

    await loadAudio()
    expect(document.querySelector('header').classList.contains('hidden')).toBe(false)
  })

  it('shows the app name and no logo bar', async () => {
    await bootApp()
    expect(document.querySelector('.drop-name').textContent).toBe('LightCutSoundz')
    expect(document.querySelector('.logo')).toBeNull()
  })

  it('hides the recent list when there is nothing to show', async () => {
    await bootApp()
    expect($('recent').classList.contains('hidden')).toBe(true)
  })

  it('lists the recent files with their folder', async () => {
    withRecent()
    await bootApp()

    await vi.waitFor(() => expect($('recent').classList.contains('hidden')).toBe(false))
    const rows = [...document.querySelectorAll('.recent-item')]
    expect(rows.map((r) => r.querySelector('.recent-name').textContent)).toEqual(['a.wav', 'b.mp3'])
    expect(rows[0].querySelector('.recent-kind').textContent).toBe('WAV')
    expect(rows[0].querySelector('.recent-dir').textContent).toBe('/home/me/music')
  })

  it('opens a recent file when it is clicked', async () => {
    withRecent()
    await bootApp()
    await vi.waitFor(() => expect(document.querySelector('.recent-open')).not.toBeNull())

    document.querySelector('.recent-open').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('load_audio', { path: '/home/me/music/a.wav', points: 900 }),
    )
  })

  it('removes one entry, or all of them', async () => {
    withRecent()
    await bootApp()
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item').length).toBe(2))

    document.querySelector('.recent-remove').click()
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item').length).toBe(1))
    expect(invoke).toHaveBeenCalledWith('forget_recent', { path: '/home/me/music/a.wav' })

    $('recent-clear').click()
    await vi.waitFor(() => expect($('recent').classList.contains('hidden')).toBe(true))
    expect(invoke).toHaveBeenCalledWith('forget_recent', { path: null })
  })

  it('redraws the list when the menu clears it', async () => {
    withRecent()
    await bootApp()
    await vi.waitFor(() => expect(document.querySelectorAll('.recent-item').length).toBe(2))

    await invoke('forget_recent', { path: null })
    menuHandlers['recent-changed']()
    await vi.waitFor(() => expect($('recent').classList.contains('hidden')).toBe(true))
  })

  it('keeps working when the recent files cannot be read', async () => {
    invoke.mockImplementation((cmd) =>
      cmd === 'get_recent' ? Promise.reject(new Error('boom')) : Promise.resolve(undefined),
    )
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await bootApp()

    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect($('recent').classList.contains('hidden')).toBe(true)
  })
})

describe('main — undo and redo', () => {
  const undoRedoCalls = () => invoke.mock.calls.filter(([c]) => c === 'set_undo_redo').map(([, a]) => a)
  const lastState = () => undoRedoCalls().at(-1)
  const preset = (v) => document.querySelector(`.preset[data-v="${v}"]`)

  it('starts with nothing to undo once a file is open', async () => {
    await bootApp()
    await loadAudio()
    expect(lastState()).toEqual({ canUndo: false, canRedo: false })
  })

  it('takes a step per edit and undoes it from the menu', async () => {
    await bootApp()
    await loadAudio()

    preset('2.0').click()
    expect($('speed').value).toBe('6') // the slider steps through the presets: 2x is the 7th
    expect(lastState()).toEqual({ canUndo: true, canRedo: false })

    menuHandlers['menu-undo']()
    expect($('speed').value).toBe('3')
    expect(lastState()).toEqual({ canUndo: false, canRedo: true })

    menuHandlers['menu-redo']()
    expect($('speed').value).toBe('6')
    expect(lastState()).toEqual({ canUndo: true, canRedo: false })
  })

  it('records a slider or field once it is released, and restores several controls', async () => {
    await bootApp()
    await loadAudio()

    $('fadein').value = '3'
    $('fadein').dispatchEvent(new Event('input', { bubbles: true }))
    $('fadein').dispatchEvent(new Event('change', { bubbles: true }))
    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change', { bubbles: true }))

    menuHandlers['menu-undo']()
    expect($('normalize').checked).toBe(false)
    expect($('fadein').value).toBe('3')
    menuHandlers['menu-undo']()
    expect($('fadein').value).toBe('0')
    expect($('fadein-val').textContent).toBe('0.0s')
  })

  it('drops the steps that were undone when a new edit is made', async () => {
    await bootApp()
    await loadAudio()
    preset('2.0').click()
    menuHandlers['menu-undo']()

    preset('0.5').click()

    expect(lastState()).toEqual({ canUndo: true, canRedo: false })
    menuHandlers['menu-redo']()
    expect($('speed').value).toBe('1')
  })

  it('ignores a click that changes nothing, and undo/redo at the ends', async () => {
    await bootApp()
    await loadAudio()
    preset('1.0').click()
    menuHandlers['menu-undo']()
    menuHandlers['menu-redo']()
    expect(lastState()).toEqual({ canUndo: false, canRedo: false })
  })

  it('starts the history again when another file is opened', async () => {
    await bootApp()
    await loadAudio()
    preset('2.0').click()

    open.mockResolvedValue('/home/me/other.wav')
    $('open-btn-header').click()

    await vi.waitFor(() => expect(lastState()).toEqual({ canUndo: false, canRedo: false }))
  })

  it('leaves undo to the typing while a number field has the focus', async () => {
    const exec = vi.fn(() => true)
    document.execCommand = exec
    await bootApp()
    await loadAudio()
    preset('2.0').click()
    $('cut-start').focus()

    menuHandlers['menu-undo']()

    expect(exec).toHaveBeenCalledWith('undo')
    expect($('speed').value).toBe('6')
  })
})

describe('main — theme', () => {
  it('marks the page with the chosen theme, and leaves "system" to the system', async () => {
    await bootApp()

    await menuHandlers['menu-set-theme']({ payload: 'light' })
    expect(document.documentElement.dataset.theme).toBe('light')

    await menuHandlers['menu-set-theme']({ payload: 'dark' })
    expect(document.documentElement.dataset.theme).toBe('dark')

    await menuHandlers['menu-set-theme']({ payload: 'system' })
    expect(document.documentElement.dataset.theme).toBeUndefined()
  })

  it('applies the saved theme before anything is drawn', async () => {
    localStorage.setItem('lcs-theme', 'light')

    await bootApp()

    expect(document.documentElement.dataset.theme).toBe('light')
  })

  it('repaints the waveform and the visualisation in the new colours', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.drawImage.mockClear()

    await menuHandlers['menu-set-theme']({ payload: 'light' })

    expect(ctx2d.drawImage).toHaveBeenCalled()
  })

  it('applies the saved theme at startup, system by default', async () => {
    await bootApp()
    expect(invoke).toHaveBeenCalledWith('set_theme', { theme: 'system' })

    localStorage.setItem('lcs-theme', 'dark')
    await bootApp()
    expect(invoke).toHaveBeenCalledWith('set_theme', { theme: 'dark' })
  })

  it('applies and remembers the theme chosen in the menu', async () => {
    await bootApp()

    await menuHandlers['menu-set-theme']({ payload: 'light' })

    expect(invoke).toHaveBeenCalledWith('set_theme', { theme: 'light' })
    expect(localStorage.getItem('lcs-theme')).toBe('light')
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
    const preset = document.querySelector('.preset[data-v="2.0"]')

    preset.click()

    expect(preset.classList.contains('active')).toBe(true)
    expect($('speed').value).toBe('6')
    expect($('speed-val').textContent).toBe('2x')
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

  it('draws the whole file in colour: the cuts are drawn over it, not in it', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.fillRect.mockClear()
    const colours = []
    ctx2d.fillRect.mockImplementation(() => colours.push(ctx2d.fillStyle))

    cutBetween(5, 6)

    expect(colours).not.toContain('#242424')
    expect(document.querySelectorAll('.tl-cut')).toHaveLength(1)
  })

  it('draws the playhead where the sound is in the file, not in what is left', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(0, 5)
    ctx2d.moveTo.mockClear()

    $('play-btn').click()
    audio.ctx.currentTime = 1 // 1 s into what is left: 6 s into the file
    runFrame()

    const x = xForTime(6)
    expect(ctx2d.moveTo.mock.calls.some(([px]) => Math.abs(px - x) < 0.5)).toBe(true)
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

    $('cut-start').dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }))

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

  it('plays what the cuts leave, as one piece', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(4, 8)

    $('play-btn').click()

    expect(lastSource().start).toHaveBeenCalledWith(0, 0)
    expect(lastSource().buffer.duration).toBeCloseTo(8.5, 2) // 12.5 s minus 4 s
    expect($('time-total').textContent).toBe('0:08')
  })

  it('plays the whole file, as it is, when nothing is cut', async () => {
    await bootApp()
    await loadAudio()

    $('play-btn').click()

    expect(lastSource().start.mock.calls[0]).toEqual([0, 0])
  })

  it('rewinds to the start of what is left when the source ends on its own', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(1, 2)
    $('play-btn').click()
    const source = lastSource()

    // Nothing in the animation loop is needed: the source ends on its own.
    source.onended()

    expect($('play-icon').innerHTML).toContain('polygon')
    $('play-btn').click()
    expect(lastSource().start).toHaveBeenCalledWith(0, 0)
  })

  it('keeps the playhead inside what is left even if no frame ran', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(2, 12.5)
    $('play-btn').click()

    audio.ctx.currentTime = 50 // a hidden window: no frame, the clock moves on
    $('play-btn').click() // pause

    $('play-btn').click()
    expect(lastSource().start).toHaveBeenCalledWith(0, 0)
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

  it('schedules the fades relative to what the cuts leave', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(0, 2)
    cutBetween(10, 12.5)
    $('fadein').value = '1'

    $('play-btn').click()

    const { setValueAtTime, linearRampToValueAtTime } = fadeNode().gain
    expect(setValueAtTime).toHaveBeenCalledWith(0, 0)
    expect(linearRampToValueAtTime).toHaveBeenCalledWith(1, 1)
  })

  it('multiplies two overlapping fades instead of taking the smaller', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(1, 12.5)
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

  it('restarts from where it is when a cut is made during playback', async () => {
    await bootApp()
    await loadAudio()
    $('play-btn').click()
    const first = lastSource()

    cutBetween(5, 9)

    expect(first.stop).toHaveBeenCalled()
    expect(lastSource()).not.toBe(first)
    expect(lastSource().start).toHaveBeenCalledWith(0, 0)
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

  it('measures the peak of what the cuts leave only', async () => {
    await bootApp()
    await loadAudio()
    // Buckets 0-89 (0 s – 1.25 s) only reach 0.9 at their 10th element: take a
    // stretch whose loudest bucket is 0.5.
    const duration = AUDIO_INFO.duration
    const bucket = (i) => (i / AUDIO_INFO.waveform.length) * duration
    cutBetween(0, bucket(10) + 0.001)
    cutBetween(bucket(15) - 0.001, duration)

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
    cutBetween(0, 2)
    cutBetween(4, 12.5)
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

  it('re-measures, debounced, when the cuts change with normalise on', async () => {
    await bootApp()
    await loadAudio()
    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))
    await vi.waitFor(() => expect(normalizeNode().gain.value).not.toBe(1))
    vi.useFakeTimers()

    cutBetween(1.08, 12.5)
    cutBetween(0, 1) // what is left, 1.0–1.08 s, peaks lower than the whole file
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

  it('shows the speed as the presets do, and steps through them', async () => {
    await bootApp()

    $('speed').value = '4'
    $('speed').dispatchEvent(new Event('input'))

    expect($('speed-val').textContent).toBe('1.25x')
    expect(document.querySelector('.preset[data-v="1.25"]').classList.contains('active')).toBe(true)
    expect(document.querySelectorAll('.preset.active')).toHaveLength(1)
  })

  it('reselects the matching preset', async () => {
    await bootApp()

    $('speed').value = '6'
    $('speed').dispatchEvent(new Event('input'))

    expect(document.querySelector('.preset[data-v="2.0"]').classList.contains('active')).toBe(true)
  })
})

describe('main — filter buttons', () => {
  const button = (type) => document.querySelector(`.stab-btn[data-for="filter-type"][data-value="${type}"]`)

  it('choose the filter type, as the select does', async () => {
    await bootApp()
    expect(button('').classList.contains('active')).toBe(true)

    button('bandpass').click()

    expect($('filter-type').value).toBe('bandpass')
    expect($('filter-params').classList.contains('hidden')).toBe(false)
    expect(button('bandpass').classList.contains('active')).toBe(true)
    expect(button('bandpass').getAttribute('aria-pressed')).toBe('true')
    expect(button('').getAttribute('aria-pressed')).toBe('false')
    expect(document.querySelectorAll('.stab-btn[data-for="filter-type"].active')).toHaveLength(1)
  })

  it('follow the type when something else sets it, undo for one', async () => {
    await bootApp()
    await loadAudio()
    button('lowpass').click()
    expect(button('lowpass').classList.contains('active')).toBe(true)

    $('undo-btn').click()

    expect($('filter-type').value).toBe('')
    expect(button('').classList.contains('active')).toBe(true)
    expect(button('lowpass').classList.contains('active')).toBe(false)
  })

  it('are named in French when the interface is French', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect([...document.querySelectorAll('.stab-btn[data-for="filter-type"]')].map((b) => b.textContent)).toEqual([
      'Aucun', 'Passe-bas', 'Passe-haut', 'Passe-bande',
    ])
  })
})

describe('main — fade curve buttons', () => {
  const button = (value) => document.querySelector(`.stab-btn[data-for="fade-curve"][data-value="${value}"]`)

  it('choose the curve, as the select does', async () => {
    await bootApp()
    expect(button('linear').classList.contains('active')).toBe(true)

    button('equal-power').click()

    expect($('fade-curve').value).toBe('equal-power')
    expect(button('equal-power').classList.contains('active')).toBe(true)
    expect(button('equal-power').getAttribute('aria-pressed')).toBe('true')
    expect(button('linear').getAttribute('aria-pressed')).toBe('false')
  })

  it('follow the curve when undo sets it back', async () => {
    await bootApp()
    await loadAudio()
    button('equal-power').click()

    $('undo-btn').click()

    expect($('fade-curve').value).toBe('linear')
    expect(button('linear').classList.contains('active')).toBe(true)
    expect(button('equal-power').classList.contains('active')).toBe(false)
  })

  it('are named in French when the interface is French', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect([button('linear'), button('equal-power')].map((b) => b.textContent)).toEqual(['Linéaire', 'Puissance égale'])
  })
})

describe('main — cuts', () => {
  const cutEls = () => [...document.querySelectorAll('.tl-cut:not(.tl-cut-draft)')]
  const widthOf = (el) => parseFloat(el.style.width)
  const leftOf = (el) => parseFloat(el.style.left)

  async function ready() {
    await bootApp()
    await loadAudio()
  }

  it('makes a cut by dragging over the track', async () => {
    await ready()

    cutBetween(4, 8)

    expect(cutEls()).toHaveLength(1)
    expect(leftOf(cutEls()[0])).toBeCloseTo((4 / 12.5) * 100, 1)
    expect(widthOf(cutEls()[0])).toBeCloseTo((4 / 12.5) * 100, 1)
    expect($('cut-count').textContent).toBe('1 cut')
    expect($('cut-count').classList.contains('hidden')).toBe(false)
    expect($('time-total').textContent).toBe('0:08')
  })

  it('says in the sidebar how to cut, and how many cuts there are', async () => {
    await ready()
    expect($('side-cut-count').classList.contains('hidden')).toBe(true)
    expect(document.querySelector('.side-hint').textContent).toContain('drag to select')

    cutBetween(1, 2)
    cutBetween(5, 6)

    expect($('side-cut-count').textContent).toBe('2 cuts')
    expect($('side-cut-count').classList.contains('hidden')).toBe(false)
  })

  it('shows the zone being drawn before the pointer is released', async () => {
    await ready()

    pointer('pointerdown', xForTime(4))
    pointer('pointermove', xForTime(8))

    expect(document.querySelectorAll('.tl-cut-draft')).toHaveLength(1)
    expect(cutEls()).toHaveLength(0)
    pointer('pointerup', xForTime(8))
    expect(document.querySelectorAll('.tl-cut-draft')).toHaveLength(0)
  })

  it('counts the cuts, in the plural too', async () => {
    await ready()

    cutBetween(1, 2)
    cutBetween(5, 6)

    expect($('cut-count').textContent).toBe('2 cuts')
  })

  it('moves the playhead on a press without a drag', async () => {
    await ready()

    pointer('pointerdown', xForTime(6))
    pointer('pointerup', xForTime(6))

    expect($('time-current').textContent).toBe('0:06')
    expect(cutEls()).toHaveLength(0)
  })

  it('resumes playback at the new point when it was playing', async () => {
    await ready()
    $('play-btn').click()

    pointer('pointerdown', xForTime(6))
    pointer('pointerup', xForTime(6))

    expect(lastSource().start).toHaveBeenLastCalledWith(0, expect.closeTo(6, 1))
    expect($('play-icon').innerHTML).toContain('rect')
  })

  it('puts the playhead at the start of a cut when it is pressed inside one', async () => {
    await ready()
    cutBetween(2, 8)

    pointer('pointerdown', xForTime(1))
    pointer('pointerup', xForTime(1))
    expect($('time-current').textContent).toBe('0:01')

    // Counted along what is left: after 2 s, the next sound is at 8 s in the file.
    pointer('pointerdown', xForTime(9))
    pointer('pointerup', xForTime(9))
    expect($('time-current').textContent).toBe('0:03')
  })

  it('does not make a cut out of a drag that is too short', async () => {
    await ready()

    cutBetween(4, 4.02)

    expect(cutEls()).toHaveLength(0)
  })

  it('drags the left edge to resize a cut', async () => {
    await ready()
    cutBetween(4, 8)

    pointer('pointerdown', xForTime(4))
    pointer('pointermove', xForTime(3))
    pointer('pointerup', xForTime(3))

    expect(leftOf(cutEls()[0])).toBeCloseTo((3 / 12.5) * 100, 1)
    expect($('time-total').textContent).toBe('0:07')
  })

  it('drags the right edge to resize a cut', async () => {
    await ready()
    cutBetween(4, 8)

    pointer('pointerdown', xForTime(8))
    pointer('pointermove', xForTime(10))
    pointer('pointerup', xForTime(10))

    expect(widthOf(cutEls()[0])).toBeCloseTo((6 / 12.5) * 100, 1)
  })

  it('keeps the edges of a cut apart', async () => {
    await ready()
    cutBetween(4, 8)

    pointer('pointerdown', xForTime(4))
    pointer('pointermove', xForTime(11)) // past the other edge
    pointer('pointerup', xForTime(11))

    const [cut] = cutEls()
    expect(widthOf(cut)).toBeGreaterThan(0)
    expect(leftOf(cut) + widthOf(cut)).toBeCloseTo((8 / 12.5) * 100, 1)
  })

  it('drags the middle of a cut to move it', async () => {
    await ready()
    cutBetween(4, 8)

    pointer('pointerdown', xForTime(6))
    pointer('pointermove', xForTime(8))
    pointer('pointerup', xForTime(8))

    expect(leftOf(cutEls()[0])).toBeCloseTo((6 / 12.5) * 100, 1)
    expect(widthOf(cutEls()[0])).toBeCloseTo((4 / 12.5) * 100, 1)
  })

  it('keeps a moved cut inside the file', async () => {
    await ready()
    cutBetween(4, 8)

    pointer('pointerdown', xForTime(6))
    pointer('pointermove', xForTime(30))
    pointer('pointerup', xForTime(30))

    expect(leftOf(cutEls()[0]) + widthOf(cutEls()[0])).toBeCloseTo(100, 1)
  })

  it('merges a cut that overlaps another', async () => {
    await ready()
    cutBetween(2, 6)

    cutBetween(1, 4) // starts clear of the first one's edge

    expect(cutEls()).toHaveLength(1)
    expect(widthOf(cutEls()[0])).toBeCloseTo((5 / 12.5) * 100, 1)
  })

  it('merges a cut that is dragged over another', async () => {
    await ready()
    cutBetween(1, 3)
    cutBetween(6, 8)

    pointer('pointerdown', xForTime(7))
    pointer('pointermove', xForTime(3))
    pointer('pointerup', xForTime(3))

    expect(cutEls()).toHaveLength(1)
  })

  it('removes a cut with its ×', async () => {
    await ready()
    cutBetween(4, 8)

    document.querySelector('.tl-cut-delete').click()

    expect(cutEls()).toHaveLength(0)
    expect($('time-total').textContent).toBe('0:12')
    expect($('cut-count').classList.contains('hidden')).toBe(true)
  })

  it('removes the selected cut with the Delete key, unless typing', async () => {
    await ready()
    cutBetween(4, 8)

    $('cut-start').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(cutEls()).toHaveLength(1)

    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    expect(cutEls()).toHaveLength(0)
  })

  it('clears every cut at once', async () => {
    await ready()
    cutBetween(1, 2)
    cutBetween(5, 6)

    $('cut-clear').click()

    expect(cutEls()).toHaveLength(0)
    expect($('cut-clear').classList.contains('hidden')).toBe(true)
  })

  it('edits the selected cut by its times', async () => {
    await ready()
    expect($('cut-fields').classList.contains('hidden')).toBe(true)
    expect($('cut-placeholder').classList.contains('hidden')).toBe(false)

    cutBetween(4, 8)

    expect($('cut-fields').classList.contains('hidden')).toBe(false)
    expect($('cut-start').value).toBe('0:04.0')
    expect($('cut-end').value).toBe('0:08.0')
    expect($('cut-length').textContent).toBe('(0:04.0)')

    $('cut-end').value = '0:10.5'
    $('cut-end').dispatchEvent(new Event('blur'))

    expect(widthOf(cutEls()[0])).toBeCloseTo((6.5 / 12.5) * 100, 1)
  })

  it('refuses a time that is not one, and puts the old one back', async () => {
    await ready()
    cutBetween(4, 8)

    $('cut-start').value = 'soon'
    $('cut-start').dispatchEvent(new Event('blur'))

    expect($('cut-start').value).toBe('0:04.0')
    expect(leftOf(cutEls()[0])).toBeCloseTo((4 / 12.5) * 100, 1)
  })

  it('does not count leaving a field untouched as an edit', async () => {
    await ready()
    cutBetween(4, 8)
    const steps = invoke.mock.calls.filter(([cmd]) => cmd === 'set_undo_redo').length

    $('cut-start').dispatchEvent(new Event('blur'))

    expect(invoke.mock.calls.filter(([cmd]) => cmd === 'set_undo_redo').length).toBe(steps)
  })

  it('does not let a typed time leave the file or cross the other edge', async () => {
    await ready()
    cutBetween(4, 8)

    $('cut-end').value = '5:00'
    $('cut-end').dispatchEvent(new Event('blur'))
    expect(leftOf(cutEls()[0]) + widthOf(cutEls()[0])).toBeCloseTo(100, 1)

    $('cut-start').value = '5:00'
    $('cut-start').dispatchEvent(new Event('blur'))
    expect(widthOf(cutEls()[0])).toBeGreaterThan(0)
  })

  it('builds what plays from the file without the cuts', async () => {
    await ready()

    cutBetween(0, 5)

    const built = audio.builtBuffers.at(-1)
    expect(built.duration).toBeCloseTo(7.5, 3)
    expect(built.getChannelData(0)[0]).toBe(0.5)
    expect(built.getChannelData(0)).toHaveLength(Math.round(7.5 * 44100))
  })

  it('plays the file itself when nothing is cut', async () => {
    await ready()
    cutBetween(0, 5)
    $('cut-clear').click()

    $('play-btn').click()

    expect(lastSource().buffer).toBe(audio.lastBuffer)
  })

  it('goes back to the whole file with undo, and forward again with redo', async () => {
    await ready()
    cutBetween(4, 8)
    expect($('undo-btn').disabled).toBe(false)

    $('undo-btn').click()
    expect(cutEls()).toHaveLength(0)
    expect($('time-total').textContent).toBe('0:12')

    $('redo-btn').click()
    expect(cutEls()).toHaveLength(1)
    expect($('time-total').textContent).toBe('0:08')
  })

  it('makes a cut with the keys I and O at the playhead', async () => {
    await ready()
    const key = (k) => $('waveform').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

    $('seekbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    key('i') // 5 s
    $('seekbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }))
    key('o') // 10 s

    expect(cutEls()).toHaveLength(1)
    expect(leftOf(cutEls()[0])).toBeCloseTo((5 / 12.5) * 100, 1)
    expect(widthOf(cutEls()[0])).toBeCloseTo((5 / 12.5) * 100, 1)
  })

  it('ignores O without an I, and a cut that would be too short', async () => {
    await ready()
    const key = (k) => $('waveform').dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))

    key('o')
    key('i')
    key('o')

    expect(cutEls()).toHaveLength(0)
  })

  it('moves the playhead with the arrow keys on the waveform', async () => {
    await ready()

    $('waveform').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    $('waveform').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))

    expect($('time-current').textContent).toBe('0:02')
  })

  it('labels the handles and the delete button in the current language', async () => {
    await ready()
    cutBetween(4, 8)
    expect(document.querySelector('.tl-cut-handle').title).toBe('Drag to resize')

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect(document.querySelector('.tl-cut-handle').title).toBe('Glisser pour redimensionner')
    expect($('cut-count').textContent).toBe('1 coupe')
  })

  it('starts again without cuts when another file is opened', async () => {
    await ready()
    cutBetween(4, 8)

    await loadAudio('/home/me/other.wav')
    await vi.waitFor(() => expect($('badge-name').textContent).toBe('other.wav'))

    expect(cutEls()).toHaveLength(0)
    expect($('time-total').textContent).toBe('0:12')
  })

  it('ignores a press that is not the main button', async () => {
    await ready()

    $('tl-track').dispatchEvent(new MouseEvent('pointerdown', { clientX: xForTime(4), bubbles: true, button: 2 }))
    pointer('pointermove', xForTime(8))
    pointer('pointerup', xForTime(8))

    expect(cutEls()).toHaveLength(0)
  })

  it('stops a drag that the system cancels', async () => {
    await ready()

    pointer('pointerdown', xForTime(4))
    pointer('pointermove', xForTime(8))
    pointer('pointercancel', xForTime(8))

    expect(document.querySelectorAll('.tl-cut-draft')).toHaveLength(0)
    expect(cutEls()).toHaveLength(0)
  })
})

describe('main — seek bar', () => {
  async function ready() {
    await bootApp()
    await loadAudio()
  }
  const seekbarX = (t) => (t / 12.5) * CANVAS_W

  it('moves the playhead where it is pressed, and follows a drag', async () => {
    await ready()

    pointer('pointerdown', seekbarX(5), $('seekbar'))
    expect($('time-current').textContent).toBe('0:05')
    pointer('pointermove', seekbarX(9), $('seekbar'))
    expect($('time-current').textContent).toBe('0:09')
    pointer('pointerup', seekbarX(9), $('seekbar'))
    pointer('pointermove', seekbarX(2), $('seekbar'))

    expect($('time-current').textContent).toBe('0:09')
  })

  it('fills up with the playhead', async () => {
    await ready()

    pointer('pointerdown', seekbarX(5), $('seekbar'))

    expect(parseFloat($('seekbar-fill').style.width)).toBeCloseTo(40, 1)
    expect(parseFloat($('seekbar-thumb').style.left)).toBeCloseTo(40, 1)
    expect($('seekbar').getAttribute('aria-valuenow')).toBe('5')
  })

  it('counts along what the cuts leave', async () => {
    await ready()
    cutBetween(0, 5)

    pointer('pointerdown', CANVAS_W, $('seekbar')) // the end of what is left: 7.5 s

    expect($('time-current').textContent).toBe('0:07')
    expect(parseFloat($('seekbar-fill').style.width)).toBeCloseTo(100, 0)
  })

  it('names the time under the pointer', async () => {
    await ready()

    pointer('pointermove', seekbarX(3), $('seekbar'))

    expect($('seekbar-tooltip').textContent).toBe('0:03')
    expect($('seekbar').classList.contains('hover')).toBe(true)
    $('seekbar').dispatchEvent(new MouseEvent('pointerleave'))
    expect($('seekbar').classList.contains('hover')).toBe(false)
  })

  it('moves with the arrow keys', async () => {
    await ready()

    $('seekbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }))
    $('seekbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true, cancelable: true }))
    $('seekbar').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }))

    expect($('time-current').textContent).toBe('0:05')
  })

  it('does nothing before a file is open', async () => {
    await bootApp()

    pointer('pointerdown', seekbarX(5), $('seekbar'))

    expect($('time-current').textContent).toBe('0:00')
  })
})

describe('main — visualisation', () => {
  async function ready() {
    await bootApp()
    await loadAudio()
  }

  it('listens to the sound on its way to the output', async () => {
    await ready()

    const [analyser] = audio.analysers
    expect(analyser.fftSize).toBe(512)
    expect(normalizeNode().connect).toHaveBeenCalledWith(analyser)
    expect(normalizeNode().connect).toHaveBeenCalledWith(audio.ctx.destination)
  })

  it('draws the frequency bars while playing', async () => {
    await ready()
    $('play-btn').click()
    ctx2d.fillRect.mockClear()

    runFrame()

    expect(audio.analysers[0].getByteFrequencyData).toHaveBeenCalled()
    expect(ctx2d.fillRect).toHaveBeenCalled()
  })

  it('draws a quiet line of short bars when nothing plays', async () => {
    await ready()
    ctx2d.fillRect.mockClear()

    pointer('pointerdown', 100, $('seekbar'))

    expect(audio.analysers[0].getByteFrequencyData).not.toHaveBeenCalled()
    expect(ctx2d.fillRect).toHaveBeenCalled()
  })

  it('still plays where the WebView has no analyser', async () => {
    const Original = globalThis.AudioContext
    vi.stubGlobal(
      'AudioContext',
      class extends Original {
        createAnalyser = undefined
      },
    )
    await ready()

    $('play-btn').click()
    audio.ctx.currentTime = 1
    runFrame()

    expect($('time-current').textContent).toBe('0:01')
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

    expect($('open-btn').textContent).toBe('Browse files')
    expect(document.documentElement.lang).toBe('en')
  })

  it('reopens in the language saved at the previous launch', async () => {
    localStorage.setItem('lcs-lang', 'fr')

    await bootApp()

    expect($('open-btn').textContent).toBe('Parcourir les fichiers')
    expect(document.documentElement.lang).toBe('fr')
  })

  it('translates the whole window again from the menu, without a restart', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('open-btn').textContent).toBe('Parcourir les fichiers')
    expect(document.querySelector('.tl-hint').textContent).toBe(
      'Faites glisser sur la piste pour marquer les parties à retirer',
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

  it('refuses cuts that leave nothing, and says which part of the screen', async () => {
    await bootApp()
    await loadAudio()

    cutBetween(0, 12.5)

    expect($('export-btn').disabled).toBe(true)
    expect($('export-hint').textContent).toContain('Everything is cut')
    expect($('tl-track').getAttribute('aria-invalid')).toBe('true')
  })

  it('clears the complaint once something is left', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(0, 12.5)

    $('cut-clear').click()

    expect($('export-btn').disabled).toBe(false)
    expect($('export-hint').textContent).toBe('')
    expect(document.querySelector('[aria-invalid]')).toBeNull()
  })

  it('refuses a fade longer than the audio kept', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(1, 12.5)

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
    cutBetween(0, 12.5)

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('export-hint').textContent).toContain('Tout est coupé')
  })

  it('sends the cuts to the backend, as pairs of seconds', async () => {
    await bootApp()
    await loadAudio()
    cutBetween(1, 2)
    cutBetween(5, 7.5)
    save.mockResolvedValue('/home/me/out.wav')

    $('export-btn').click()

    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('process_audio', {
        opts: expect.objectContaining({ cuts: [[1, 2], [5, 7.5]] }),
      }),
    )
    const { opts } = invoke.mock.calls.find(([cmd]) => cmd === 'process_audio')[1]
    expect(opts).not.toHaveProperty('trim_start')
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

describe('main — header and export dialog', () => {
  it('keeps the export options in a dialog, opened by the header button', async () => {
    await bootApp()
    await loadAudio()
    expect($('export-modal').classList.contains('hidden')).toBe(true)

    $('export-open-btn').click()
    expect($('export-modal').classList.contains('hidden')).toBe(false)

    $('export-dismiss').click()
    expect($('export-modal').classList.contains('hidden')).toBe(true)

    $('export-open-btn').click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect($('export-modal').classList.contains('hidden')).toBe(true)

    $('export-open-btn').click()
    $('export-modal').click()
    expect($('export-modal').classList.contains('hidden')).toBe(true)
  })

  it('cannot be closed while exporting, and closes itself when done', async () => {
    await bootApp()
    await loadAudio()
    $('export-open-btn').click()
    save.mockResolvedValue('/home/me/out.wav')
    const running = deferred()
    invoke.mockImplementation((cmd) => (cmd === 'process_audio' ? running.promise : Promise.resolve(undefined)))
    $('export-btn').click()
    await vi.waitFor(() => expect($('export-btn').classList.contains('processing')).toBe(true))

    $('export-close').click()
    expect($('export-modal').classList.contains('hidden')).toBe(false)
    expect($('export-dismiss').classList.contains('hidden')).toBe(true)
    menuHandlers['export-progress']({ payload: 40 })
    expect($('export-progress-fill').style.width).toBe('40%')

    running.resolve()
    await vi.waitFor(() => expect($('export-modal').classList.contains('hidden')).toBe(true))
    expect($('export-dismiss').classList.contains('hidden')).toBe(false)
  })

  it('undoes and redoes from the header, and greys the buttons out when there is nothing to do', async () => {
    await bootApp()
    await loadAudio()
    expect($('undo-btn').disabled).toBe(true)
    expect($('redo-btn').disabled).toBe(true)

    document.querySelector('.preset[data-v="2.0"]').click()
    expect($('undo-btn').disabled).toBe(false)

    $('undo-btn').click()
    expect($('speed').value).toBe('3')
    expect($('undo-btn').disabled).toBe(true)
    expect($('redo-btn').disabled).toBe(false)

    $('redo-btn').click()
    expect($('speed').value).toBe('6')
  })

  it('only shows the WAV sample format for WAV', async () => {
    await bootApp()
    await loadAudio()
    expect($('depth-row').classList.contains('hidden')).toBe(false)

    document.querySelector('.fmt[data-fmt="mp3"]').click()
    expect($('depth-row').classList.contains('hidden')).toBe(true)
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

  it('marks the start of a cut with I and its end with O, at the playhead', async () => {
    await bootApp()
    await loadAudio()
    press($('waveform'), { key: 'ArrowRight', shiftKey: true }) // 5 s
    press($('waveform'), { key: 'i' })
    press($('waveform'), { key: 'ArrowRight', shiftKey: true }) // 10 s

    press($('waveform'), { key: 'o' })

    expect(document.querySelectorAll('.tl-cut')).toHaveLength(1)
    expect($('cut-start').value).toBe('0:05.0')
    expect($('cut-end').value).toBe('0:10.0')
  })

  it('makes no cut from an O without an I', async () => {
    await bootApp()
    await loadAudio()
    press($('waveform'), { key: 'ArrowRight', shiftKey: true })

    press($('waveform'), { key: 'o' })

    expect(document.querySelectorAll('.tl-cut')).toHaveLength(0)
  })

  it('redraws and re-validates after a keyboard cut', async () => {
    await bootApp()
    await loadAudio()
    press($('waveform'), { key: 'i' })
    press($('waveform'), { key: 'ArrowRight', shiftKey: true })
    ctx2d.fillRect.mockClear()

    press($('waveform'), { key: 'o' })

    expect(ctx2d.fillRect).toHaveBeenCalled()
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
    expect($('seekbar').getAttribute('aria-label')).toBe('Seek')
    expect($('undo-btn').getAttribute('aria-label')).toBe('Undo')
    expect($('waveform').getAttribute('aria-label')).toContain('Waveform')
  })

  it('relabels them in French', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('seekbar').getAttribute('aria-label')).toBe('Position de lecture')
    expect($('redo-btn').getAttribute('aria-label')).toBe('Rétablir')
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

    const dialog = document.querySelector('.about-card[role="dialog"]')
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
  it('redraws the bars only when something that changes them did', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.fillRect.mockClear()

    // Playhead movement alone must not redraw the 900 bars.
    $('play-btn').click()
    audio.ctx.currentTime = 1
    runFrame()
    runFrame()

    // Only the visualisation's few bars, not the waveform's 900.
    expect(ctx2d.fillRect.mock.calls.length).toBeLessThan(AUDIO_INFO.waveform.length)
    expect(ctx2d.drawImage).toHaveBeenCalled()
  })

  it('does not redraw the 900 bars when a cut is made', async () => {
    await bootApp()
    await loadAudio()
    ctx2d.fillRect.mockClear()

    cutBetween(3, 4)

    expect(ctx2d.fillRect.mock.calls.length).toBeLessThan(AUDIO_INFO.waveform.length)
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
    expect(titles[0]).toBe('v1.2.0' + '2026-10-28')
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
    expect(dialog.querySelector('h3').textContent).toBe('v1.2.0' + '2026-10-28')
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

  it('cycles the focus between the close cross, the scrolling text and the button', async () => {
    const dialog = await open_()
    const button = dialog.querySelector('.btn-primary')
    const cross = dialog.querySelector('.dialog-close')
    const text = dialog.querySelector('.changelog-body')
    const tab = (shiftKey = false) =>
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, cancelable: true }))
    expect(document.activeElement).toBe(button)

    tab()
    expect(document.activeElement).toBe(cross)
    tab()
    expect(document.activeElement).toBe(text)
    tab()
    expect(document.activeElement).toBe(button)
    tab(true)
    expect(document.activeElement).toBe(text)
  })

  it('closes with the cross as well as with the button', async () => {
    const dialog = await open_()
    dialog.querySelector('.dialog-close').click()
    expect(document.getElementById('changelog-dialog')).toBeNull()
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

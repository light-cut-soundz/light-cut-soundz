import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Le vrai `index.html`, privé de son `<script>`, plutôt qu'une copie du balisage :
 * une copie finit toujours par diverger, et c'est précisément sur les attributs
 * `data-i18n` que la divergence passerait inaperçue. */
const APP_MARKUP = readFileSync(join(HERE, '..', 'index.html'), 'utf8')
  .replace(/[\s\S]*<body>/, '')
  .replace(/<\/body>[\s\S]*/, '')
  .replace(/<script[\s\S]*?<\/script>/g, '')
  .trim()

// `main.js` reaches for the Tauri APIs and the DOM the moment it is imported.
const invoke = vi.fn()
const convertFileSrc = vi.fn((p) => `asset://${p}`)
const open = vi.fn()
const save = vi.fn()
const check = vi.fn()
const relaunch = vi.fn()
let dragDropHandler
/** Les écouteurs d'événements de menu enregistrés par `main.js`. */
let menuHandlers = {}

vi.mock('@tauri-apps/api/core', () => ({ invoke, convertFileSrc }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open, save }))
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
    getChannelData: () => new Float32Array([0, 0.5, -0.25]),
  }
}

/** The node chain `main.js` built, so tests can inspect what the preview applied.
 * `main.js` wires it as fade -> normalize -> filter, in that creation order. */
let audio

function installAudioContext() {
  const node = () => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    gain: { value: 1, setValueAtTime: vi.fn() },
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
    decodeAudioData = vi.fn(() => Promise.resolve(fakeAudioBuffer()))
    resume = vi.fn(() => Promise.resolve())
  }
  vi.stubGlobal('AudioContext', FakeAudioContext)
}

const fadeNode = () => audio.gains[0]
const normalizeNode = () => audio.gains[1]
const filterNode = () => audio.filters[0]
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
    scale: vi.fn(),
    fillRect: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fill: vi.fn(),
    setLineDash: vi.fn(),
    roundRect: vi.fn(),
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
  // Chaque bootApp laisse derrière lui les écouteurs `window` de son module ; un
  // mouseup global relâche tout glisser resté en cours dans une instance passée.
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

  it('announces an available update and relaunches', async () => {
    const downloadAndInstall = vi.fn(() => Promise.resolve())
    check.mockResolvedValue({ version: '9.9.9', downloadAndInstall })
    await bootApp()

    await vi.waitFor(() => expect(relaunch).toHaveBeenCalled())
    expect($('update-banner').textContent).toContain('9.9.9')
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

    // Background + one bar per waveform point.
    expect(ctx2d.fillRect.mock.calls.length).toBeGreaterThan(AUDIO_INFO.waveform.length)
    expect($('waveform').width).toBe(CANVAS_W)
    expect(ctx2d.scale).toHaveBeenCalledWith(1, 1)
  })

  it('honours the device pixel ratio', async () => {
    vi.stubGlobal('devicePixelRatio', 2)
    await bootApp()

    await loadAudio()

    expect($('waveform').width).toBe(CANVAS_W * 2)
    expect(ctx2d.scale).toHaveBeenCalledWith(2, 2)
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

    expect(colours).toContain('#7c3aed') // dans la sélection
    expect(colours).toContain('#24243e') // hors sélection
  })

  it('draws a handle at each end of the trim range', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    ctx2d.roundRect.mockClear()

    $('trim-start').dispatchEvent(new Event('input'))

    expect(ctx2d.roundRect).toHaveBeenCalledTimes(2)
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

    document.querySelector('.preset[data-v="2.0"]').click() // ré-ancre à t=0, puis ×2
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

    expect(lastSource().start).toHaveBeenCalledWith(0, 4)
  })

  it('stops when the playhead reaches the trim end', async () => {
    await bootApp()
    await loadAudio()
    $('trim-enabled').checked = true
    $('trim-start').value = '1'
    $('trim-end').value = '2'
    $('play-btn').click()
    const source = lastSource()

    audio.ctx.currentTime = 5
    runFrame()

    expect(source.stop).toHaveBeenCalled()
    expect($('play-icon').innerHTML).toContain('polygon')
    // Le prochain play repart du début de la sélection.
    $('play-btn').click()
    expect(lastSource().start).toHaveBeenCalledWith(0, 1)
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

  it('applies the fade envelope while playing', async () => {
    await bootApp()
    await loadAudio()
    $('fadein').value = '4'
    $('play-btn').click()

    audio.ctx.currentTime = 1
    runFrame()

    // Un quart du fondu d'entrée écoulé.
    expect(fadeNode().gain.value).toBeCloseTo(0.25, 5)
  })
})

describe('main — preview settings', () => {
  it('compensates the peak when normalising', async () => {
    await bootApp()
    await loadAudio()

    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))

    // Le pic du buffer factice est 0,5.
    expect(normalizeNode().gain.value).toBeCloseTo(2, 5)
  })

  it('revient à un gain neutre sans normalisation', async () => {
    await bootApp()
    await loadAudio()
    $('normalize').checked = true
    $('normalize').dispatchEvent(new Event('change'))

    $('normalize').checked = false
    $('normalize').dispatchEvent(new Event('change'))

    expect(normalizeNode().gain.value).toBe(1)
  })

  it('laisse le filtre transparent quand aucun type n’est choisi', async () => {
    await bootApp()
    await loadAudio()

    expect(filterNode().type).toBe('allpass')
    expect($('filter-params').classList.contains('hidden')).toBe(true)
  })

  it('configure un passe-bas', async () => {
    await bootApp()
    await loadAudio()

    $('filter-type').value = 'lowpass'
    $('filter-type').dispatchEvent(new Event('change'))

    expect(filterNode().type).toBe('lowpass')
    expect(filterNode().frequency.value).toBe(1000)
    expect(filterNode().Q.value).toBeCloseTo(0.7071, 4)
    expect($('filter-params').classList.contains('hidden')).toBe(false)
    expect($('filter-bw-row').style.display).toBe('none')
    expect($('filter-freq-label').textContent).toBe('Cutoff')
  })

  it('configure un passe-haut', async () => {
    await bootApp()
    await loadAudio()

    $('filter-type').value = 'highpass'
    $('filter-type').dispatchEvent(new Event('change'))

    expect(filterNode().type).toBe('highpass')
  })

  it('configure un passe-bande et révèle la largeur', async () => {
    await bootApp()
    await loadAudio()

    $('filter-type').value = 'bandpass'
    $('filter-type').dispatchEvent(new Event('change'))

    expect(filterNode().type).toBe('bandpass')
    expect(filterNode().Q.value).toBeCloseTo(2, 5) // 1000 Hz / 500 Hz
    expect($('filter-bw-row').style.display).toBe('flex')
    expect($('filter-freq-label').textContent).toBe('Centre')
  })

  it('suit les changements de fréquence et de largeur', async () => {
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

  it('borne la fréquence à la moitié de la fréquence d’échantillonnage', async () => {
    await bootApp()
    await loadAudio()

    $('filter-type').value = 'lowpass'
    $('filter-freq').value = '99999'
    $('filter-type').dispatchEvent(new Event('change'))

    expect(filterNode().frequency.value).toBeLessThan(audio.ctx.sampleRate / 2)
  })
})

describe('main — slider labels', () => {
  it('affiche la valeur du fondu d’entrée', async () => {
    await bootApp()

    $('fadein').value = '2.5'
    $('fadein').dispatchEvent(new Event('input'))

    expect($('fadein-val').textContent).toBe('2.5s')
  })

  it('affiche la valeur du fondu de sortie', async () => {
    await bootApp()

    $('fadeout').value = '1.2'
    $('fadeout').dispatchEvent(new Event('input'))

    expect($('fadeout-val').textContent).toBe('1.2s')
  })

  it('affiche la vitesse et désactive les préréglages hors grille', async () => {
    await bootApp()

    $('speed').value = '1.25'
    $('speed').dispatchEvent(new Event('input'))

    expect($('speed-val').textContent).toBe('1.25×')
    expect(document.querySelectorAll('.preset.active')).toHaveLength(0)
  })

  it('réactive le préréglage correspondant', async () => {
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

  it('signale la poignée sous le curseur', async () => {
    const canvas = await withTrim()

    mouse('mousemove', xForTime(2))
    expect(canvas.classList.contains('cursor-resize')).toBe(true)

    mouse('mousemove', xForTime(6))
    expect(canvas.classList.contains('cursor-resize')).toBe(false)
  })

  it('efface le curseur en quittant le canvas', async () => {
    const canvas = await withTrim()
    mouse('mousemove', xForTime(2))

    canvas.dispatchEvent(new MouseEvent('mouseleave'))

    expect(canvas.classList.contains('cursor-resize')).toBe(false)
  })

  it('ne propose aucune poignée quand le trim est désactivé', async () => {
    await bootApp()
    await loadAudio()
    const canvas = $('waveform')

    mouse('mousemove', xForTime(0))

    expect(canvas.classList.contains('cursor-resize')).toBe(false)
  })

  it('déplace la poignée de début', async () => {
    await withTrim()

    mouse('mousedown', xForTime(2))
    mouse('mousemove', xForTime(5), window)
    mouse('mouseup', 0, window)

    expect(parseFloat($('trim-start').value)).toBeCloseTo(5, 1)
    expect($('waveform').classList.contains('cursor-resize')).toBe(false)
  })

  it('déplace la poignée de fin', async () => {
    await withTrim()

    mouse('mousedown', xForTime(10))
    mouse('mousemove', xForTime(7), window)
    mouse('mouseup', 0, window)

    expect(parseFloat($('trim-end').value)).toBeCloseTo(7, 1)
  })

  it('empêche les poignées de se croiser', async () => {
    await withTrim()

    mouse('mousedown', xForTime(2))
    mouse('mousemove', xForTime(12), window) // au-delà de la fin
    mouse('mouseup', 0, window)

    expect(parseFloat($('trim-start').value)).toBeCloseTo(9.9, 2)
  })

  it('ignore les déplacements hors glisser', async () => {
    await withTrim()

    mouse('mousemove', xForTime(5), window)

    expect($('trim-start').value).toBe('2')
  })

  it('déplace la tête de lecture au clic hors poignée', async () => {
    await withTrim()

    mouse('mousedown', xForTime(6))

    expect($('time-current').textContent).toBe('0:06')
  })

  it('reprend la lecture au nouveau point quand elle était en cours', async () => {
    await withTrim()
    $('play-btn').click()

    mouse('mousedown', xForTime(6))

    expect(lastSource().start).toHaveBeenLastCalledWith(0, expect.closeTo(6, 1))
    expect($('play-icon').innerHTML).toContain('rect')
  })
})

describe('main — audio setup failures', () => {
  it('signale un fichier inaccessible', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404 })))
    await bootApp()
    open.mockResolvedValue('/home/me/gone.wav')

    $('open-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toContain('404'))
    expect($('editor').classList.contains('hidden')).toBe(true)
  })

  it('reprend le contexte audio suspendu', async () => {
    await bootApp()
    // Le contexte n'existe qu'après le premier chargement ; on force l'état sur le second.
    await loadAudio()
    audio.ctx.state = 'suspended'

    await loadAudio('/home/me/other.wav')

    expect(audio.ctx.resume).toHaveBeenCalled()
  })
})

describe('langue', () => {
  it("démarre en anglais tant qu'aucun choix n'a été fait", async () => {
    await bootApp()

    expect($('open-btn').textContent).toBe('Open a file')
    expect(document.documentElement.lang).toBe('en')
  })

  it('rouvre dans la langue retenue au lancement précédent', async () => {
    localStorage.setItem('lcs-lang', 'fr')

    await bootApp()

    expect($('open-btn').textContent).toBe('Ouvrir un fichier')
    expect(document.documentElement.lang).toBe('fr')
  })

  it('retraduit toute la fenêtre depuis le menu, sans redémarrage', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('open-btn').textContent).toBe('Ouvrir un fichier')
    expect(document.querySelector('.player-hint').textContent).toBe(
      'Glisse les poignées pour trimmer',
    )
  })

  it('retient le choix pour la prochaine ouverture', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect(localStorage.getItem('lcs-lang')).toBe('fr')
  })

  it('fait retraduire la barre de menu par le système', async () => {
    await bootApp()
    invoke.mockClear()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect(invoke).toHaveBeenCalledWith('set_menu_language', { lang: 'fr' })
  })

  it('annonce la langue retenue au démarrage, pour que le menu naisse dans la bonne', async () => {
    localStorage.setItem('lcs-lang', 'fr')

    await bootApp()

    expect(invoke).toHaveBeenCalledWith('set_menu_language', { lang: 'fr' })
  })

  it('traduit aussi les infobulles', async () => {
    await bootApp()

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('play-btn').title).toBe('Espace pour lire/mettre en pause')
  })

  it("garde le libellé de fréquence dans la langue courante quand elle change", async () => {
    await bootApp()
    $('filter-type').value = 'bandpass'
    $('filter-type').dispatchEvent(new Event('change'))
    expect($('filter-freq-label').textContent).toBe('Centre')

    await menuHandlers['menu-set-language']({ payload: 'fr' })

    expect($('filter-freq-label').textContent).toBe('Centre')
  })

  it('traduit les messages, pas seulement les libellés figés', async () => {
    await bootApp()
    await menuHandlers['menu-set-language']({ payload: 'fr' })
    invoke.mockRejectedValueOnce('boom')

    open.mockResolvedValue('/home/me/song.wav')
    $('open-btn').click()

    await vi.waitFor(() => expect($('toast').textContent).toBe('Erreur : boom'))
  })
})

describe('menu — Fichier', () => {
  it('ouvre un fichier depuis le menu', async () => {
    await bootApp()
    open.mockResolvedValue('/home/me/song.wav')

    await menuHandlers['menu-open']()

    await vi.waitFor(() => expect($('editor').classList.contains('hidden')).toBe(false))
  })
})

describe('menu — À propos', () => {
  it('affiche la version reçue du menu', async () => {
    await bootApp()

    menuHandlers['menu-about']({ payload: '0.1.10' })

    expect(document.querySelector('.about-version').textContent).toBe('Version 0.1.10')
  })

  it('parle la langue courante', async () => {
    await bootApp()
    await menuHandlers['menu-set-language']({ payload: 'fr' })

    menuHandlers['menu-about']({ payload: '0.1.10' })

    expect(document.querySelector('.about-title').textContent).toBe(
      'À propos de LightCutSoundz',
    )
  })

  it('se ferme par son bouton', async () => {
    await bootApp()
    menuHandlers['menu-about']({ payload: '0.1.10' })

    document.querySelector('.about-card button').click()

    expect(document.getElementById('about-dialog')).toBeNull()
  })

  it('se ferme avec Échap', async () => {
    await bootApp()
    menuHandlers['menu-about']({ payload: '0.1.10' })

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))

    expect(document.getElementById('about-dialog')).toBeNull()
  })

  it("ne s'empile pas quand on la rouvre", async () => {
    await bootApp()

    menuHandlers['menu-about']({ payload: '0.1.10' })
    menuHandlers['menu-about']({ payload: '0.1.10' })

    expect(document.querySelectorAll('.about-card')).toHaveLength(1)
  })
})

describe('menu — mise à jour', () => {
  it("dit que tout est à jour quand il n'y a rien à installer", async () => {
    await bootApp()
    check.mockResolvedValue(null)

    await menuHandlers['menu-check-updates']()

    await vi.waitFor(() =>
      expect($('toast').textContent).toBe('LightCutSoundz is up to date'),
    )
  })

  it('installe puis relance quand une version est disponible', async () => {
    await bootApp()
    const downloadAndInstall = vi.fn().mockResolvedValue(undefined)
    check.mockResolvedValue({ version: '0.2.0', downloadAndInstall })

    await menuHandlers['menu-check-updates']()

    await vi.waitFor(() => expect(relaunch).toHaveBeenCalled())
    expect(downloadAndInstall).toHaveBeenCalled()
    expect(document.getElementById('update-banner').textContent).toBe(
      'v0.2.0 available, downloading…',
    )
  })

  it("signale l'échec quand la vérification vient du menu", async () => {
    await bootApp()
    check.mockRejectedValue('pas de réseau')

    await menuHandlers['menu-check-updates']()

    await vi.waitFor(() =>
      expect($('toast').textContent).toBe('Update check failed: pas de réseau'),
    )
  })

  it('reste muet quand la vérification au démarrage échoue', async () => {
    check.mockRejectedValue('pas de réseau')

    await bootApp()

    expect($('toast').classList.contains('hidden')).toBe(true)
  })
})

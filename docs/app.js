// ── Language toggle ──────────────────────────────────────────────────────────

const LANGUAGES = ['fr', 'en']

/** The saved choice if it is one the page speaks, else the browser's language:
 * an unexpected stored value used to blank every text. */
function initialLang() {
  let saved = null
  try { saved = localStorage.getItem('lcs-lang') } catch { /* storage blocked */ }
  if (LANGUAGES.includes(saved)) return saved
  return (navigator.language || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

let lang = initialLang()

function applyLang() {
  document.documentElement.lang = lang
  document.querySelectorAll('[data-fr][data-en]').forEach(el => {
    el.textContent = el.dataset[lang]
  })
  document.getElementById('langToggle').textContent = lang === 'fr' ? 'EN' : 'FR'

  const desc = document.querySelector('meta[name="description"]')
  if (desc) {
    desc.content = lang === 'fr'
      ? 'LightCutSoundz est un éditeur audio desktop léger et gratuit pour macOS et Linux. Décodage pur Rust, aperçu en temps réel.'
      : 'LightCutSoundz is a lightweight free desktop audio editor for macOS and Linux. Pure Rust decoding, real-time preview.'
  }
  document.title = lang === 'fr'
    ? 'LightCutSoundz — Éditeur audio léger'
    : 'LightCutSoundz — Lightweight audio editor'
}

document.getElementById('langToggle').addEventListener('click', () => {
  lang = lang === 'fr' ? 'en' : 'fr'
  try { localStorage.setItem('lcs-lang', lang) } catch { /* storage blocked */ }
  applyLang()
})

applyLang()

// ── Latest version number ────────────────────────────────────────────────────
// Installing goes through commands rather than links to the binaries: the only
// thing left to fetch is the number shown under the title.

;(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/light-cut-soundz/light-cut-soundz/releases/latest')
    // GitHub answers 403 once the 60 requests/hour of an anonymous client are
    // used, and 404 before the first release: the body is then an error object.
    if (!res.ok) return
    const rel = await res.json()
    if (typeof rel.tag_name !== 'string') return
    document.querySelectorAll('.dl-release-version').forEach(el => { el.textContent = rel.tag_name })
  } catch {
    // Offline: the version number is a nicety, the page works without it.
  }
})()

/** The HTML formatter may fold a long command onto two lines; a raw textContent
 * would then copy the line break and the indentation into the clipboard, so any
 * run of whitespace is flattened. */
function commandText(el) {
  return el.textContent.replace(/\s+/g, ' ').trim()
}

// ── Copy install commands ─────────────────────────────────────────────────────

document.querySelectorAll('.copy-btn').forEach(btn => {
  // A button with no recognised container would get null here, and the
  // exception would kill the whole script — the copy of the other commands too.
  const cmdEl = btn.closest('.installer-cmd, .install-hero-cmd')?.querySelector('.copy-target')
  if (!cmdEl) return
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(commandText(cmdEl))
      btn.classList.add('copied')
      setTimeout(() => btn.classList.remove('copied'), 2000)
    } catch {
      const range = document.createRange()
      range.selectNode(cmdEl)
      window.getSelection().removeAllRanges()
      window.getSelection().addRange(range)
    }
  })
})

// ── Smooth nav highlight ──────────────────────────────────────────────────────

const sections = document.querySelectorAll('section[id]')
const navLinks = document.querySelectorAll('.nav-links a[href^="#"]')

const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      navLinks.forEach(a => {
        a.style.color = a.getAttribute('href') === '#' + entry.target.id
          ? 'var(--text)'
          : ''
      })
    }
  })
}, { threshold: 0.4 })

sections.forEach(s => observer.observe(s))

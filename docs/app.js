// ── Language toggle ──────────────────────────────────────────────────────────

let lang = localStorage.getItem('lcs-lang') || 'fr'

function applyLang() {
  document.documentElement.lang = lang
  document.querySelectorAll('[data-fr][data-en]').forEach(el => {
    el.textContent = el.dataset[lang]
  })
  document.getElementById('langToggle').textContent = lang === 'fr' ? 'EN' : 'FR'

  const desc = document.querySelector('meta[name="description"]')
  if (desc) {
    desc.content = lang === 'fr'
      ? 'LightCutSoundZ est un éditeur audio desktop léger et gratuit pour macOS et Linux. Décodage pur Rust, aperçu en temps réel.'
      : 'LightCutSoundZ is a lightweight free desktop audio editor for macOS and Linux. Pure Rust decoding, real-time preview.'
  }
  document.title = lang === 'fr'
    ? 'LightCutSoundZ — Éditeur audio léger'
    : 'LightCutSoundZ — Lightweight audio editor'
}

document.getElementById('langToggle').addEventListener('click', () => {
  lang = lang === 'fr' ? 'en' : 'fr'
  localStorage.setItem('lcs-lang', lang)
  applyLang()
})

applyLang()

// ── Dynamic download links ────────────────────────────────────────────────────

(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/light-cut-soundz/light-cut-soundz/releases/latest')
    const rel = await res.json()
    const tag = rel.tag_name

    const versionEls = document.querySelectorAll('.dl-release-version')
    versionEls.forEach(el => { el.textContent = tag })

    const find = pat => (rel.assets.find(a => pat.test(a.name)) || {}).browser_download_url || '#'

    const arm   = find(/aarch64\.dmg$/)
    const appimage = find(/\.AppImage$/)
    const deb   = find(/\.deb$/)

    const set = (id, url) => { const el = document.getElementById(id); if (el) el.href = url }
    set('btn-mac-arm',     arm)
    set('btn-linux-appimage', appimage)
    set('btn-linux-deb',   deb)
    set('btn-appimage-alt', appimage)
  } catch (e) {
    // silently fallback to releases page
    document.querySelectorAll('.dl-fallback').forEach(el => { el.style.display = '' })
  }
})()

// ── Copy install commands ─────────────────────────────────────────────────────

document.querySelectorAll('.copy-btn').forEach(btn => {
  const cmdEl = btn.closest('.installer-cmd').querySelector('.copy-target')
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(cmdEl.textContent.trim())
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

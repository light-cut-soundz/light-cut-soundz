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
      ? 'LightCutSoundz est un éditeur audio desktop léger et gratuit pour macOS et Linux. Décodage pur Rust, aperçu en temps réel.'
      : 'LightCutSoundz is a lightweight free desktop audio editor for macOS and Linux. Pure Rust decoding, real-time preview.'
  }
  document.title = lang === 'fr'
    ? 'LightCutSoundz — Éditeur audio léger'
    : 'LightCutSoundz — Lightweight audio editor'
}

document.getElementById('langToggle').addEventListener('click', () => {
  lang = lang === 'fr' ? 'en' : 'fr'
  localStorage.setItem('lcs-lang', lang)
  applyLang()
})

applyLang()

// ── Numéro de la dernière version ────────────────────────────────────────────
// L'installation passe par des commandes, plus par des liens vers les binaires :
// il ne reste à récupérer que le numéro affiché sous le titre.

;(async () => {
  try {
    const res = await fetch('https://api.github.com/repos/light-cut-soundz/light-cut-soundz/releases/latest')
    const rel = await res.json()
    document.querySelectorAll('.dl-release-version').forEach(el => { el.textContent = rel.tag_name })
  } catch (e) {
    document.querySelectorAll('.dl-fallback').forEach(el => { el.style.display = '' })
  }
})()

/** Le formateur HTML peut replier une commande longue sur deux lignes ; un
 * textContent brut recopierait alors le retour à la ligne et l'indentation dans le
 * presse-papiers. On aplatit toute suite d'espaces. */
function commandText(el) {
  return el.textContent.replace(/\s+/g, ' ').trim()
}

// ── Copy install commands ─────────────────────────────────────────────────────

document.querySelectorAll('.copy-btn').forEach(btn => {
  // Un bouton sans conteneur reconnu renverrait null ici, et l'exception tuerait
  // tout le script — donc aussi la copie des autres commandes.
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

import { describe, it, expect, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { LANGUAGES, applyLang, getT, keysOf, loadLang, saveLang } from './i18n.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...parts) => readFileSync(join(HERE, ...parts), 'utf8')

const NAMESPACES = 'changelog|header|drop|player|trim|fade|volume|speed|filter|export|msg|update|about|badge'

/** Every translation key the markup and the scripts mention: `data-i18n*`
 * attributes, and any quoted `namespace.name` string in the scripts. */
function keysUsedBySources() {
  const html = read('..', 'index.html')
  const js = read('main.js') + read('helpers.js')
  const fromHtml = [...html.matchAll(/data-i18n(?:-title|-aria)?="([^"]+)"/g)].map((m) => m[1])
  const fromJs = [...js.matchAll(new RegExp(`'((?:${NAMESPACES})\\.\\w+)'`, 'g'))].map((m) => m[1])
  return [...new Set([...fromHtml, ...fromJs])]
}

describe('translation tables', () => {
  it('have exactly the same keys in every language', () => {
    const reference = keysOf('en').sort()
    for (const lang of LANGUAGES) {
      expect(keysOf(lang).sort(), lang).toEqual(reference)
    }
  })

  it('leave no value empty', () => {
    for (const lang of LANGUAGES) {
      const t = getT(lang)
      for (const key of keysOf(lang)) expect(t(key).trim(), `${lang}:${key}`).not.toBe('')
    }
  })

  it('use the same {placeholders} in every language', () => {
    const slots = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    const en = getT('en')
    for (const lang of LANGUAGES) {
      const t = getT(lang)
      for (const key of keysOf('en')) expect(slots(t(key)), `${lang}:${key}`).toEqual(slots(en(key)))
    }
  })

  it('cover every key the markup and the scripts ask for', () => {
    const known = new Set(keysOf('en'))
    for (const key of keysUsedBySources()) expect(known.has(key), key).toBe(true)
  })

  it('leave no key unused', () => {
    const used = new Set(keysUsedBySources())
    // `err.<code>` keys are built from the codes the backend sends.
    for (const key of keysOf('en').filter((k) => !k.startsWith('err.'))) {
      expect(used.has(key), key).toBe(true)
    }
  })
})

describe('getT', () => {
  it('substitutes every occurrence of a placeholder', () => {
    const t = getT('en')
    expect(t('update.downloading', { version: '1.2', percent: 5 })).toBe('Downloading v1.2… 5%')
  })

  it('does not interpret `$` sequences in the values', () => {
    expect(getT('en')('export.done', { name: "a$&b$'c" })).toBe("Exported: a$&b$'c")
  })

  it('falls back to English for a missing key in another language, then to the key', () => {
    expect(getT('xx')('header.open')).toBe('Open')
    expect(getT('fr')('no.such.key')).toBe('no.such.key')
  })
})

describe('language choice', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to English', () => {
    expect(loadLang()).toBe('en')
  })

  it('remembers French', () => {
    saveLang('fr')
    expect(loadLang()).toBe('fr')
  })

  it('refuses an unknown language', () => {
    saveLang('de')
    expect(loadLang()).toBe('en')
  })

  it('treats an unexpected stored value as English', () => {
    localStorage.setItem('lcs-lang', 'klingon')
    expect(loadLang()).toBe('en')
  })
})

describe('applyLang', () => {
  it('fills text, tooltips and accessible names', () => {
    document.body.innerHTML = `
      <span data-i18n="header.open"></span>
      <button data-i18n-title="player.playPause" data-i18n-aria="player.playPause"></button>`

    applyLang('fr')

    expect(document.querySelector('span').textContent).toBe('Ouvrir')
    const b = document.querySelector('button')
    expect(b.title).toBe('Espace pour lire/mettre en pause')
    expect(b.getAttribute('aria-label')).toBe('Espace pour lire/mettre en pause')
    expect(document.documentElement.lang).toBe('fr')
  })
})

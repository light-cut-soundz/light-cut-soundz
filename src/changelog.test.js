import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseChangelog, parseSections, releaseNotesSections } from './helpers.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (name) => readFileSync(join(ROOT, name), 'utf8')

describe('the changelog files', () => {
  const en = parseChangelog(read('CHANGELOG.md'))
  const fr = parseChangelog(read('CHANGELOG.fr.md'))

  it('exist in both languages with entries', () => {
    expect(en.length).toBeGreaterThan(1)
    expect(fr.length).toBeGreaterThan(1)
  })

  it('list the same versions, in the same order, on the same dates', () => {
    expect(fr.map((e) => [e.version, e.date])).toEqual(en.map((e) => [e.version, e.date]))
  })

  it('give each version the same sections with as many items in both languages', () => {
    en.forEach((entry, i) => {
      expect(fr[i].sections.map((s) => s.items.length), entry.version).toEqual(
        entry.sections.map((s) => s.items.length),
      )
    })
  })

  it('have no empty release (only Unreleased may be empty)', () => {
    for (const entry of [...en, ...fr].filter((e) => e.version !== 'Unreleased')) {
      expect(entry.sections.flatMap((s) => s.items).length, entry.version).toBeGreaterThan(0)
    }
  })

  it('start with Unreleased, then the releases from newest to oldest', () => {
    expect(en[0].version).toBe('Unreleased')
    const released = en.slice(1).map((e) => e.version.split('.').map(Number))
    for (let i = 1; i < released.length; i++) {
      const [a, b] = [released[i - 1], released[i]]
      const newer = a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
      expect(newer).toBeGreaterThan(0)
    }
  })

  it('has the version the app is at', () => {
    const version = JSON.parse(read('package.json')).version
    expect(en.map((e) => e.version)).toContain(version)
  })
})

describe('scripts/release-notes.sh', () => {
  const run = (version) =>
    execFileSync('bash', [join(ROOT, 'scripts', 'release-notes.sh'), version], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  it('writes one block per language for a version, which the app can read back', () => {
    const notes = run('1.0.0')
    expect(notes.indexOf('<!-- en -->')).toBeLessThan(notes.indexOf('<!-- fr -->'))
    expect(releaseNotesSections(notes, 'en')[0].title).toBe('Added')
    expect(releaseNotesSections(notes, 'fr')[0].title).toBe('Ajouté')
  })

  it('accepts a tag with its v', () => {
    expect(run('v1.0.0')).toBe(run('1.0.0'))
  })

  it('does not mix in the neighbouring versions', () => {
    expect(run('1.0.0')).not.toContain('Export progress')
  })

  it('refuses a version that has no entry', () => {
    expect(() => run('9.9.9')).toThrow(/no entry for 9\.9\.9/)
  })
})

describe('parseSections', () => {
  it('reads headings and bullets', () => {
    expect(parseSections('### Added\n- one\n- two\n\n### Fixed\n* three')).toEqual([
      { title: 'Added', items: ['one', 'two'] },
      { title: 'Fixed', items: ['three'] },
    ])
  })

  it('keeps plain text that has no heading or bullet', () => {
    expect(parseSections('Just a note')).toEqual([{ title: '', items: ['Just a note'] }])
  })

  it('flattens links and bold but leaves code spans for the renderer', () => {
    expect(parseSections('- see [the docs](https://x.y) and **this** `code`')[0].items).toEqual([
      'see the docs and this `code`',
    ])
  })

  it('is empty for empty text', () => {
    expect(parseSections('')).toEqual([])
    expect(parseSections('  \n\n')).toEqual([])
  })

  it('copes with Windows line endings', () => {
    expect(parseSections('### A\r\n- x\r\n')).toEqual([{ title: 'A', items: ['x'] }])
  })
})

describe('parseChangelog', () => {
  const md = '# Changelog\n\nintro\n\n## [Unreleased]\n\n### Added\n- a\n\n## [1.2.0] - 2026-01-02\n\n### Fixed\n- b\n\n## [1.0.0]\n- c\n'

  it('reads versions, dates and sections, ignoring the introduction', () => {
    expect(parseChangelog(md)).toEqual([
      { version: 'Unreleased', date: null, sections: [{ title: 'Added', items: ['a'] }] },
      { version: '1.2.0', date: '2026-01-02', sections: [{ title: 'Fixed', items: ['b'] }] },
      { version: '1.0.0', date: null, sections: [{ title: '', items: ['c'] }] },
    ])
  })

  it('is empty without any entry', () => {
    expect(parseChangelog('# Changelog\n')).toEqual([])
    expect(parseChangelog('')).toEqual([])
  })
})

describe('releaseNotesSections', () => {
  const notes = '<!-- en -->\n### Added\n- english\n\n<!-- fr -->\n### Ajouté\n- français\n\n---\n\n### Downloads\n- table'

  it('picks the block of the language', () => {
    expect(releaseNotesSections(notes, 'fr')).toEqual([{ title: 'Ajouté', items: ['français'] }])
    expect(releaseNotesSections(notes, 'en')).toEqual([{ title: 'Added', items: ['english'] }])
  })

  it('drops what follows a horizontal rule', () => {
    const all = JSON.stringify(releaseNotesSections(notes, 'fr'))
    expect(all).not.toContain('Downloads')
  })

  it('falls back to English, then to the first block, for a language it lacks', () => {
    expect(releaseNotesSections(notes, 'de')[0].items).toEqual(['english'])
    expect(releaseNotesSections('<!-- fr -->\n- seul', 'en')[0].items).toEqual(['seul'])
  })

  it('takes notes without markers whole', () => {
    expect(releaseNotesSections('### Fixed\n- x', 'fr')).toEqual([{ title: 'Fixed', items: ['x'] }])
  })

  it('is empty for missing or blank notes', () => {
    for (const n of [undefined, null, '', '   ', 42]) expect(releaseNotesSections(n, 'en')).toEqual([])
  })
})

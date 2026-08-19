const LANG_KEY = 'lcs-lang'

const dict = {
  en: {
    // Header
    'header.openOther': 'Open another file',
    'header.open': 'Open',

    // Drop zone
    'drop.title': 'Drop an audio file here',
    'drop.or': 'or',
    'drop.open': 'Open a file',

    // Player
    'player.playPause': 'Space to play/pause',
    'player.hint': 'Drag the handles to trim',

    // Trim
    'trim.title': 'Trim',
    'trim.start': 'Start',
    'trim.end': 'End',

    // Fade
    'fade.title': 'Fade',
    'fade.in': 'Fade in',
    'fade.out': 'Fade out',

    // Volume
    'volume.title': 'Volume',
    'volume.normalize': 'Normalise (peak −1 dBFS)',

    // Speed
    'speed.title': 'Speed',

    // Filter
    'filter.title': 'Filter',
    'filter.none': 'None',
    'filter.frequency': 'Frequency',
    'filter.cutoff': 'Cutoff',
    'filter.centre': 'Centre',
    'filter.bandwidth': 'Bandwidth',

    // Export
    'export.run': 'Export',
    'export.working': 'Processing…',
    'export.done': 'Exported: {name}',

    // Messages
    'msg.loading': 'Loading…',
    'msg.error': 'Error: {error}',
    'msg.unreachable': 'Cannot read the file ({status})',

    // Updates
    'update.checking': 'Checking for updates…',
    'update.upToDate': 'LightCutSoundz is up to date',
    'update.found': 'v{version} available, downloading…',
    'update.failed': 'Update check failed: {error}',

    // About
    'about.title': 'About LightCutSoundz',
    'about.version': 'Version {version}',
    'about.tagline': 'Lightweight audio editor — trim, fade, normalise, export.',
    'about.close': 'Close',
  },
  fr: {
    // Header
    'header.openOther': 'Ouvrir un autre fichier',
    'header.open': 'Ouvrir',

    // Drop zone
    'drop.title': 'Dépose un fichier audio ici',
    'drop.or': 'ou',
    'drop.open': 'Ouvrir un fichier',

    // Player
    'player.playPause': 'Espace pour lire/mettre en pause',
    'player.hint': 'Glisse les poignées pour trimmer',

    // Trim
    'trim.title': 'Trim',
    'trim.start': 'Début',
    'trim.end': 'Fin',

    // Fade
    'fade.title': 'Fondu',
    'fade.in': 'Fondu entrant',
    'fade.out': 'Fondu sortant',

    // Volume
    'volume.title': 'Volume',
    'volume.normalize': 'Normaliser (pic −1 dBFS)',

    // Speed
    'speed.title': 'Vitesse',

    // Filter
    'filter.title': 'Filtre',
    'filter.none': 'Aucun',
    'filter.frequency': 'Fréquence',
    'filter.cutoff': 'Coupure',
    'filter.centre': 'Centre',
    'filter.bandwidth': 'Largeur',

    // Export
    'export.run': 'Exporter',
    'export.working': 'Traitement…',
    'export.done': 'Export réussi : {name}',

    // Messages
    'msg.loading': 'Chargement…',
    'msg.error': 'Erreur : {error}',
    'msg.unreachable': "Impossible d'accéder au fichier ({status})",

    // Updates
    'update.checking': 'Recherche de mises à jour…',
    'update.upToDate': 'LightCutSoundz est à jour',
    'update.found': 'v{version} disponible, téléchargement…',
    'update.failed': 'Échec de la recherche de mise à jour : {error}',

    // About
    'about.title': 'À propos de LightCutSoundz',
    'about.version': 'Version {version}',
    'about.tagline': 'Éditeur audio léger — trimmer, fondre, normaliser, exporter.',
    'about.close': 'Fermer',
  },
}

export const LANGUAGES = ['en', 'fr']

/** La langue retenue au dernier lancement. Anglais par défaut, comme les autres apps. */
export function loadLang() {
  return localStorage.getItem(LANG_KEY) === 'fr' ? 'fr' : 'en'
}

export function saveLang(lang) {
  localStorage.setItem(LANG_KEY, LANGUAGES.includes(lang) ? lang : 'en')
}

export function keysOf(lang) {
  return Object.keys(dict[lang])
}

export function getT(lang) {
  const table = dict[lang] ?? dict.en
  return (key, vars) => {
    let s = table[key] ?? dict.en[key] ?? key
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v))
    return s
  }
}

/** Applique `lang` au document : `data-i18n` remplace le texte, `data-i18n-title`
 * l'infobulle. Rien d'autre n'est touché, pour que le HTML reste lisible. */
export function applyLang(lang, root = document) {
  const t = getT(lang)
  root.documentElement && (root.documentElement.lang = lang)
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n)
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle)
  }
  return t
}

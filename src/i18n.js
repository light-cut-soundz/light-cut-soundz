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
    'fade.curve': 'Curve',
    'fade.linear': 'Linear',
    'fade.equalPower': 'Equal power',

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
    'filter.slope': 'Slope',
    'filter.q': 'Q',

    // Export
    'export.run': 'Export',
    'export.cancel': 'Cancel',
    'export.depth': 'WAV sample format',
    'depth.float32': '32-bit float',
    'depth.pcm24': '24-bit',
    'depth.pcm16': '16-bit (dithered)',
    'export.progress': 'Processing… {percent}%',
    'export.cancelled': 'Export cancelled',
    'export.done': 'Exported: {name}',

    // Messages
    'msg.loading': 'Loading…',
    'msg.error': 'Error: {error}',
    'msg.unreachable': 'Cannot read the file ({status})',
    'msg.previewUnavailable': 'Preview unavailable for this format — the export still works.',

    // Updates
    'update.checking': 'Checking for updates…',
    'update.upToDate': 'LightCutSoundz is up to date',
    'update.available': 'Version {version} is available',
    'update.install': 'Install and restart',
    'update.notes': 'What’s new',
    'update.hideNotes': 'Hide',
    'update.later': 'Later',
    'update.downloading': 'Downloading v{version}… {percent}%',
    'update.restarting': 'Update installed — restarting…',
    'update.waitingForExport': 'Update installed — restarting once the export is done…',
    'update.failed': 'Update check failed: {error}',

    // Filter types
    'filter.lowpass': 'Low-pass',
    'filter.highpass': 'High-pass',
    'filter.bandpass': 'Band-pass',

    // File badge
    'badge.meta': '{channels}ch · {rate}Hz · {duration}',

    // Accessibility labels
    'player.waveform':
      'Waveform. Click or use the arrow keys to move the playhead; I and O set the trim start and end at the playhead.',
    'trim.toggle': 'Enable trim',
    // Errors (codes sent by the backend, and by the checks made before it)
    'err.trim_range': 'Invalid trim range {start}–{end} s (the audio is {total} s long)',
    'err.trim_empty': 'The selected range contains no audio',
    'err.fade_too_long.in': 'The fade in ({secs} s) is longer than the audio kept',
    'err.fade_too_long.out': 'The fade out ({secs} s) is longer than the audio kept',
    'err.filter_value': 'Invalid frequency or bandwidth: “{value}”',
    'err.filter_range': 'The frequency {hz} Hz must be between 0 and {max} Hz',
    'err.filter_bandwidth': 'The bandwidth must be a positive number (got {hz} Hz)',
    'err.filter_spec': 'Invalid filter: {spec}',
    'err.cannot_open': 'Cannot open “{path}”',
    'err.cannot_write': 'Cannot write “{path}”',
    'err.unsupported_format': 'This audio format is not supported',
    'err.empty_audio': 'The file contains no audio',
    'err.ffmpeg_missing': 'ffmpeg was not found — install it to export MP3, FLAC, OGG or M4A',
    'err.ffmpeg_failed': 'ffmpeg could not encode {format}: {detail}',
    'err.unknown_format': 'Unknown export format: {format}',
    'err.speed_invalid': 'Invalid speed factor',
    'err.cancelled': 'Export cancelled',
    'err.path_not_approved': '“{path}” was not chosen with the file picker or dropped on the window',
    'err.wav_depth': 'Unknown WAV sample format: {value}',
    'err.fade_curve': 'Unknown fade curve: {value}',
    'err.filter_slope': 'The slope must be 12, 24, 36 or 48 dB/octave (got {value})',
    'err.filter_q': 'Q must be a positive number (got “{value}”)',
    'err.filter_q_slope': 'Q can only be set on a 12 dB/octave filter',

    // About
    'about.title': 'About LightCutSoundz',
    'about.version': 'Version {version}',
    'about.tagline': 'Lightweight audio editor — trim, fade, normalise, export.',
    'about.licenses':
      'Includes FFmpeg (LGPL), LAME and the Xiph libraries. Licences and sources: THIRD_PARTY_LICENSES.md, installed with the app.',
    'about.close': 'Close',

    // Changelog
    'changelog.title': 'What’s new',
    'changelog.unreleased': 'Unreleased',
    'changelog.empty': 'No changelog available.',
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
    'fade.curve': 'Courbe',
    'fade.linear': 'Linéaire',
    'fade.equalPower': 'Puissance égale',

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
    'filter.slope': 'Pente',
    'filter.q': 'Q',

    // Export
    'export.run': 'Exporter',
    'export.cancel': 'Annuler',
    'export.depth': 'Format des échantillons WAV',
    'depth.float32': 'Flottant 32 bits',
    'depth.pcm24': '24 bits',
    'depth.pcm16': '16 bits (dithering)',
    'export.progress': 'Traitement… {percent} %',
    'export.cancelled': 'Export annulé',
    'export.done': 'Export réussi : {name}',

    // Messages
    'msg.loading': 'Chargement…',
    'msg.error': 'Erreur : {error}',
    'msg.unreachable': "Impossible d'accéder au fichier ({status})",
    'msg.previewUnavailable': "Aperçu indisponible pour ce format ; l'export fonctionne.",

    // Updates
    'update.checking': 'Recherche de mises à jour…',
    'update.upToDate': 'LightCutSoundz est à jour',
    'update.available': 'La version {version} est disponible',
    'update.install': 'Installer et redémarrer',
    'update.notes': 'Nouveautés',
    'update.hideNotes': 'Masquer',
    'update.later': 'Plus tard',
    'update.downloading': 'Téléchargement de la v{version}… {percent} %',
    'update.restarting': 'Mise à jour installée — redémarrage…',
    'update.waitingForExport': "Mise à jour installée — redémarrage à la fin de l'export…",
    'update.failed': 'Échec de la recherche de mise à jour : {error}',

    // Filter types
    'filter.lowpass': 'Passe-bas',
    'filter.highpass': 'Passe-haut',
    'filter.bandpass': 'Passe-bande',

    // File badge
    'badge.meta': '{channels} can. · {rate} Hz · {duration}',

    // Accessibility labels
    'player.waveform':
      'Forme d’onde. Clique ou utilise les flèches pour déplacer la tête de lecture ; I et O placent le début et la fin du trim sur la tête de lecture.',
    'trim.toggle': 'Activer le trim',
    // Errors (codes sent by the backend, and the checks made before it)
    'err.trim_range': "Plage de trim invalide {start}–{end} s (l'audio dure {total} s)",
    'err.trim_empty': 'La plage sélectionnée ne contient aucun audio',
    'err.fade_too_long.in': "Le fondu entrant ({secs} s) dépasse l'audio conservé",
    'err.fade_too_long.out': "Le fondu sortant ({secs} s) dépasse l'audio conservé",
    'err.filter_value': 'Fréquence ou largeur invalide : « {value} »',
    'err.filter_range': 'La fréquence {hz} Hz doit être comprise entre 0 et {max} Hz',
    'err.filter_bandwidth': 'La largeur doit être un nombre positif (reçu {hz} Hz)',
    'err.filter_spec': 'Filtre invalide : {spec}',
    'err.cannot_open': 'Impossible d’ouvrir « {path} »',
    'err.cannot_write': 'Impossible d’écrire « {path} »',
    'err.unsupported_format': "Ce format audio n'est pas pris en charge",
    'err.empty_audio': 'Le fichier ne contient aucun audio',
    'err.ffmpeg_missing': "ffmpeg est introuvable — installe-le pour exporter en MP3, FLAC, OGG ou M4A",
    'err.ffmpeg_failed': "ffmpeg n'a pas pu encoder en {format} : {detail}",
    'err.unknown_format': "Format d'export inconnu : {format}",
    'err.speed_invalid': 'Facteur de vitesse invalide',
    'err.cancelled': 'Export annulé',
    'err.path_not_approved': '« {path} » n’a pas été choisi avec le sélecteur de fichiers ni déposé sur la fenêtre',
    'err.wav_depth': 'Format d’échantillons WAV inconnu : {value}',
    'err.fade_curve': 'Courbe de fondu inconnue : {value}',
    'err.filter_slope': 'La pente doit valoir 12, 24, 36 ou 48 dB/octave (reçu {value})',
    'err.filter_q': 'Q doit être un nombre positif (reçu « {value} »)',
    'err.filter_q_slope': 'Q ne se règle que sur un filtre à 12 dB/octave',

    // About
    'about.title': 'À propos de LightCutSoundz',
    'about.version': 'Version {version}',
    'about.tagline': 'Éditeur audio léger — trimmer, fondre, normaliser, exporter.',
    'about.licenses':
      'Inclut FFmpeg (LGPL), LAME et les bibliothèques Xiph. Licences et sources : THIRD_PARTY_LICENSES.md, installé avec l’application.',
    'about.close': 'Fermer',

    // Changelog
    'changelog.title': 'Nouveautés',
    'changelog.unreleased': 'Non publié',
    'changelog.empty': 'Aucun journal des modifications disponible.',
  },
}

export const LANGUAGES = ['en', 'fr']

/** The language saved at the last launch. English by default, like other apps. */
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
    // split/join rather than `replace`: a value containing `$&` must not be
    // interpreted, and `replaceAll` is missing from the oldest WebKit targeted.
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v))
    return s
  }
}

/** Applies `lang` to the document: `data-i18n` replaces the text,
 * `data-i18n-title` the tooltip, `data-i18n-aria` the accessible label. Nothing
 * else is touched, so the HTML stays readable. */
export function applyLang(lang, root = document) {
  const t = getT(lang)
  root.documentElement && (root.documentElement.lang = lang)
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n)
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle)
  }
  for (const el of root.querySelectorAll('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria))
  }
  return t
}

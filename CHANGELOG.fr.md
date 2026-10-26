# Journal des modifications

Toutes les modifications notables de LightCutSoundz. Version anglaise : [CHANGELOG.md](CHANGELOG.md).

Le format suit [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/) et le projet utilise le [versionnage sémantique](https://semver.org/lang/fr/). Chaque version doit figurer dans **les deux** fichiers : l'application affiche celui de la langue de l'utilisateur, et les notes affichées avant une mise à jour en sont tirées.

## [Unreleased]

## [1.1.0] - 2026-10-26

### Ajouté
- Progression de l'export, et bouton Annuler pendant qu'il tourne.
- Export WAV en 32 bits flottants, 24 bits ou 16 bits avec dithering ; export M4A (AAC).
- Titre, artiste, album… et la pochette sont conservés à l'export en MP3, FLAC et M4A (tags seuls pour OGG).
- Courbe de fondu à puissance égale ; passe-bas et passe-haut de 12 à 48 dB/octave, avec un Q réglable sur un seul étage.
- Ouverture de fichiers en ligne de commande et par « Ouvrir avec… » ; import AIFF, CAF, MKA et WebM.
- Les réglages sont vérifiés avant l'export : le champ fautif est signalé et la raison indiquée dans la langue de l'interface.
- Ce journal des modifications, dans l'application (Aide ▸ Nouveautés) et avant l'installation d'une mise à jour.
- Les licences tierces sont livrées avec l'application.

### Modifié
- La normalisation s'applique en dernier : le fichier exporté culmine vraiment à −1 dBFS, quels que soient la vitesse ou le filtre.
- L'aperçu correspond à l'export : même cible de normalisation, fondus qui se chevauchent multipliés, même forme de filtre.
- Les mises à jour sont annoncées et installées seulement quand vous le décidez, jamais pendant un export.
- Le FFmpeg embarqué est une petite version LGPL, audio uniquement (environ 3 Mo au lieu de 80 Mo), compilée depuis des sources vérifiées.
- L'export est écrit dans un fichier temporaire puis déplacé : un export échoué ou annulé ne détruit plus le fichier qu'il aurait remplacé.
- Chargement et export plus rapides : le fichier n'est décodé qu'une fois, le travail ne bloque plus l'interface, la forme d'onde est mise en cache pendant la lecture.
- Les exports MP3 sont de meilleure qualité (VBR ≈ 190 kb/s).

### Corrigé
- Les fichiers situés dans un dossier caché, `/tmp` ou un montage réseau ne pouvaient pas être ouverts.
- Un format que le système ne sait pas prévisualiser n'empêche plus d'ouvrir et d'exporter le fichier.
- Exporter sans taper d'extension n'échoue plus ; l'extension du format choisi est ajoutée.
- L'arrêt de la lecture à la fin du trim et les fondus ne dépendent plus de la visibilité de la fenêtre.
- Plusieurs problèmes plus petits : exports de trim vides, régions silencieuses avec normalisation, valeurs de filtre comme `NaN`, barre d'espace sur les boutons, messages d'erreur en anglais, etc.

### Sécurité
- Seuls les fichiers que vous avez choisis, déposés ou passés au lancement peuvent être lus ou écrits ; une politique de sécurité du contenu est activée.
- Les téléchargements de `install.sh` sont vérifiés par SHA-256 avant installation, et les workflows de release épinglent leurs actions.

## [1.0.0] - 2026-08-19

### Ajouté
- Première version : trim, fondus, normalisation au pic, changement de vitesse, filtres passe-bas / passe-haut / passe-bande.
- Aperçu en temps réel, forme d'onde avec poignées de trim déplaçables.
- Export en WAV, MP3, FLAC et OGG.
- Interface en anglais et en français, mises à jour automatiques, installeurs pour macOS (Homebrew) et Linux (`.deb`, AppImage).

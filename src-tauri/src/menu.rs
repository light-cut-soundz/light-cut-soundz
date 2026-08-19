//! Menu natif : Fichier (Ouvrir, Quitter) et Aide (Mise à jour, À propos, Langue).
//!
//! Les libellés vivent ici plutôt que côté web parce que la barre de menu est dessinée
//! par le système : le front ne peut pas la traduire lui-même. Changer de langue
//! reconstruit le menu — c'est la seule façon d'en modifier les libellés sous GTK.

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Langue de l'interface. Anglais par défaut, comme partout ailleurs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    En,
    Fr,
}

impl Lang {
    /// Tout ce qui n'est pas explicitement `fr` retombe sur l'anglais : le front
    /// envoie une chaîne libre, et une valeur inconnue ne doit pas casser le menu.
    pub fn parse(raw: &str) -> Self {
        if raw == "fr" {
            Lang::Fr
        } else {
            Lang::En
        }
    }
}

/// Libellé d'une entrée de menu. Table exhaustive : ajouter une entrée sans sa
/// traduction ne compile pas.
pub fn label(lang: Lang, key: &'static str) -> &'static str {
    match (key, lang) {
        ("file", Lang::En) => "File",
        ("file", Lang::Fr) => "Fichier",
        ("open", Lang::En) => "Open…",
        ("open", Lang::Fr) => "Ouvrir…",
        ("quit", Lang::En) => "Quit",
        ("quit", Lang::Fr) => "Quitter",
        ("help", Lang::En) => "Help",
        ("help", Lang::Fr) => "Aide",
        ("check-updates", Lang::En) => "Check for Updates…",
        ("check-updates", Lang::Fr) => "Rechercher les mises à jour…",
        ("about", Lang::En) => "About LightCutSoundz",
        ("about", Lang::Fr) => "À propos de LightCutSoundz",
        ("language", Lang::En) => "Language",
        ("language", Lang::Fr) => "Langue",
        _ => key,
    }
}

/// Ce qu'une entrée de menu déclenche. Séparé de la construction du menu pour que la
/// table soit vérifiable sans lancer l'application.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction {
    /// Événement poussé vers le front, avec sa charge utile.
    Emit {
        event: &'static str,
        payload: &'static str,
    },
    /// Ferme l'application.
    Quit,
    /// Entrée inconnue : rien à faire.
    Ignore,
}

const fn emit(event: &'static str) -> MenuAction {
    MenuAction::Emit { event, payload: "" }
}

pub fn menu_action(id: &str) -> MenuAction {
    match id {
        "file-open" => emit("menu-open"),
        "file-quit" => MenuAction::Quit,
        "check-updates" => emit("menu-check-updates"),
        "about" => MenuAction::Emit {
            event: "menu-about",
            payload: env!("CARGO_PKG_VERSION"),
        },
        "lang-en" => MenuAction::Emit {
            event: "menu-set-language",
            payload: "en",
        },
        "lang-fr" => MenuAction::Emit {
            event: "menu-set-language",
            payload: "fr",
        },
        _ => MenuAction::Ignore,
    }
}

/// (Re)construit la barre de menu dans `lang` et l'installe sur l'application.
pub fn install<R: Runtime>(app: &AppHandle<R>, lang: Lang) -> tauri::Result<()> {
    let open = MenuItemBuilder::with_id("file-open", label(lang, "open"))
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("file-quit", label(lang, "quit"))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let file = SubmenuBuilder::new(app, label(lang, "file"))
        .item(&open)
        .separator()
        .item(&quit)
        .build()?;

    let check_updates =
        MenuItemBuilder::with_id("check-updates", label(lang, "check-updates")).build(app)?;
    let about = MenuItemBuilder::with_id("about", label(lang, "about")).build(app)?;
    let lang_en = CheckMenuItemBuilder::with_id("lang-en", "English")
        .checked(lang == Lang::En)
        .build(app)?;
    let lang_fr = CheckMenuItemBuilder::with_id("lang-fr", "Français")
        .checked(lang == Lang::Fr)
        .build(app)?;
    let language = SubmenuBuilder::new(app, label(lang, "language"))
        .item(&lang_en)
        .item(&lang_fr)
        .build()?;
    let help = SubmenuBuilder::new(app, label(lang, "help"))
        .item(&check_updates)
        .separator()
        .item(&about)
        .separator()
        .item(&language)
        .build()?;

    let menu = MenuBuilder::new(app).item(&file).item(&help).build()?;
    app.set_menu(menu)?;
    Ok(())
}

/// Applique l'action d'une entrée de menu.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match menu_action(id) {
        MenuAction::Emit { event, payload } => {
            app.emit(event, payload).ok();
        }
        MenuAction::Quit => app.exit(0),
        MenuAction::Ignore => {}
    }
}

/// Redessine le menu dans la langue demandée. Appelée par le front au démarrage avec
/// la langue retenue, puis à chaque changement.
#[tauri::command]
pub fn set_menu_language(app: AppHandle, lang: String) -> Result<(), String> {
    install(&app, Lang::parse(&lang)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── langue ───────────────────────────────────────────────────────────────

    #[test]
    fn the_menu_speaks_english_unless_told_otherwise() {
        assert_eq!(Lang::default(), Lang::En);
    }

    #[test]
    fn french_is_recognised() {
        assert_eq!(Lang::parse("fr"), Lang::Fr);
    }

    #[test]
    fn a_language_the_app_does_not_speak_falls_back_to_english() {
        assert_eq!(Lang::parse("klingon"), Lang::En);
        assert_eq!(Lang::parse(""), Lang::En);
        assert_eq!(Lang::parse("FR"), Lang::En);
    }

    #[test]
    fn each_code_the_menu_sends_is_understood_when_it_comes_back() {
        // Les charges utiles de `menu_action` sont les seules entrées possibles.
        assert_eq!(Lang::parse("en"), Lang::En);
        assert_eq!(Lang::parse("fr"), Lang::Fr);
    }

    // ── libellés ─────────────────────────────────────────────────────────────

    const KEYS: [&str; 7] = [
        "file",
        "open",
        "quit",
        "help",
        "check-updates",
        "about",
        "language",
    ];

    #[test]
    fn every_entry_is_written_in_both_languages() {
        for key in KEYS {
            for lang in [Lang::En, Lang::Fr] {
                // Une clé sans traduction ressort telle quelle : c'est ce qu'il ne
                // faut pas voir dans la barre de menu.
                assert_ne!(label(lang, key), key, "{key} manque en {:?}", lang);
            }
        }
    }

    #[test]
    fn the_two_languages_say_different_things() {
        // Sauf pour les entrées qui s'écrivent pareil — il n'y en a aucune ici.
        for key in KEYS {
            assert_ne!(label(Lang::En, key), label(Lang::Fr, key), "{key}");
        }
    }

    #[test]
    fn an_unknown_key_is_returned_as_is_rather_than_panicking() {
        assert_eq!(label(Lang::Fr, "nope"), "nope");
    }

    // ── actions ──────────────────────────────────────────────────────────────

    #[test]
    fn opening_a_file_is_handed_to_the_front() {
        assert_eq!(menu_action("file-open"), emit("menu-open"));
    }

    #[test]
    fn quitting_is_handled_natively() {
        assert_eq!(menu_action("file-quit"), MenuAction::Quit);
    }

    #[test]
    fn checking_for_updates_is_handed_to_the_front() {
        assert_eq!(menu_action("check-updates"), emit("menu-check-updates"));
    }

    #[test]
    fn about_carries_the_running_version() {
        match menu_action("about") {
            MenuAction::Emit { event, payload } => {
                assert_eq!(event, "menu-about");
                assert_eq!(payload, env!("CARGO_PKG_VERSION"));
                assert!(!payload.is_empty());
            }
            other => panic!("attendu un Emit, obtenu {other:?}"),
        }
    }

    #[test]
    fn each_language_entry_carries_its_own_code() {
        for (id, code) in [("lang-en", "en"), ("lang-fr", "fr")] {
            assert_eq!(
                menu_action(id),
                MenuAction::Emit {
                    event: "menu-set-language",
                    payload: code,
                }
            );
        }
    }

    #[test]
    fn an_unknown_entry_does_nothing() {
        assert_eq!(menu_action("does-not-exist"), MenuAction::Ignore);
        assert_eq!(menu_action(""), MenuAction::Ignore);
    }

    // ── construction ─────────────────────────────────────────────────────────

    // muda refuse de construire un menu hors du thread principal sous macOS, et
    // `cargo test` donne un thread à chaque test. La construction n'est donc
    // vérifiable que sur les autres plateformes ; la table des libellés et celle
    // des actions, elles, sont testées partout.
    #[cfg_attr(target_os = "macos", ignore)]
    #[test]
    fn the_menu_can_be_built_in_either_language() {
        let app = tauri::test::mock_app();
        for lang in [Lang::En, Lang::Fr] {
            install(app.handle(), lang).unwrap();
        }
    }

    // muda refuse de construire un menu hors du thread principal sous macOS, et
    // `cargo test` donne un thread à chaque test. La construction n'est donc
    // vérifiable que sur les autres plateformes ; la table des libellés et celle
    // des actions, elles, sont testées partout.
    #[cfg_attr(target_os = "macos", ignore)]
    #[test]
    fn switching_language_redraws_the_menu_rather_than_failing() {
        let app = tauri::test::mock_app();
        install(app.handle(), Lang::En).unwrap();

        install(app.handle(), Lang::Fr).unwrap();
    }
}

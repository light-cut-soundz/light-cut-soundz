//! Native menu: File (Open, Quit) and Help (Updates, About, Language).
//!
//! The labels live here rather than on the web side because the menu bar is drawn
//! by the system: the front end cannot translate it itself. Changing language
//! rebuilds the menu — the only way to change its labels under GTK.

use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// Interface language. English by default, as everywhere else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Lang {
    #[default]
    En,
    Fr,
}

impl Lang {
    /// Tout ce qui n'est pas explicitement `fr` retombe sur l'anglais : le front
    /// sends a free-form string, and an unknown value must not break the menu.
    pub fn parse(raw: &str) -> Self {
        if raw == "fr" {
            Lang::Fr
        } else {
            Lang::En
        }
    }
}

/// Label of a menu entry. An unknown key is returned as is rather than failing
/// the construction of the menu; the `KEYS` test below checks that every entry
/// in use is translated in both languages.
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
        ("changelog", Lang::En) => "What's New…",
        ("changelog", Lang::Fr) => "Nouveautés…",
        ("language", Lang::En) => "Language",
        ("language", Lang::Fr) => "Langue",
        ("edit", Lang::En) => "Edit",
        ("edit", Lang::Fr) => "Édition",
        ("undo", Lang::En) => "Undo",
        ("undo", Lang::Fr) => "Annuler",
        ("redo", Lang::En) => "Redo",
        ("redo", Lang::Fr) => "Rétablir",
        ("cut", Lang::En) => "Cut",
        ("cut", Lang::Fr) => "Couper",
        ("copy", Lang::En) => "Copy",
        ("copy", Lang::Fr) => "Copier",
        ("paste", Lang::En) => "Paste",
        ("paste", Lang::Fr) => "Coller",
        ("select-all", Lang::En) => "Select All",
        ("select-all", Lang::Fr) => "Tout sélectionner",
        ("hide", Lang::En) => "Hide LightCutSoundz",
        ("hide", Lang::Fr) => "Masquer LightCutSoundz",
        ("hide-others", Lang::En) => "Hide Others",
        ("hide-others", Lang::Fr) => "Masquer les autres",
        ("show-all", Lang::En) => "Show All",
        ("show-all", Lang::Fr) => "Tout afficher",
        ("window", Lang::En) => "Window",
        ("window", Lang::Fr) => "Fenêtre",
        ("minimize", Lang::En) => "Minimize",
        ("minimize", Lang::Fr) => "Réduire",
        _ => key,
    }
}

/// What a menu entry triggers. Kept apart from the construction of the menu so
/// that the table can be checked without starting the application.
#[derive(Debug, PartialEq, Eq)]
pub enum MenuAction {
    /// Event pushed to the front end, with its payload.
    Emit {
        event: &'static str,
        payload: &'static str,
    },
    /// Ferme l'application.
    Quit,
    /// Unknown entry: nothing to do.
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
        "changelog" => emit("menu-changelog"),
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
    let check_updates =
        MenuItemBuilder::with_id("check-updates", label(lang, "check-updates")).build(app)?;
    let about = MenuItemBuilder::with_id("about", label(lang, "about")).build(app)?;
    let changelog = MenuItemBuilder::with_id("changelog", label(lang, "changelog")).build(app)?;
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

    let file = SubmenuBuilder::new(app, label(lang, "file")).item(&open);
    let help = SubmenuBuilder::new(app, label(lang, "help"))
        .item(&check_updates)
        .item(&changelog);

    // On macOS the first submenu is the application menu: Quit and About live
    // there, and the text fields get no copy/paste or undo until an Edit menu
    // declares them.
    #[cfg(target_os = "macos")]
    let menu = {
        use tauri::menu::PredefinedMenuItem as P;
        let t = |key| Some(label(lang, key));
        let app_menu = SubmenuBuilder::new(app, "LightCutSoundz")
            .item(&about)
            .separator()
            .item(&P::hide(app, t("hide"))?)
            .item(&P::hide_others(app, t("hide-others"))?)
            .item(&P::show_all(app, t("show-all"))?)
            .separator()
            .item(&quit)
            .build()?;
        let edit = SubmenuBuilder::new(app, label(lang, "edit"))
            .item(&P::undo(app, t("undo"))?)
            .item(&P::redo(app, t("redo"))?)
            .separator()
            .item(&P::cut(app, t("cut"))?)
            .item(&P::copy(app, t("copy"))?)
            .item(&P::paste(app, t("paste"))?)
            .item(&P::select_all(app, t("select-all"))?)
            .build()?;
        let window = SubmenuBuilder::new(app, label(lang, "window"))
            .item(&P::minimize(app, t("minimize"))?)
            .build()?;
        let help = help.separator().item(&language).build()?;
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file.build()?)
            .item(&edit)
            .item(&window)
            .item(&help)
            .build()?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = {
        let file = file.separator().item(&quit).build()?;
        let help = help
            .separator()
            .item(&about)
            .separator()
            .item(&language)
            .build()?;
        MenuBuilder::new(app).item(&file).item(&help).build()?
    };

    app.set_menu(menu)?;
    Ok(())
}

/// Applies the action of a menu entry.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match menu_action(id) {
        MenuAction::Emit { event, payload } => {
            app.emit(event, payload).ok();
        }
        MenuAction::Quit => app.exit(0),
        MenuAction::Ignore => {}
    }
}

/// Redraws the menu in the requested language. Called by the front end at startup
/// with the saved language, then at every change.
#[tauri::command]
pub fn set_menu_language(app: AppHandle, lang: String) -> Result<(), String> {
    install(&app, Lang::parse(&lang)).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── language ───────────────────────────────────────────────────────────────

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
        // The payloads of `menu_action` are the only possible inputs.
        assert_eq!(Lang::parse("en"), Lang::En);
        assert_eq!(Lang::parse("fr"), Lang::Fr);
    }

    // ── labels ─────────────────────────────────────────────────────────────

    const KEYS: [&str; 20] = [
        "changelog",
        "file",
        "open",
        "quit",
        "help",
        "check-updates",
        "about",
        "language",
        "edit",
        "undo",
        "redo",
        "cut",
        "copy",
        "paste",
        "select-all",
        "hide",
        "hide-others",
        "show-all",
        "window",
        "minimize",
    ];

    #[test]
    fn every_entry_is_written_in_both_languages() {
        for key in KEYS {
            for lang in [Lang::En, Lang::Fr] {
                // A key with no translation comes back as is: exactly what must
                // not show in the menu bar.
                assert_ne!(label(lang, key), key, "{key} manque en {:?}", lang);
            }
        }
    }

    #[test]
    fn the_two_languages_say_different_things() {
        // Except for entries spelled the same in both — there are none here.
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
    fn the_changelog_is_handed_to_the_front() {
        assert_eq!(menu_action("changelog"), emit("menu-changelog"));
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

    // muda refuses to build a menu off the main thread on macOS, and
    // `cargo test` gives every test its own thread. Building is therefore only
    // checkable on the other platforms; the label table and the action table
    // are tested everywhere.
    #[cfg_attr(target_os = "macos", ignore)]
    #[test]
    fn the_menu_can_be_built_in_either_language() {
        let app = tauri::test::mock_app();
        for lang in [Lang::En, Lang::Fr] {
            install(app.handle(), lang).unwrap();
        }
    }

    #[cfg_attr(target_os = "macos", ignore)]
    #[test]
    fn switching_language_redraws_the_menu_rather_than_failing() {
        let app = tauri::test::mock_app();
        install(app.handle(), Lang::En).unwrap();

        install(app.handle(), Lang::Fr).unwrap();
    }
}

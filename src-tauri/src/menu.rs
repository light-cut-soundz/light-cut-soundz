//! Native menu: File (Open, Quit) and Help (Updates, About, Language).
//!
//! The labels live here rather than on the web side because the menu bar is drawn
//! by the system: the front end cannot translate it itself. Changing language
//! rebuilds the menu — the only way to change its labels under GTK.

use crate::approval::Approved;
use crate::recent::{self, RecentFile};
use std::sync::Mutex;
use tauri::menu::{CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

/// Paints the GTK menus like LightCutVidz's (measured on its screenshots: the
/// bar is the title bar's grey and 29 px tall; entries are 33 px tall, set in
/// 15.7 px with 19 px at each side; a popup has 10 px above and below), so that
/// the apps of the suite look alike. They stay dark whatever the theme of the
/// page: LightCutVidz's menus are, and GTK draws these with the system's theme.
#[cfg(target_os = "linux")]
pub fn style_menu_bar() {
    use gtk::prelude::{CssProviderExt, GtkSettingsExt};
    // Chromium (LightCutVidz) draws its text unhinted; GTK follows the system's
    // "slight" hinting, which makes the glyphs a pixel shorter.
    if let Some(settings) = gtk::Settings::default() {
        settings.set_gtk_xft_hinting(0);
        settings.set_gtk_xft_hintstyle(Some("hintnone"));
    }
    let provider = gtk::CssProvider::new();
    // GTK reserves 25 px before an entry's text and `muda` pulls a submenu's
    // box back by a fixed -22 px. The negative margins below bring every label
    // to 20 px from the popup's edge, as in LightCutVidz; USER priority lets
    // this sheet win over `muda`'s own rule.
    let css = "\
        menubar { background-color: #2c2c2c; min-height: 29px; } \
        menubar > menuitem { min-height: 29px; padding-top: 0; padding-bottom: 0; } \
        menubar > menuitem label { color: #f7f7f7; } \
        .csd.popup decoration { box-shadow: 0 1px 2px transparent, 0 0 0 1px transparent; } \
        menu { padding: 10px 0; border: none; border-radius: 8px; box-shadow: none; background-color: #1d1d1d; } \
        menu menuitem { min-height: 33px; padding: 0 19px 0 0; margin-left: -5px; font-size: 15.7px; } \
        menu menuitem:hover { background-color: #3a3a3a; } \
        menu menuitem > box { margin: 0 0 0 -25px; } \
        menu menuitem > box > image { min-width: 0; margin: 0 0 0 3px; } \
        menu menuitem label { color: #f7f7f7; } \
        menu menuitem check { min-width: 16px; min-height: 16px; margin-left: 16px; margin-right: 12px; border: 2px solid #f7f7f7; border-radius: 50%; background-color: transparent; background-image: none; box-shadow: none; -gtk-icon-source: none; } \
        menu menuitem check:checked { border-color: #7c3aed; background-image: radial-gradient(circle, #7c3aed 38%, transparent 42%); } \
        menu menuitem:disabled label { color: #929292; } \
        menu separator { margin: 8px 0; }";
    if provider.load_from_data(css.as_bytes()).is_err() {
        return;
    }
    if let Some(screen) = gtk::gdk::Screen::default() {
        gtk::StyleContext::add_provider_for_screen(
            &screen,
            &provider,
            gtk::STYLE_PROVIDER_PRIORITY_USER,
        );
    }
}

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

/// Colour theme chosen in View → Theme.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

impl Theme {
    /// Anything that is not `light` or `dark` follows the system.
    pub fn parse(raw: &str) -> Self {
        match raw {
            "light" => Theme::Light,
            "dark" => Theme::Dark,
            _ => Theme::System,
        }
    }

    pub fn window_theme(self) -> Option<tauri::Theme> {
        match self {
            Theme::System => None,
            Theme::Light => Some(tauri::Theme::Light),
            Theme::Dark => Some(tauri::Theme::Dark),
        }
    }
}

/// What the menu shows besides its fixed entries.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct MenuPrefs {
    pub lang: Lang,
    pub theme: Theme,
    pub can_undo: bool,
    pub can_redo: bool,
}

/// The preferences the menu is currently drawn with.
#[derive(Default)]
pub struct MenuState(pub Mutex<MenuPrefs>);

/// Label of a menu entry. An unknown key is returned as is rather than failing
/// the construction of the menu; the `KEYS` test below checks that every entry
/// in use is translated in both languages.
pub fn label(lang: Lang, key: &'static str) -> &'static str {
    match (key, lang) {
        ("file", Lang::En) => "File",
        ("file", Lang::Fr) => "Fichier",
        ("open", Lang::En) => "Open audio file…",
        ("open", Lang::Fr) => "Ouvrir un fichier audio…",
        ("open-recent", Lang::En) => "Open recent",
        ("open-recent", Lang::Fr) => "Ouvrir récent",
        ("clear-recent", Lang::En) => "Clear recent",
        ("clear-recent", Lang::Fr) => "Effacer les récents",
        ("quit", Lang::En) => "Quit",
        ("quit", Lang::Fr) => "Quitter",
        ("help", Lang::En) => "Help",
        ("help", Lang::Fr) => "Aide",
        ("check-updates", Lang::En) => "Check for Updates…",
        ("check-updates", Lang::Fr) => "Vérifier les mises à jour…",
        ("about", Lang::En) => "About LightCutSoundz",
        ("about", Lang::Fr) => "À propos de LightCutSoundz",
        ("changelog", Lang::En) => "What's new",
        ("changelog", Lang::Fr) => "Nouveautés",
        ("language", Lang::En) => "Language",
        ("language", Lang::Fr) => "Langue",
        ("view", Lang::En) => "View",
        ("view", Lang::Fr) => "Affichage",
        ("fullscreen", Lang::En) => "Toggle Full Screen",
        ("fullscreen", Lang::Fr) => "Basculer en plein écran",
        ("theme", Lang::En) => "Theme",
        ("theme", Lang::Fr) => "Thème",
        ("theme-system", Lang::En) => "Follow the system",
        ("theme-system", Lang::Fr) => "Suivre le système",
        ("theme-light", Lang::En) => "Light",
        ("theme-light", Lang::Fr) => "Clair",
        ("theme-dark", Lang::En) => "Dark",
        ("theme-dark", Lang::Fr) => "Sombre",
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
    /// Opens the n-th entry of the recent list.
    OpenRecent(usize),
    ClearRecent,
    ToggleFullscreen,
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
        "recent-clear" => MenuAction::ClearRecent,
        "edit-undo" => emit("menu-undo"),
        "edit-redo" => emit("menu-redo"),
        "view-fullscreen" => MenuAction::ToggleFullscreen,
        "theme-system" => MenuAction::Emit {
            event: "menu-set-theme",
            payload: "system",
        },
        "theme-light" => MenuAction::Emit {
            event: "menu-set-theme",
            payload: "light",
        },
        "theme-dark" => MenuAction::Emit {
            event: "menu-set-theme",
            payload: "dark",
        },
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
        _ => match id.strip_prefix("recent-").and_then(|n| n.parse().ok()) {
            Some(n) => MenuAction::OpenRecent(n),
            None => MenuAction::Ignore,
        },
    }
}

/// (Re)construit la barre de menu et l'installe sur l'application. Same entries,
/// in the same order, as LightCutVidz's menu.
pub fn install<R: Runtime>(
    app: &AppHandle<R>,
    prefs: MenuPrefs,
    recent: &[RecentFile],
) -> tauri::Result<()> {
    let lang = prefs.lang;
    let open = MenuItemBuilder::with_id("file-open", label(lang, "open"))
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let quit = MenuItemBuilder::with_id("file-quit", label(lang, "quit"))
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    let mut recent_menu =
        SubmenuBuilder::new(app, label(lang, "open-recent")).enabled(!recent.is_empty());
    for (i, file) in recent.iter().enumerate() {
        recent_menu = recent_menu
            .item(&MenuItemBuilder::with_id(format!("recent-{i}"), file.name()).build(app)?);
    }
    let recent_menu = recent_menu
        .separator()
        .item(&MenuItemBuilder::with_id("recent-clear", label(lang, "clear-recent")).build(app)?)
        .build()?;

    let file = SubmenuBuilder::new(app, label(lang, "file"))
        .item(&open)
        .item(&recent_menu)
        .separator();

    let redo_accel = if cfg!(target_os = "macos") {
        "Cmd+Shift+Z"
    } else {
        "Ctrl+Y"
    };
    let undo = MenuItemBuilder::with_id("edit-undo", label(lang, "undo"))
        .accelerator("CmdOrCtrl+Z")
        .enabled(prefs.can_undo)
        .build(app)?;
    let redo = MenuItemBuilder::with_id("edit-redo", label(lang, "redo"))
        .accelerator(redo_accel)
        .enabled(prefs.can_redo)
        .build(app)?;
    let edit = SubmenuBuilder::new(app, label(lang, "edit"))
        .item(&undo)
        .item(&redo);

    let fullscreen_accel = if cfg!(target_os = "macos") {
        "Ctrl+Cmd+F"
    } else {
        "F11"
    };
    let fullscreen = MenuItemBuilder::with_id("view-fullscreen", label(lang, "fullscreen"))
        .accelerator(fullscreen_accel)
        .build(app)?;
    let mut theme = SubmenuBuilder::new(app, label(lang, "theme"));
    for (id, key, value) in [
        ("theme-system", "theme-system", Theme::System),
        ("theme-light", "theme-light", Theme::Light),
        ("theme-dark", "theme-dark", Theme::Dark),
    ] {
        theme = theme.item(
            &CheckMenuItemBuilder::with_id(id, label(lang, key))
                .checked(prefs.theme == value)
                .build(app)?,
        );
    }
    let view = SubmenuBuilder::new(app, label(lang, "view"))
        .item(&fullscreen)
        .item(&theme.build()?);

    let about = MenuItemBuilder::with_id("about", label(lang, "about")).build(app)?;
    let changelog = MenuItemBuilder::with_id("changelog", label(lang, "changelog")).build(app)?;
    let check_updates =
        MenuItemBuilder::with_id("check-updates", label(lang, "check-updates")).build(app)?;
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
        .item(&about)
        .item(&changelog)
        .separator()
        .item(&check_updates)
        .separator()
        .item(&language)
        .build()?;

    // On macOS the first submenu is the application menu, and the text fields
    // get no copy/paste until an Edit menu declares them.
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
        let edit = edit
            .separator()
            .item(&P::cut(app, t("cut"))?)
            .item(&P::copy(app, t("copy"))?)
            .item(&P::paste(app, t("paste"))?)
            .item(&P::select_all(app, t("select-all"))?)
            .build()?;
        MenuBuilder::new(app)
            .item(&app_menu)
            .item(&file.build()?)
            .item(&edit)
            .item(&view.build()?)
            .item(&help)
            .build()?
    };
    #[cfg(not(target_os = "macos"))]
    let menu = {
        let file = file.item(&quit).build()?;
        MenuBuilder::new(app)
            .item(&file)
            .item(&edit.build()?)
            .item(&view.build()?)
            .item(&help)
            .build()?
    };

    app.set_menu(menu)?;
    Ok(())
}

/// Redraws the menu from the current preferences and recent files. Always on
/// the main thread: macOS refuses to build a menu anywhere else, and this is
/// also called after a file load, which runs on the blocking pool.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(state) = handle.try_state::<MenuState>() else {
            return;
        };
        let prefs = *state.0.lock().unwrap_or_else(|e| e.into_inner());
        let list = recent::existing(&handle);
        if let Err(e) = install(&handle, prefs, &list) {
            eprintln!("Cannot redraw the menu: {e}");
        }
    });
}

fn update<R: Runtime>(app: &AppHandle<R>, change: impl FnOnce(&mut MenuPrefs)) {
    change(
        &mut app
            .state::<MenuState>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner()),
    );
    refresh(app);
}

/// Applies the action of a menu entry.
pub fn handle<R: Runtime>(app: &AppHandle<R>, id: &str) {
    match menu_action(id) {
        MenuAction::Emit { event, payload } => {
            app.emit(event, payload).ok();
        }
        MenuAction::Quit => app.exit(0),
        MenuAction::OpenRecent(n) => {
            if let Some(path) = recent::path_at(app, n) {
                app.state::<Approved>().allow_input(&path);
                app.emit("open-file", path).ok();
            }
        }
        MenuAction::ClearRecent => {
            recent::clear(app);
            refresh(app);
            // The home screen lists the same files.
            app.emit("recent-changed", ()).ok();
        }
        MenuAction::ToggleFullscreen => {
            if let Some(w) = app.get_webview_window("main") {
                let on = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!on);
            }
        }
        MenuAction::Ignore => {}
    }
}

/// Redraws the menu in the requested language. Called by the front end at startup
/// with the saved language, then at every change.
#[tauri::command]
pub fn set_menu_language(app: AppHandle, lang: String) {
    update(&app, |p| p.lang = Lang::parse(&lang));
}

/// Applies the theme chosen in View → Theme to the window (so that the page's
/// `prefers-color-scheme` follows) and ticks it in the menu.
#[tauri::command]
pub fn set_theme(app: AppHandle, theme: String) {
    let theme = Theme::parse(&theme);
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_theme(theme.window_theme());
    }
    update(&app, |p| p.theme = theme);
}

/// Tells the menu whether Undo and Redo have something to do.
#[tauri::command]
pub fn set_undo_redo(app: AppHandle, state: State<'_, MenuState>, can_undo: bool, can_redo: bool) {
    {
        let mut prefs = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if prefs.can_undo == can_undo && prefs.can_redo == can_redo {
            return;
        }
        prefs.can_undo = can_undo;
        prefs.can_redo = can_redo;
    }
    refresh(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

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

    const KEYS: [&str; 28] = [
        "changelog",
        "open-recent",
        "clear-recent",
        "view",
        "fullscreen",
        "theme",
        "theme-system",
        "theme-light",
        "theme-dark",
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
    fn the_edit_and_view_entries_are_wired() {
        assert_eq!(menu_action("edit-undo"), emit("menu-undo"));
        assert_eq!(menu_action("edit-redo"), emit("menu-redo"));
        assert_eq!(menu_action("view-fullscreen"), MenuAction::ToggleFullscreen);
    }

    #[test]
    fn each_theme_entry_carries_its_own_name() {
        for (id, name) in [
            ("theme-system", "system"),
            ("theme-light", "light"),
            ("theme-dark", "dark"),
        ] {
            assert_eq!(
                menu_action(id),
                MenuAction::Emit {
                    event: "menu-set-theme",
                    payload: name,
                }
            );
        }
    }

    #[test]
    fn recent_entries_are_numbered() {
        assert_eq!(menu_action("recent-0"), MenuAction::OpenRecent(0));
        assert_eq!(menu_action("recent-12"), MenuAction::OpenRecent(12));
        assert_eq!(menu_action("recent-clear"), MenuAction::ClearRecent);
        assert_eq!(menu_action("recent-x"), MenuAction::Ignore);
    }

    #[test]
    fn a_theme_that_is_not_light_or_dark_follows_the_system() {
        assert_eq!(Theme::parse("light"), Theme::Light);
        assert_eq!(Theme::parse("dark"), Theme::Dark);
        assert_eq!(Theme::parse("system"), Theme::System);
        assert_eq!(Theme::parse("neon"), Theme::System);
        assert_eq!(Theme::System.window_theme(), None);
        assert_eq!(Theme::Dark.window_theme(), Some(tauri::Theme::Dark));
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
    fn prefs(lang: Lang) -> MenuPrefs {
        MenuPrefs {
            lang,
            ..MenuPrefs::default()
        }
    }

    #[cfg_attr(target_os = "macos", ignore)]
    #[test]
    fn the_menu_can_be_built_in_either_language() {
        let app = tauri::test::mock_app();
        for lang in [Lang::En, Lang::Fr] {
            install(app.handle(), prefs(lang), &[]).unwrap();
        }
    }

    #[cfg_attr(target_os = "macos", ignore)]
    #[test]
    fn switching_language_redraws_the_menu_rather_than_failing() {
        let app = tauri::test::mock_app();
        install(app.handle(), prefs(Lang::En), &[]).unwrap();

        install(app.handle(), prefs(Lang::Fr), &[]).unwrap();
    }

    #[cfg_attr(target_os = "macos", ignore)]
    #[test]
    fn the_menu_can_be_built_with_recent_files_and_every_state() {
        let app = tauri::test::mock_app();
        let recent = [
            RecentFile::for_test("/home/me/a.wav"),
            RecentFile::for_test("/home/me/b.mp3"),
        ];
        for theme in [Theme::System, Theme::Light, Theme::Dark] {
            for (can_undo, can_redo) in [(false, false), (true, false), (true, true)] {
                let prefs = MenuPrefs {
                    lang: Lang::Fr,
                    theme,
                    can_undo,
                    can_redo,
                };
                install(app.handle(), prefs, &recent).unwrap();
            }
        }
    }
}

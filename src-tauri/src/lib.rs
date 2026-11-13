mod assets;
mod atomic;
mod config;
mod diagnostics;
mod docs;
mod error;
mod export;
mod history;
mod import;
mod markdown;
mod models;
mod notion;
mod notion_blocks;
mod notion_sync;
mod paths;
mod links;
mod search;
mod storage;
mod system;
mod update;
mod workspace;

use std::sync::Mutex;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // `opener` replaces the old `open` shell calls (macOS-only) and
        // `dialog` replaces the AppleScript folder picker, so links, reveal and
        // import all work on Windows too.
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            workspace::get_workspace_root,
            workspace::ensure_workspace,
            workspace::create_folder,
            workspace::rename_folder,
            workspace::delete_folder,
            workspace::create_doc,
            workspace::rename_doc,
            workspace::delete_doc,
            workspace::restore_node,
            workspace::purge_node,
            workspace::empty_trash,
            workspace::set_completed,
            workspace::set_pinned,
            workspace::move_node,
            workspace::restore_workspace,
            docs::read_doc,
            docs::save_doc,
            docs::duplicate_doc,
            docs::doc_stamp,
            docs::workspace_stamp,
            search::search_docs,
            links::backlinks_doc,
            storage::get_storage_state,
            storage::set_storage,
            storage::reveal_storage_folder,
            assets::save_asset,
            assets::delete_asset,
            assets::list_dir,
            system::open_url,
            diagnostics::report_client_error,
            notion::notion_get_state,
            notion::notion_connect,
            notion::notion_disconnect,
            notion::notion_set_parent,
            notion_sync::notion_sync_docs,
            notion_sync::notion_resolve_conflicts,
            export::export_doc,
            export::export_workspace,
            export::reveal_path,
            import::pick_import_folder,
            import::import_markdown,
            import::import_markdown_text,
            import::import_json_text,
            import::parse_markdown_body,
            history::list_doc_versions,
            history::restore_doc_version,
            history::read_doc_version,
            history::create_doc_version,
            config::get_history_limit,
            config::set_history_limit,
            config::get_history_enabled,
            config::set_history_enabled,
            update::update_check,
            update::update_download,
            update::update_install,
            update::update_startup_report,
            update::update_reveal_log,
        ])
        .setup(|app| {
            // the storage choice must be readable before the first command runs
            let cfg = config::load(app.handle());
            app.manage(config::ConfigState(Mutex::new(cfg)));
            let notion = notion::load(app.handle());
            app.manage(notion::NotionState(Mutex::new(notion)));
            app.manage(update::UpdateState::default());

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Novion");
}

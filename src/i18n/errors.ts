/**
 * Backend error codes → English message ids.
 *
 * Rust returns `{ code, message }`. The message is written for the developer
 * and may be in either language, so the interface translates the *code* instead
 * of showing that text. Codes without an entry (`io_error`, `json_error`) carry
 * details only the operating system knows and are shown verbatim.
 */
export const ERROR_MESSAGES: Record<string, string> = {
  not_found: "That item no longer exists.",
  invalid_argument: "That request was not valid.",
  doc_conflict:
    "This note changed on disk, possibly on another Mac. Saving was paused so the other version is not overwritten.",
  asset_scope: "That file lives outside the workspace.",
  no_config_dir: "The application support folder could not be located.",
  no_home_dir: "The home folder could not be located.",
  no_document_dir: "The workspace folder could not be located.",
  icloud_unavailable: "iCloud Drive is not available on this Mac.",
  pick_failed: "The folder picker could not be opened.",

  notion_no_token: "Notion is not connected yet.",
  notion_no_parent: "Choose a Notion page as the sync target first.",
  notion_invalid_token: "That token does not look like a Notion integration token.",
  notion_unauthorized: "Notion rejected the token. Check that it is complete and still active.",
  notion_forbidden: "The Notion integration has no access to that page. Share the page with it.",
  notion_not_found: "That Notion page no longer exists or is no longer shared.",
  notion_rate_limited: "Notion is limiting requests right now. Try again in a moment.",
  notion_network: "Could not reach Notion. Check your connection and try again.",
  notion_server: "Notion reported a server error. Try again later.",
  notion_validation: "Notion rejected the content of this page.",
  notion_conflict: "Notion reported a conflict while writing this page.",
  notion_api_error: "Notion returned an error.",
  notion_create_failed: "The page could not be created in Notion.",
  notion_upload: "The file could not be uploaded to Notion.",
  notion_append_failed: "The block content could not be written to Notion.",
  notion_bad_target: "That is not a page that can be used as a sync target.",

  update_network: "Could not reach GitHub. Check your connection and try again.",
  update_rate_limited: "GitHub is limiting update checks right now. Try again later.",
  update_incomplete: "The update download did not finish. Try again.",
  update_not_ready: "There is no downloaded update to install.",
  update_untrusted: "The update address was not a GitHub HTTPS address, so it was refused.",
  update_too_large: "The update file is unexpectedly large, so the download was cancelled.",
  update_checksum: "The downloaded update does not match its published checksum, so it was rejected.",
  update_unavailable: "This build cannot install updates automatically.",
  update_state: "The update state is unavailable. Restart the app and try again.",
};
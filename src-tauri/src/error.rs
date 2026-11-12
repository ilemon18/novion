use serde::Serialize;

/// Structured error surfaced to the frontend as `{ code, message }`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    pub code: String,
    pub message: String,
}

pub type AppResult<T> = Result<T, AppError>;

impl AppError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
        }
    }

    pub fn io(context: &str, err: std::io::Error) -> Self {
        Self::wrap(context, err)
    }

    /// Same shape as [`AppError::io`] for errors that are not `std::io::Error`
    /// (plugin calls, for instance).
    pub fn wrap(context: &str, err: impl std::fmt::Display) -> Self {
        Self::new("io_error", format!("{context}：{err}"))
    }

    pub fn json(context: &str, err: serde_json::Error) -> Self {
        Self::new("json_error", format!("{context}：{err}"))
    }

    pub fn not_found(context: &str) -> Self {
        Self::new("not_found", context)
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message)
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl From<AppError> for String {
    fn from(value: AppError) -> Self {
        value.message
    }
}
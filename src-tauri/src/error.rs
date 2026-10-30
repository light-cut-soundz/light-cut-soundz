//! Errors meant for the user: a stable code the front end translates
//! (`err.<code>`), parameters for the messages, and the English fallback text.

use anyhow::Error;
use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Coded {
    pub code: &'static str,
    pub params: BTreeMap<&'static str, String>,
    pub message: String,
}

impl fmt::Display for Coded {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Coded {}

/// Builds a coded error. `message` is the English text, used as is by the logs
/// and by any client that does not know `code`.
pub fn coded(
    code: &'static str,
    params: &[(&'static str, String)],
    message: impl Into<String>,
) -> Error {
    Error::new(Coded {
        code,
        params: params.iter().cloned().collect(),
        message: message.into(),
    })
}

/// What the front end receives when a command fails.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CmdError {
    pub code: String,
    pub params: BTreeMap<String, String>,
    pub message: String,
}

impl From<Error> for CmdError {
    fn from(e: Error) -> Self {
        // `downcast_ref` looks through `.context(...)`: the coded error can still
        // be found when it is wrapped.
        if let Some(c) = e.downcast_ref::<Coded>() {
            return CmdError {
                code: c.code.to_string(),
                params: c
                    .params
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.clone()))
                    .collect(),
                message: c.message.clone(),
            };
        }
        CmdError {
            code: "generic".into(),
            params: BTreeMap::new(),
            message: format!("{e:#}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::Context;

    #[test]
    fn a_coded_error_keeps_its_code_and_params() {
        let e: CmdError = coded("trim_range", &[("start", "5".into())], "bad range").into();
        assert_eq!(e.code, "trim_range");
        assert_eq!(e.params["start"], "5");
        assert_eq!(e.message, "bad range");
    }

    #[test]
    fn the_code_survives_added_context() {
        let r: anyhow::Result<()> = Err(coded("cannot_open", &[], "nope"));
        let e: CmdError = r.context("while loading").unwrap_err().into();
        assert_eq!(e.code, "cannot_open");
    }

    #[test]
    fn a_plain_error_becomes_generic_with_its_full_chain() {
        let r: anyhow::Result<()> = Err(anyhow::anyhow!("inner"));
        let e: CmdError = r.context("outer").unwrap_err().into();
        assert_eq!(e.code, "generic");
        assert_eq!(e.message, "outer: inner");
        assert!(e.params.is_empty());
    }

    #[test]
    fn display_is_the_english_message() {
        let c = Coded {
            code: "x",
            params: BTreeMap::new(),
            message: "hello".into(),
        };
        assert_eq!(c.to_string(), "hello");
    }
}

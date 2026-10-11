use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use serde::Deserialize;

const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarHealth {
    pub sidecar: String,
    pub node: String,
    pub drivers: String,
    pub filters: usize,
}

#[derive(Debug, Deserialize)]
struct HealthResponse {
    id: Option<u64>,
    ok: bool,
    sidecar: Option<String>,
    node: Option<String>,
    drivers: Option<String>,
    filters: Option<usize>,
    error: Option<String>,
}

/// Locate `sidecar/cheese-sidecar.mjs`: explicit path first, then next to the
/// running executable (dev: `target/debug/../sidecar`, installed: alongside).
pub fn locate_script(explicit: Option<&str>) -> Option<PathBuf> {
    if let Some(path) = explicit {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
        return None;
    }
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    [
        exe_dir.join("../sidecar/cheese-sidecar.mjs"),
        exe_dir.join("sidecar/cheese-sidecar.mjs"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

/// Spawn `node <script>`, send one `health` request over stdio, read the
/// single-line reply. The child is killed on timeout or protocol mismatch.
pub fn check_health(node: &str, script: &Path) -> Result<SidecarHealth, String> {
    let (sender, receiver) = mpsc::channel();
    let script = script.to_path_buf();
    let node = node.to_owned();
    std::thread::spawn(move || {
        sender.send(roundtrip(&node, &script)).unwrap_or(());
    });
    receiver.recv_timeout(HEALTH_TIMEOUT).map_err(|_| {
        format!(
            "sidecar health check timed out after {}s",
            HEALTH_TIMEOUT.as_secs()
        )
    })?
}

fn roundtrip(node: &str, script: &Path) -> Result<SidecarHealth, String> {
    let mut child = Command::new(node)
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("cannot spawn sidecar with {node}: {error}"))?;
    let mut stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    stdin
        .write_all(b"{\"id\":1,\"cmd\":\"health\"}\n")
        .map_err(|error| format!("cannot write to sidecar: {error}"))?;
    drop(stdin);
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .map_err(|error| format!("cannot read sidecar reply: {error}"))?;
    let _ = child.kill();
    let response: HealthResponse =
        serde_json::from_str(&line).map_err(|error| format!("sidecar spoke no JSON: {error}"))?;
    if response.id != Some(1) {
        return Err("sidecar reply id mismatch".into());
    }
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "sidecar reported failure".into()));
    }
    Ok(SidecarHealth {
        sidecar: response.sidecar.ok_or("sidecar reply lacks version")?,
        node: response.node.ok_or("sidecar reply lacks node version")?,
        drivers: response
            .drivers
            .ok_or("sidecar reply lacks drivers version")?,
        filters: response.filters.unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn script() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecar/cheese-sidecar.mjs")
    }

    #[test]
    fn health_roundtrip() {
        let health = check_health("node", &script()).expect("node sidecar must answer health");
        assert_eq!(health.sidecar, "cheese-sidecar/1");
        assert!(health.drivers.starts_with("@openmouse/protocol@"));
        assert!(health.filters > 100);
    }

    #[test]
    fn missing_script_dir_is_none() {
        assert!(locate_script(Some("/nonexistent/cheese-sidecar.mjs")).is_none());
    }
}

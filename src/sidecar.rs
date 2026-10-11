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

/// One live USB device annotated with the driver catalog (brand/model are
/// `None` when the VID:PID is not a known supported mouse).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbDevice {
    pub vid: u16,
    pub pid: u16,
    pub usb_name: String,
    pub brand: Option<String>,
    pub model: Option<String>,
    pub known: bool,
}

/// Display title: catalog name for known mice, USB string otherwise.
pub fn device_title(device: &UsbDevice) -> String {
    match (&device.brand, &device.model) {
        (Some(brand), Some(model)) => format!("{brand} {model}"),
        (Some(brand), None) => format!("{brand} device"),
        (None, _) => device.usb_name.clone(),
    }
}

pub fn device_detail(device: &UsbDevice) -> String {
    format!(
        "VID 0x{:04x} PID 0x{:04x} · connected",
        device.vid, device.pid
    )
}

#[derive(Debug, Deserialize)]
struct TaggedResponse {
    id: Option<u64>,
    ok: bool,
    error: Option<String>,
}

/// Locate `sidecar/cheese-sidecar.mjs`: explicit path first, then relative to
/// the running executable (dev: `target/debug/../../sidecar`, installed:
/// alongside the binary).
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
        exe_dir.join("../../sidecar/cheese-sidecar.mjs"),
        exe_dir.join("sidecar/cheese-sidecar.mjs"),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

/// Spawn `node <script>`, send one JSON request line over stdio, read the
/// single-line reply. The child is killed on timeout or protocol mismatch.
pub fn check_health(node: &str, script: &Path) -> Result<SidecarHealth, String> {
    let reply = transact(node, script, 1, "{\"id\":1,\"cmd\":\"health\"}")?;
    Ok(SidecarHealth {
        sidecar: field(&reply, "sidecar")?,
        node: field(&reply, "node")?,
        drivers: field(&reply, "drivers")?,
        filters: reply
            .get("filters")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0) as usize,
    })
}

/// Live USB enumeration with catalog annotations; only `known` entries are
/// supported mice. Errors when lsusb is missing or the sidecar fails.
pub fn list_devices(node: &str, script: &Path) -> Result<Vec<UsbDevice>, String> {
    let reply = transact(node, script, 2, "{\"id\":2,\"cmd\":\"devices\"}")?;
    let devices = reply
        .get("devices")
        .ok_or("sidecar devices reply lacks device list")?;
    serde_json::from_value(devices.clone())
        .map_err(|error| format!("sidecar devices malformed: {error}"))
}

fn field(reply: &serde_json::Value, name: &str) -> Result<String, String> {
    reply
        .get(name)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("sidecar reply lacks {name}"))
}

fn transact(
    node: &str,
    script: &Path,
    id: u64,
    payload: &str,
) -> Result<serde_json::Value, String> {
    let (sender, receiver) = mpsc::channel();
    let script = script.to_path_buf();
    let node = node.to_owned();
    let payload = payload.to_owned();
    std::thread::spawn(move || {
        sender
            .send(roundtrip(&node, &script, id, &payload))
            .unwrap_or(());
    });
    receiver.recv_timeout(HEALTH_TIMEOUT).map_err(|_| {
        format!(
            "sidecar request timed out after {}s",
            HEALTH_TIMEOUT.as_secs()
        )
    })?
}

fn roundtrip(
    node: &str,
    script: &Path,
    id: u64,
    payload: &str,
) -> Result<serde_json::Value, String> {
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
        .write_all(payload.as_bytes())
        .map_err(|error| format!("cannot write to sidecar: {error}"))?;
    stdin
        .write_all(b"\n")
        .map_err(|error| format!("cannot write to sidecar: {error}"))?;
    drop(stdin);
    let mut line = String::new();
    BufReader::new(stdout)
        .read_line(&mut line)
        .map_err(|error| format!("cannot read sidecar reply: {error}"))?;
    let _ = child.kill();
    let response: TaggedResponse =
        serde_json::from_str(&line).map_err(|error| format!("sidecar spoke no JSON: {error}"))?;
    if response.id != Some(id) {
        return Err("sidecar reply id mismatch".into());
    }
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "sidecar reported failure".into()));
    }
    serde_json::from_str(&line).map_err(|error| format!("sidecar reply malformed: {error}"))
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

    #[test]
    fn explicit_script_path_resolves() {
        let path = script();
        assert!(locate_script(Some(&path.to_string_lossy())).is_some());
    }

    fn sample_device() -> UsbDevice {
        UsbDevice {
            vid: 0x1532,
            pid: 0x00a5,
            usb_name: "Razer USA, Ltd".into(),
            brand: Some("Razer".into()),
            model: Some("Viper V2 Pro".into()),
            known: true,
        }
    }

    #[test]
    fn device_title_prefers_catalog_name() {
        assert_eq!(device_title(&sample_device()), "Razer Viper V2 Pro");
        assert_eq!(
            device_detail(&sample_device()),
            "VID 0x1532 PID 0x00a5 · connected"
        );
    }

    #[test]
    fn device_title_falls_back_to_usb_string() {
        let unknown = UsbDevice {
            brand: None,
            model: None,
            known: false,
            ..sample_device()
        };
        assert_eq!(device_title(&unknown), "Razer USA, Ltd");
        let branded = UsbDevice {
            model: None,
            ..sample_device()
        };
        assert_eq!(device_title(&branded), "Razer device");
    }

    #[test]
    fn live_list_returns_annotated_devices() {
        let devices = list_devices("node", &script()).expect("lsusb must enumerate on Linux");
        assert!(!devices.is_empty());
        for device in &devices {
            assert_eq!(device.known, device.brand.is_some());
        }
    }
}

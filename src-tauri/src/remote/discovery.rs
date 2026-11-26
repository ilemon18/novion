use std::collections::HashMap;
use std::net::IpAddr;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};

use mdns_sd::{ResolvedService, ServiceDaemon, ServiceEvent, ServiceInfo};

use crate::error::{AppError, AppResult};

use super::protocol::RemoteHost;
use super::store::PROTOCOL_VERSION;

pub const SERVICE_TYPE: &str = "_novion._tcp.local.";
const SCAN_WINDOW: Duration = Duration::from_millis(4_200);

pub struct Advertiser {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Advertiser {
    pub fn stop(self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

impl Drop for Advertiser {
    fn drop(&mut self) {
        let _ = self.daemon.unregister(&self.fullname);
        let _ = self.daemon.shutdown();
    }
}

fn ca_chunks(ca_pem: &str) -> Vec<(String, String)> {
    const CHUNK: usize = 180;
    STANDARD
        .encode(ca_pem.as_bytes())
        .as_bytes()
        .chunks(CHUNK)
        .enumerate()
        .map(|(index, chunk)| {
            (
                format!("ca{index}"),
                String::from_utf8_lossy(chunk).to_string(),
            )
        })
        .collect()
}

pub fn display_addresses() -> Vec<String> {
    let addresses = local_addresses();
    let ipv4: Vec<String> = addresses
        .iter()
        .filter(|ip| ip.is_ipv4())
        .map(ToString::to_string)
        .collect();
    if !ipv4.is_empty() {
        return ipv4;
    }
    addresses
        .into_iter()
        .map(|ip| match ip {
            IpAddr::V6(ip) => format!("[{ip}]"),
            other => other.to_string(),
        })
        .collect()
}

pub fn local_addresses() -> Vec<IpAddr> {
    let mut out = Vec::new();
    if let Ok(items) = local_ip_address::list_afinet_netifas() {
        for (_, ip) in items {
            if ip.is_loopback() || ip.is_unspecified() {
                continue;
            }
            if !out.contains(&ip) {
                out.push(ip);
            }
        }
    }
    if out.is_empty() {
        if let Ok(ip) = local_ip_address::local_ip() {
            out.push(ip);
        }
    }
    if out.is_empty() {
        out.push(IpAddr::from([127, 0, 0, 1]));
    }
    out
}

pub fn advertise(
    host_id: &str,
    host_name: &str,
    port: u16,
    ca_pem: &str,
    fingerprint: &str,
    workspace_name: &str,
) -> AppResult<Advertiser> {
    let daemon = ServiceDaemon::new().map_err(|e| AppError::wrap("启动局域网发现失败", e))?;
    let short_id: String = host_id.chars().take(12).collect();
    let instance = format!("Novion-{short_id}");
    let mdns_host = format!("novion-{short_id}.local.");
    let addresses = local_addresses();

    let mut properties = HashMap::new();
    properties.insert("id".to_string(), host_id.to_string());
    properties.insert("name".to_string(), host_name.to_string());
    properties.insert("proto".to_string(), PROTOCOL_VERSION.to_string());
    properties.insert("fp".to_string(), fingerprint.to_string());
    properties.insert("workspace".to_string(), workspace_name.to_string());
    for (key, value) in ca_chunks(ca_pem) {
        properties.insert(key, value);
    }

    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &instance,
        &mdns_host,
        addresses.as_slice(),
        port,
        properties,
    )
    .map_err(|e| AppError::wrap("创建局域网服务失败", e))?;
    let fullname = info.get_fullname().to_string();
    daemon
        .register(info)
        .map_err(|e| AppError::wrap("广播局域网服务失败", e))?;
    Ok(Advertiser { daemon, fullname })
}

fn property(info: &ResolvedService, key: &str) -> Option<String> {
    info.get_properties()
        .get_property_val_str(key)
        .map(str::to_string)
}

fn ca_from_info(info: &ResolvedService) -> String {
    let mut parts: Vec<(usize, String)> = Vec::new();
    for index in 0..32 {
        let key = format!("ca{index}");
        let Some(part) = property(info, &key) else {
            break;
        };
        parts.push((index, part));
    }
    parts.sort_by_key(|(index, _)| *index);
    let encoded: String = parts.into_iter().map(|(_, part)| part).collect();
    STANDARD
        .decode(encoded.as_bytes())
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .unwrap_or_default()
}

fn preferred_address(info: &ResolvedService) -> Option<std::net::Ipv4Addr> {
    let mut addresses: Vec<std::net::Ipv4Addr> = info.get_addresses_v4().into_iter().collect();
    addresses.retain(|ip| !ip.is_loopback() && !ip.is_link_local());
    addresses.sort_by_key(|ip| {
        let octets = ip.octets();
        if octets[0] == 192 && octets[1] == 168 {
            0
        } else if octets[0] == 10 {
            1
        } else if octets[0] == 172 && (16..=31).contains(&octets[1]) {
            2
        } else {
            3
        }
    });
    addresses.into_iter().next()
}

fn scan_blocking() -> AppResult<Vec<RemoteHost>> {
    let daemon = ServiceDaemon::new().map_err(|e| AppError::wrap("启动局域网扫描失败", e))?;
    let receiver = daemon
        .browse(SERVICE_TYPE)
        .map_err(|e| AppError::wrap("启动局域网扫描失败", e))?;
    let deadline = Instant::now() + SCAN_WINDOW;
    let mut found: HashMap<String, RemoteHost> = HashMap::new();

    loop {
        let now = Instant::now();
        if now >= deadline {
            break;
        }
        let remaining = deadline.saturating_duration_since(now);
        let event = match receiver.recv_timeout(remaining) {
            Ok(event) => event,
            Err(_) => break,
        };
        let ServiceEvent::ServiceResolved(info) = event else {
            continue;
        };
        if !info.is_valid() {
            continue;
        }
        let Some(host_id) = property(&info, "id") else {
            continue;
        };
        let Some(fingerprint) = property(&info, "fp") else {
            continue;
        };
        let ca_pem = ca_from_info(&info);
        if ca_pem.trim().is_empty() {
            continue;
        }
        let Some(address) = preferred_address(&info) else {
            continue;
        };
        found.insert(
            host_id.clone(),
            RemoteHost {
                host_id,
                host_name: property(&info, "name").unwrap_or_else(|| "Novion".to_string()),
                address: address.to_string(),
                port: info.get_port(),
                fingerprint,
                ca_pem,
                protocol: property(&info, "proto")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(PROTOCOL_VERSION),
                workspace_name: property(&info, "workspace")
                    .unwrap_or_else(|| "Novion".to_string()),
            },
        );
    }

    let _ = daemon.stop_browse(SERVICE_TYPE);
    let _ = daemon.shutdown();

    let mut hosts: Vec<RemoteHost> = found.into_values().collect();
    hosts.sort_by(|a, b| a.host_name.cmp(&b.host_name));
    Ok(hosts)
}

pub async fn scan() -> AppResult<Vec<RemoteHost>> {
    tokio::task::spawn_blocking(scan_blocking)
        .await
        .map_err(|e| AppError::wrap("局域网扫描失败", e))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "uses the machine's multicast DNS network"]
    fn advertise_and_scan_roundtrip() {
        let advertiser = advertise(
            "testhost01234567",
            "Test Novion",
            39262,
            "-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----\n",
            "00:11:22:33",
            "Novion",
        )
        .expect("advertise");
        std::thread::sleep(Duration::from_millis(500));
        let found = scan_blocking().expect("scan");
        advertiser.stop();
        assert!(found.iter().any(|host| host.host_id == "testhost01234567"));
    }
}

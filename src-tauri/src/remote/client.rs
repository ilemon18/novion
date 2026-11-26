use std::time::Duration;

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{AppError, AppResult};

use super::protocol::{
    HelloResponse, PairRequest, PairResponse, PublicInfo, RpcRequest, RpcResponse,
};

pub fn base_url(host: &str, port: u16) -> String {
    let host = host.trim().trim_end_matches('/');
    if host.starts_with("https://") || host.starts_with("http://") {
        if host.starts_with("http://") {
            // The host always serves TLS; upgrade a pasted http:// address.
            return format!(
                "https://{}/",
                host.trim_start_matches("http://").trim_end_matches('/')
            );
        }
        format!("{host}/")
    } else if host.contains(':') && !host.starts_with('[') {
        format!("https://[{host}]:{port}/")
    } else {
        format!("https://{host}:{port}/")
    }
}

pub fn pinned_client(ca_pem: &str) -> AppResult<reqwest::Client> {
    let ca = reqwest::Certificate::from_pem(ca_pem.as_bytes())
        .map_err(|e| AppError::wrap("读取主机证书失败", e))?;
    reqwest::Client::builder()
        .use_rustls_tls()
        .add_root_certificate(ca)
        .danger_accept_invalid_hostnames(true)
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|e| AppError::wrap("创建远程连接失败", e))
}

fn tofu_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .use_rustls_tls()
        .danger_accept_invalid_certs(true)
        .danger_accept_invalid_hostnames(true)
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| AppError::wrap("创建远程连接失败", e))
}

fn network_error(context: &str, error: reqwest::Error) -> AppError {
    if error.is_timeout() {
        AppError::new("remote_timeout", format!("{context}超时，请确认主机在线。"))
    } else if error.is_connect() {
        AppError::new(
            "remote_offline",
            format!("{context}失败，请确认两台电脑在同一局域网且主机正在共享。"),
        )
    } else {
        AppError::new("remote_offline", format!("{context}失败：{error}"))
    }
}

async fn parse_json<T: DeserializeOwned>(
    context: &str,
    response: reqwest::Response,
) -> AppResult<T> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| network_error(context, e))?;
    if !status.is_success() {
        if let Ok(error) = serde_json::from_slice::<RpcResponse>(&bytes) {
            if let Some(error) = error.error {
                return Err(AppError::new(&error.code, error.message));
            }
        }
        let message = String::from_utf8_lossy(&bytes);
        if status.as_u16() == 401 {
            return Err(AppError::new(
                "remote_unauthorized",
                "主机未授权此设备，请重新配对。",
            ));
        }
        return Err(AppError::new(
            "remote_http",
            format!("{context}失败（HTTP {}）：{message}", status.as_u16()),
        ));
    }
    serde_json::from_slice(&bytes).map_err(|e| AppError::json(context, e))
}

pub async fn info(base: &str, ca_pem: Option<&str>) -> AppResult<PublicInfo> {
    let client = match ca_pem {
        Some(pem) => pinned_client(pem)?,
        None => tofu_client()?,
    };
    let response = client
        .get(format!("{base}v1/info"))
        .send()
        .await
        .map_err(|e| network_error("连接主机", e))?;
    parse_json("读取主机信息", response).await
}

pub async fn pair(
    base: &str,
    code: &str,
    client_name: &str,
    ca_pem: Option<&str>,
) -> AppResult<PairResponse> {
    let client = match ca_pem {
        Some(pem) => pinned_client(pem)?,
        None => tofu_client()?,
    };
    let response = client
        .post(format!("{base}v1/pair"))
        .json(&PairRequest {
            code: code.to_string(),
            client_name: client_name.to_string(),
        })
        .send()
        .await
        .map_err(|e| network_error("配对", e))?;
    parse_json("配对", response).await
}

pub async fn hello(base: &str, token: &str, ca_pem: &str) -> AppResult<HelloResponse> {
    let client = pinned_client(ca_pem)?;
    let response = client
        .get(format!("{base}v1/hello"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| network_error("连接主机", e))?;
    parse_json("连接主机", response).await
}

pub async fn rpc<T: DeserializeOwned, A: Serialize>(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    name: &str,
    args: &A,
) -> AppResult<T> {
    let response = client
        .post(format!("{base}v1/rpc"))
        .bearer_auth(token)
        .json(&RpcRequest {
            name: name.to_string(),
            args: serde_json::to_value(args)
                .map_err(|e| AppError::json("序列化远程参数失败", e))?,
        })
        .send()
        .await
        .map_err(|e| network_error("远程操作", e))?;
    let envelope: RpcResponse = parse_json("远程操作", response).await?;
    if !envelope.ok {
        let error = envelope.error.unwrap_or_else(|| super::protocol::RpcError {
            code: "remote_error".to_string(),
            message: "主机返回了未知错误。".to_string(),
        });
        return Err(AppError::new(&error.code, error.message));
    }
    let value = envelope
        .data
        .ok_or_else(|| AppError::new("remote_empty", "主机返回了空响应。"))?;
    serde_json::from_value(value).map_err(|e| AppError::json("解析远程结果失败", e))
}

#[cfg(test)]
mod tests {
    use super::base_url;

    #[test]
    fn host_addresses_are_normalised_to_tls() {
        assert_eq!(base_url("192.168.1.20", 39262), "https://192.168.1.20:39262/");
        assert_eq!(base_url("http://192.168.1.20:39262", 39262), "https://192.168.1.20:39262/");
        assert_eq!(base_url("fe80::1", 39262), "https://[fe80::1]:39262/");
    }
}

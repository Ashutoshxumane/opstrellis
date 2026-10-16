use anyhow::{Context, Result};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{HeaderName, HeaderValue};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

pub type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;
pub use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::frame::{coding::CloseCode, CloseFrame};

/// A close frame with an error code (providers report failures this way) is a failed stream,
/// not the end of a successful one — callers must fall back instead of using partial text.
pub fn check_close(frame: &Option<CloseFrame>) -> Result<()> {
    match frame {
        Some(f) if f.code != CloseCode::Normal => anyhow::bail!("stream closed with {} {}", u16::from(f.code), f.reason),
        _ => Ok(()),
    }
}

/// The audio sender task must have finished cleanly, otherwise audio was lost mid-stream.
pub async fn check_sender<T>(sender: tokio::task::JoinHandle<Result<T>>) -> Result<()> {
    match sender.await {
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(e.context("sending audio failed")),
        Err(e) => anyhow::bail!("audio sender crashed: {e}"),
    }
}

pub async fn connect(url: &str, headers: &[(&str, &str)]) -> Result<Ws> {
    let mut req = url.into_client_request()?;
    for (k, v) in headers {
        req.headers_mut().insert(HeaderName::from_bytes(k.as_bytes())?, HeaderValue::from_str(v)?);
    }
    let (ws, _) = tokio::time::timeout(std::time::Duration::from_secs(8), tokio_tungstenite::connect_async(req))
        .await
        .context("timed out connecting")?
        .with_context(|| format!("could not connect to {}", url.split('?').next().unwrap_or(url)))?;
    Ok(ws)
}

/// Test peer: accepts one connection, records binary bytes and text frames until it receives a
/// text frame containing `end_marker`, then replays `script` and closes.
#[cfg(test)]
pub async fn scripted_peer(end_marker: &'static str, script: Vec<String>) -> (String, tokio::task::JoinHandle<(usize, Vec<String>)>) {
    use futures_util::{SinkExt, StreamExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let handle = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_async(tcp).await.unwrap();
        let (mut audio_bytes, mut texts) = (0usize, Vec::new());
        while let Some(Ok(msg)) = ws.next().await {
            match msg {
                Message::Binary(b) => audio_bytes += b.len(),
                Message::Text(t) => {
                    let done = t.contains(end_marker);
                    texts.push(t.to_string());
                    if done {
                        break;
                    }
                }
                _ => {}
            }
        }
        let mut close = None;
        for s in script {
            // "CLOSE:<code>" ends the script with that close code instead of a normal close.
            if let Some(code) = s.strip_prefix("CLOSE:") {
                close = Some(CloseFrame { code: CloseCode::from(code.parse::<u16>().unwrap()), reason: "test".into() });
                break;
            }
            ws.send(Message::Text(s.into())).await.unwrap();
        }
        let _ = ws.close(close).await;
        (audio_bytes, texts)
    });
    (url, handle)
}

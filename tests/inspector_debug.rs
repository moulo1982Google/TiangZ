use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::{connect_async, tungstenite::Message};

struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn unused_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn fetch_targets(port: u16) -> Option<Vec<Value>> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(200),
    )
    .ok()?;
    stream
        .write_all(
            format!(
                "GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .ok()?;
    let mut response = String::new();
    stream.read_to_string(&mut response).ok()?;
    let body = response.split_once("\r\n\r\n")?.1;
    serde_json::from_str(body).ok()
}

async fn send_command(
    socket: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    id: u32,
    method: &str,
) {
    socket
        .send(Message::Text(
            json!({ "id": id, "method": method }).to_string().into(),
        ))
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn inspector_breaks_before_app_and_publishes_inline_source_map() {
    let bundle = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("dist")
            .join("main.js"),
    )
    .unwrap();
    let expect_inline_source_map =
        bundle.contains("sourceMappingURL=data:application/json;base64,");
    if expect_inline_source_map {
        let encoded = bundle
            .rsplit_once("sourceMappingURL=data:application/json;base64,")
            .unwrap()
            .1
            .trim();
        let map: Value = serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .unwrap(),
        )
        .unwrap();
        assert!(map["sources"].as_array().unwrap().iter().any(|source| {
            source
                .as_str()
                .is_some_and(|source| source.ends_with("app/main.ts"))
        }));
        assert_eq!(
            map["sources"].as_array().unwrap().len(),
            map["sourcesContent"].as_array().unwrap().len()
        );
    }
    let business_port = unused_port();
    let inspector_port = unused_port();
    let temp = tempfile::tempdir().unwrap();
    let config_path = temp.path().join("inspector.json");
    std::fs::write(
        &config_path,
        serde_json::to_vec_pretty(&json!({
            "process": {
                "name": "debug_test",
                "debug": {
                    "inspectorIp": "127.0.0.1",
                    "inspectorPort": inspector_port,
                    "breakOnStart": true
                }
            },
            "scenes": [{
                "name": "log_debug_test",
                "sceneType": "Log",
                "ip": "127.0.0.1",
                "port": business_port
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    let child = Command::new(env!("CARGO_BIN_EXE_TiangZ"))
        .arg(&config_path)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut child = ChildGuard(child);

    let deadline = Instant::now() + Duration::from_secs(15);
    let target = loop {
        if let Some(status) = child.0.try_wait().unwrap() {
            panic!("runtime exited before inspector attach: {status}");
        }
        if let Some(target) =
            fetch_targets(inspector_port).and_then(|items| items.into_iter().next())
        {
            break target;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for inspector metadata"
        );
        thread::sleep(Duration::from_millis(50));
    };
    let websocket_url = target["webSocketDebuggerUrl"].as_str().unwrap();
    let (mut socket, _) = connect_async(websocket_url).await.unwrap();

    send_command(&mut socket, 1, "Runtime.enable").await;
    send_command(&mut socket, 2, "Debugger.enable").await;
    send_command(&mut socket, 3, "Runtime.runIfWaitingForDebugger").await;

    let mut paused = false;
    let mut source_map = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while !(paused && (!expect_inline_source_map || source_map)) {
        let message = tokio::time::timeout_at(deadline, socket.next())
            .await
            .expect("timed out waiting for inspector events")
            .expect("inspector websocket closed")
            .unwrap();
        let Message::Text(text) = message else {
            continue;
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        paused |= value["method"] == "Debugger.paused";
        source_map |= value["method"] == "Debugger.scriptParsed"
            && value["params"]["url"]
                .as_str()
                .is_some_and(|url| url.ends_with("/dist/main.js"))
            && value["params"]["sourceMapURL"]
                .as_str()
                .is_some_and(|url| url.starts_with("data:application/json;base64,"));
    }

    send_command(&mut socket, 4, "Debugger.resume").await;
}

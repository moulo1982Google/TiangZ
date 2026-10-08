use super::*;
use deno_core::{JsRuntime, RuntimeOptions};
use tokio::{io::AsyncReadExt, net::TcpListener};

struct ResetBridge;
impl Drop for ResetBridge {
    fn drop(&mut self) {
        DBPROXY_BRIDGE.with(|slot| *slot.borrow_mut() = None);
    }
}

// Isolated TCP peer accepts the SDK handshake but never replies. No real storage or credentials are used.
#[tokio::test]
async fn bare_v8_deadline_reclaims_the_tcp_handshake_before_host_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = listener.local_addr().unwrap().to_string();
    let peer = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut received = Vec::new();
        socket.read_to_end(&mut received).await.unwrap();
        assert!(
            !received.is_empty(),
            "the actual SDK handshake must have reached the peer"
        );
        // A second expired request must not even reconnect.
        assert!(
            tokio::time::timeout(Duration::from_millis(150), listener.accept())
                .await
                .is_err()
        );
    });
    let mut config = ClientConfig::new(endpoint.clone(), "isolated-fixture", "budget-test");
    config.connect_timeout = Duration::from_secs(2);
    config.request_timeout = Duration::from_secs(3);
    DBPROXY_BRIDGE.with(|slot| {
        *slot.borrow_mut() = Some(DbProxyBridge {
            config,
            pool: PoolSlot::new("budget-test", 1),
            queued_pool: None,
            host_runtime: Handle::current(),
            metrics: Arc::new(DbProxyClientMetrics::new(vec![endpoint])),
        })
    });
    let _reset = ResetBridge;
    let mut runtime = JsRuntime::new(RuntimeOptions {
        extensions: vec![init()],
        ..Default::default()
    });
    runtime
        .execute_script("budget-bootstrap", BOOTSTRAP_SOURCE)
        .unwrap();
    runtime.execute_script("budget-probe", r#"
      const db = globalThis.__hostDbProxy;
      if (db.requestTimeoutMs !== 3000 || !db.supportsRequestTimeout) throw new Error("invalid budget capability");
      const started = db.monotonicNowMs();
      globalThis.probe = db.load("budget", "one", started + 80).then(async result => {
        if (result.error?.code !== 3001) throw new Error("expected storage unavailable");
        const elapsed = db.monotonicNowMs() - started;
        if (elapsed < 60 || elapsed > 1000) throw new Error(`deadline was reset: ${elapsed}`);
        const expired = await db.load("budget", "two", started + 1);
        if (expired.error?.code !== 3001) throw new Error("expired request was not rejected");
        const record = { namespace: "budget", key: "two" };
        const write = { requestId: "same", ...record, record, schema: "counter", schemaVersion: 1,
          payload: new Uint8Array([1]), expectedRevision: "0", updatedAtUnixMs: "1" };
        const transaction = { ...write, operationId: "transaction", result: new Uint8Array() };
        const multi = { ...transaction, writes: [write] };
        const calls = [
          () => db.loadMulti([record], started + 1),
          () => db.save(write, started + 1), () => db.saveMulti([write], started + 1),
          () => db.enqueueSnapshot(write, started + 1), () => db.enqueueMultiSnapshot([write], started + 1),
          () => db.applyTransaction(transaction, started + 1), () => db.loadTransaction("transaction", "budget", "two", started + 1),
          () => db.applyMultiTransaction(multi, started + 1),
          () => db.commitRecords({ ...multi, appends: [], outboxEvents: [] }, started + 1),
          () => db.loadMultiTransaction("transaction", [record], started + 1),
        ];
        for (const call of calls) if ((await call()).error?.code !== 3001) throw new Error("operation lost its deadline");
      });
    "#).unwrap();
    tokio::time::timeout(
        Duration::from_secs(2),
        runtime.run_event_loop(Default::default()),
    )
    .await
    .unwrap()
    .unwrap();
    tokio::time::timeout(Duration::from_secs(1), peer)
        .await
        .unwrap()
        .unwrap();
}

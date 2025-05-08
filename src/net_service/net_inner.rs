
use tracing::{trace, error, info, warn, debug};
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::net_service::tcp_service::{TcpService, NetService};
use crate::create_entity;
use gen_macro::Component;
use crate::entity::Awake;

create_entity! {
    #[derive(Component, Default)]
    #[awake]
    pub struct NetInnerComponent {
    }
}

impl Awake for Arc<Mutex<NetInnerComponent>> {
    fn awake(&self) {
        trace!("NetInnerComponent awake called");
        let clone = self.clone();
        tokio::spawn(async move {
            let guard = clone.lock().await;
            guard.start_tcp_service().await;
        });
    }
}

impl NetInnerComponent {
    async fn start_tcp_service(&self) {
        let rt = Arc::new(tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap());

        let service_id = NetService::instance().add_service(
            Box::new(TcpService::new("0.0.0.0:8080".to_string(), rt)
            .await.unwrap()));
    }
}

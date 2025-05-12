#![allow(unused)]

use tokio::net::{TcpStream, TcpListener};
use tokio::runtime::Runtime;
use tokio::io;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use tracing::{trace, error, info, warn, debug};
use std::sync::atomic::Ordering;
use dashmap::DashMap;

static NET_RT: once_cell::sync::Lazy<tokio::runtime::Runtime> = once_cell::sync::Lazy::new(|| {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(8)  // 明确线程数
        .enable_all()
        .build()
        .unwrap()
});

pub enum NetworkProtocol
{
    TCP,
    KCP,
    Websocket,
}

pub trait AService {
    fn set_service_id(&mut self, id: usize);
}

pub struct TcpService {
    service_id: usize,
    addr: String,
    listener: Arc<TcpListener>,
}

impl AService for TcpService {
    fn set_service_id(&mut self, id: usize) {
        self.service_id = id;
    }
}

impl TcpService {
    pub async fn new(addr: &String) -> io::Result<Self> {

        let listener: TcpListener = TcpListener::bind(&addr).await?;
        let mut tcp = TcpService {
            service_id: 0,
            addr: addr.clone(),
            listener: Arc::new(listener),
        };
        tcp.start_accept();
        Ok(tcp)
    }

    fn start_accept(&mut self) {
        let listener = self.listener.clone();
        NET_RT.spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((socket, remote_addr)) => {
                        //TODO: 处理连接
                    }
                    Err(e) => {
                        error!("accept 失败，退出");
                        return;
                    }
                }
            }
        });
    }
}

pub struct NetService {
    service_id_gen: Arc<AtomicUsize>,
    all_service: Arc<DashMap<usize, Box<dyn AService + Send + Sync>>>
}

impl NetService {

    pub fn instance() -> &'static Self {
        static INSTANCE: std::sync::OnceLock<NetService> = std::sync::OnceLock::new();
        INSTANCE.get_or_init(|| {
            let instance = NetService::new();
            instance
        })
    }

    fn new() -> Self {
        Self {
            service_id_gen: Arc::new(AtomicUsize::new(0)),
            all_service: Arc::new(DashMap::new()),
        }
    }

    pub fn add_service(&self, mut serice: Box<dyn AService  + Send + Sync>) -> usize {
        let id = self.service_id_gen.fetch_add(1, Ordering::SeqCst);
        serice.set_service_id(id);
        self.all_service.insert(id, serice);
        id
    }
}

#[cfg(test)]
mod net_test {
    use super::*;

    #[tokio::test]
    async fn test_net_service() {

        let rt = Arc::new(tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap());

        let service_id = NetService::instance().add_service(
            Box::new(TcpService::new(&"0.0.0.0:8080".to_string())
            .await.unwrap()));
    }
}


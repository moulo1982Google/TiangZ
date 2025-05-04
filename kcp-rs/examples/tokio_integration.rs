use kcp_rs::Kcp;
use tokio::net::UdpSocket;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 创建 UDP Socket 和 KCP 实例
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let kcp = Arc::new(Mutex::new(Kcp::new(123, std::ptr::null_mut())?));
    kcp.lock().await.set_nodelay(1, 10, 2, 1);

    // 模拟网络收发
    let kcp_clone = Arc::clone(&kcp);
    tokio::spawn(async move {
        let mut buf = [0u8; 1500];
        loop {
            let len = socket.recv(&mut buf).await.unwrap();
            let mut guard = kcp_clone.lock().await;
            guard.input(&buf[..len]).unwrap();
        }
    });

    // 定时更新 KCP
    let kcp_clone = Arc::clone(&kcp);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_millis(10));
        loop {
            interval.tick().await;
            let mut guard = kcp_clone.lock().await;
            guard.update(current_time_ms());
        }
    });

    Ok(())
}
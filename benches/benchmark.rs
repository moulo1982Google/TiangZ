use criterion::{criterion_group, criterion_main, Criterion};
use tokio::runtime::Runtime;
use bytes::{BytesMut, BufMut};
use tokio::io::{AsyncReadExt, AsyncWriteExt};  // 添加这行
use TiangZ::Server;

lazy_static::lazy_static! {
    pub static ref WORK_THREAD_NUM: usize = std::thread::available_parallelism().unwrap().get();
    pub static ref QUEUE_LEN: usize = 100_000;
}

async fn send_test_message(addr: &str, message: &str) {
    let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
    
    let mut buf = BytesMut::with_capacity(2 + message.len());
    buf.put_u16(message.len() as u16);
    buf.put(message.as_bytes());
    
    stream.write_all(&buf).await.unwrap();
    
    let mut response = vec![0; 128];
    let _ = stream.read(&mut response).await.unwrap();
}

fn bench_server(c: &mut Criterion) {
    // 创建新的Runtime用于服务器
    let server_rt = tokio::runtime::Builder::new_multi_thread()
    .worker_threads(1)
    .enable_all()
    .build()
    .unwrap();
    
    // 启动测试服务器 (使用move取得所有权)
    std::thread::spawn(move || {
        let _ = server_rt.block_on(async {
            let server = TiangZ::TCPServer::new("127.0.0.1:8080").await;
            server.run(*WORK_THREAD_NUM, *QUEUE_LEN).await.unwrap();
        });
    });
    
    // 等待服务器启动
    std::thread::sleep(std::time::Duration::from_secs(5));
    
    // 创建新的Runtime用于客户端测试
    let client_rt = Runtime::new().unwrap();
    
    c.bench_function("TCP Server single request", |b| {
        b.iter(|| {
            client_rt.block_on(send_test_message("127.0.0.1:8081", "test"));
        })
    });
}

criterion_group!(benches, bench_server);
criterion_main!(benches);
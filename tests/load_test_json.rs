use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use bytes::{BytesMut, BufMut};
use std::time::Instant;

const CONCURRENT_REQUESTS: usize = 16;
const TOTAL_REQUESTS: usize = 1600000;

#[tokio::test(flavor = "multi_thread")]
async fn load_test() {
    let start = Instant::now();
    let mut handles = vec![];
    
    for _ in 0..CONCURRENT_REQUESTS {
        handles.push(tokio::spawn(async move {
            let mut stream = TcpStream::connect("127.0.0.1:8080").await.unwrap();

            let message = r#"{"_t": "C2M_PingRequest", "rpc_id": 1}"#;
            let mut buf = BytesMut::with_capacity(2 + message.len());
            buf.put_u16(message.len() as u16);
            buf.put(message.as_bytes());
            
            for _ in 0..TOTAL_REQUESTS/CONCURRENT_REQUESTS {
                stream.write_all(&buf).await.unwrap();
                let mut response = vec![0; 32];
                let _ = stream.read(&mut response).await.unwrap();
            }
        }));
    }
    
    for handle in handles {
        handle.await.unwrap();
    }
    
    let duration = start.elapsed();
    println!(
        "Completed {} requests in {:?} ({:.2} req/s)",
        TOTAL_REQUESTS,
        duration,
        TOTAL_REQUESTS as f64 / duration.as_secs_f64()
    );
}
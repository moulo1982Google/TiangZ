use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;
use bytes::{BytesMut, BufMut};
use std::time::Instant;
use serde::Serialize;

const CONCURRENT_REQUESTS: usize = 128;
const TOTAL_REQUESTS: usize = 12800000;

#[tokio::test(flavor = "multi_thread")]
async fn load_test_message() {
    let start = Instant::now();
    let mut handles = vec![];

    for _ in 0..CONCURRENT_REQUESTS {
        handles.push(tokio::spawn(async move {
            let mut stream = TcpStream::connect("127.0.0.1:8080").await.unwrap();

            let mut ping_msg = Vec::new();
            TiangZ::C2M_MoveToMessage{_t: "C2M_MoveToMessage".to_string(), player_id:9527}
                .serialize(&mut rmp_serde::Serializer::new(&mut ping_msg).with_struct_map()).unwrap();

            let mut buf = BytesMut::with_capacity(2 + ping_msg.len());
            buf.put_u16(ping_msg.len() as u16);
            buf.put_slice(&ping_msg);
            
            

            for _ in 0..TOTAL_REQUESTS/CONCURRENT_REQUESTS {
                stream.write_all(&buf).await.unwrap();
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
#![allow(unused_imports)]
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use bytes::{BytesMut, BufMut};
use TiangZ::IMessage;
use std::sync::atomic::AtomicI32;
use std::time::Instant;
use serde::Serialize;

use std::sync::{Arc, atomic::Ordering};

#[cfg(debug_assertions)]
const CONCURRENT_REQUESTS: usize = 1;
#[cfg(debug_assertions)]
const TOTAL_REQUESTS: usize = 10;

#[cfg(not(debug_assertions))]
const CONCURRENT_REQUESTS: usize = 256;
#[cfg(not(debug_assertions))]
const TOTAL_REQUESTS: usize = 2560000;

#[tokio::test(flavor = "multi_thread")]
async fn load_test_msgpack() {
    let start = Instant::now();
    let mut handles = vec![];
    
    let rpc_id = Arc::new(AtomicI32::new(0));
    for _ in 0..CONCURRENT_REQUESTS {

        handles.push(tokio::spawn(async move {
            let stream = TcpStream::connect("127.0.0.1:8080").await.unwrap();

            let mut ping_msg = Vec::new();
            TiangZ::C2M_PingRequest::default()
                .serialize(&mut rmp_serde::Serializer::new(&mut ping_msg).with_struct_map()).unwrap();

            let mut ping_res_msg =  BytesMut::with_capacity(64);
            TiangZ::C2M_PingResponse::default().to_bytes(&mut ping_res_msg);

            let mut buf = BytesMut::with_capacity(2 + ping_msg.len());
            buf.put_u16(ping_msg.len() as u16);
            buf.put_slice(&ping_msg);

            let (rx, mut wx) = stream.into_split();
            for _ in 0..TOTAL_REQUESTS/CONCURRENT_REQUESTS {
                wx.write_all(&buf).await.unwrap();
            }

            let reader = Arc::new(tokio::sync::Mutex::new(rx));
            let reader1 = reader.clone();

            let handle = tokio::spawn(async move {
                let mut response = vec![0u8; (ping_res_msg.len() + 2) * TOTAL_REQUESTS/CONCURRENT_REQUESTS];

                match reader1.lock().await.read_exact(&mut response).await {
                    Ok(_) => { /* 成功 */ },
                    Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => {
                        eprintln!("连接被对方关闭，数据不完整！");
                    },
                    Err(e) => {
                        eprintln!("读取错误: {}", e);
                    }
                }
            });
            
            let _ = tokio::join!(handle);
        }));
    }
    
    for handle in handles {
        handle.await.unwrap();
    }
    
    let duration = start.elapsed();
    println!(
        "Completed {} requests in {:?} ({:.2} req/s, rpc_id: {:?})",
        TOTAL_REQUESTS,
        duration,
        TOTAL_REQUESTS as f64 / duration.as_secs_f64(),
        rpc_id
    );
}

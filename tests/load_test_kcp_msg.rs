#![allow(unused_imports)]

use std::sync::atomic::{AtomicI32, Ordering};
use std::net::SocketAddr;
use std::time::{Duration, Instant};
use std::sync::Arc;

use tokio::io::AsyncWriteExt;
use bytes::{BytesMut, BufMut};
use serde::Serialize;

use tokio::io::AsyncReadExt;
use tokio_kcp::{KcpConfig, KcpStream};


const CONCURRENT_REQUESTS: usize = 2;
const TOTAL_REQUESTS: usize = 1000;


#[tokio::test(flavor = "multi_thread")]
async fn load_test_kcp() {
    let start = Instant::now();
    let mut handles = vec![];
    
    let rpc_id = Arc::new(AtomicI32::new(0));
    for _ in 0..CONCURRENT_REQUESTS {


        //let rpc_id = rpc_id.clone();

        handles.push(tokio::spawn(async move {

            let config = tokio_kcp::KcpConfig {
                mtu: 1400,
                nodelay: tokio_kcp::KcpNoDelayConfig::fastest(),

                wnd_size: (1024, 1024),
                session_expire: std::time::Duration::from_secs(30),
                flush_write: true,
                flush_acks_input: false,
                stream: false,
                allow_recv_empty_packet: false,
            };

            //let server_addr = "192.168.50.79:3100".parse::<SocketAddr>().unwrap();
            let server_addr = "127.0.0.1:3100".parse::<SocketAddr>().unwrap();
            let mut stream = KcpStream::connect(&config, server_addr).await.unwrap();

            let mut ping_msg = Vec::new();
            TiangZ::C2M_MoveToMessage{ _t: "C2M_MoveToMessage".to_string(), player_id:9527}
                .serialize(&mut rmp_serde::Serializer::new(&mut ping_msg).with_struct_map()).unwrap();

            let mut buf = BytesMut::with_capacity(2 + ping_msg.len());
            buf.put_u16(ping_msg.len() as u16);
            buf.put_slice(&ping_msg);

            //不停的写

            for _ in 0..TOTAL_REQUESTS/CONCURRENT_REQUESTS {
                stream.write_all(&buf).await.unwrap();              
            }

            drop(stream)
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
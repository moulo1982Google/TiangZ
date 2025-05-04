use TiangZ; // 你的crate名

use tokio::net::TcpStream;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use bytes::{BytesMut, BufMut};
use TiangZ::Server;

#[tokio::test]
async fn test_server_response() {
    // 启动测试服务器
    let server_handle = tokio::spawn( async {
        let server = TiangZ::TCPServer::new("0.0.0.0:8080").await;
        server.run(8, 10000).await.unwrap();
    });
    
    // 等待服务器启动
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    
    // 测试连接
    let mut stream = TcpStream::connect("127.0.0.1:8082").await.unwrap();
    
    // 发送测试消息
    let message = "integration_test";
    let mut buf = BytesMut::with_capacity(2 + message.len());
    buf.put_u16(message.len() as u16);
    buf.put(message.as_bytes());
    
    stream.write_all(&buf).await.unwrap();
    
    // 读取响应
    let mut response = BytesMut::with_capacity(1024);
    let n = stream.read_buf(&mut response).await.unwrap();
    
    assert!(n > 0);
    assert_eq!(&response[..message.len()], message.as_bytes());
    
    server_handle.abort();
}
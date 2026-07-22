#[cfg(feature = "kcp")]
#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    use std::net::SocketAddr;
    use std::time::Duration;

    let address = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1:7000".to_string())
        .parse::<SocketAddr>()?;
    let mut client = tiangz_transport::KcpClient::connect(address).await?;
    let request = [0x27, 0x12, 0xd0, 0x05, 0x01];
    let response = client.request(&request, Duration::from_secs(5)).await?;
    if response.len() < 2 || u16::from_be_bytes([response[0], response[1]]) != 10_003 {
        anyhow::bail!("unexpected KCP response frame: {response:02x?}");
    }
    println!("kcp-smoke passed response_bytes={}", response.len());
    client.close().await?;
    Ok(())
}

#[cfg(not(feature = "kcp"))]
fn main() {
    eprintln!("kcp_smoke requires --features kcp");
    std::process::exit(2);
}

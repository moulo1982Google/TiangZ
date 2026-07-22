#[cfg(feature = "kcp")]
pub mod kcp;
#[cfg(feature = "kcp")]
mod kcp_client;
#[cfg(feature = "kcp")]
pub mod kcp_wire;

#[cfg(feature = "kcp")]
pub use kcp_client::KcpClient;

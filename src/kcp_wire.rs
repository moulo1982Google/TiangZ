//! 独立于 KCP 字节流定义 TiangZ 带认证的 KCP Session 信封。 / Defines TiangZ's authenticated KCP session envelope independently from the KCP stream itself.

pub const PROTOCOL_VERSION: u8 = 1;
pub const HELLO: u8 = 1;
pub const CHALLENGE: u8 = 2;
pub const CONNECT: u8 = 3;
pub const ACCEPT: u8 = 4;
pub const DATA: u8 = 5;
pub const CLOSE: u8 = 6;
pub const HELLO_BYTES: usize = 14;
pub const CHALLENGE_BYTES: usize = 26;
pub const ACCEPT_BYTES: usize = 10;
pub const DATA_HEADER_BYTES: usize = 10;
pub const CLOSE_BYTES: usize = 14;

pub fn read_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap())
}

pub fn read_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(bytes[offset..offset + 8].try_into().unwrap())
}

pub fn write_u32(bytes: &mut [u8], offset: usize, value: u32) {
    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

pub fn write_u64(bytes: &mut [u8], offset: usize, value: u64) {
    bytes[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

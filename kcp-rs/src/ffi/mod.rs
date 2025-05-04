#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]
#![allow(non_snake_case)]
#![allow(clippy::all)]

pub use self::kcp::*;
mod kcp {
    include!(concat!(env!("OUT_DIR"), "/kcp.rs"));
}
use thiserror::Error;

#[derive(Error, Debug)]
pub enum KcpError {
    #[error("KCP receive queue empty")]
    RecvQueueEmpty,
    #[error("KCP send buffer full")]
    SendBufferFull,
    #[error("KCP invalid argument")]
    InvalidArg,
    #[error("KCP unknown error: {0}")]
    Unknown(i32),
}

impl From<i32> for KcpError {
    fn from(code: i32) -> Self {
        match code {
            -1 => Self::RecvQueueEmpty,
            -2 => Self::SendBufferFull,
            -3 => Self::InvalidArg,
            _ => Self::Unknown(code),
        }
    }
}
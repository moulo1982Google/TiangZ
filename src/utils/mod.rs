use std::sync::atomic::{AtomicI64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

static COUNTER: AtomicI64 = AtomicI64::new(0);
const INSTANCE_ID: i64 = 123; // 实例唯一标识（0-511）

pub fn generate_id() -> i64 {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64;

    let seq = COUNTER.fetch_add(1, Ordering::Relaxed) & 0x3FF;
    
    (timestamp << 19) | 
    (INSTANCE_ID << 10) | 
    seq
}
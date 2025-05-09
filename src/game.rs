use std::time::{Duration, Instant};
use tokio::time::{sleep, timeout};
use lazy_static::lazy_static;
use tracing::{trace, warn};

const TARGET_FPS: u32 = 60;
const FRAME_DURATION: Duration = Duration::from_nanos(1_000_000_000 / TARGET_FPS as u64);

lazy_static! {
    pub static ref GAME_STATE: std::sync::Arc<tokio::sync::RwLock<GameState>> = 
        std::sync::Arc::new(tokio::sync::RwLock::new(GameState::new()));
}

#[derive(Clone, Copy)]  // 允许复制时间数据
struct FrameTiming {
    pub delta_time: f32,
    pub last_frame_time: Instant,
    pub current_time: Instant,
}

pub struct GameState {
    timing: FrameTiming,
}

impl GameState {

    fn new() -> Self {
        let now = Instant::now();
        Self {
            timing: FrameTiming {
                delta_time: 1.0 / TARGET_FPS as f32,
                last_frame_time: now,
                current_time: now,
            },
        }
    }

    fn update_timing(&mut self, current_time: Instant) {
        self.timing.delta_time = (current_time - self.timing.current_time).as_secs_f32();
        self.timing.last_frame_time = self.timing.current_time; // 上一帧的时间
        self.timing.current_time = current_time; // 当前帧的时间
    }

    async fn update(&self) {
        let timing = self.timing;
        trace!("delta_time: {}", timing.delta_time);
        crate::event::event_system::EventSystem::instance().update(timing.delta_time).await;
    }
}

pub async fn game_loop() {
    loop {
        let frame_start = Instant::now();

        {
            let mut state = GAME_STATE.write().await;
            state.update_timing(frame_start);
        }
        
        // 更新游戏状态
        GAME_STATE.read().await.update().await;
        
        // 帧率控制：计算当前帧实际耗时，并 sleep 剩余时间
        let elapsed = frame_start.elapsed();
        if let Some(sleep_time) = FRAME_DURATION.checked_sub(elapsed) {
            sleep(sleep_time).await;
        } else {
            // 如果帧处理超时，打印警告
            warn!("Frame took too long: {:.2}ms (target: {:.2}ms)", 
                elapsed.as_secs_f64() * 1000.0,
                FRAME_DURATION.as_secs_f64() * 1000.0
            );
        }
    }
}
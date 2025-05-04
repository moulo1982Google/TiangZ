#![allow(unused_imports)]
// 事件系统模块
pub mod event_system;
pub mod monster; 
mod on_monster_move;
mod timer;

// 重新导出常用组件，方便使用
pub use event_system::{
    IEventParam,
    EventSystem,
    IEvent
};

// 导出已有的事件与处理器
pub use monster::*; 
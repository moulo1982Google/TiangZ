// #![allow(dead_code)]

// use std::fmt::Debug;
// use std::time::Duration;
// use std::sync::{Arc, RwLock, OnceLock};
// use tokio::sync::{mpsc, oneshot};
// use tokio::time::Instant;
// use tokio_util::time::{delay_queue, DelayQueue};
// use futures::StreamExt;



// // 任务处理结果类型
// type TaskResult<T> = Result<T, String>;

// // Actor操作枚举
// #[derive(Debug)]
// enum DelayQueueOp<T> {
//     // 基础操作
//     Insert(T, Duration, oneshot::Sender<TaskResult<delay_queue::Key>>),
//     InsertAt(T, Instant, oneshot::Sender<TaskResult<delay_queue::Key>>),
//     Remove(delay_queue::Key, oneshot::Sender<TaskResult<T>>),
//     Clear(oneshot::Sender<TaskResult<()>>),
//     Shutdown,
    
//     // 管理操作
//     GetStats(oneshot::Sender<TaskResult<QueueStats>>),
// }

// // 队列统计信息
// #[derive(Debug, Clone)]
// struct QueueStats {
//     item_count: usize,
//     is_empty: bool,
// }

// // 任务到期时的回调函数类型
// type TaskCallback<T> = Box<dyn Fn(T) -> () + Send + 'static>;

// // TimerActor公共API
// #[derive(Clone)]
// pub struct TimerHandle<T> {
//     sender: mpsc::Sender<DelayQueueOp<T>>,
// }

// impl<T: Clone + Send + Debug + 'static> TimerHandle<T> {
//     // 插入新的延迟任务
//     pub async fn schedule(&self, task: T, delay: Duration) -> TaskResult<delay_queue::Key> {
//         let (tx, rx) = oneshot::channel();
//         self.sender.send(DelayQueueOp::Insert(task, delay, tx)).await
//             .map_err(|_| "计时器Actor已关闭".to_string())?;
//         rx.await.map_err(|_| "计时器Actor未返回结果".to_string())?
//     }
    
//     // 在特定时间点插入任务
//     pub async fn schedule_at(&self, task: T, time: Instant) -> TaskResult<delay_queue::Key> {
//         let (tx, rx) = oneshot::channel();
//         self.sender.send(DelayQueueOp::InsertAt(task, time, tx)).await
//             .map_err(|_| "计时器Actor已关闭".to_string())?;
//         rx.await.map_err(|_| "计时器Actor未返回结果".to_string())?
//     }
    
//     // 移除任务
//     pub async fn cancel(&self, key: delay_queue::Key) -> TaskResult<T> {
//         let (tx, rx) = oneshot::channel();
//         self.sender.send(DelayQueueOp::Remove(key, tx)).await
//             .map_err(|_| "计时器Actor已关闭".to_string())?;
//         rx.await.map_err(|_| "计时器Actor未返回结果".to_string())?
//     }
    
//     // 清空队列
//     pub async fn clear(&self) -> TaskResult<()> {
//         let (tx, rx) = oneshot::channel();
//         self.sender.send(DelayQueueOp::Clear(tx)).await
//             .map_err(|_| "计时器Actor已关闭".to_string())?;
//         rx.await.map_err(|_| "计时器Actor未返回结果".to_string())?
//     }
    
//     // 获取队列统计信息
//     async fn get_stats(&self) -> TaskResult<QueueStats> {
//         let (tx, rx) = oneshot::channel();
//         self.sender.send(DelayQueueOp::GetStats(tx)).await
//             .map_err(|_| "计时器Actor已关闭".to_string())?;
//         rx.await.map_err(|_| "计时器Actor未返回结果".to_string())?
//     }
    
//     // 关闭计时器
//     pub async fn shutdown(&self) -> Result<(), String> {
//         self.sender.send(DelayQueueOp::Shutdown).await
//             .map_err(|_| "计时器Actor已关闭".to_string())
//     }
// }

// // TimerActor核心实现
// pub struct TimerActor<T> {
//     delay_queue: DelayQueue<T>,
//     receiver: mpsc::Receiver<DelayQueueOp<T>>,
//     task_callback: Option<TaskCallback<T>>,
// }

// impl<T: Clone + Send + Debug + 'static> TimerActor<T> {
//     // 创建新的计时器Actor和Handle
//     pub fn new() -> (Self, TimerHandle<T>) {
//         let (sender, receiver) = mpsc::channel(100);
        
//         let actor = TimerActor {
//             delay_queue: DelayQueue::new(),
//             receiver,
//             task_callback: None,
//         };
        
//         let handle = TimerHandle { sender };
        
//         (actor, handle)
//     }
    
//     // 带回调函数创建
//     pub fn with_callback(callback: impl Fn(T) -> () + Send + 'static) -> (Self, TimerHandle<T>) {
//         let (mut actor, handle) = Self::new();
//         actor.task_callback = Some(Box::new(callback));
//         (actor, handle)
//     }
    
//     // 设置容量
//     pub fn with_capacity(capacity: usize) -> (Self, TimerHandle<T>) {
//         let (sender, receiver) = mpsc::channel(100);
        
//         let actor = TimerActor {
//             delay_queue: DelayQueue::with_capacity(capacity),
//             receiver,
//             task_callback: None,
//         };
        
//         let handle = TimerHandle { sender };
        
//         (actor, handle)
//     }
    
//     // 运行Actor主循环
//     pub async fn run(mut self) {
//         loop {
//             tokio::select! {
//                 // 处理过期的任务
//                 Some(expired) = self.delay_queue.next() => {
//                     let value = expired.into_inner();
                    
//                     // 如果有回调函数，则调用
//                     if let Some(callback) = &self.task_callback {
//                         callback(value.clone());
//                     } else {
//                         println!("任务已过期: {:?}", value);
//                     }
//                 }
                
//                 // 处理收到的操作请求
//                 Some(op) = self.receiver.recv() => {
//                     match op {
//                         DelayQueueOp::Insert(task, duration, reply) => {
//                             let key = self.delay_queue.insert(task, duration);
//                             let _ = reply.send(Ok(key));
//                         }
                        
//                         DelayQueueOp::InsertAt(task, time, reply) => {
//                             let key = self.delay_queue.insert_at(task, time);
//                             let _ = reply.send(Ok(key));
//                         }
                        
//                         DelayQueueOp::Remove(key, reply) => {
//                             let entry = self.delay_queue.remove(&key);
//                             let _ = reply.send(Ok(entry.into_inner()));
//                         }
                        
//                         DelayQueueOp::Clear(reply) => {
//                             self.delay_queue.clear();
//                             let _ = reply.send(Ok(()));
//                         }
                        
//                         DelayQueueOp::GetStats(reply) => {
//                             let stats = QueueStats {
//                                 item_count: self.delay_queue.len(),
//                                 is_empty: self.delay_queue.is_empty(),
//                             };
//                             let _ = reply.send(Ok(stats));
//                         }
                        
//                         DelayQueueOp::Shutdown => {
//                             println!("计时器Actor接收到关闭请求");
//                             break;
//                         }
//                     }
//                 }
                
//                 // 如果没有任务且通道已关闭，则退出
//                 else => {
//                     if self.delay_queue.is_empty() {
//                         println!("计时器Actor通道已关闭且队列为空，退出");
//                         break;
//                     }
//                 }
//             }
//         }
//     }
// }

// //////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////


// pub trait TimerEventHandler<P: crate::event::EventParam>: Send + Sync {
//     fn handle(&self, param: &P);
// }

// pub struct TimerSystem<P: crate::event::EventParam> {
//     handlers: Arc<RwLock<Vec<Box<dyn TimerEventHandler<P>>>>>,
// }

// // 手动实现单例模式
// impl<P: crate::event::EventParam> TimerSystem<P> {
//     /// 获取全局单例实例
//     // pub fn instance() -> &'static Self {
//     //     static INSTANCE: OnceLock<TimerActor> = OnceLock::new();
//     //     INSTANCE.get_or_init(|| TimerActor::new())
//     // }

//     fn register(&self, handler: impl TimerEventHandler<P> + 'static) {
//         self.handlers.write().unwrap().push(Box::new(handler));
//     }

//     pub fn init(&self) {
//         for factory in inventory::iter::<TimerEventHandlerFactory> {
//             (factory.register_fn)(self);
//         }
//     }
// }

// // ========== 事件处理器工厂 ==========
// /// 事件处理器工厂，用于自动注册事件处理器
// pub struct TimerEventHandlerFactory {
//     pub name: &'static str,
//     pub register_fn: fn(&TimerSystem),
// }

// inventory::collect!(TimerEventHandlerFactory);

// #[cfg(test)]
// mod main_tests {
//     use super::*;

//     #[tokio::test]
//     async fn test_timer_actor() {
//     }
// }
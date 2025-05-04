#![allow(unused)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::{result, sync::Arc};
use std::any::Any;
use dashmap::DashMap;
use tokio::runtime;
use rand::Rng;
use tokio::net::{TcpStream, TcpListener};
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use bytes::{BytesMut, Buf};
use tokio::task;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use async_trait::async_trait;

use gen_macro::EventHandler;


//回调，必须有一个回调类型

pub trait IEventParam: Any + Send + Sync + Clone {}
impl<T: Any + Send + Sync + Clone> IEventParam for T {}

#[async_trait]
pub trait IEvent<P: IEventParam>: Send + Sync {
    async fn handle(&self, param: P);
}

struct CallBackPack<P: IEventParam> {
    handler: Box<dyn IEvent<P>>,
}

impl<P: IEventParam> CallBackPack<P> {
    fn new(handler: impl IEvent<P> + 'static) -> Self {
        Self {
            handler: Box::new(handler),
        }
    }
}

pub struct EventSystem {
    call_back_map: DashMap<std::any::TypeId, Box<dyn Any + Send + Sync>>,
}

impl EventSystem {
    fn new() -> Self {
        Self {
            call_back_map: DashMap::new(),
        }
    }

    pub fn instance() -> &'static Self {
        static INSTANCE: std::sync::OnceLock<EventSystem> = std::sync::OnceLock::new();
        INSTANCE.get_or_init(|| {
            let mut instance = EventSystem::new();
            instance.init();
            instance
        })
    }

    pub fn init(&mut self) {
        for factory in inventory::iter::<CallBackHandlerFactory> {
            (factory.register_fn)(self);
        }
        
    }

    // 注册回调函数
    pub fn register_call_back<P: IEventParam + Any + Send + Sync>(&self, call_back: impl IEvent<P> + 'static) {
        // 将回调函数插入到回调函数映射表中
        self.call_back_map.insert(std::any::TypeId::of::<P>(), Box::new(CallBackPack::new(call_back)));
    }
    
    // 执行回调函数
    pub async fn publish_async<P: IEventParam + Any + Send + Sync>(&self, param: P) {
        // 从回调函数映射表中获取回调函数
        if let Some(call_back) = self.call_back_map.get(&std::any::TypeId::of::<P>()) {
            // 执行回调函数
            if let Some(call_back_pack) = call_back.downcast_ref::<CallBackPack<P>>() {
                // 克隆参数而不是借用
                call_back_pack.handler.handle(param.clone()).await;
            }
        }
    }
}

pub struct CallBackHandlerFactory {
    pub register_fn: fn(&EventSystem),
}

inventory::collect!(CallBackHandlerFactory);


#[cfg(test)]
mod tests {
    
    use crate::event::EventSystem;

    #[tokio::test]
    async fn test_event_system() -> std::io::Result<()> {   
        EventSystem::instance().publish_async(crate::event::MonsterMoveParam { monster_id: 1, x: 1.0, y: 2.0 }).await;
        tokio::spawn(EventSystem::instance().publish_async(crate::event::MonsterMoveParam { monster_id: 2, x: 3.0, y: 4.0 }));
        tokio::spawn(EventSystem::instance().publish_async(crate::event::MonsterDeadParam {x: 1.0, y: 2.0 }));
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        println!("1");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        println!("2");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        println!("3");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        println!("4");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        println!("5");
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        println!("6");

        println!("执行完毕");
        Ok(())
    }
}

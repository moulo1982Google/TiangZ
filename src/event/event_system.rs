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

pub trait IEventParam: Any + Clone {}
impl<T: Any + Clone> IEventParam for T {}

#[async_trait]
pub trait IEvent<P: IEventParam> {
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
    call_back_map: DashMap<std::any::TypeId, std::boxed::Box<dyn std::any::Any>>,
    update_call_back_map: DashMap<i64, std::rc::Rc<std::cell::RefCell<dyn crate::entity::Update>>>,

}

unsafe impl Send for EventSystem {}
unsafe impl Sync for EventSystem {}

lazy_static::lazy_static! {
    static ref INSTANCE: EventSystem = {
        let mut instance = EventSystem::new();
        instance.init();
        instance
    };
}

impl EventSystem {
    fn new() -> Self {
        Self {
            call_back_map: DashMap::new(),
            update_call_back_map: DashMap::new(),
        }
    }

    pub fn instance() -> &'static EventSystem {
        &INSTANCE
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

    pub fn register_update_handler(&self, id: i64, handler: std::rc::Rc<std::cell::RefCell<dyn crate::entity::Update>>) {
        self.update_call_back_map.insert(id, handler);
    }

    pub fn unregister_update_handler(&self, id: i64) {
        self.update_call_back_map.remove(&id);
    }

    pub fn update(&self, delta_time: f32) {
        for handler in self.update_call_back_map.iter() {
            let handler = handler.clone();
            tokio::task::spawn_local(async move {
                handler.borrow_mut().update(delta_time);
            });
        }
    }
}

pub struct CallBackHandlerFactory {
    pub register_fn: fn(&EventSystem),
}

inventory::collect!(CallBackHandlerFactory);


#[cfg(test)]
mod tests {
}

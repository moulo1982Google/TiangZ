#![allow(dead_code)]

pub mod scene;
pub mod monster;
pub mod player;
pub mod unit;
pub mod npc;
pub mod root;
pub mod server_scene_manager;

use std::any::Any;
use dashmap::DashMap;

pub type EntityType = dyn EntityTrait + Send + Sync;
pub type ComponentType = dyn ComponentTrait + Send + Sync;
pub type StdParentOption = std::option::Option<std::sync::Weak<std::sync::RwLock<EntityType>>>;
pub type ChildType = std::sync::Arc<std::sync::RwLock<EntityType>>;
pub type StdChildrens = std::sync::Arc<DashMap<i64, std::sync::Arc<std::sync::RwLock<EntityType>>>>;

pub trait EntityTrait: Any {
    fn get_id(&self) -> i64;
    fn as_any(&self) -> &dyn Any;
    fn as_any_mut(&mut self) -> &mut dyn Any;
}

pub trait SelfNameTrait {
    fn to_type_string() -> &'static str;
}

pub trait Unit: Any {
    
}
pub trait ComponentTrait: EntityTrait {
    
}

pub trait Awake {
    fn awake(&self);
}

pub trait Destroy {
    fn destroy(&mut self);
}

#[async_trait::async_trait]
pub trait Update {
    async fn update(&mut self);
}

pub trait Builder: 'static {
    fn new()  -> std::sync::Arc<tokio::sync::Mutex<Self>> where Self: Sized;
}

pub trait StaticBuilder: 'static {
    fn new()  -> &'static Self where Self: Sized;
}

#[derive(Clone)]
pub struct ChildBase {
}

// pub trait Singleton {
//     fn instance() -> &'static Self;
// }


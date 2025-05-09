#![allow(unused_imports)]

use crate::create_entity;
use gen_macro::Entity;
use crate::entity::Builder;
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;
use tracing::info;
use crate::entity::scene::Scene;
use crate::entity::server_scene_manager::ServerSceneManagerComponent;

use super::scene::SceneFactory;

struct ComponentWrapper(std::sync::Arc<dyn std::any::Any + Send + Sync>);

pub struct Root {
    scene: std::sync::Arc<tokio::sync::Mutex<Scene>>,
    components: dashmap::DashMap::<
        std::any::TypeId, 
        ComponentWrapper
    >,
}

impl Root {

    pub fn instance() -> &'static Self {
        static INSTANCE: std::sync::OnceLock<Root> = std::sync::OnceLock::new();
        INSTANCE.get_or_init(|| {
            Root::new()
        })
    }


    pub fn add_component<T>(&self) 
    where 
        T: crate::entity::ComponentTrait + crate::entity::Builder + 'static  + Send + Sync
    {
        self.components.insert(std::any::TypeId::of::<T>(), ComponentWrapper(T::new()));
    }

    pub fn add_component_p1<T, P1>(&self, p1: P1) 
    where 
        T: crate::entity::ComponentTrait + crate::entity::BuilderP1<P1> + 'static  + Send + Sync
    {
        self.components.insert(std::any::TypeId::of::<T>(), ComponentWrapper(T::new(p1)));
    }
    
    async fn get_component<T>(
        &self
    ) -> Option<std::sync::Arc<tokio::sync::Mutex<T>>> 
    where 
        T: crate::entity::ComponentTrait + crate::entity::Builder + 'static  + Send + Sync
    {
        self.components.get(&std::any::TypeId::of::<T>())
            .and_then(|entry| {
                let wrapper = entry.value().0.clone();
                wrapper.downcast::<tokio::sync::Mutex<T>>().ok()
            })
    }

    pub fn new() -> Self {
        let ins = Self {
            scene: SceneFactory::create_scene(super::scene::SceneType::Process, None),
            components: dashmap::DashMap::new(),
        };
        ins
    }

    pub async fn run(&self) {
        info!("Root run");
    }
}

#[cfg(test)]
mod tests {
    #![allow(unused_variables)]
    use crate::net_service::NetInnerComponent;

    use super::*;

    fn test_root() {
        let root = Root::instance();
        root.add_component::<NetInnerComponent>();
    }
}


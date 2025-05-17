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

struct ComponentWrapper<T>(std::rc::Rc<std::cell::RefCell<T>>);
unsafe impl<T> Send for ComponentWrapper<T> {}

unsafe impl Send for Root {}
unsafe impl Sync for Root {}

lazy_static::lazy_static! {
    static ref INSTANCE: Root = {
        let instance = Root::new();
        instance
    };
}

pub struct Root {
    scene: std::rc::Rc<std::cell::RefCell<std::boxed::Box<Scene>>>,
    components: dashmap::DashMap::<
        std::any::TypeId, 
        ComponentWrapper<std::boxed::Box<dyn std::any::Any>>
    >,
}

impl Root {

    pub fn instance() -> &'static Self {
        &INSTANCE
    }


    pub fn add_component<T>(&self) 
    where 
        T: crate::entity::ComponentTrait + crate::entity::Builder
    {
        self.components.insert(std::any::TypeId::of::<T>(), 
        ComponentWrapper(std::rc::Rc::new(std::cell::RefCell::new(std::boxed::Box::new(T::new()) as Box<dyn std::any::Any>))));
    }

    pub fn add_component_p1<T, P1>(&self, p1: P1) 
    where 
        T: crate::entity::ComponentTrait + crate::entity::BuilderP1<P1>
    {
        self.components.insert(std::any::TypeId::of::<T>(), ComponentWrapper(std::rc::Rc::new(std::cell::RefCell::new(std::boxed::Box::new(T::new(p1)) as Box<dyn std::any::Any>))));
    }

    pub fn add_component_p2<T, P1, P2>(&self, p1: P1, p2: P2) 
    where 
        T: crate::entity::ComponentTrait + crate::entity::BuilderP2<P1, P2>
    {
        self.components.insert(std::any::TypeId::of::<T>(), ComponentWrapper(std::rc::Rc::new(std::cell::RefCell::new(std::boxed::Box::new(T::new(p1, p2)) as Box<dyn std::any::Any>))));
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
    use super::*;

    fn test_root() {

    }
}


#![allow(dead_code)]

pub mod scene;
pub mod root;
pub mod server_scene_manager;

//pub mod unit;
//pub mod npc;
//pub mod monster;
//pub mod player;

use std::any::Any;

//父级弱引用
pub type StdParentOption = std::option::Option<std::rc::Weak<std::cell::RefCell<dyn EntityTrait>>>;

//子级强引用
pub type ChildType = std::rc::Rc<std::cell::RefCell<dyn EntityTrait>>;
//pub type StdChildrens = dashmap::DashMap<i64, ChildType>;

pub type ComponentType = std::rc::Rc<std::cell::RefCell<dyn ComponentTrait>>;
//pub type StdComponents = dashmap::DashMap<i64, ComponentType>;

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

pub trait AwakeP1<P1> {
    fn awake(&self, p1: P1);
}

pub trait AwakeP2<P1, P2> {
    fn awake(&self, p1: P1, p2: P2);
}

pub trait Destroy {
    fn destroy(&mut self);
}

pub trait Update {
    fn update(&mut self, delta_time: f32);
}

pub trait Builder: 'static {
    fn new()  -> std::rc::Rc<std::cell::RefCell<Self>> where Self: Sized;
}

pub trait BuilderP1<P1>: 'static {
    fn new(p1: P1)  -> std::rc::Rc<std::cell::RefCell<Self>> where Self: Sized;
}

pub trait BuilderP2<P1, P2>: 'static {
    fn new(p1: P1, p2: P2)  -> std::rc::Rc<std::cell::RefCell<Self>> where Self: Sized;
}

pub trait StaticBuilder: 'static {
    fn new()  -> &'static Self where Self: Sized;
}
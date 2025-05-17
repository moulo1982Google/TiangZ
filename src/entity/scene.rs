use crate::create_entity;
use gen_macro::Entity;
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;

use super::{AwakeP2, Destroy, StdParentOption};

#[derive(Debug)]
pub enum SceneType {
    None,
    Process,
}

impl Default for SceneType {
    fn default() -> Self {
        SceneType::None
    }
}

create_entity! {
    #[derive(Entity)]
    #[awake(SceneType, StdParentOption)]
    #[destroy]
    pub struct Scene {
        pub scene_type: SceneType,
        pub parent: StdParentOption,
    }
}

impl AwakeP2<SceneType, StdParentOption> for std::rc::Rc<std::cell::RefCell<Scene>> {
    fn awake(&self, scene_type: SceneType, parent: StdParentOption) {
        trace!("Scene awake called, scene_type: {:?}, parent: {:?}", scene_type, parent);
    }
}

impl Destroy for Scene {
    fn destroy(&mut self) {
        trace!("Scene destroy called");
    }
}

pub struct SceneFactory {
    
}

impl SceneFactory {
    pub fn create_scene(scene_type: SceneType, parent: StdParentOption) -> std::rc::Rc<std::cell::RefCell<std::boxed::Box<Scene>>> {
        convert(Scene::new_origin(scene_type, parent))
    }
}

fn convert<T>(rc_refcell: std::rc::Rc<std::cell::RefCell<T>>) -> std::rc::Rc<std::cell::RefCell<std::boxed::Box<T>>> 
where
    T: std::fmt::Debug
{
    // 1. 从 Rc<RefCell<T>> 中提取 T 的所有权
    let value = std::rc::Rc::try_unwrap(rc_refcell)  // 尝试解包 Rc
        .unwrap()                          // 如果 Rc 唯一，则成功
        .into_inner();                     // 解包 RefCell，获取 T

    // 2. 将 T 包装为 Box<T>，再重新封装为 Rc<RefCell<Box<T>>>
    std::rc::Rc::new(std::cell::RefCell::new(std::boxed::Box::new(value)))
}

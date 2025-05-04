use TiangZ::create_entity;
use gen_macro::Entity;
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;

use super::{Awake, Destroy, StdParentOption};

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
    #[awake]
    #[destroy]
    pub struct Scene {
        pub scene_type: SceneType,
        pub parent: StdParentOption,
    }
}

impl Awake for Scene {
    fn awake(&mut self) {
        trace!("Scene awake called");
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
    pub fn create_scene(scene_type: SceneType, parent: StdParentOption) -> Scene {
        Scene::new_origin_with_param(scene_type, parent)
    }
}


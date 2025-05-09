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

impl AwakeP2<SceneType, StdParentOption> for std::sync::Arc<tokio::sync::Mutex<Scene>> {
    fn awake(&self, scene_type: SceneType, parent: StdParentOption) {
        //let scene = self.lock().unwrap();
        //scene.scene_type = scene_type;
        //scene.parent = parent;
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
    pub fn create_scene(scene_type: SceneType, parent: StdParentOption) -> std::sync::Arc<tokio::sync::Mutex<Scene>> {
        Scene::new_origin(scene_type, parent)
    }
}


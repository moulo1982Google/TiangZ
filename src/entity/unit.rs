use crate::create_entity;
use gen_macro::{Entity, Component};
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;
use crate::entity::Awake;


create_entity! {
    #[derive(Clone)]
    #[derive(Entity)]
    #[awake]
    pub struct Unit {
    }
}

impl Awake for std::sync::Arc<tokio::sync::Mutex<Unit>> {
    fn awake(&self) {
        trace!("Unit awake called");
    }
}


create_entity! {
    #[derive(Component)]
    #[awake]
    pub struct UnitComponent<Unit> {
    }
}

impl Awake for std::sync::Arc<tokio::sync::Mutex<UnitComponent>> {
    fn awake(&self) {
        trace!("UnitComponent awake called");
    }
}

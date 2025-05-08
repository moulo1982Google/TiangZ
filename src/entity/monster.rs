use crate::create_entity;
use gen_macro::Entity;
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;
use crate::entity::Awake;

create_entity! {
    #[derive(Entity)]
    #[awake]
    pub struct Monster {
        pub health: i32,
        pub level: u8,
    }
}

impl Awake for std::sync::Arc<tokio::sync::Mutex<Monster>> {
    fn awake(&self) {
        trace!("Monster awake called");
    }
}

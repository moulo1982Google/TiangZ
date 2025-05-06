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

impl Awake for Monster {
    fn awake(self: &mut Monster) {
        trace!("Monster awake called");
    }
}

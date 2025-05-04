use TiangZ::create_entity;
use gen_macro::Entity;
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;
use crate::entity::{Awake, Destroy};

create_entity! {
    #[derive(Entity)]
    #[awake]
    #[destroy]
    pub struct Player {
        pub health: i32,
        pub level: u8,
    }
}

impl Awake for Player {
    fn awake(&mut self) {
        trace!("Player awake called");
    }
}

impl Destroy for Player {
    fn destroy(&mut self) {
        trace!("Player destroy called");
    }
}

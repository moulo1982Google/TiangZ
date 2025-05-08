use crate::create_entity;
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

impl Awake for std::sync::Arc<tokio::sync::Mutex<Player>> {
    fn awake(&self) {
        trace!("Player awake called");
    }
}

impl Destroy for Player {
    fn destroy(&mut self) {
        trace!("Player destroy called");
    }
}

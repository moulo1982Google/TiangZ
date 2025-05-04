use TiangZ::create_entity;
use gen_macro::Entity;
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;
use crate::entity::Awake;

create_entity! {
    #[derive(Entity)]
    pub struct Npc {
        pub x: f32,
        pub y: f32,
    }
}

//Npc结构体，没有加[awake]标记，所以就算实现了Awake，也不会被调用
impl Awake for Npc {
    fn awake(self: &mut Npc) {
        trace!("NpcEntity awake called");
    }
}
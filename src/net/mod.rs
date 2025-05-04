use TiangZ::create_entity;
use crate::entity::Awake;
use gen_macro::Component;
//use crate::errors::my_errors::{MyError, RetResult};
use tracing::trace;

create_entity! {
    #[derive(Component)]
    #[awake]
    pub struct NetServerComponent {
    }
}

impl Awake for NetServerComponent {
    fn awake(self: &mut NetServerComponent) {
        trace!("NetServerComponent awake called");
    }
}

// impl NetServerComponent {
//     pub async fn run(&self) {
        
//     }
// }
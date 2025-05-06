use crate::create_entity;
use gen_macro::Component;
//use crate::entity::Builder;

create_entity! {
    #[derive(Component)]
    pub struct ServerSceneManagerComponent {
    }
}
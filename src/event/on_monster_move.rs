//use gen_macro::event_handler;
//use crate::event::event_system::EventHandler;

// #[derive(Debug)]
// struct MonsterMoveParam { x: i32, y: i32 }

// struct OnMonsterMove;
// #[async_trait::async_trait]
// impl EventHandler for OnMonsterMove {
//     type Event = MonsterMoveParam;
//     async fn handle(&self, event: &MonsterMoveParam) {
//         println!("Handling move to ({}, {})", event.x, event.y);
//     }
// }
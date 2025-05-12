#![allow(unused)]
use tracing::{trace, error, info, warn, debug};
use std::cell::RefCell;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::net::{TcpStream, TcpListener};

use crate::net_service::tcp_service::{TcpService, NetService};
use crate::create_entity;
use gen_macro::{Component, Entity};
use crate::entity::{AwakeP1, Update};

create_entity! {
    #[derive(Component, Default)]
    #[awake(String)]
    #[update]
    pub struct NetInnerComponent {
        service_id: usize,
    }
}

impl AwakeP1<String> for std::rc::Rc<std::cell::RefCell<NetInnerComponent>> {
    fn awake(&self, p1: String) {
        trace!("NetInnerComponent awake called");
        let clone = self.clone();
        tokio::task::spawn_local(async move {
            clone.borrow_mut().start(p1).await;
        });
    }
}


impl Update for NetInnerComponent {
    fn update(&mut self, delta_time: f32) {
        trace!("NetInnerComponent update called");
    }
}

impl NetInnerComponent {
    async fn start(&mut self, addr: String) {
        let service_id = NetService::instance().add_service(
            Box::new(TcpService::new(&addr)
            .await.unwrap()));

        //NetService::instance().register_accept(service_id, self.on_accept);
        //NetService::instance().register_read(service_id, self.on_read);
        //NetService::instance().register_error(service_id, self.on_error);

        self.service_id = service_id;

        trace!("NetInnerComponent start at {}", addr);
    }

    // pub async fn add_child_with_id<T, P1>(&self, id: i64, p1: P1) -> crate::entity::ChildType 
    // where 
    //     T: crate::entity::Builder + crate::entity::EntityTrait + Send + Sync
    // {
    //     let child_entity = T::new();
    //     let child_id = child_entity.lock().await.get_id();
    //     let ret = child_entity.clone();
    //     self.children.insert(child_id, child_entity);
    //     ret
    // }

    // fn on_accept(&self, channel_id: i64, socket: TcpStream, remote_addr: SocketAddr) {
    //     trace!("NetInnerComponent on_accept called");
    //     self.add_child_with_id<Session, usize>(channel_id, self.service_id);
    // }

    // fn on_read(&self, channel_id: i64, message: crate::NetworkMessage) {
    //     trace!("NetInnerComponent on_read called");
    //     let session = self.get_child::<Session>(channel_id).unwrap();
        
    //     session.last_recv_time = Time::now();
        
    //     self.handle_message(message);
    // }

    // fn on_error(&self, socket: TcpStream, remote_addr: SocketAddr) {
    //     trace!("NetInnerComponent on_error called");
    //     // let session = self.get_child::<Session>(channel_id).unwrap();
    //     // session.on_error(socket, remote_addr);
    //     // self.remove_child(channel_id);
    // }

    // fn handle_message(&self, message: crate::NetworkMessage) {
    //     trace!("NetInnerComponent handle_message called");
    // }
}


create_entity! {
    #[derive(Entity, Default)]
    pub struct Session {
        service_id: usize,
    }
}
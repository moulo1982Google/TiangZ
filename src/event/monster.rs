#![allow(dead_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::{result, sync::Arc};
use std::any::Any;
use dashmap::DashMap;
use tokio::runtime;
use rand::Rng;
use tokio::net::{TcpStream, TcpListener};
use tokio::io::{self, AsyncReadExt, AsyncWriteExt};
use bytes::{BytesMut, Buf};
use tokio::task;
use tokio::sync::mpsc;
use tokio::time::{sleep, Duration};
use async_trait::async_trait;
use gen_macro::EventHandler;

#[derive(Clone, Debug)]
pub struct MonsterMoveParam {
    pub monster_id: u32,
    pub x: f32,
    pub y: f32,
}


#[derive(EventHandler)]
#[EventType(MonsterMoveParam)]
struct MonsterMoveHandler;

#[async_trait]
impl crate::event::IEvent<MonsterMoveParam> for MonsterMoveHandler {
    async fn handle(&self, param: MonsterMoveParam) {
        tokio::time::sleep(Duration::from_secs(2)).await;
        println!("MonsterMoveHandler: {:?}, {:?}, {:?}", param.monster_id, param.x, param.y);
    }
}


#[derive(Clone, Debug)]
pub struct MonsterDeadParam {
    pub x: f32,
    pub y: f32,
}

#[derive(EventHandler)]
#[EventType(MonsterDeadParam)]
struct MonsterDeadHandler;

#[async_trait]
impl crate::event::IEvent<MonsterDeadParam> for MonsterDeadHandler {
    async fn handle(&self, param: MonsterDeadParam) {
        println!("MonsterDeadHandler: {:?}, {:?}", param.x, param.y);
    }
}
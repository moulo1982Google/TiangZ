#![allow(unused_imports, non_snake_case)]

use std::collections::HashMap;
use std::sync::{LazyLock, Arc, atomic::{AtomicUsize, Ordering}};
use std::io;
use std::future::pending;
use std::any::Any;
use std::thread;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, broadcast};
use tokio::signal;
use bytes::{BytesMut, BufMut, Buf};
use dashmap::DashMap;
use tokio::time::{sleep, Duration};
use async_trait::async_trait;
use tracing::{trace, error, info, warn, debug};
use tokio_kcp::KcpStream;
use object_pool::Pool;

use gen_macro::{IActorLocationRpcHandler, IActorLocationRpcRequest, IActorLocationRpcResponse, 
    IActorLocationMessageRequest, IActorLocationMessageHandler, Singleton};

mod errors;
mod struct_macro;
mod event;
mod my_future;
mod protocol_parser;
mod kcp_wrapper;

use crate::errors::my_errors::RetResult;
use crate::errors::my_errors::MyError;
use protocol_parser::ProtocolParser;
//////////////////////////////////////////////////////////////////////////////////////////////
type TcpListener = tokio::net::TcpListener;  

fn start_runtime(work_thread: usize) -> Arc<tokio::runtime::Runtime> {

    // let mut core_ids = core_affinity::get_core_ids().unwrap();
    // let core_ids = core_ids.split_off(1);

    // let thread_id = Arc::new(std::sync::Mutex::new(0 as usize));

    
    Arc::new(tokio::runtime::Builder::new_multi_thread()
        .worker_threads(work_thread)
        // .on_thread_start(move || {
        //     // 将每个工作线程绑定到不同的物理核心
        //     let thread_id = Arc::clone(&thread_id);
        //     let mut guard = thread_id.lock().unwrap();
        //     let core = core_ids[ *guard % core_ids.len()];
        //     info!("thread_id:{} 已绑定到线程:{:?}", *guard, core);
        //     core_affinity::set_for_current(core);
        //     *guard = *guard + 1;
        // })
        .enable_all()
        .build()
        .unwrap())
}

pub enum NetworkMessage {
    Request {
        client_id: usize,
        data: Arc::<Box<dyn IMessage>>,
    },
    Response {
        client_id: usize,
        data: Arc::<Box<dyn IMessage>>,
    },
    Message {
        data: Arc::<Box<dyn IMessage>>,
    },
    //Shutdown,
}

#[async_trait]
pub trait Server {
    async fn run(&self, work_thead_num: usize, queue_len: usize) -> io::Result<()>;
}

struct ClientConnection {
    client_id: usize,
    //addr: std::net::SocketAddr,
    writer: std::sync::Arc<tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>>,
    msg_sender: mpsc::Sender<NetworkMessage>,
    msg_receiver: Arc<tokio::sync::Mutex<mpsc::Receiver<NetworkMessage>>>,
}

lazy_static::lazy_static! {
    static ref BYTES_MUT_POOL: Pool<BytesMut> = Pool::new(
        1024, // 最大缓存1024个实例
        || BytesMut::with_capacity(4096), // 默认分配4KB                          
    );
}

impl ClientConnection {

    pub fn new(client_id: usize, _addr: std::net::SocketAddr, writer: std::sync::Arc<tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>>) -> Self {
        let (sender, receiver) = mpsc::channel(1000);
        ClientConnection {
            client_id: client_id,
            //addr: addr,
            writer: writer,
            msg_sender: sender,
            msg_receiver: Arc::new(tokio::sync::Mutex::new(receiver)),
        }
    }   

    pub fn run(&mut self, 
        rt: Arc<tokio::runtime::Runtime>,
        clients: Arc<DashMap<usize, ClientConnection>>,
    ) {

        let socket_writer = self.writer.clone();
        let client_id = self.client_id;

        let receiver = self.msg_receiver.clone();
        rt.spawn(async move {
            //这个buff再重复使用，所以不存在内存反复分配释放问题
            let mut buf = BytesMut::with_capacity(4096);
            let mut start = Instant::now();
            loop {
                let mut receiver_guard = receiver.lock().await;
                tokio::select! {
                    result = receiver_guard.recv() => {
                        match result {
                            Some(NetworkMessage::Response { data, .. }) => {
                                let mut buf_temp = BytesMut::with_capacity(128);
                                data.to_bytes(&mut buf_temp);
                                buf.put_u16(buf_temp.len() as u16);
                                buf.unsplit(buf_temp);
                            }
                            _ => {
                                trace!("通道已关闭，退出");
                                break; // 连接关闭
                            }
                        }
                    }

                    _ = tokio::time::sleep(Duration::from_millis(10)) => {}
                }

                if buf.len() >= 1024 || start.elapsed().as_millis() >= 10 {
                    if let Err(e) = socket_writer.lock().await.write_all(&buf).await {
                        error!("write_all clientid:{}, 出错:{}", client_id, e);
                        break;
                    }
                    buf.clear();
                    start = Instant::now();
                }
            }

            clients.remove(&client_id);
        });
    }
}

pub struct TCPServer {
    clients: Arc<DashMap<usize, ClientConnection>>,
    addr: String,
    client_id: Arc<AtomicUsize>,
}

#[async_trait]
impl Server for TCPServer {
    async fn run(&self, work_thead_num: usize, queue_len: usize) -> io::Result<()>{

        let listener = TcpListener::bind(&self.addr).await?;

        info!("服务器启动成功，监听端口:{}", self.addr);

        let (shutdown_sender, _) = broadcast::channel(1);

        let rt = start_runtime(work_thead_num);

        let (request_sender, mut request_receiver) = mpsc::channel(queue_len * work_thead_num);
        let clients = self.clients.clone();
        let client_id = self.client_id.clone();

        let rt1 = Arc::clone(&rt);
        
        let mut s_receiver = shutdown_sender.subscribe();
        rt.spawn(async move {
            loop {
                tokio::select! {
                    result = listener.accept() => {
                        if let Ok((socket, addr)) = result {
    
                            let client_id = client_id.fetch_add(1, Ordering::SeqCst);
                            info!("新连接: {:?}, {}，当前共有{}个客户端", addr, client_id, clients.len());

                            let (mut reader, writer) = socket.into_split();
                            
                            let mut client_connection = ClientConnection::new(client_id, addr, 
                                Arc::new(tokio::sync::Mutex::new(writer)));

                            client_connection.run(rt1.clone(), clients.clone());
                            clients.insert(client_id, client_connection);
    
                            let request_sender = request_sender.clone();
    
                            let clientx = clients.clone();
    
                            rt1.spawn(async move {
                                
                                let mut b = ProtocolParser::new().with_max_frame_size(10*1024);
                                
                                loop {
                                    match b.read_frame(&mut reader).await {
                                        Ok(Some(message)) => {
                                            // 使用提取的函数处理消息
                                            if let Err(err) = process_frame_message(&message, client_id, &request_sender).await {
                                                match *err.downcast_ref::<MyError>().unwrap() {
                                                    // 对于关键错误，断开连接
                                                    MyError::SendRequestFailed() => break,
                                                    _ => continue,
                                                }
                                            }
                                        },
                                        Ok(None) => {
                                            info!("客户端正常关闭, client:{client_id}, 关闭socket: 协程退出");
                                            break;
                                        },
                                        Err(e) => {
                                            error!("客户端异常关闭, client:{client_id}, 关闭socket, Err:{e} 协程退出");
                                            break;
                                        }
                                    }
                                }
    
                                trace!("read frame client:{client_id} 协程退出");
                                clientx.remove(&client_id);
                                return;
                            });
                        } else {
                            error!("accept 失败，退出");
                            return;
                        }
                    }
                    _ = s_receiver.recv() => {
                        info!("listener.accept received shutdown signal, exit");
                        return; // 退出
                    }
                }
            }
        });

        let clients = self.clients.clone();

        'outer: loop {
            
            tokio::select! {
                result = request_receiver.recv() => {
                    match result {
                        Some(NetworkMessage::Request { client_id, data }) => {
                            let msg_sender = clients.get(&client_id).map(|client| client.msg_sender.clone());
                            process_message_msgpack(data, client_id, msg_sender).await;
                        }
                        Some(NetworkMessage::Message { data }) => {
                            process_message_msgpack(data, 0, std::option::Option::None).await;
                        }
                        _ => {
                            error!("request_receiver 通道已关闭");
                            break; // 连接关闭
                        }
                    }
                }
            
                _result = signal::ctrl_c() => {
                    info!("CTRL_C 被按下，服务器终止！");
                    shutdown_sender.send(()).unwrap();
                    break 'outer;
                }

                _result = handle_signal() => {
                    info!("收到kill ，服务器终止！");
                    shutdown_sender.send(()).unwrap();
                    break 'outer;
                }
            }
        }

        shutdown_sender.send(()).unwrap();

        sleep(Duration::from_secs(2)).await;

        //终止创建的运行时
        match Arc::try_unwrap(rt) {
            Ok(rt) => rt.shutdown_background(),
            Err(_) => eprintln!("Failed to shutdown: Runtime is still shared"),
        }

        // loop {
        //     let rt = rt.clone();
        //     match Arc::try_unwrap(rt) {
        //         Ok(rt) => {rt.shutdown_background(); break;}
        //         Err(_) => continue,
        //     }
        // }

        Ok(())
        //ETTask::complete().await; 
    }

}

impl TCPServer {
    pub async fn new(addr: &str) -> Self {
        TCPServer {
            clients: Arc::new(DashMap::new()),
            addr: addr.to_string(),
            client_id: Arc::new(AtomicUsize::new(0)),
        }
    }

}


async fn handle_signal() {
    pending::<()>().await;
}

//////////////////////////////////////////////////////////////////////////////////////////////
pub trait Singleton {
    fn instance() -> &'static Self;
}

#[derive(Singleton)]
pub struct Root{}
//////////////////////////////////////////////////////////////////////////////////////////////


pub enum Layer2Type {
    ActorMessage,
    ActorRequest,
    ActorResponse,
}

pub trait GetLayer2Type {
    fn get_layer2_type() -> &'static Layer2Type;
}

pub enum Layer3Type {
    ActorLocationMessage,
    ActorLocationRequest,
    ActorLocationResponse,
}

pub trait GetLayer3Type {
    fn get_layer3_type() -> &'static Layer3Type;
}

pub trait IMessage : Any + Send + Sync {
    fn with_serde_json_value(&self, message: serde_json::Value) -> RetResult<Box<dyn IMessage>>;
    fn as_any(&self) -> &dyn Any;
    fn get_type_name(&self) -> &str;
    fn to_bytes(&self, buf: &mut BytesMut);
    fn to_json_string(&self) -> String;
}

pub trait IRequest: IMessage{
    fn get_rpc_id(&self) -> i32;
}

pub trait IResponse: IMessage{
    fn get_rpc_id(&self) -> i32;
    fn get_error(&self) -> i32;
    fn get_message(&self) -> String;
}
///////////////////////////////////////////////////////////////////////////////////////////////

pub trait IActorMessage: IMessage{
}

pub trait IActorRequest: IRequest{
}

pub trait IActorResponse: IResponse{
}
///////////////////////////////////////////////////////////////////////////////////////////////

pub trait IActorLocationMessage: IActorMessage {

}

pub trait IActorLocationRequest: IActorRequest {

}

pub trait IActorLocationResponse: IActorResponse {

}

#[async_trait]
pub trait IMActorHandler : Send + Sync {
    async fn handle_message(&self, message: Arc<Box<dyn IMessage>>, client_id: usize, sender: std::option::Option<mpsc::Sender<NetworkMessage>>);
}

//带应答的ActorLocationRpc消息
#[async_trait]
pub trait AMActorLocationRpcHandler<T1: IActorLocationRequest, T2: IActorLocationResponse> {
    async fn handler(&self, request: &T1, response: &mut T2);
}

//带应答的ActorRpc消息
#[async_trait]
pub trait AMActorRpcHandler<T1: IActorRequest, T2: IActorResponse> {
    async fn handler(&self, request: &T1, response: &mut T2);
}

//不带应答的ActorLocation消息
#[async_trait]
pub trait AMActorLocationHandler<T: IActorLocationMessage> {
    async fn handler(&self, message: &T);
}

//不带应答的Actor消息
#[async_trait]
pub trait AMActorHandler<T: IActorMessage> {
    async fn handler(&self, message: &T);
}

///////////////////////////////////////////////////////////////////////////////////////////////
struct KeyedHandler {
    key: &'static str,
    handler: &'static LazyLock<Box<dyn IMActorHandler>>,
}

inventory::collect!(KeyedHandler);

lazy_static::lazy_static! {
    static ref HANDLER_MAP: DashMap<&'static str, &'static Box<dyn IMActorHandler>> = {
        let m = DashMap::new();
        for handler in inventory::iter::<KeyedHandler> {
            m.insert(handler.key, &**handler.handler);
        }
        m
    };
}

struct MessageParaser {
    key: &'static str,
    paraser: &'static LazyLock<Box<dyn IMessage>>,
}

inventory::collect!(MessageParaser);

lazy_static::lazy_static! {
    static ref MESSAGE_PARASER: DashMap<&'static str, &'static Box<dyn IMessage>> = {
        let m = DashMap::new();
        for handler in inventory::iter::<MessageParaser> {
            m.insert(handler.key, &**handler.paraser);
        }
        m
    };
}
///////////////////////////////////////////////////////////////////////////////////////////////

create_actorLocationMessageRequest! {
    pub struct C2M_MoveToMessage {
        #[serde(default)]  // 如果字段不存在，使用默认值（None）
        pub player_id: i64 
    }
}

#[allow(non_camel_case_types)]
#[derive(IActorLocationMessageHandler, Default)]
#[RequestType(C2M_MoveToMessage)]
pub struct C2M_MoveToMessageHandler;

impl C2M_MoveToMessageHandler  {
    async fn run(&self, _request: &C2M_MoveToMessage)  {
        //trace!("C2M_MoveToMessage");
    }
}
///////////////////////////////////////////////////////////////////////////////////////////////

create_actorLocationRpcRequest! {
    pub struct C2M_GetPlayerInfoRequest {
        #[serde(default)]  // 如果字段不存在，使用默认值（None）
        pub player_id: i64 
    }
}

create_actorLocationRpcResponse! {
    pub struct M2C_GetPlayerInfoResponse {
    }
}

#[allow(non_camel_case_types)]
#[derive(IActorLocationRpcHandler, Default)]
#[ResponseType(M2C_GetPlayerInfoResponse)]
#[RequestType(C2M_GetPlayerInfoRequest)]
pub struct C2M_GetPlayerInfoHandler;

impl C2M_GetPlayerInfoHandler  {
    async fn run(&self, _request: &C2M_GetPlayerInfoRequest, _response: &mut M2C_GetPlayerInfoResponse)  {
        trace!("正在处理C2M_GetPlayerInfoRequest, rpc_id:{}", _request.get_rpc_id());
        //if request.player_id == 0 {
            //error!("C2M_GetPlayerInfoRequest的请求参数player_id为0，请求不合法");
        //    response.error = 1;
        //    return;
        //}
        //response.error = 0;
    }
}
//////////////////////////////以下这两部分，应该是用工具生成的代码，然后编译时在处理宏////////////////////////////////////////
create_actorLocationRpcRequest! {
    pub struct C2M_PingRequest {
    }
}

create_actorLocationRpcResponse! {
    pub struct C2M_PingResponse {
        //count: i64,
    }
}
////////////////////////////以下这段，是开发者自己增加的，在于生成一个处理请求和返回的Handler//////////////
#[allow(non_camel_case_types)]
#[derive(IActorLocationRpcHandler, Default)]
#[ResponseType(C2M_PingResponse)]
#[RequestType(C2M_PingRequest)]
pub struct C2M_PingHandler;

impl C2M_PingHandler  {
    async fn run(&self, _request: &C2M_PingRequest, _response: &mut C2M_PingResponse)  {
        //_response.count += 1;
        trace!("正在处理C2M_PingRequest, rpc_id:{}", _request.get_rpc_id());
    }
}
///////////////////////////////////////////////////////////////////////////////////////////////////
pub async fn  process_message_msgpack(data: Arc<Box<dyn IMessage>>, 
    client_id: usize, 
    sender: std::option::Option<mpsc::Sender<NetworkMessage>>){
    let type_name = data.get_type_name();
        if let Some(handler) = get_handler(type_name) {
        handler.handle_message(data, client_id, sender).await;
    } else {
        error!("消息：{} 没有对应的Handler ", type_name);
    }
}

pub fn get_handler(key: &str) -> Option<&'static dyn IMActorHandler> {
    HANDLER_MAP.get(key).map(|v| &**v).map(|v| &**v)
}

pub fn get_paraser(key: &str) -> Option<&'static dyn IMessage> {
    MESSAGE_PARASER.get(key).map(|v| &**v).map(|v| &**v)
}

// 处理单个消息帧
async fn process_frame_message(
    message: &[u8],
    client_id: usize,
    request_sender: &mpsc::Sender<NetworkMessage>
) -> RetResult<()> {
    // 解析消息为serde_json::Value
    let v = match rmp_serde::from_slice::<Value>(message) {
        Ok(v) => v,
        Err(_) => {
            error!("client:{client_id}, 收到消息, 但解析失败, 不是一段合法的rmp_serde,msgpack数据, 丢弃data:{}", message.len());
            return Err(MyError::NotMessagePack().into());
        }
    };
    
    // 获取消息类型
    let message_type = match v["_t"].as_str() {
        Some(t) => t,
        None => {
            error!("client:{client_id}, 收到消息, 但是其中没有_t字段, 无法处理, 丢弃data:{}", message.len());
            return Err(MyError::MessageNoTField().into());
        }
    };
    
    // 获取解析器
    let paraser = match get_paraser(message_type) {
        Some(p) => p,
        None => {
            error!("client:{client_id}, 收到消息{}, 但是其中没有对应的handler, 无法处理, 丢弃data:{}", message_type, message.len());
            return Err(MyError::MessageHandlerNotFound(message_type.to_string()).into());
        }
    };
    
    // 解析具体消息对象
    let message_obj = match paraser.with_serde_json_value(v) {
        Ok(obj) => obj,
        Err(e) => {
            error!("with_serde_json_value 解析数据失败，client:{client_id}, Err:{}", e);
            return Err(MyError::MessageObjectConvertFailed().into());
        }
    };
    
    // 发送消息到处理队列
    if let Err(e) = request_sender.send(NetworkMessage::Request {
        client_id,
        data: Arc::new(message_obj),
    }).await {
        error!("request_sender.send Request 发送消息失败, {}", e);
        return Err(MyError::SendRequestFailed().into());
    }
    
    Ok(())
}

#[cfg(test)]
mod tests {
    #![allow(unused_imports)]
    use bytes::{BytesMut, BufMut};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use tracing_subscriber::EnvFilter;
    use tracing_subscriber::fmt::time::LocalTime;
    use serde::Serialize;

    use tracing::{trace, error, info, warn, debug};

    #[tokio::test]
    async fn test_kcp() { 
        use crate::C2M_PingResponse;
        use crate::IMessage;

        let mut ping_res_msg =  BytesMut::with_capacity(64);
        ping_res_msg.put_u16(30);
        println!("{:?}", ping_res_msg);
        C2M_PingResponse::default().to_bytes(&mut ping_res_msg);
        println!("{:?}", ping_res_msg);
    }
}

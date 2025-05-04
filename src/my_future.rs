use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};

pub struct ETTask<T>(Pin<Box<dyn Future<Output = T> + Send>>);

impl<T: std::marker::Send + 'static> ETTask<T> {
    #[allow(dead_code)]
    pub fn new(future: impl Future<Output = T> + Send + 'static) -> Self {
        Self(Box::pin(future))
    }

    
    // 定义一个协程函数，参数为self，返回类型为空
    #[allow(dead_code)]
    pub fn coroutine(self) where T: Send + 'static {
        // 使用tokio库的spawn函数，创建一个异步任务，执行self.await
        tokio::spawn(async move { self.await; });
    }

    /// 泛型实现仍保留
    #[allow(dead_code)]
    pub fn ready(value: T) -> Self {
        Self::new(std::future::ready(value))
    }
}

#[allow(dead_code)]
pub fn complete() -> ETTask<()> {
    ETTask::complete()
}

impl ETTask<()> {
    /// 无返回值版本的 complete()
    #[allow(dead_code)]
    pub fn complete() -> Self {
        Self::new(std::future::ready(()))
    }
}

impl<T> Future for ETTask<T> {
    type Output = T;
    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        self.0.as_mut().poll(cx)
    }
}
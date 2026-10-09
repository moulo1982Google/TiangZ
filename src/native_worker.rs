//! 托管模块专用线程和有界准入；不接触 V8 内存。 / Owns module threads and bounded admission without accessing V8 memory.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::Instant;

use deno_core::{OpState, op2};
use deno_error::JsErrorBox;
use serde::Serialize;
use tokio::sync::{Notify, oneshot};

pub(crate) struct WorkerSpec {
    pub name: &'static str,
    pub capacity: usize,
    pub max_input_bytes: usize,
    pub max_output_bytes: usize,
    pub compute: fn(String) -> Result<String, String>,
}

struct Job {
    input: String,
    enqueued: Instant,
    reply: oneshot::Sender<Result<String, String>>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Stats {
    pub accepting: bool,
    pub pending: usize,
    pub running: bool,
    pub completed: u64,
    pub rejected: u64,
    pub failed: u64,
    pub wait_micros: u64,
    pub compute_micros: u64,
}

struct Shared {
    stats: Mutex<Stats>,
    changed: Notify,
}

struct Worker {
    sender: Mutex<Option<mpsc::SyncSender<Job>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    shared: Arc<Shared>,
    capacity: usize,
    max_input_bytes: usize,
}

impl Worker {
    /// 每个声明创建一个线程；所有任务按通道顺序执行。 / Creates one thread per declaration and executes jobs in channel order.
    fn new(spec: WorkerSpec) -> std::io::Result<Self> {
        let (sender, receiver) = mpsc::sync_channel::<Job>(spec.capacity);
        let shared = Arc::new(Shared {
            stats: Mutex::new(Stats {
                accepting: true,
                ..Stats::default()
            }),
            changed: Notify::new(),
        });
        let state = Arc::clone(&shared);
        let thread = std::thread::Builder::new()
            .name(format!("native:{}", spec.name))
            .spawn(move || {
                while let Ok(job) = receiver.recv() {
                    let started = Instant::now();
                    {
                        let mut stats = state.stats.lock().unwrap();
                        stats.running = true;
                        stats.wait_micros = stats
                            .wait_micros
                            .saturating_add(job.enqueued.elapsed().as_micros() as u64);
                    }
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        // 业务错误也会跨V8边界；超限用固定诊断替换，panic诊断保持独立。
                        // Compute errors also cross V8; replace oversized values with fixed diagnostics, preserving panic diagnostics.
                        match (spec.compute)(job.input) {
                            Ok(output) if output.len() > spec.max_output_bytes => {
                                Err("native worker output too large".into())
                            }
                            Err(error) if error.len() > spec.max_output_bytes => {
                                Err("native worker error too large".into())
                            }
                            result => result,
                        }
                    }))
                    .unwrap_or_else(|_| Err("native worker computation panicked".into()));
                    {
                        let mut stats = state.stats.lock().unwrap();
                        stats.compute_micros = stats
                            .compute_micros
                            .saturating_add(started.elapsed().as_micros() as u64);
                        stats.running = false;
                        stats.pending -= 1;
                        stats.completed += 1;
                        stats.failed += u64::from(result.is_err());
                    }
                    let _ = job.reply.send(result);
                    // 结果已可取后再叫醒主循环，空闲 Process 无需等到下一个 idle tick。
                    // Wake the loop only after the result is observable so an idle Process need not wait for the next idle tick.
                    crate::host_wake::notify_async_result();
                    state.changed.notify_waiters();
                }
            })?;
        Ok(Self {
            sender: Mutex::new(Some(sender)),
            thread: Mutex::new(Some(thread)),
            shared,
            capacity: spec.capacity,
            max_input_bytes: spec.max_input_bytes,
        })
    }

    /// 准入与计数在同一锁内；调用方丢弃接收端不取消任务。 / Atomically admits and counts jobs; dropping the reply does not cancel work.
    fn submit(&self, input: String) -> Result<oneshot::Receiver<Result<String, String>>, String> {
        let mut stats = self.shared.stats.lock().unwrap();
        let error = if !stats.accepting {
            Some("native worker draining")
        } else if input.len() > self.max_input_bytes {
            Some("native worker input too large")
        } else if stats.pending >= self.capacity {
            Some("native worker overloaded")
        } else {
            None
        };
        if let Some(error) = error {
            stats.rejected += 1;
            return Err(error.into());
        }
        let (reply, receiver) = oneshot::channel();
        self.sender
            .lock()
            .unwrap()
            .as_ref()
            .ok_or_else(|| "native worker unavailable".to_string())?
            .try_send(Job {
                input,
                reply,
                enqueued: Instant::now(),
            })
            .map_err(|_| "native worker unavailable".to_string())?;
        stats.pending += 1;
        Ok(receiver)
    }

    /// 排空不可逆，接收端超时不能重新打开准入。 / Drain is irreversible; caller timeout cannot reopen admission.
    fn stop_admission(&self) {
        self.shared.stats.lock().unwrap().accepting = false;
        self.sender.lock().unwrap().take();
    }

    /// 只 join 已退出线程，超时路径绝不无限阻塞 V8。 / Joins only exited threads and never blocks V8 indefinitely on a timeout path.
    fn exited(&self) -> bool {
        let mut thread = self.thread.lock().unwrap();
        if thread.as_ref().is_some_and(|thread| !thread.is_finished()) {
            return false;
        }
        if let Some(thread) = thread.take() {
            let _ = thread.join();
        }
        true
    }

    /// 先注册通知再检查计数，避免最后一个任务完成时丢失唤醒。 / Registers notification before checking counts to avoid lost completion wakeups.
    async fn drain(&self) {
        self.stop_admission();
        loop {
            let notified = self.shared.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.shared.stats.lock().unwrap().pending == 0 {
                break;
            }
            notified.await;
        }
        while !self.exited() {
            tokio::time::sleep(std::time::Duration::from_millis(1)).await;
        }
    }
}

pub(crate) struct Registry(BTreeMap<String, Arc<Worker>>, Arc<AtomicUsize>);
impl Registry {
    /// 启动期创建固定清单，重复身份失败。 / Creates an immutable startup catalog and rejects duplicate identities.
    pub fn new(specs: Vec<WorkerSpec>) -> anyhow::Result<Self> {
        let mut workers = BTreeMap::new();
        for spec in specs {
            anyhow::ensure!(
                spec.capacity > 0 && spec.max_input_bytes > 0 && spec.max_output_bytes > 0,
                "invalid native worker limits"
            );
            let name = spec.name.to_string();
            anyhow::ensure!(
                !workers.contains_key(&name),
                "duplicate native worker: {name}"
            );
            workers.insert(name, Arc::new(Worker::new(spec)?));
        }
        Ok(Self(workers, Arc::new(AtomicUsize::new(0))))
    }

    /// 在途统计独立于 TS Promise 生命周期。 / Counts work independently of TS Promise lifetime.
    pub fn pending(&self) -> usize {
        self.1.load(Ordering::Acquire)
            + self
                .0
                .values()
                .map(|w| {
                    let stats = w.shared.stats.lock().unwrap();
                    let pending = stats.pending;
                    let accepting = stats.accepting;
                    drop(stats);
                    pending + usize::from(!accepting && !w.exited())
                })
                .sum::<usize>()
    }

    /// 停机先关闭所有 worker 准入，已准入任务继续。 / Stops admission before shutdown while accepted work continues.
    pub fn stop_admission(&self) {
        for worker in self.0.values() {
            worker.stop_admission();
        }
    }

    /// 固定名称指标进入宿主采样，不使用请求 ID 作为标签。 / Samples fixed worker names without request-ID label cardinality.
    pub fn snapshot(&self) -> Vec<(String, Stats)> {
        self.0
            .iter()
            .map(|(name, worker)| (name.clone(), worker.shared.stats.lock().unwrap().clone()))
            .collect()
    }

    /// Deno 交付回调才释放计数；Future 完成可能早于 V8 泵，不能用 RAII 代替。
    /// Counts until Deno delivers results; future completion may precede the V8 pump.
    pub fn delivery_metrics(&self) -> deno_core::OpMetricsFactoryFn {
        let count = Arc::clone(&self.1);
        Box::new(move |_, _, decl| {
            if !matches!(
                decl.name,
                "op_native_worker_call" | "op_native_worker_drain"
            ) {
                return None;
            }
            let count = Arc::clone(&count);
            Some(Rc::new(move |_, event, _| {
                if event == deno_core::OpMetricsEvent::Dispatched {
                    count.fetch_add(1, Ordering::AcqRel);
                } else {
                    count.fetch_sub(1, Ordering::AcqRel);
                }
            }))
        })
    }
}

/// 只允许访问构建清单中的 worker。 / Resolves only workers declared in the build catalog.
fn lookup(state: &OpState, name: &str) -> Result<Arc<Worker>, JsErrorBox> {
    state
        .borrow::<Registry>()
        .0
        .get(name)
        .cloned()
        .ok_or_else(|| JsErrorBox::generic("unknown native worker"))
}

#[op2]
#[string]
async fn op_native_worker_call(
    state: Rc<RefCell<OpState>>,
    #[string] name: String,
    #[string] input: String,
) -> Result<String, JsErrorBox> {
    let worker = lookup(&state.borrow(), &name)?;
    let reply = worker.submit(input).map_err(JsErrorBox::generic)?;
    reply
        .await
        .map_err(|_| JsErrorBox::generic("native worker lost result"))?
        .map_err(JsErrorBox::generic)
}

#[op2]
async fn op_native_worker_drain(
    state: Rc<RefCell<OpState>>,
    #[string] name: String,
) -> Result<(), JsErrorBox> {
    let worker = lookup(&state.borrow(), &name)?;
    worker.drain().await;
    Ok(())
}

#[op2]
#[serde]
fn op_native_worker_stats(
    state: &mut OpState,
    #[string] name: String,
) -> Result<Stats, JsErrorBox> {
    Ok(lookup(state, &name)?.shared.stats.lock().unwrap().clone())
}

deno_core::extension!(
    native_workers,
    ops = [
        op_native_worker_call,
        op_native_worker_drain,
        op_native_worker_stats
    ]
);

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;
    static GATE: OnceLock<(Mutex<bool>, std::sync::Condvar)> = OnceLock::new();

    fn compute(input: String) -> Result<String, String> {
        if input == "block" {
            let (lock, cv) = GATE.get_or_init(|| (Mutex::new(false), std::sync::Condvar::new()));
            let _guard = cv
                .wait_while(lock.lock().unwrap(), |released| !*released)
                .unwrap();
        }
        if input == "panic" {
            panic!("test computation panic");
        }
        Ok(input)
    }

    #[tokio::test]
    async fn capacity_cancellation_fifo_and_drain() {
        let worker = Worker::new(WorkerSpec {
            name: "test",
            capacity: 2,
            max_input_bytes: 8,
            max_output_bytes: 8,
            compute,
        })
        .unwrap();
        let first = worker.submit("block".into()).unwrap();
        drop(first);
        let second = worker.submit("next".into()).unwrap();
        assert!(
            worker
                .submit("full".into())
                .unwrap_err()
                .contains("overloaded")
        );
        assert_eq!(worker.shared.stats.lock().unwrap().pending, 2);
        worker.stop_admission();
        assert!(
            worker
                .submit("closed".into())
                .unwrap_err()
                .contains("draining")
        );
        let (lock, cv) = GATE.get_or_init(|| (Mutex::new(false), std::sync::Condvar::new()));
        *lock.lock().unwrap() = true;
        cv.notify_all();
        assert_eq!(second.await.unwrap().unwrap(), "next");
        worker.drain().await;
        let stats = worker.shared.stats.lock().unwrap();
        assert_eq!(stats.pending, 0);
        assert_eq!(stats.completed, 2);
        assert!(!stats.accepting);
    }

    // 结果交给 oneshot 之后才叫醒主循环：每个叫醒到来时检查结果，直到结果可取。
    // The loop is woken after the oneshot holds the result: check the result on each wake until it is observable.
    #[tokio::test]
    #[allow(clippy::await_holding_lock)]
    async fn finished_job_wakes_the_process_loop_after_its_result_is_observable() {
        let (_guard, _signal, wake) = crate::host_wake::install_for_test();
        let worker = Worker::new(WorkerSpec {
            name: "wake",
            capacity: 1,
            max_input_bytes: 8,
            max_output_bytes: 8,
            compute,
        })
        .unwrap();
        let mut reply = worker.submit("ok".into()).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            wake.recv_timeout(remaining)
                .expect("a finished job must wake the process loop");
            if let Ok(result) = reply.try_recv() {
                assert_eq!(result.unwrap(), "ok");
                break;
            }
        }
        worker.drain().await;
    }

    #[tokio::test]
    async fn rejects_size_and_recovers_from_computation_panic() {
        let worker = Worker::new(WorkerSpec {
            name: "errors",
            capacity: 1,
            max_input_bytes: 8,
            max_output_bytes: 3,
            compute,
        })
        .unwrap();
        assert!(
            worker
                .submit("123456789".into())
                .unwrap_err()
                .contains("input too large")
        );
        assert!(
            worker
                .submit("panic".into())
                .unwrap()
                .await
                .unwrap()
                .unwrap_err()
                .contains("panicked")
        );
        assert!(
            worker
                .submit("1234".into())
                .unwrap()
                .await
                .unwrap()
                .unwrap_err()
                .contains("output too large")
        );
        assert_eq!(
            worker.submit("ok".into()).unwrap().await.unwrap().unwrap(),
            "ok"
        );
        worker.drain().await;
        let stats = worker.shared.stats.lock().unwrap();
        assert_eq!(stats.failed, 2);
        assert_eq!(stats.completed, 3);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn v8_promise_runs_on_dedicated_thread_and_drains() {
        let registry = Registry::new(vec![]).unwrap();
        let mut runtime = deno_core::JsRuntime::new(deno_core::RuntimeOptions {
            extensions: vec![native_workers::init()],
            op_metrics_factory_fn: Some(registry.delivery_metrics()),
            ..Default::default()
        });
        let mut workers = Registry::new(vec![WorkerSpec {
            name: "module::test",
            capacity: 2,
            max_input_bytes: 32,
            max_output_bytes: 64,
            compute: |_| {
                std::thread::sleep(std::time::Duration::from_millis(200));
                Ok(std::thread::current()
                    .name()
                    .unwrap_or("unnamed")
                    .to_string())
            },
        }])
        .unwrap();
        workers.1 = registry.1;
        runtime.op_state().borrow_mut().put(workers);
        runtime.execute_script("worker-test", r#"
          globalThis.result = null;
          globalThis.response = Deno.core.ops.op_native_worker_call('module::test', 'input').then(value => {
            if (value !== 'native:module::test') throw Error('computation was not on dedicated worker');
            globalThis.result = value;
            return Deno.core.ops.op_native_worker_drain('module::test');
          });
          if (!(response instanceof Promise)) throw Error('missing Promise facade');
          globalThis.otherSceneWork = 42;
          globalThis.rejected = Deno.core.ops.op_native_worker_call('missing', 'input').then(() => {throw Error('unknown worker accepted');}, () => true);
        "#).unwrap();
        // 尚未完成的计算不能阻塞 V8；计算结束但 Promise 尚未交付时屏障仍关闭。
        // V8 stays responsive while compute runs; completion without Promise delivery keeps the barrier closed.
        assert!(
            tokio::time::timeout(
                std::time::Duration::from_millis(20),
                runtime.run_event_loop(Default::default())
            )
            .await
            .is_err()
        );
        runtime.execute_script("worker-responsive", "if (otherSceneWork !== 42 || result !== null) throw Error('V8 blocked or early result');").unwrap();
        assert!(runtime.op_state().borrow().borrow::<Registry>().pending() > 0);
        runtime
            .op_state()
            .borrow()
            .borrow::<Registry>()
            .stop_admission();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        assert_eq!(
            runtime.op_state().borrow().borrow::<Registry>().snapshot()[0]
                .1
                .completed,
            1
        );
        assert!(runtime.op_state().borrow().borrow::<Registry>().pending() > 0);
        runtime.run_event_loop(Default::default()).await.unwrap();
        runtime.execute_script("worker-result", r#"
          if (result !== 'native:module::test' || otherSceneWork !== 42) throw Error('missing result');
          const stats = Deno.core.ops.op_native_worker_stats('module::test');
          if (stats.pending !== 0 || stats.accepting || stats.completed !== 1) throw Error('bad drain');
          globalThis.closed = Deno.core.ops.op_native_worker_call('module::test', 'input').then(() => {throw Error('closed worker accepted');}, () => true);
        "#).unwrap();
        runtime.run_event_loop(Default::default()).await.unwrap();
        assert_eq!(
            runtime.op_state().borrow().borrow::<Registry>().pending(),
            0
        );
    }

    /// 业务错误同样按UTF-8字节限长；拒绝大错误后仍可使用原容量。 / Bounds compute errors by UTF-8 bytes and retains capacity after rejecting a large error.
    #[tokio::test]
    async fn bounds_compute_errors_without_losing_capacity() {
        let worker = Worker::new(WorkerSpec {
            name: "error-size",
            capacity: 1,
            max_input_bytes: 16,
            max_output_bytes: 24,
            compute: |input| match input.as_str() {
                "large" => Err("界".repeat(9)),
                "exact" => Err("界".repeat(8)),
                _ => Ok(input),
            },
        })
        .unwrap();
        assert_eq!(
            worker
                .submit("large".into())
                .unwrap()
                .await
                .unwrap()
                .unwrap_err(),
            "native worker error too large"
        );
        assert_eq!(
            worker
                .submit("exact".into())
                .unwrap()
                .await
                .unwrap()
                .unwrap_err(),
            "界".repeat(8)
        );
        assert_eq!(
            worker.submit("ok".into()).unwrap().await.unwrap().unwrap(),
            "ok"
        );
        worker.drain().await;
        let stats = worker.shared.stats.lock().unwrap();
        assert_eq!(stats.pending, 0);
        assert_eq!(stats.completed, 3);
        assert_eq!(stats.failed, 2);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn empty_preflight_registry_has_no_workers_to_drain() {
        let mut state = OpState::new(None);
        state.put(Registry::new(vec![]).unwrap());
        state.borrow::<Registry>().stop_admission();
        assert!(state.borrow::<Registry>().snapshot().is_empty());
        assert_eq!(state.borrow::<Registry>().pending(), 0);
    }
}

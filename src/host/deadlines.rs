//! 为调用期限提供 isolate 所有的可取消资源，不占远程操作批次槽。 / Provides isolate-owned cancellable call deadlines outside remote-operation batch slots.

use std::borrow::Cow;
use std::cell::{Cell, RefCell};
use std::rc::Rc;
use std::time::Duration;

use deno_core::{CancelFuture, CancelHandle, OpState, Resource, op2};
use deno_error::JsErrorBox;
use tokio::time::Instant;

const MAX_DEADLINES: usize = 65_536;

#[derive(Default)]
pub(super) struct DeadlineBudget(Rc<Cell<usize>>);

struct Deadline {
    expires_at: Instant,
    cancel: Rc<CancelHandle>,
    waiting: Cell<bool>,
    live: Rc<Cell<usize>>,
}

impl Deadline {
    /// 创建前检查原预算，实际资源 Drop 才归还。 / Checks the original budget before creation and releases only on the resource's actual Drop.
    fn create(budget: &DeadlineBudget, ms: u32) -> Result<Self, JsErrorBox> {
        let live = Rc::clone(&budget.0);
        if live.get() >= MAX_DEADLINES {
            return Err(JsErrorBox::generic(
                "[scene-overloaded] host deadline capacity reached",
            ));
        }
        live.set(live.get() + 1);
        Ok(Self {
            expires_at: Instant::now() + Duration::from_millis(u64::from(ms)),
            cancel: CancelHandle::new_rc(),
            waiting: Cell::new(false),
            live,
        })
    }

    /// 绝对期限不因延迟开始轮询而后移，取消也必须等此等待真实退出。 / Delayed polling cannot move the absolute deadline, and cancellation waits for this wait to exit.
    async fn wait(self: Rc<Self>) -> Result<(), JsErrorBox> {
        if self.waiting.replace(true) {
            return Err(JsErrorBox::generic("host deadline already has a waiter"));
        }
        tokio::time::sleep_until(self.expires_at)
            .or_cancel(Rc::clone(&self.cancel))
            .await
            .map_err(|error| JsErrorBox::generic(error.to_string()))
    }
}

impl Resource for Deadline {
    /// 为宿主资源表提供稳定类型名称。 / Provides a stable resource-table name.
    fn name(&self) -> Cow<'_, str> {
        "tiangzCallDeadline".into()
    }

    /// 关闭只请求取消；最后一个原生等待引用退出时才归还名额。 / Closing requests cancellation; admission returns only when the final native wait reference exits.
    fn close(self: Rc<Self>) {
        self.cancel.cancel();
    }
}

impl Drop for Deadline {
    /// 最后引用退出时归还原 isolate 预算。 / Returns the original isolate's budget when the final reference exits.
    fn drop(&mut self) {
        self.cancel.cancel();
        self.live.set(self.live.get() - 1);
    }
}

/// 记录创建时绝对期限，预算独立属于当前 isolate。 / Records an absolute deadline at creation with a budget owned by the current isolate.
#[op2(fast)]
pub(super) fn op_host_create_deadline(state: &mut OpState, ms: u32) -> Result<u32, JsErrorBox> {
    let deadline = Deadline::create(state.borrow::<DeadlineBudget>(), ms)?;
    Ok(state.resource_table.add(deadline))
}

/// 每资源只允许一个等待者；等待退出才释放自己的引用。 / Allows one waiter per resource and retains its reference until the native wait exits.
#[op2]
pub(super) async fn op_host_wait_deadline(
    state: Rc<RefCell<OpState>>,
    id: u32,
) -> Result<(), JsErrorBox> {
    let deadline = state
        .borrow()
        .resource_table
        .get::<Deadline>(id)
        .map_err(|error| JsErrorBox::generic(error.to_string()))?;
    deadline.wait().await
}

/// 仅移除指定类型的本次资源；重复或未知 id 不影响其他宿主资源。 / Removes only this deadline resource; repeated or unknown ids cannot affect other host resources.
#[op2(fast)]
pub(super) fn op_host_cancel_deadline(state: &mut OpState, id: u32) {
    if let Ok(deadline) = state.resource_table.take::<Deadline>(id) {
        deadline.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deadline_budget_is_returned_only_by_the_last_reference() {
        let budget = DeadlineBudget::default();
        let mut resources: Vec<_> = (0..MAX_DEADLINES)
            .map(|_| Rc::new(Deadline::create(&budget, 30000).unwrap()))
            .collect();
        assert!(Deadline::create(&budget, 1).is_err());
        let last = resources.pop().unwrap();
        Rc::clone(&last).close();
        assert_eq!(budget.0.get(), MAX_DEADLINES);
        assert!(Deadline::create(&budget, 1).is_err());
        drop(last);
        let replacement = Deadline::create(&budget, 1).unwrap();
        assert_eq!(budget.0.get(), MAX_DEADLINES);
        drop(resources);
        drop(replacement);
        assert_eq!(budget.0.get(), 0);
    }

    #[tokio::test]
    async fn deadline_cancellation_drains_the_actual_wait_and_rejects_duplicate_waiters() {
        let budget = DeadlineBudget::default();
        let resource = Rc::new(Deadline::create(&budget, 30000).unwrap());
        let mut wait = Box::pin(Rc::clone(&resource).wait());
        assert!(futures_util::poll!(&mut wait).is_pending());
        assert!(
            Rc::clone(&resource)
                .wait()
                .await
                .unwrap_err()
                .to_string()
                .contains("already has a waiter")
        );
        resource.close();
        assert_eq!(budget.0.get(), 1);
        assert!(wait.await.is_err());
        assert_eq!(budget.0.get(), 0);
    }

    #[tokio::test]
    async fn deadline_expires_from_creation_even_if_wait_is_polled_later() {
        let budget = DeadlineBudget::default();
        let resource = Rc::new(Deadline::create(&budget, 200).unwrap());
        tokio::time::sleep(Duration::from_millis(250)).await;
        tokio::time::timeout(Duration::from_millis(100), Rc::clone(&resource).wait())
            .await
            .unwrap()
            .unwrap();
        resource.close();
        assert_eq!(budget.0.get(), 0);
    }

    #[test]
    fn releasing_an_old_resource_does_not_charge_a_new_isolate_budget() {
        let old = DeadlineBudget::default();
        let old_resource = Deadline::create(&old, 30000).unwrap();
        let new = DeadlineBudget::default();
        let new_resource = Deadline::create(&new, 30000).unwrap();
        drop(old_resource);
        assert_eq!(old.0.get(), 0);
        assert_eq!(new.0.get(), 1);
        drop(new_resource);
        assert_eq!(new.0.get(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn real_v8_deadlines_release_resources_and_do_not_share_scene_batch_slots() {
        const CASE_ENV: &str = "TIANGZ_TEST_HOST_DEADLINES_CASE";
        if std::env::var(CASE_ENV).as_deref() != Ok("v8") {
            let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
            command.args(["--exact", "host::deadlines::tests::real_v8_deadlines_release_resources_and_do_not_share_scene_batch_slots", "--nocapture"])
                .env(CASE_ENV, "v8").kill_on_drop(true);
            #[cfg(windows)]
            command.creation_flags(0x0800_0000);
            let output = tokio::time::timeout(Duration::from_secs(15), command.output())
                .await
                .unwrap()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(
                String::from_utf8_lossy(&output.stdout)
                    .contains("test result: ok. 1 passed; 0 failed;")
            );
            return;
        }
        tokio::task::spawn_blocking(|| {
            let event_loop = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
            let _entered = event_loop.enter();
            let mut runtime = super::super::create_runtime(false, 0).unwrap();
            let state = runtime.op_state();
            let other = state.borrow_mut().resource_table.add(CancelHandle::new());
            runtime.execute_script("deadline:other-resource", format!("__hostCancelDeadline({other});")).unwrap();
            assert!(!state.borrow().resource_table.get::<CancelHandle>(other).unwrap().is_canceled());
            runtime.execute_script("deadline:lifecycle", r#"
              globalThis.deadlineFinished = false;
              globalThis.deadlineFailure = '';
              (async () => {
                const held = Array.from({length: 256}, () => __hostCreateDeadline(30000));
                const waits = held.map(id => __hostWaitDeadline(id).catch(() => {}));
                const short = __hostCreateDeadline(1);
                await __hostWaitDeadline(short);
                __hostCancelDeadline(short);
                for (const id of held) { __hostCancelDeadline(id); __hostCancelDeadline(id); }
                await Promise.all(waits);
                for (let i = 0; i < 65540; i++) {
                  const id = __hostCreateDeadline(30000);
                  const wait = __hostWaitDeadline(id);
                  __hostCancelDeadline(id);
                  await wait.catch(() => {});
                }
                globalThis.deadlineFinished = true;
              })().catch(error => { globalThis.deadlineFailure = String(error); });
            "#).unwrap();
            event_loop.block_on(async {
                tokio::time::timeout(Duration::from_secs(5), runtime.run_event_loop(Default::default())).await.unwrap().unwrap();
            });
            runtime.execute_script("deadline:assert", "if (!deadlineFinished || deadlineFailure) throw new Error('deadline lifecycle failed: ' + deadlineFailure);").unwrap();
            assert_eq!(state.borrow().borrow::<DeadlineBudget>().0.get(), 0);
            assert_eq!(state.borrow().resource_table.len(), 1);
        }).await.unwrap();
    }
}

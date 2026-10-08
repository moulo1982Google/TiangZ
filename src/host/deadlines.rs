//! 为调用和停机期限提供 isolate 所有的独立额度与可取消资源。 / Provides isolate-owned independent admission and cancellable resources for call and shutdown deadlines.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Duration;

use deno_core::{CancelFuture, CancelHandle, OpState, op2};
use deno_error::JsErrorBox;
use tokio::time::Instant;

const MAX_DEADLINES: usize = 65_536;
const MAX_DEADLINE_HANDLE: u64 = 9_007_199_254_740_991;

#[derive(Default)]
pub(super) struct DeadlineBudget(Rc<Cell<usize>>);

#[derive(Default)]
pub(super) struct ShutdownDeadlineBudget(Rc<Cell<usize>>);

pub(super) struct DeadlineTable {
    entries: BTreeMap<u64, Rc<Deadline>>,
    next_call: u64,
    next_shutdown: u64,
}

impl Default for DeadlineTable {
    /// 两类编号以奇偶分开，普通调用不能消耗停机句柄空间。 / Separates odd and even ids so ordinary calls cannot consume shutdown handles.
    fn default() -> Self {
        Self {
            entries: BTreeMap::new(),
            next_call: 2,
            next_shutdown: 1,
        }
    }
}

impl DeadlineTable {
    /// 只发出不复用的精确 Number 句柄；耗尽时归还本次资源。 / Issues nonreused exact Number handles, releasing the new resource on exhaustion.
    fn insert(&mut self, deadline: Deadline, shutdown: bool) -> Result<f64, JsErrorBox> {
        let next = if shutdown {
            &mut self.next_shutdown
        } else {
            &mut self.next_call
        };
        let id = *next;
        if id > MAX_DEADLINE_HANDLE {
            return Err(JsErrorBox::generic(
                "[scene-overloaded] host deadline handles exhausted",
            ));
        }
        self.entries.insert(id, Rc::new(deadline));
        *next = id + 2;
        Ok(id as f64)
    }

    /// 等待者持有原资源，关闭表项不会提前释放其预算。 / Waiters retain the original resource so removing its entry cannot release their budget early.
    fn get(&self, id: u64) -> Result<Rc<Deadline>, JsErrorBox> {
        self.entries
            .get(&id)
            .cloned()
            .ok_or_else(|| JsErrorBox::generic("unknown host deadline handle"))
    }

    /// 只关闭本表条目；未知和重复句柄不影响任何其他资源。 / Closes only this table's entry; unknown or repeated handles cannot affect other resources.
    fn close(&mut self, id: u64) {
        if let Some(deadline) = self.entries.remove(&id) {
            deadline.close();
        }
    }
}

impl Drop for DeadlineTable {
    /// isolate 清理时取消所有等待，最后引用仍负责归还原预算。 / Cancels waits during isolate cleanup while final references retain responsibility for returning their original budget.
    fn drop(&mut self) {
        for deadline in self.entries.values() {
            deadline.cancel.cancel();
        }
    }
}

/// 直接 Native 调用也不能截断或四舍五入成别的有效句柄。 / Direct native calls must not truncate or round invalid input into another valid handle.
fn parse_deadline_id(id: f64) -> Result<u64, JsErrorBox> {
    if !id.is_finite() || id.fract() != 0.0 || id < 0.0 || id > MAX_DEADLINE_HANDLE as f64 {
        return Err(JsErrorBox::range_error(
            "deadline id must be a non-negative safe integer",
        ));
    }
    Ok(id as u64)
}

struct Deadline {
    expires_at: Instant,
    cancel: Rc<CancelHandle>,
    waiting: Cell<bool>,
    live: Rc<Cell<usize>>,
}

impl Deadline {
    /// 创建前检查原预算，实际资源 Drop 才归还。 / Checks the original budget before creation and releases only on the resource's actual Drop.
    fn create(budget: &DeadlineBudget, ms: u32) -> Result<Self, JsErrorBox> {
        Self::create_with_limit(&budget.0, MAX_DEADLINES, ms, "host deadline")
    }

    /// 两类期限共享资源实现，但各自保留独立的原所有者额度。 / Shares deadline resources while retaining independent admission on each original owner.
    fn create_with_limit(
        live: &Rc<Cell<usize>>,
        limit: usize,
        ms: u32,
        name: &str,
    ) -> Result<Self, JsErrorBox> {
        if live.get() >= limit {
            return Err(JsErrorBox::generic(format!(
                "[scene-overloaded] {name} capacity reached"
            )));
        }
        let live = Rc::clone(live);
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
pub(super) fn op_host_create_deadline(state: &mut OpState, ms: u32) -> Result<f64, JsErrorBox> {
    let deadline = Deadline::create(state.borrow::<DeadlineBudget>(), ms)?;
    state.borrow_mut::<DeadlineTable>().insert(deadline, false)
}

/// 每 isolate 为停机预留一个期限，不竞争普通 RPC 期限或远程批次。 / Reserves one shutdown deadline per isolate outside ordinary RPC deadlines and remote batches.
#[op2(fast)]
pub(super) fn op_host_create_shutdown_deadline(
    state: &mut OpState,
    ms: u32,
) -> Result<f64, JsErrorBox> {
    let deadline = Deadline::create_with_limit(
        &state.borrow::<ShutdownDeadlineBudget>().0,
        1,
        ms,
        "host shutdown deadline",
    )?;
    state.borrow_mut::<DeadlineTable>().insert(deadline, true)
}

/// 每资源只允许一个等待者；等待退出才释放自己的引用。 / Allows one waiter per resource and retains its reference until the native wait exits.
#[op2]
pub(super) async fn op_host_wait_deadline(
    state: Rc<RefCell<OpState>>,
    id: f64,
) -> Result<(), JsErrorBox> {
    let id = parse_deadline_id(id)?;
    let deadline = state.borrow().borrow::<DeadlineTable>().get(id)?;
    drop(state);
    deadline.wait().await
}

/// 仅移除指定类型的本次资源；重复或未知 id 不影响其他宿主资源。 / Removes only this deadline resource; repeated or unknown ids cannot affect other host resources.
#[op2(fast)]
pub(super) fn op_host_cancel_deadline(state: &mut OpState, id: f64) -> Result<(), JsErrorBox> {
    let id = parse_deadline_id(id)?;
    state.borrow_mut::<DeadlineTable>().close(id);
    Ok(())
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

    #[test]
    fn shutdown_reservation_is_independent_and_returns_only_after_the_last_reference() {
        let calls = DeadlineBudget::default();
        let shutdown = ShutdownDeadlineBudget::default();
        let call = Deadline::create(&calls, 30000).unwrap();
        let stop = Rc::new(Deadline::create_with_limit(&shutdown.0, 1, 30000, "shutdown").unwrap());
        let running = Rc::clone(&stop);
        stop.close();
        assert!(Deadline::create_with_limit(&shutdown.0, 1, 1, "shutdown").is_err());
        assert_eq!(shutdown.0.get(), 1);
        drop(running);
        assert_eq!(shutdown.0.get(), 0);
        let next = Deadline::create_with_limit(&shutdown.0, 1, 1, "shutdown").unwrap();
        drop(call);
        assert_eq!(calls.0.get(), 0);
        assert_eq!(shutdown.0.get(), 1);
        drop(next);
        assert_eq!(shutdown.0.get(), 0);
    }

    #[tokio::test]
    async fn stale_handles_cannot_close_replacements_or_release_an_active_wait() {
        let budget = DeadlineBudget::default();
        let mut table = DeadlineTable::default();
        let first = table
            .insert(Deadline::create(&budget, 30000).unwrap(), false)
            .unwrap() as u64;
        let mut wait = Box::pin(table.get(first).unwrap().wait());
        assert!(futures_util::poll!(&mut wait).is_pending());
        table.close(first);
        assert!(table.get(first).is_err());
        assert_eq!(budget.0.get(), 1);
        let second = table
            .insert(Deadline::create(&budget, 30000).unwrap(), false)
            .unwrap() as u64;
        assert_ne!(first, second);
        table.close(first);
        assert!(!table.get(second).unwrap().cancel.is_canceled());
        assert_eq!(budget.0.get(), 2);
        assert!(wait.await.is_err());
        assert_eq!(budget.0.get(), 1);
        table.close(second);
        assert_eq!(budget.0.get(), 0);
    }

    #[tokio::test]
    async fn table_drop_cancels_both_kinds_without_releasing_waiter_references_early() {
        let calls = DeadlineBudget::default();
        let shutdown = ShutdownDeadlineBudget::default();
        let mut table = DeadlineTable::default();
        let call = table
            .insert(Deadline::create(&calls, 30000).unwrap(), false)
            .unwrap() as u64;
        let stop = table
            .insert(
                Deadline::create_with_limit(&shutdown.0, 1, 30000, "shutdown").unwrap(),
                true,
            )
            .unwrap() as u64;
        let mut call_wait = Box::pin(table.get(call).unwrap().wait());
        let mut stop_wait = Box::pin(table.get(stop).unwrap().wait());
        assert!(futures_util::poll!(&mut call_wait).is_pending());
        assert!(futures_util::poll!(&mut stop_wait).is_pending());
        drop(table);
        assert_eq!(calls.0.get(), 1);
        assert_eq!(shutdown.0.get(), 1);
        assert!(call_wait.await.is_err());
        assert!(stop_wait.await.is_err());
        assert_eq!(calls.0.get(), 0);
        assert_eq!(shutdown.0.get(), 0);
    }

    #[test]
    fn handle_exhaustion_is_exact_atomic_and_independent_for_shutdown() {
        let calls = DeadlineBudget::default();
        let shutdown = ShutdownDeadlineBudget::default();
        let mut table = DeadlineTable {
            entries: BTreeMap::new(),
            next_call: MAX_DEADLINE_HANDLE - 1,
            next_shutdown: MAX_DEADLINE_HANDLE,
        };
        let last_call = table
            .insert(Deadline::create(&calls, 30000).unwrap(), false)
            .unwrap();
        assert_eq!(
            parse_deadline_id(last_call).unwrap(),
            MAX_DEADLINE_HANDLE - 1
        );
        assert!(
            table
                .insert(Deadline::create(&calls, 30000).unwrap(), false)
                .unwrap_err()
                .to_string()
                .contains("handles exhausted")
        );
        assert_eq!(calls.0.get(), 1);
        assert_eq!(table.entries.len(), 1);
        let last_stop = table
            .insert(
                Deadline::create_with_limit(&shutdown.0, 1, 30000, "shutdown").unwrap(),
                true,
            )
            .unwrap();
        assert_eq!(parse_deadline_id(last_stop).unwrap(), MAX_DEADLINE_HANDLE);
        table.close(last_stop as u64);
        assert!(
            table
                .insert(
                    Deadline::create_with_limit(&shutdown.0, 1, 30000, "shutdown").unwrap(),
                    true
                )
                .unwrap_err()
                .to_string()
                .contains("handles exhausted")
        );
        assert_eq!(shutdown.0.get(), 0);
        assert_eq!(calls.0.get(), 1);
        assert!(!table.get(last_call as u64).unwrap().cancel.is_canceled());
        table.close(last_call as u64);
        assert_eq!(calls.0.get(), 0);
        assert!(table.entries.is_empty());
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
                const full = Array.from({length: 65536 - held.length}, () => __hostCreateDeadline(30000));
                let callRejected = false;
                try { __hostCreateDeadline(1); } catch (error) { callRejected = String(error).includes('capacity reached'); }
                if (!callRejected) throw new Error('ordinary call capacity was not full');
                const shutdown = __hostCreateShutdownDeadline(1);
                let duplicateRejected = false;
                try { __hostCreateShutdownDeadline(1); } catch (error) { duplicateRejected = String(error).includes('capacity reached'); }
                if (!duplicateRejected) throw new Error('shutdown reservation admitted two resources');
                await __hostWaitDeadline(shutdown);
                __hostCancelDeadline(shutdown);
                __hostCancelDeadline(shutdown);
                const nextShutdown = __hostCreateShutdownDeadline(30000);
                __hostCancelDeadline(nextShutdown);
                for (const id of full) __hostCancelDeadline(id);
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
            assert_eq!(state.borrow().borrow::<ShutdownDeadlineBudget>().0.get(), 0);
            assert_eq!(state.borrow().resource_table.len(), 1);
            let next_other = state.borrow_mut().resource_table.add(CancelHandle::new());
            assert_eq!(next_other, other + 1, "completed deadlines consumed generic resource ids");
            assert!(state.borrow().borrow::<DeadlineTable>().entries.is_empty());
            {
                let mut state = state.borrow_mut();
                let table = state.borrow_mut::<DeadlineTable>();
                table.next_call = u64::from(u32::MAX) + 1;
                table.next_shutdown = MAX_DEADLINE_HANDLE;
            }
            runtime.execute_script("deadline:large-handles", r#"
              globalThis.largeHandlesFinished = false;
              (async () => {
                const id = __hostCreateDeadline(1);
                if (id !== 0x100000000) throw new Error('large handle lost precision');
                const ops = Deno.core.ops;
                for (const value of [NaN, Infinity, -Infinity, -1, 0.5, id + 0.5, 2 ** 53]) {
                  for (const cancel of [__hostCancelDeadline, ops.op_host_cancel_deadline]) {
                    let rejected = false;
                    try { cancel(value); } catch (error) { rejected = String(error).includes('safe integer'); }
                    if (!rejected) throw new Error('invalid cancel handle accepted: ' + value);
                  }
                  for (const wait of [__hostWaitDeadline, ops.op_host_wait_deadline]) {
                    let rejected = false;
                    try { await wait(value); } catch (error) { rejected = String(error).includes('safe integer'); }
                    if (!rejected) throw new Error('invalid wait handle accepted: ' + value);
                  }
                }
                await __hostWaitDeadline(id);
                __hostCancelDeadline(id);
                __hostCancelDeadline(id);
                let unknownRejected = false;
                try { await __hostWaitDeadline(id); } catch (error) { unknownRejected = String(error).includes('unknown host deadline'); }
                if (!unknownRejected) throw new Error('closed handle still waitable');
                const stop = __hostCreateShutdownDeadline(1);
                if (stop !== Number.MAX_SAFE_INTEGER) throw new Error('last safe handle lost precision');
                await __hostWaitDeadline(stop);
                __hostCancelDeadline(stop);
                let exhausted = false;
                try { __hostCreateShutdownDeadline(1); } catch (error) { exhausted = String(error).includes('handles exhausted'); }
                if (!exhausted) throw new Error('exhausted handles wrapped');
                const next = __hostCreateDeadline(1);
                if (next !== id + 2) throw new Error('independent call handle lost');
                __hostCancelDeadline(id);
                await __hostWaitDeadline(next);
                __hostCancelDeadline(next);
                globalThis.largeHandlesFinished = true;
              })().catch(error => { globalThis.deadlineFailure = String(error); });
            "#).unwrap();
            event_loop.block_on(async {
                tokio::time::timeout(Duration::from_secs(2), runtime.run_event_loop(Default::default())).await.unwrap().unwrap();
            });
            runtime.execute_script("deadline:assert-large", "if (!largeHandlesFinished || deadlineFailure) throw new Error('large handle lifecycle failed: ' + deadlineFailure);").unwrap();
            assert_eq!(state.borrow().borrow::<DeadlineBudget>().0.get(), 0);
            assert_eq!(state.borrow().borrow::<ShutdownDeadlineBudget>().0.get(), 0);
            assert!(state.borrow().borrow::<DeadlineTable>().entries.is_empty());
            assert!(!state.borrow().resource_table.get::<CancelHandle>(other).unwrap().is_canceled());
            assert!(!state.borrow().resource_table.get::<CancelHandle>(next_other).unwrap().is_canceled());
            assert_eq!(state.borrow().resource_table.len(), 2);

            runtime.execute_script("deadline:runtime-drop", "__hostCreateDeadline(30000);").unwrap();
            let owned = state.borrow().borrow::<DeadlineTable>().entries.values().next().cloned().unwrap();
            let live = Rc::clone(&owned.live);
            let mut wait = Box::pin(owned.wait());
            event_loop.block_on(async { assert!(futures_util::poll!(&mut wait).is_pending()); });
            drop(runtime);
            assert!(state.borrow().try_borrow::<DeadlineTable>().is_none());
            assert_eq!(live.get(), 1);
            assert!(event_loop.block_on(async { tokio::time::timeout(Duration::from_millis(100), wait).await.unwrap() }).is_err());
            assert_eq!(live.get(), 0);
        }).await.unwrap();
    }
}

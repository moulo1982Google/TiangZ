//! 锁定 V8 API 的真实所有权探针，不将 GC 观察冒充业务堆或容量保证。 / Probes the locked V8 ownership API without claiming heap or capacity guarantees.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use std::time::{Duration, Instant};

use deno_core::{JsRuntime, ToV8, convert::Uint8Array, v8};

#[derive(Default)]
struct Ledger {
    bytes: AtomicUsize,
    drops: AtomicUsize,
}

struct OwnedBytes {
    bytes: Box<[u8]>,
    ledger: Arc<Ledger>,
}

impl AsMut<[u8]> for OwnedBytes {
    fn as_mut(&mut self) -> &mut [u8] {
        &mut self.bytes
    }
}

impl Drop for OwnedBytes {
    fn drop(&mut self) {
        self.ledger
            .bytes
            .fetch_sub(self.bytes.len(), Ordering::SeqCst);
        self.ledger.drops.fetch_add(1, Ordering::SeqCst);
    }
}

/// 只使用依赖的安全容器 API，不自行实现原始指针删除器。 / Uses the dependency's safe owning container API without a custom raw-pointer deleter.
fn publish(
    runtime: &mut JsRuntime,
    ledger: &Arc<Ledger>,
    len: usize,
) -> v8::SharedRef<v8::BackingStore> {
    let bytes = vec![73; len].into_boxed_slice();
    let pointer = bytes.as_ptr();
    ledger.bytes.fetch_add(len, Ordering::SeqCst);
    let backing = v8::ArrayBuffer::new_backing_store_from_bytes(Box::new(OwnedBytes {
        bytes,
        ledger: Arc::clone(ledger),
    }))
    .make_shared();
    assert_eq!(
        backing.data().unwrap().as_ptr().cast::<u8>(),
        pointer.cast_mut()
    );
    deno_core::scope!(scope, runtime);
    let buffer = v8::ArrayBuffer::with_backing_store(scope, &backing);
    let view = v8::Uint8Array::new(scope, buffer, 0, len).unwrap();
    let global = scope.get_current_context().global(scope);
    let key = v8::String::new(scope, "original").unwrap();
    assert_eq!(global.set(scope, key.into(), view.into()), Some(true));
    backing
}

fn execute(runtime: &mut JsRuntime, source: &'static str) {
    drop(
        runtime
            .execute_script("test:backing-ownership.js", source)
            .unwrap(),
    );
}

/// 主动 GC 只用于有界探针；没有推导自然 GC 的期限或增加生产强制回收。 / Forced GC belongs only to this bounded probe, not a production collection policy or natural-GC deadline.
fn collect_until_released(runtime: &mut JsRuntime, ledger: &Ledger) {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        runtime.v8_isolate().low_memory_notification();
        if ledger.bytes.load(Ordering::SeqCst) == 0 {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "backing store still owned after bounded GC probe"
        );
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn real_v8_backing_store_follows_last_view_and_native_owner() {
    let mut runtime = JsRuntime::new(Default::default());
    // 核对当前 Host 使用的 deno_core 转换没有再复制 Box 内容。 / Checks the current Host conversion transfers the boxed bytes without another payload copy.
    {
        let current = Uint8Array::from(vec![11; 128]);
        let pointer = current.0.as_ptr();
        deno_core::scope!(scope, &mut runtime);
        let value = current.to_v8(scope).unwrap();
        let array = v8::Local::<v8::Uint8Array>::try_from(value).unwrap();
        let backing = array.buffer(scope).unwrap().get_backing_store();
        assert_eq!(
            backing.data().unwrap().as_ptr().cast::<u8>(),
            pointer.cast_mut()
        );
    }
    let ledger = Arc::new(Ledger::default());
    drop(publish(&mut runtime, &ledger, 65_536));
    execute(
        &mut runtime,
        r#"
        globalThis.small = original.subarray(20, 24);
        globalThis.readSmall = ((view) => () => view[0])(small);
        globalThis.copied = new Uint8Array(small);
        original = undefined;
        small = undefined;
    "#,
    );
    runtime.v8_isolate().low_memory_notification();
    assert_eq!(
        ledger.bytes.load(Ordering::SeqCst),
        65_536,
        "four-byte view retains the whole original allocation"
    );
    assert_eq!(ledger.drops.load(Ordering::SeqCst), 0);
    execute(
        &mut runtime,
        "if (readSmall() !== 73) throw Error('view changed'); readSmall = undefined;",
    );
    collect_until_released(&mut runtime, &ledger);
    assert_eq!(ledger.drops.load(Ordering::SeqCst), 1);
    execute(
        &mut runtime,
        "if (copied.length !== 4 || copied[0] !== 73) throw Error('independent copy changed');",
    );

    // 即使 isolate 已退出，原生 SharedRef 仍是有效所有者。 / A native SharedRef remains an owner even after the isolate exits.
    let native = publish(&mut runtime, &ledger, 32);
    drop(runtime);
    assert_eq!(ledger.bytes.load(Ordering::SeqCst), 32);
    assert_eq!(ledger.drops.load(Ordering::SeqCst), 1);
    drop(native);
    assert_eq!(ledger.bytes.load(Ordering::SeqCst), 0);
    assert_eq!(ledger.drops.load(Ordering::SeqCst), 2);

    let mut runtime = JsRuntime::new(Default::default());
    drop(publish(&mut runtime, &ledger, 64));
    drop(runtime);
    assert_eq!(
        ledger.bytes.load(Ordering::SeqCst),
        0,
        "isolate exit releases its final live view"
    );
    assert_eq!(ledger.drops.load(Ordering::SeqCst), 3);
    println!(
        "V8 ownership probe passed: same pointer, subview retains 65536 bytes, final owner drops once, explicit copy excluded"
    );
}

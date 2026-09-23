//! 操作系统安全随机数。业务 V8 只有可预测的 `Math.random`，凭证、令牌等不可猜测的值必须从这里取。
//! OS-backed secure randomness. Business V8 only has the predictable `Math.random`; unguessable
//! values such as credentials and tokens must come from here.

use deno_core::op2;
use deno_error::JsErrorBox;

/// 单次最多填充的字节数，与 Web Crypto `getRandomValues` 的上限一致。 / Per-call limit, matching Web Crypto `getRandomValues`.
pub const MAX_SECURE_RANDOM_BYTES: usize = 65_536;

/// 用操作系统 CSPRNG 原地填充调用方缓冲；超限或随机源不可用时抛错，绝不退化为弱随机。
/// Fills the caller's buffer in place from the OS CSPRNG; oversized requests or an unavailable
/// source throw instead of silently degrading to weak randomness.
#[op2(fast)]
fn op_host_secure_random_fill(#[buffer] target: &mut [u8]) -> Result<(), JsErrorBox> {
    fill(target).map_err(JsErrorBox::generic)
}

fn fill(target: &mut [u8]) -> Result<(), String> {
    if target.len() > MAX_SECURE_RANDOM_BYTES {
        return Err(format!(
            "secure random request of {} bytes exceeds {MAX_SECURE_RANDOM_BYTES}",
            target.len()
        ));
    }
    getrandom::fill(target).map_err(|error| format!("secure random source unavailable: {error}"))
}

deno_core::extension!(secure_random_host, ops = [op_host_secure_random_fill]);

pub fn init() -> deno_core::Extension {
    secure_random_host::init()
}

/// 只暴露一个冻结的填充函数，并在启动时捕获 op 引用，之后改写 `Deno.core.ops` 不会重定向它；Stable 包装在 `app/core/runtime/SecureRandom.ts`。
/// Exposes one frozen fill function bound to the op captured at bootstrap, so later changes to
/// `Deno.core.ops` cannot redirect it; the Stable wrapper lives in `app/core/runtime/SecureRandom.ts`.
pub const BOOTSTRAP_SOURCE: &str = r#"(() => {
const fillOp = globalThis.Deno.core.ops.op_host_secure_random_fill;
Object.defineProperty(globalThis, "__hostSecureRandom", {
  value: Object.freeze({ fill: bytes => fillOp(bytes) }),
  writable: false,
  configurable: false,
});
})();"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fills_distinct_buffers_and_accepts_empty_and_limit() {
        let mut first = [0_u8; 32];
        let mut second = [0_u8; 32];
        fill(&mut first).unwrap();
        fill(&mut second).unwrap();
        // 两次 256 位随机值相同或全零的概率可以忽略。 / Equal or all-zero 256-bit outputs are negligible.
        assert_ne!(first, second);
        assert_ne!(first, [0_u8; 32]);
        fill(&mut []).unwrap();
        fill(&mut vec![0_u8; MAX_SECURE_RANDOM_BYTES]).unwrap();
    }

    #[test]
    fn rejects_oversized_requests() {
        let error = fill(&mut vec![0_u8; MAX_SECURE_RANDOM_BYTES + 1]).unwrap_err();
        assert!(error.contains("exceeds"), "{error}");
    }
}

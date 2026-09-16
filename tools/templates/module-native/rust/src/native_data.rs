use deno_core::op2;

/// 无状态加法，用于验证 TS 到 Rust 的调用链。 / Stateless addition verifies the TS-to-Rust bridge.
#[op2(fast)]
pub fn op_native_add(left: f64, right: f64) -> f64 {
    add_numbers(left, right)
}

/// 算法与 op 注册分开，便于直接做 Rust 单测。 / Keep the algorithm separate from op registration for Rust unit tests.
fn add_numbers(left: f64, right: f64) -> f64 {
    left + right
}

#[cfg(test)]
mod tests {
    #[test]
    fn adds_numbers() {
        assert_eq!(super::add_numbers(2.0, 3.0), 5.0);
    }
}

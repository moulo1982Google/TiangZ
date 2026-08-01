//! Demo移动领域的Rust入口，作为开发者业务模块的最小可编译样例。 / Rust entrypoints for Demo movement and the minimal compilable example for game modules.

use deno_core::op2;
use deno_error::JsErrorBox;

#[op2(fast)]
/// 更新Unit移动意图，但不推进模拟，也不回调TS。 / Updates Unit movement intent without advancing simulation or calling back into TS.
pub(crate) fn op_native_unit_set_movement_input(
    handle: u32,
    input_x: i8,
    input_z: i8,
    sequence: u32,
) -> Result<bool, JsErrorBox> {
    crate::native_data::set_unit_movement_input(handle, input_x, input_z, sequence)
}

#[op2(fast)]
/// 在重连或Session所有权变化时清除当前及排队移动。 / Clears current and queued movement after reconnect or Session ownership changes.
pub(crate) fn op_native_unit_reset_movement(handle: u32) -> Result<(), JsErrorBox> {
    crate::native_data::reset_unit_movement(handle)
}

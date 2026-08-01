//! Demo移动领域的Rust入口，作为开发者业务模块的最小可编译样例。 / Rust entrypoints for Demo movement and the minimal compilable example for game modules.

use deno_core::convert::Uint8Array;
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

#[op2]
/// 为Unit设置NavMesh目标并返回Rust实际接受的路径；路径状态不会回到TS保存。 / Sets a NavMesh target and returns the accepted path while retaining movement state in Rust.
pub(crate) fn op_native_unit_set_navigation_target(
    map_id: u32,
    handle: u32,
    target_x: f64,
    target_y: f64,
    target_z: f64,
    sequence: u32,
) -> Result<Uint8Array, JsErrorBox> {
    crate::native_data::set_unit_navigation_target(
        map_id, handle, target_x, target_y, target_z, sequence,
    )
    .map(Into::into)
}

#[op2]
/// 将角色朝向和离散方向输入转换为Rust持有的短NavMesh路径；零输入会明确停止。 / Converts facing and discrete input into a Rust-owned short NavMesh path; zero input explicitly stops.
pub(crate) fn op_native_unit_set_navigation_input(
    map_id: u32,
    handle: u32,
    forward: i8,
    strafe: i8,
    yaw: f64,
    sequence: u32,
) -> Result<Uint8Array, JsErrorBox> {
    crate::native_data::set_unit_navigation_input(map_id, handle, forward, strafe, yaw, sequence)
        .map(Into::into)
}

#[op2(fast)]
/// 在重连或Session所有权变化时清除当前及排队移动。 / Clears current and queued movement after reconnect or Session ownership changes.
pub(crate) fn op_native_unit_reset_movement(handle: u32) -> Result<(), JsErrorBox> {
    crate::native_data::reset_unit_movement(handle)
}

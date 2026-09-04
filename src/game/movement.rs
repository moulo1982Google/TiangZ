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

#[op2(fast)]
/// 设置Grid2D最终目标格；与玩家持续方向输入分离，供服务端AI精确停靠。 / Sets a final Grid2D destination, separate from continuous player input, so server AI stops exactly on arrival.
pub(crate) fn op_native_unit_set_grid_movement_target(
    handle: u32,
    target_cell_x: i32,
    target_cell_z: i32,
    sequence: u32,
) -> Result<bool, JsErrorBox> {
    crate::native_data::set_unit_grid_movement_target(
        handle,
        target_cell_x,
        target_cell_z,
        sequence,
    )
}

#[op2(fast)]
/// 原子验收一个已通过地图策略校验的Grid2D位置快照，避免高频网关逐字段跨越V8边界。 / Atomically accepts one policy-validated Grid2D position snapshot so gateways do not cross V8 once per field.
pub(crate) fn op_native_unit_apply_grid_movement_snapshot(
    handle: u32,
    cell_x: i32,
    height: f64,
    cell_z: i32,
    yaw: f64,
    moving: bool,
    sequence: u32,
) -> Result<bool, JsErrorBox> {
    crate::native_data::apply_unit_grid_movement_snapshot(
        handle, cell_x, height, cell_z, yaw, moving, sequence,
    )
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

#[op2]
/// 服务端领域效果触发一次权威位移；返回Rust校验、投影或栅格吸附后的最终坐标。 / Applies one server-authored authoritative relocation and returns the final Rust-validated, projected, or grid-snapped position.
pub(crate) fn op_native_unit_relocate(
    map_id: u32,
    handle: u32,
    x: f64,
    y: f64,
    z: f64,
    yaw: f64,
) -> Result<Uint8Array, JsErrorBox> {
    crate::native_data::relocate_unit(map_id, handle, x, y, z, yaw).map(Into::into)
}

#[op2(fast)]
/// 在重连或Session所有权变化时清除当前及排队移动。 / Clears current and queued movement after reconnect or Session ownership changes.
pub(crate) fn op_native_unit_reset_movement(handle: u32) -> Result<(), JsErrorBox> {
    crate::native_data::reset_unit_movement(handle)
}

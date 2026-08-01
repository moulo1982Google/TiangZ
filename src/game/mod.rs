//! 游戏专用Rust业务模块入口；这里的代码随Process编译部署，不参与TS Hotfix。 / Entry point for game-owned Rust modules; this code is compiled with the Process and does not participate in TS Hotfix.
//!
//! 每个领域使用独立子模块，例如`buff`、`combat`或`movement`。业务模块可以
//! 实现`.native`声明的粗粒度op，但不得直接接管Transport、Location或Actor mailbox。
//! Use one submodule per domain, such as `buff`, `combat`, or `movement`. Game
//! modules may implement coarse-grained ops declared in `.native`, but must not
//! bypass Transport, Location, or Actor mailbox ownership.

mod movement;
mod numeric;
pub(crate) mod numeric_formula;

pub(crate) use movement::{
    op_native_unit_reset_movement, op_native_unit_set_movement_input,
    op_native_unit_set_navigation_input, op_native_unit_set_navigation_target,
};
#[cfg(test)]
pub(crate) use numeric::set_numeric;
pub(crate) use numeric::{
    op_native_numeric_attach, op_native_numeric_detach, op_native_numeric_get,
    op_native_numeric_set,
};

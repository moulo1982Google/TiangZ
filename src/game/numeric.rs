//! Numeric约定式派生属性；TS维护编号，Rust按编号关系重算最终值。 / Convention-based Numeric derivation; TS owns ids while Rust recomputes final values from their numeric relationship.

use deno_core::op2;
use deno_error::JsErrorBox;

use super::numeric_formula::{
    ADD_SUFFIX, BASE_SUFFIX, PCT_SUFFIX, derive_base_add_pct, is_derived_type, modifier_target,
};

#[op2(fast)]
/// 为尚未拥有Numeric的Unit挂载空字典。 / Attaches an empty Numeric dictionary to a Unit that does not already own one.
pub(crate) fn op_native_numeric_attach(unit_handle: u32) -> Result<(), JsErrorBox> {
    crate::native_data::attach_numeric(unit_handle)
}

#[op2(fast)]
/// Component销毁时移除Numeric值和脏版本。 / Removes Numeric values and dirty revisions during Component disposal.
pub(crate) fn op_native_numeric_detach(unit_handle: u32) -> Result<(), JsErrorBox> {
    crate::native_data::detach_numeric(unit_handle)
}

#[op2(fast)]
#[bigint]
/// 读取一个i64 NumericType；未设置的key返回零。 / Reads one i64 NumericType and returns zero for an unset key.
pub(crate) fn op_native_numeric_get(
    unit_handle: u32,
    numeric_type: u32,
) -> Result<i64, JsErrorBox> {
    crate::native_data::numeric_value(unit_handle, numeric_type)
}

#[op2(fast)]
/// 写入源属性并在Rust内重算约定派生属性，返回是否产生任何变化。 / Writes one source and recomputes its convention-derived attribute in Rust, returning whether anything changed.
pub(crate) fn op_native_numeric_set(
    unit_handle: u32,
    numeric_type: u32,
    #[bigint] value: i64,
) -> Result<bool, JsErrorBox> {
    set_numeric(unit_handle, numeric_type, value)
}

/// 先完成派生计算再原子提交，溢出时不会留下半更新状态。 / Finishes derivation before one atomic commit so overflow cannot leave partial state.
pub(crate) fn set_numeric(
    unit_handle: u32,
    numeric_type: u32,
    value: i64,
) -> Result<bool, JsErrorBox> {
    if numeric_type == 0 {
        return Err(JsErrorBox::generic(
            "numeric type must be greater than zero",
        ));
    }
    if is_derived_type(numeric_type) {
        return Err(JsErrorBox::generic(format!(
            "numeric type {numeric_type} is derived and cannot be assigned directly"
        )));
    }

    let current = crate::native_data::numeric_value(unit_handle, numeric_type)?;
    if current == value {
        return Ok(false);
    }

    let mut staged = vec![(numeric_type, value)];
    if let Some(target) = modifier_target(numeric_type) {
        let base = read_value(unit_handle, &staged, target * 10 + BASE_SUFFIX)?;
        let addition = read_value(unit_handle, &staged, target * 10 + ADD_SUFFIX)?;
        let percentage = read_value(unit_handle, &staged, target * 10 + PCT_SUFFIX)?;
        let derived = derive_base_add_pct(base, addition, percentage)
            .ok_or_else(|| JsErrorBox::generic("numeric derived value exceeds i64"))?;
        stage_value(&mut staged, target, derived);
    }

    crate::native_data::set_numeric_values(unit_handle, &staged)
}

fn read_value(
    unit_handle: u32,
    staged: &[(u32, i64)],
    numeric_type: u32,
) -> Result<i64, JsErrorBox> {
    staged_value(staged, numeric_type)
        .map(Ok)
        .unwrap_or_else(|| crate::native_data::numeric_value(unit_handle, numeric_type))
}

fn staged_value(staged: &[(u32, i64)], numeric_type: u32) -> Option<i64> {
    staged
        .iter()
        .find_map(|&(candidate, value)| (candidate == numeric_type).then_some(value))
}

fn stage_value(staged: &mut Vec<(u32, i64)>, numeric_type: u32, value: i64) {
    if let Some(existing) = staged
        .iter_mut()
        .find(|(candidate, _)| *candidate == numeric_type)
    {
        existing.1 = value;
    } else {
        staged.push((numeric_type, value));
    }
}

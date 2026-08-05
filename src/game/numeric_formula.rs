//! Numeric约定式派生编号和纯计算内核，可由正式Runtime与微基准共同复用。 / Pure Numeric convention and derivation kernel shared by the runtime and microbenchmarks.

pub(crate) const DERIVED_TYPE_MIN: u32 = 1_000;
pub(crate) const DERIVED_TYPE_MAX: u32 = 9_999;
pub(crate) const BASE_SUFFIX: u32 = 1;
pub(crate) const ADD_SUFFIX: u32 = 2;
pub(crate) const PCT_SUFFIX: u32 = 3;

/// 标识禁止直接赋值的派生结果编号。 / Identifies derived result ids that reject direct assignment.
pub(crate) fn is_derived_type(numeric_type: u32) -> bool {
    (DERIVED_TYPE_MIN..=DERIVED_TYPE_MAX).contains(&numeric_type)
}

/// 把Base/Add/Pct来源编号投影到派生结果；普通编号返回None。 / Projects a Base/Add/Pct source id to its derived result and returns None for ordinary ids.
pub(crate) fn modifier_target(numeric_type: u32) -> Option<u32> {
    let target = numeric_type / 10;
    let suffix = numeric_type % 10;
    (is_derived_type(target) && (BASE_SUFFIX..=PCT_SUFFIX).contains(&suffix)).then_some(target)
}

/// 使用i128中间值计算`(Base + Add) * (100 + Pct) / 100`，结果向零截断并校验i64范围。 / Computes the conventional formula with i128 intermediates, truncates toward zero, and checks the i64 result range.
pub(crate) fn derive_base_add_pct(base: i64, addition: i64, percentage: i64) -> Option<i64> {
    let derived = i128::from(base)
        .checked_add(i128::from(addition))?
        .checked_mul(100_i128.checked_add(i128::from(percentage))?)?
        / 100;
    i64::try_from(derived).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_modifier_ids_and_checks_i64_results() {
        assert_eq!(modifier_target(10_001), Some(1_000));
        assert_eq!(modifier_target(10_002), Some(1_000));
        assert_eq!(modifier_target(10_003), Some(1_000));
        assert_eq!(modifier_target(20_001), Some(2_000));
        assert_eq!(modifier_target(20_002), Some(2_000));
        assert_eq!(modifier_target(20_003), Some(2_000));
        assert_eq!(modifier_target(10_004), None);
        assert_eq!(derive_base_add_pct(1_000, 100, 20), Some(1_320));
        assert_eq!(derive_base_add_pct(i64::MAX, i64::MAX, 100), None);
    }
}

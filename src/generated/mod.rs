// UnitData intentionally stays inline in the Arena: boxing every Unit would add
// an allocation to the hottest entity path merely to shrink the uncommon Item variant.
#[allow(clippy::large_enum_variant)]
pub mod native_data;
pub mod native_ops;

//! 提供编译期TiangZ版本身份。 / Provides the compile-time TiangZ version identity.

/// 返回Cargo包版本，供CLI、日志和后续监控使用。
///
/// Returns the Cargo package version for CLI, logs, and future observability.
pub(crate) const fn current() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// 返回包含产品名的可读版本字符串。 / Returns a human-readable version string including the product name.
pub(crate) fn display() -> String {
    format!("TiangZ {}", current())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display_uses_cargo_package_version() {
        assert_eq!(display(), format!("TiangZ {}", env!("CARGO_PKG_VERSION")));
    }
}

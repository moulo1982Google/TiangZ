//! Unix core dump 启动设置：只提升 RLIMIT_CORE，不安装信号处理器。 / Unix core-dump startup setup: raises RLIMIT_CORE only and installs no signal handlers.

/// 把 core 文件大小软限制提到硬限制（硬限制为无限时即无限），返回要记录的说明。
///
/// core 文件写到哪里由宿主机的 `kernel.core_pattern` 决定，这里只读取并报告它。
///
/// Raises the core-file soft limit to the hard limit (unlimited when the hard limit is), returning
/// messages to log.
///
/// Where cores are written is decided by the host's `kernel.core_pattern`; it is only read and reported here.
pub(super) fn enable_core_dumps() -> Vec<String> {
    let mut messages = Vec::new();
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: 传入有效的 rlimit 指针。 / Passes a valid rlimit pointer.
    if unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut limit) } != 0 {
        messages.push(format!(
            "getrlimit(RLIMIT_CORE) failed: {}",
            std::io::Error::last_os_error()
        ));
        return messages;
    }
    let unlimited = libc::rlimit {
        rlim_cur: libc::RLIM_INFINITY,
        rlim_max: libc::RLIM_INFINITY,
    };
    // SAFETY: 传入有效的 rlimit 指针；有特权（或硬限制本就无限）时直接设为无限。
    // Valid pointer; succeeds directly when privileged or when the hard limit is already unlimited.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &unlimited) } == 0 {
        messages.push("core dump size limit set to unlimited".to_string());
        push_core_pattern(&mut messages);
        return messages;
    }
    let wanted = libc::rlimit {
        rlim_cur: limit.rlim_max,
        rlim_max: limit.rlim_max,
    };
    // SAFETY: 传入有效的 rlimit 指针；只提升软限制，不需要特权。 / Valid pointer; raising only the soft limit needs no privilege.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &wanted) } != 0 {
        messages.push(format!(
            "setrlimit(RLIMIT_CORE) failed: {}",
            std::io::Error::last_os_error()
        ));
    } else if limit.rlim_max == libc::RLIM_INFINITY {
        messages.push("core dump size limit raised to unlimited".to_string());
    } else {
        messages.push(format!(
            "core dump size limit raised to the hard limit {} bytes (container may need --ulimit core=-1)",
            limit.rlim_max
        ));
    }
    push_core_pattern(&mut messages);
    messages
}

fn push_core_pattern(messages: &mut Vec<String>) {
    if let Ok(pattern) = std::fs::read_to_string("/proc/sys/kernel/core_pattern") {
        messages.push(format!(
            "kernel.core_pattern = {} (set on the host, not by TiangZ)",
            pattern.trim()
        ));
    }
}

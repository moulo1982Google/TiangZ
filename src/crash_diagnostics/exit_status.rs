//! 把子进程退出状态解码为可读原因：Windows 按 NTSTATUS，Unix 按信号与 core 标志。 / Decodes child exit status into readable causes: NTSTATUS on Windows, signal and core flag on Unix.

use std::process::ExitStatus;

/// 按当前平台解码退出状态。 / Decodes an exit status for the current platform.
pub(crate) fn describe_exit_status(status: &ExitStatus) -> String {
    #[cfg(windows)]
    {
        match status.code() {
            Some(code) => describe_windows_exit_code(code as u32),
            None => format!("{status}"),
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        describe_unix_wait_status(status.into_raw())
    }
    #[cfg(not(any(windows, unix)))]
    {
        format!("{status}")
    }
}

/// 原生异常记录 `exception_code` 使用的名称表，与 DBProxy 的报告约定逐字一致。
///
/// Name table for the native-exception `exception_code` field, matching the DBProxy report contract verbatim.
#[cfg(any(windows, test))]
pub(crate) fn exception_name(code: u32) -> Option<&'static str> {
    Some(match code {
        0xC000_0005 => "EXCEPTION_ACCESS_VIOLATION",
        0xC000_00FD => "EXCEPTION_STACK_OVERFLOW",
        0xC000_0409 => "STATUS_STACK_BUFFER_OVERRUN",
        0xC000_001D => "EXCEPTION_ILLEGAL_INSTRUCTION",
        0xC000_0094 => "EXCEPTION_INT_DIVIDE_BY_ZERO",
        0xC000_0096 => "EXCEPTION_PRIV_INSTRUCTION",
        0xC000_0006 => "EXCEPTION_IN_PAGE_ERROR",
        0xC000_0374 => "STATUS_HEAP_CORRUPTION",
        0x8000_0003 => "EXCEPTION_BREAKPOINT",
        _ => return None,
    })
}

/// 解码 Windows 退出码；不小于 0x80000000 的值按 NTSTATUS 十六进制显示并识别常见值。
///
/// Decodes a Windows exit code; values at or above 0x80000000 are shown as hexadecimal NTSTATUS
/// with common values named.
#[cfg(any(windows, test))]
pub(crate) fn describe_windows_exit_code(code: u32) -> String {
    if code < 0x8000_0000 {
        let meaning = match code {
            0 => " (success / 正常退出)",
            1 => " (error returned by the process / 进程返回错误)",
            101 => " (Rust panic default exit code / Rust panic 默认退出码)",
            _ => "",
        };
        return format!("exit code {code}{meaning}");
    }
    let name = match code {
        0xC000_0005 => "STATUS_ACCESS_VIOLATION / 访问违规",
        0xC000_00FD => "STATUS_STACK_OVERFLOW / 栈溢出",
        0xC000_0409 => {
            "STATUS_STACK_BUFFER_OVERRUN (fast fail: Rust abort, V8 fatal error, CRT abort) / 快速失败（Rust abort、V8 致命错误、CRT abort）"
        }
        0xC000_0374 => "STATUS_HEAP_CORRUPTION / 堆损坏",
        0xC000_001D => "STATUS_ILLEGAL_INSTRUCTION / 非法指令",
        0xC000_0094 => "STATUS_INTEGER_DIVIDE_BY_ZERO / 整数除零",
        0xC000_0017 => "STATUS_NO_MEMORY / 内存不足",
        0xC000_0602 => "STATUS_FAIL_FAST_EXCEPTION / 快速失败异常",
        0xC000_0420 => "STATUS_ASSERTION_FAILURE / 断言失败",
        0xC000_013A => "STATUS_CONTROL_C_EXIT / Ctrl+C 退出",
        0xC000_0142 => "STATUS_DLL_INIT_FAILED / DLL 初始化失败",
        0xC000_0135 => "STATUS_DLL_NOT_FOUND / 找不到 DLL",
        0x8000_0003 => {
            "STATUS_BREAKPOINT (V8 fatal error or OOM on Windows, int3) / 断点（Windows 上 V8 致命错误或内存耗尽）"
        }
        _ => "unrecognized NTSTATUS / 未识别的 NTSTATUS",
    };
    format!("NTSTATUS 0x{code:08X} ({name})")
}

/// 解码 Unix `wait` 原始状态：正常退出码、终止信号（Linux 编号）以及是否 core dumped。
///
/// Decodes a raw Unix `wait` status: normal exit code, terminating signal (Linux numbering), and
/// whether a core was dumped.
#[cfg(any(unix, test))]
pub(crate) fn describe_unix_wait_status(raw: i32) -> String {
    let low = raw & 0x7f;
    if low == 0 {
        let code = (raw >> 8) & 0xff;
        let meaning = match code {
            0 => " (success / 正常退出)",
            101 => " (Rust panic default exit code / Rust panic 默认退出码)",
            _ => "",
        };
        return format!("exit code {code}{meaning}");
    }
    if low == 0x7f {
        return format!("stopped or continued (wait status 0x{raw:04X}) / 已暂停或继续");
    }
    let core = if raw & 0x80 != 0 {
        "core dumped / 已生成 core"
    } else {
        "no core dump (check ulimit -c, coreDump and core_pattern) / 未生成 core（检查 ulimit -c、coreDump 与 core_pattern）"
    };
    format!("signal {low} ({}), {core}", linux_signal_name(low))
}

/// 返回 Linux 信号名与中文含义；未知编号返回通用说明。 / Returns the Linux signal name and meaning; unknown numbers get a generic label.
#[cfg(any(unix, test))]
pub(crate) fn linux_signal_name(signal: i32) -> &'static str {
    match signal {
        1 => "SIGHUP / 终端挂断",
        2 => "SIGINT / 中断",
        3 => "SIGQUIT / 退出",
        4 => "SIGILL / 非法指令",
        5 => "SIGTRAP / 断点陷阱",
        6 => "SIGABRT / abort（Rust abort、V8 致命错误）",
        7 => "SIGBUS / 总线错误",
        8 => "SIGFPE / 算术异常",
        9 => "SIGKILL / 强制终止（含 OOM killer）",
        11 => "SIGSEGV / 段错误",
        13 => "SIGPIPE / 管道断开",
        15 => "SIGTERM / 终止请求",
        31 => "SIGSYS / 非法系统调用",
        _ => "unrecognized signal / 未识别的信号",
    }
}

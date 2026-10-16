//! Windows 未处理异常过滤器：在独立写入线程同步写文本记录与可选 MiniDump。 / Windows unhandled-exception filter that writes a text record and optional MiniDump on a dedicated writer thread.

use std::io::{self, Write};
use std::os::windows::io::AsRawHandle;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicPtr, AtomicU32, Ordering};
use std::time::SystemTime;

use windows_sys::Win32::Foundation::{GetLastError, HANDLE, WAIT_OBJECT_0};
use windows_sys::Win32::System::Diagnostics::Debug::{
    EXCEPTION_CONTINUE_SEARCH, EXCEPTION_POINTERS, LPTOP_LEVEL_EXCEPTION_FILTER,
    MINIDUMP_EXCEPTION_INFORMATION, MINIDUMP_TYPE, MiniDumpWithHandleData,
    MiniDumpWithIndirectlyReferencedMemory, MiniDumpWithThreadInfo, MiniDumpWithUnloadedModules,
    MiniDumpWriteDump, SetUnhandledExceptionFilter,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, INFINITE, SetEvent,
    WaitForSingleObject,
};

use super::exit_status::exception_name;
use super::report::{self, FileClass, create_unique_file, file_stem, write_field};
use super::{CrashSettings, state, write_report_with_stem};

/// 转储级别与 DBProxy 相同：Normal + 线程信息 + 间接引用内存 + 已卸载模块 + 句柄，不含完整堆。
/// Same level as DBProxy: Normal + thread info + indirectly referenced memory + unloaded modules + handles, no full heap.
const DUMP_TYPE: MINIDUMP_TYPE = MiniDumpWithThreadInfo
    | MiniDumpWithIndirectlyReferencedMemory
    | MiniDumpWithUnloadedModules
    | MiniDumpWithHandleData;
/// 崩溃线程等待写入线程的上限，避免写盘异常时进程永不退出。 / Upper bound for the crashing thread to wait on the writer, so a stuck disk cannot keep the process alive.
const WRITER_WAIT_MS: u32 = 120_000;

struct Channel {
    request: usize,
    done: usize,
    previous: LPTOP_LEVEL_EXCEPTION_FILTER,
}

static CHANNEL: OnceLock<Channel> = OnceLock::new();
static ENTERED: AtomicBool = AtomicBool::new(false);
static POINTERS: AtomicPtr<EXCEPTION_POINTERS> = AtomicPtr::new(std::ptr::null_mut());
static THREAD_ID: AtomicU32 = AtomicU32::new(0);

/// 启动写入线程并安装未处理异常过滤器；失败只返回说明，不阻止进程启动。
///
/// 写入工作放在预先创建的线程上，因为栈溢出时崩溃线程剩余栈很小，不能直接调用 MiniDumpWriteDump。
///
/// Starts the writer thread and installs the unhandled-exception filter; failures return a
/// message instead of blocking startup.
///
/// Work runs on a pre-created thread because a stack-overflowing thread has too little stack left
/// to call MiniDumpWriteDump directly.
pub(super) fn install() -> Result<(), String> {
    // SAFETY: 创建匿名自动复位事件，参数均为合法空指针。 / Creates anonymous auto-reset events with valid null arguments.
    let request = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
    let done = unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) };
    if request.is_null() || done.is_null() {
        return Err(format!("CreateEventW failed: {}", unsafe {
            GetLastError()
        }));
    }
    let (request, done) = (request as usize, done as usize);
    std::thread::Builder::new()
        .name("tiangz-crash-writer".to_string())
        .spawn(move || writer_loop(request as HANDLE, done as HANDLE))
        .map_err(|error| format!("failed to start crash writer thread: {error}"))?;
    // SAFETY: 过滤器是进程级函数指针，生命周期为 'static。 / The filter is a process-wide 'static function pointer.
    let previous = unsafe { SetUnhandledExceptionFilter(Some(unhandled_exception_filter)) };
    let _ = CHANNEL.set(Channel {
        request,
        done,
        previous,
    });
    Ok(())
}

unsafe extern "system" fn unhandled_exception_filter(pointers: *const EXCEPTION_POINTERS) -> i32 {
    let Some(channel) = CHANNEL.get() else {
        return EXCEPTION_CONTINUE_SEARCH;
    };
    if !ENTERED.swap(true, Ordering::SeqCst) {
        POINTERS.store(pointers.cast_mut(), Ordering::SeqCst);
        // SAFETY: 只调用不分配内存的线程与同步 API。 / Calls only non-allocating thread and sync APIs.
        unsafe {
            THREAD_ID.store(GetCurrentThreadId(), Ordering::SeqCst);
            SetEvent(channel.request as HANDLE);
            if WaitForSingleObject(channel.done as HANDLE, WRITER_WAIT_MS) != WAIT_OBJECT_0 {
                let _ = io::stderr().write_all(b"[tiangz] crash dump timed out\n");
            }
        }
    }
    match channel.previous {
        // SAFETY: 链接到安装前的过滤器，保持其他组件的处理。 / Chains to the filter installed before ours.
        Some(previous) => unsafe { previous(pointers) },
        None => EXCEPTION_CONTINUE_SEARCH,
    }
}

fn writer_loop(request: HANDLE, done: HANDLE) {
    loop {
        // SAFETY: 事件句柄在进程生命周期内有效。 / Event handles stay valid for the process lifetime.
        unsafe { WaitForSingleObject(request, INFINITE) };
        let _ = std::panic::catch_unwind(write_native_crash);
        unsafe { SetEvent(done) };
    }
}

fn write_native_crash() {
    let Some(crash) = state() else { return };
    let pointers = POINTERS.load(Ordering::SeqCst);
    let thread_id = THREAD_ID.load(Ordering::SeqCst);
    let stem = file_stem(
        &crash.settings.file_label,
        std::process::id(),
        SystemTime::now(),
    );
    // 转储先写，尽早固定现场；文本记录与转储共用同一个文件名主干。
    // Write the dump first to capture state early; the text record shares the dump's file stem.
    let minidump = if crash.settings.mini_dump {
        match write_mini_dump(&crash.settings, &stem, pointers, thread_id) {
            Ok(name) => {
                report::after_write(&crash.settings, Some(&crash.retention), FileClass::Dump);
                name
            }
            Err(error) => format!("failed: {error}"),
        }
    } else {
        "not requested (diagnostics.crash.miniDump = false)".to_string()
    };
    // SAFETY: 指针来自系统传给过滤器的异常信息，崩溃线程在等待期间保持其有效。
    // The pointer comes from the system's exception information and stays valid while the crashing thread waits.
    let record = unsafe {
        pointers
            .as_ref()
            .and_then(|value| value.ExceptionRecord.as_ref())
    };
    write_report_with_stem("native-exception", Some(stem), &mut |out| {
        writeln!(out, "thread_id: {thread_id}")?;
        let (code, address) = record.map_or((0, 0), |record| {
            (
                record.ExceptionCode as u32,
                record.ExceptionAddress as usize,
            )
        });
        match exception_name(code) {
            Some(name) => writeln!(out, "exception_code: 0x{code:08X} ({name})")?,
            None => writeln!(out, "exception_code: 0x{code:08X}")?,
        }
        writeln!(out, "exception_address: 0x{address:016X}")?;
        if let Some(record) = record
            && code == 0xC000_0005
            && record.NumberParameters >= 2
        {
            let operation = match record.ExceptionInformation[0] {
                0 => "read",
                1 => "write",
                8 => "execute",
                _ => "unknown access",
            };
            writeln!(
                out,
                "access_violation: {operation} at 0x{:016X}",
                record.ExceptionInformation[1]
            )?;
        }
        write_field(out, "minidump", &minidump)
    });
}

fn write_mini_dump(
    settings: &CrashSettings,
    stem: &str,
    pointers: *mut EXCEPTION_POINTERS,
    thread_id: u32,
) -> Result<String, String> {
    let (path, file) =
        create_unique_file(&settings.directory, stem, "dmp").map_err(|error| error.to_string())?;
    let exception = MINIDUMP_EXCEPTION_INFORMATION {
        ThreadId: thread_id,
        ExceptionPointers: pointers,
        ClientPointers: 0,
    };
    let exception_param = if pointers.is_null() {
        std::ptr::null()
    } else {
        &exception as *const MINIDUMP_EXCEPTION_INFORMATION
    };
    // SAFETY: 文件句柄在调用期间有效；异常信息属于本进程、由等待中的崩溃线程保持有效。
    // The file handle is valid for the call; the exception information belongs to this process and stays valid while the crashing thread waits.
    let written = unsafe {
        MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            file.as_raw_handle() as HANDLE,
            DUMP_TYPE,
            exception_param,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if written == 0 {
        let error = unsafe { GetLastError() };
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(format!("MiniDumpWriteDump error {error}"));
    }
    let _ = file.sync_all();
    let _ = writeln!(
        io::stderr(),
        "[tiangz] minidump written to {}",
        path.display()
    );
    Ok(path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default())
}

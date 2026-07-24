//! 选择进程级全局分配器，且不把分配策略泄漏到业务模块。 / Selects the process-global allocator without leaking allocator policy into business modules.

#[cfg(feature = "mimalloc-allocator")]
use mimalloc::MiMalloc;

#[cfg(feature = "mimalloc-allocator")]
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

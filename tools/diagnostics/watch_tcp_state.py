"""按当前 ELF 的 DWARF 监视连接状态；仅供隔离诊断，不修改 inferior。

Watch live TCP future states using this ELF's DWARF, without writing inferior memory.
Run with gdb --batch --return-child-result -x this-file.py --args <matching ELF> ...
"""
import hashlib
import json
import os
import time

import gdb


OUTER = 'TiangZ::transport_backend::epoll::run_scene_listener::{async_fn#0}::{async_block_env#0}'
INNER = 'TiangZ::transport_backend::epoll::handle_connection::{async_fn_env#0}'
LIMIT = int(os.environ.get('TIANGZ_WATCH_CONNECTIONS', '4'))
OUTPUT = os.environ.get('TIANGZ_WATCH_OUTPUT', '/evidence')
LABEL = os.environ.get('TIANGZ_WATCH_LABEL', 'tcp')
os.makedirs(OUTPUT, exist_ok=True)
if LIMIT < 1 or LIMIT > 4:
    raise gdb.GdbError('hardware watchpoint count must be 1..4')

for command in ('set pagination off', 'set confirm off', 'set debuginfod enabled off',
                'set disable-randomization off', 'set print thread-events off',
                'set print elements 16', 'set print max-depth 5',
                'handle SIGPIPE nostop noprint pass', 'handle SIGTERM nostop noprint pass',
                'set language c', 'set can-use-hw-watchpoints 1'):
    gdb.execute(command)

binary = gdb.current_progspace().filename
with open(binary, 'rb') as source:
    binary_hash = hashlib.file_digest(source, 'sha256').hexdigest()
expected_hash = os.environ.get('TIANGZ_WATCH_ELF_SHA256')
if expected_hash and binary_hash != expected_hash:
    raise gdb.GdbError('diagnostic ELF hash mismatch')


def field(kind, name):
    """字段来自本 ELF，禁止复用另一构建的固定偏移。 / Resolve this ELF's field offset."""
    return next(item for item in kind.fields() if item.name == name)


outer_type = gdb.lookup_type(OUTER)
inner_type = gdb.lookup_type(INNER)
suspend = next(item for item in outer_type.fields() if str(item.type).endswith('::Suspend0'))
awaited = field(suspend.type, '__awaitee')
inner_offset = (suspend.bitpos + awaited.bitpos) // 8
state_offset = field(inner_type, '__state').bitpos // 8
legal_states = {int(item.name) for item in inner_type.fields() if item.name.isdigit()}
if legal_states != set(range(6)) or str(awaited.type) != str(inner_type):
    raise gdb.GdbError('unexpected coroutine layout; inspect this build before watching')

stats = {'binarySha256': binary_hash, 'label': LABEL, 'maxWatchpoints': LIMIT,
         'innerOffset': inner_offset, 'stateOffset': state_offset,
         'attached': 0, 'completed': 0, 'dropped': 0, 'transitions': 0,
         'peakActive': 0, 'active': 0, 'state': 'starting', 'monitorPausedAtCapacity': 0,
         'uncoveredPolicy': 'new connections are not observed while all watch slots are occupied'}
active = {}
last_stop = None
exited = None
prefix = os.path.join(OUTPUT, 'watch-' + LABEL + '-' + str(os.getpid()))


def record(event, **data):
    """追加独立事件，不覆盖失败证据。 / Append lifecycle evidence."""
    with open(prefix + '.jsonl', 'a', encoding='utf8') as output:
        output.write(json.dumps({'at': time.time(), 'event': event, **data}) + '\n')


def save():
    """原子发布监视覆盖与状态，供外围监督器读取。 / Publish coverage atomically."""
    stats['active'] = len(active)
    stats['updatedAt'] = time.time()
    with open(prefix + '.json.tmp', 'w', encoding='utf8') as output:
        json.dump(stats, output, indent=2)
    os.replace(prefix + '.json.tmp', prefix + '.json')


def byte_at(address):
    """只读 inferior；不使用写内存来绕过故障。 / Read one state byte."""
    return int.from_bytes(gdb.selected_inferior().read_memory(address, 1).tobytes(), 'little')


def entry_address(symbol):
    """断在函数第一条指令，保证 x86-64 参数寄存器尚未复用。 / Break before the prologue."""
    return int(gdb.parse_and_eval("&'" + symbol + "'"))


def stage_future():
    """沿真实调用栈找 Tokio Stage，不从优化掉的局部变量猜地址。 / Locate the live Stage."""
    frame = gdb.newest_frame()
    while frame:
        try:
            pointer = frame.read_var('ptr')
            if (not pointer.is_optimized_out and 'core::Stage<' in str(pointer.type)
                    and OUTER in str(pointer.type)):
                running = field(pointer.type.target(), 'Running')
                value = field(running.type, '__0')
                if str(value.type) != str(outer_type):
                    raise gdb.GdbError('Stage future type mismatch')
                return int(pointer) + (running.bitpos + value.bitpos) // 8
        except (gdb.error, ValueError, StopIteration):
            pass
        frame = frame.older()
    raise gdb.GdbError('no live connection Stage found at entry')


def retire(address, reason):
    """在进程仍停止时撤销监视点，再允许析构/释放继续。 / Remove before resuming destruction."""
    slot = active.pop(address, None)
    if slot is None:
        return
    slot['breakpoint'].delete()
    stats[reason] += 1
    record('retired', future=hex(address), reason=reason)
    acquire.enabled = True


def capture(reason, **detail):
    """故障现场先落盘，随后终止；绝不在 SIGSEGV 后继续游戏。 / Preserve and stop on failure."""
    stats.update(state='incident', reason=reason, detail=detail, inferiorPid=gdb.selected_inferior().pid)
    save()
    base = prefix + '-incident'
    for command, suffix in [('thread apply all bt 40', '.backtrace.txt'), ('info registers', '.registers.txt'),
                            ('info proc mappings', '.mappings.txt'), ('info breakpoints', '.breakpoints.txt')]:
        try:
            with open(base + suffix, 'w', encoding='utf8') as output:
                output.write(gdb.execute(command, to_string=True))
        except gdb.error as error:
            record('capture-error', command=command, error=str(error))
    if os.environ.get('TIANGZ_WATCH_CORE', '1') == '1':
        try:
            gdb.execute('generate-core-file ' + base + '.core', to_string=True)
            stats['core'] = base + '.core'
        except gdb.error as error:
            stats['coreError'] = str(error)
    save()
    print('TCP_STATE_INCIDENT ' + prefix + '.json', flush=True)


def on_stop(event):
    """只记事件；修改断点在停止后的主循环执行。 / Defer all breakpoint mutation to the loop."""
    global last_stop
    last_stop = event


def on_exit(event):
    """退出码必须保留，退出信号不能当作成功。 / Preserve the inferior exit status."""
    global exited
    exited = getattr(event, 'exit_code', -1)


gdb.events.stop.connect(on_stop)
gdb.events.exited.connect(on_exit)
# PIE 地址在启动后才完成重定位；不能把启动前的地址用作绝对断点。
# Resolve absolute function-entry addresses only after the PIE is mapped.
gdb.execute('starti', to_string=True)
acquire = gdb.Breakpoint('/engine/src/transport_backend/epoll.rs:121', internal=True)
# Rust 的取消路径会在该函数入口析构内层 future，先撤销它的监视点。
# The inner future's drop glue runs on cancellation; remove its watchpoint before destruction.
drop_symbol = 'core::ptr::drop_glue<' + INNER + '>'
drop = gdb.Breakpoint('*' + hex(entry_address(drop_symbol)), internal=True)
record('layout', binary=binary, **stats)
save()
exit_code = 1
try:
    gdb.execute('continue', to_string=True)
    if gdb.selected_inferior().pid and 'i386:x86-64' not in gdb.selected_frame().architecture().name():
        raise gdb.GdbError('only the verified Linux x86-64 ABI is supported')
    while exited is None:
        if isinstance(last_stop, gdb.SignalEvent):
            capture('native-signal', signal=last_stop.stop_signal)
            break
        if not isinstance(last_stop, gdb.BreakpointEvent):
            raise gdb.GdbError('unexpected debugger stop: ' + str(last_stop))
        for stopped in last_stop.breakpoints:
            if stopped.number == drop.number:
                # 此断点位于函数首指令；SysV ABI 第一参数是被析构的内层 future 地址。
                # At the first instruction, RDI is the inner future under the SysV ABI.
                retire(int(gdb.parse_and_eval('$rdi')) - inner_offset, 'dropped')
            elif stopped.number == acquire.number:
                address = stage_future()
                if address in active:
                    raise gdb.GdbError('connection entry reused an active watch address')
                state_address = address + inner_offset + state_offset
                value = byte_at(state_address)
                if value not in legal_states:
                    capture('invalid-state-at-entry', future=hex(address), value=value)
                    raise gdb.GdbError('invalid initial state')
                watch = gdb.Breakpoint('*(unsigned char*)' + hex(state_address), type=gdb.BP_WATCHPOINT,
                                       wp_class=gdb.WP_WRITE, internal=True)
                if watch.type != gdb.BP_HARDWARE_WATCHPOINT:
                    watch.delete()
                    raise gdb.GdbError('hardware watchpoint unavailable; refusing software fallback')
                active[address] = {'breakpoint': watch, 'address': state_address, 'last': value}
                stats['attached'] += 1
                stats['peakActive'] = max(stats['peakActive'], len(active))
                record('attached', future=hex(address), stateAddress=hex(state_address), value=value,
                       breakpointType=watch.type)
                if len(active) >= LIMIT:
                    acquire.enabled = False
                    stats['monitorPausedAtCapacity'] += 1
            else:
                address, slot = next((address, slot) for address, slot in active.items()
                                     if slot['breakpoint'].number == stopped.number)
                value = byte_at(slot['address'])
                stats['transitions'] += 1
                record('transition', future=hex(address), previous=slot['last'], value=value)
                slot['last'] = value
                if value not in legal_states:
                    capture('invalid-state-write', future=hex(address), value=value)
                    raise gdb.GdbError('illegal coroutine state written')
                if value in (1, 2):
                    retire(address, 'completed')
        stats['state'] = 'watching'
        stats['inferiorPid'] = gdb.selected_inferior().pid
        save()
        last_stop = None
        gdb.execute('continue', to_string=True)
    if exited is not None:
        stats.update(state='exited', exitCode=exited, activeAtExit=len(active))
        save()
        exit_code = exited if exited >= 0 else 1
except Exception as error:
    if stats['state'] != 'incident':
        stats.update(state='tool-error', error=str(error))
        record('tool-error', error=str(error))
        save()
    print('TCP_STATE_MONITOR_FAILED ' + str(error), flush=True)
finally:
    for slot in list(active.values()):
        if slot['breakpoint'].is_valid():
            slot['breakpoint'].delete()
    if gdb.selected_inferior().pid:
        gdb.execute('kill', to_string=True)
gdb.execute('quit ' + str(exit_code))

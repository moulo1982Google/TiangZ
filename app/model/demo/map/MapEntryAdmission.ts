/**
 * 入场队列默认可容纳10000人，按20Hz每Tick放行1人时理论排空需要500秒。
 * 首次进图和地图传送必须使用独立长事务预算，不能继承普通Scene RPC的5秒超时。
 * 这是故障兜底，不是业务响应时延目标；队列长度和实际等待时间仍必须持续观测。
 *
 * The default admission queue may need 500 seconds to drain at one player per 20Hz tick.
 * Initial entry and map transfer therefore use a dedicated budget instead of the 5s RPC default.
 * This is a failure bound, not a latency target; queue depth and wait time remain observable SLOs.
 */
export const MAP_ENTRY_ADMISSION_TIMEOUT_MS = 10 * 60_000;

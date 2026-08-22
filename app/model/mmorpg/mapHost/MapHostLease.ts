/**
 * MapHost每5秒续租，连续三次未报告后才判定失联；Location重启后额外等待一次完整租约窗口。
 * MapHosts renew every five seconds and are considered lost after three missed
 * reports. Location startup allows one additional full lease window for recovery.
 */
export const MAP_HOST_REPORT_INTERVAL_MS = 5_000;
export const MAP_HOST_LEASE_TIMEOUT_MS = 15_000;
export const MAP_ROUTE_RECOVERY_GRACE_MS = 20_000;


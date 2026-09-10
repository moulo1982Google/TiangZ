/** 单次投递身份与原始信封；streamId仅用于MQ确认，领域按event_id去重。
 * Delivery identity and raw envelope; streamId is for MQ ACK, domain deduplicates event_id.
 */
export interface StreamDelivery { readonly streamId: string; readonly event: string; }
interface StreamHost { configured(): boolean; poll(): Promise<StreamDelivery[]>; ack(id: string): Promise<void>; }
function host(): StreamHost {
  const value = (globalThis as unknown as { __hostEventStream?: StreamHost }).__hostEventStream;
  if (!value) throw new Error("event stream Host is unavailable");
  return value;
}
/** 固定部署目标的消费组适配器。业务提交inbox及状态后才能ACK；失败保留pending。
 * Consumer-group adapter for a deployment-owned destination. ACK only after inbox/state commit; failure stays pending.
 */
export class HostStreamConsumer {
  static IsAvailable(): boolean { return (globalThis as unknown as { __hostEventStream?: StreamHost }).__hostEventStream?.configured() === true; }
  Poll(): Promise<StreamDelivery[]> { return host().poll(); }
  Ack(streamId: string): Promise<void> { return host().ack(streamId); }
}

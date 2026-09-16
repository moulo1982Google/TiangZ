/** 本地验证控制器：只管理 start 返回的资源，不扫描系统进程。 / Local validation controller owns only resources returned by start. */
export class LocalReplicaController {
  constructor({ min = 1, max = 3, start, drain, stop, now = Date.now, cooldownMs = 200, retryMs = 500 }) {
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) throw new Error("invalid replica bounds");
    Object.assign(this, { min, max, start, drain, stop, now, cooldownMs, retryMs });
    this.instances = new Map(); this.sequence = 0; this.pending = undefined; this.closed = false; this.nextChange = 0;
  }
  reconcile(desired) {
    if (!Number.isInteger(desired) || desired < this.min || desired > this.max) return Promise.reject(new Error("desired replicas outside bounds"));
    if (this.closed) return Promise.reject(new Error("controller is closed"));
    if (this.pending) return this.pending;
    this.pending = this.step(desired).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  async step(desired) {
    if (this.now() < this.nextChange) return;
    try {
      const draining = [...this.instances].find(([, item]) => item.draining);
      if (draining) {
        const [id, item] = draining;
        if (await this.drain(item.resource)) { await this.stop(item.resource); this.instances.delete(id); this.nextChange = this.now() + this.cooldownMs; }
        return;
      }
      if (this.instances.size < desired) {
        const id = ++this.sequence;
        const resource = await this.start(id);
        this.instances.set(id, { resource, draining: false });
        this.nextChange = this.now() + this.cooldownMs;
      } else if (this.instances.size > desired) {
        const item = [...this.instances.values()].at(-1);
        item.draining = true; // 退出确认前仍占一个槽，不能提前补建。 / Draining resources still count until confirmed stopped.
        if (await this.drain(item.resource)) { await this.stop(item.resource); this.instances.delete([...this.instances.keys()].at(-1)); }
        this.nextChange = this.now() + this.cooldownMs;
      }
    } catch (error) { this.nextChange = this.now() + this.retryMs; throw error; }
  }
  async close() {
    this.closed = true;
    await this.pending?.catch(() => {});
    const errors = [];
    for (const [id, item] of this.instances) {
      try { await this.stop(item.resource); this.instances.delete(id); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "owned replicas did not stop cleanly");
  }
}

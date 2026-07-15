import type { Entity } from "./entities";
import type { InstanceId } from "./types";

export class EntityRoot {
  private readonly allEntities = new Map<InstanceId, Entity>();

  Add(entity: Entity): void {
    if (entity.InstanceId <= 0) {
      throw new Error(`cannot add detached entity: ${entity.constructor.name}`);
    }
    if (this.allEntities.has(entity.InstanceId)) {
      throw new Error(`duplicate entity instance id: ${entity.InstanceId}`);
    }
    this.allEntities.set(entity.InstanceId, entity);
  }

  Get<T extends Entity = Entity>(
    instanceId: InstanceId,
  ): T | undefined {
    return this.allEntities.get(instanceId) as T | undefined;
  }

  Remove(instanceId: InstanceId): boolean {
    return this.allEntities.delete(instanceId);
  }

  Has(instanceId: InstanceId): boolean {
    return this.allEntities.has(instanceId);
  }

  get Count(): number {
    return this.allEntities.size;
  }
}

const host = globalThis as typeof globalThis & {
  __nativeEntityCreate: (entityType: number, values: Float64Array) => number;
  __nativeEntityDestroy: (handle: number) => void;
  __nativeEntityGetNumber: (handle: number, field: number) => number;
  __nativeEntitySetNumber: (handle: number, field: number, value: number) => void;
};

export class NativeEntityBridge {
  static Create(entityType: number, values: Float64Array): number {
    return host.__nativeEntityCreate(entityType, values);
  }

  static Destroy(handle: number): void {
    host.__nativeEntityDestroy(handle);
  }

  static GetNumber(handle: number, field: number): number {
    return host.__nativeEntityGetNumber(handle, field);
  }

  static SetNumber(handle: number, field: number, value: number): void {
    host.__nativeEntitySetNumber(handle, field, value);
  }
}

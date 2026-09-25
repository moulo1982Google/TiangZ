import { Component } from "../../../app/core/public";

class InvalidAsyncLifecycle extends Component {
  override async Awake(): Promise<void> {}
}

class InvalidThenableLifecycle extends Component {
  CaptureTransfer(): Promise<{ value: number }> {
    return Promise.resolve({ value: 1 });
  }
}

class InvalidOverloadedLifecycle extends Component {
  override OnDestroy(): void;
  override OnDestroy() { return Promise.resolve(); }
}

class InvalidTimerContracts extends Component {
  Schedule(dynamicMethod: string): void {
    this.NewOnceTimer(1, dynamicMethod, { count: 1 });
    this.NewOnceTimer(1, "Missing", { count: 1 });
    this.NewOnceTimer(1, "Tick", "wrong args");
    this.NewOnceTimer(1, "Tick", { count: 1 }, { onCancelled: "MissingCancellation" });
    this.NewOnceTimer(1, "Tick", { count: 1 }, { onCancelled: "BadCancellation" });
  }

  Tick(_args: { readonly count: number }): void {}
  BadCancellation(_args: { readonly count: number }, _context: string): void {}
}

void InvalidAsyncLifecycle;
void InvalidThenableLifecycle;
void InvalidOverloadedLifecycle;
void InvalidTimerContracts;

// 同名工具类不属于 Core 生命周期。 / Same-named utility methods are not runtime hooks.
class Unrelated { async Awake(): Promise<void> {} }
void Unrelated;

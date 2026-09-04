interface TimerOptions {
  readonly onCancelled?: string;
}

interface TimerCancelledContext {
  readonly timerId: number;
  readonly reason: string;
  readonly cancelledAt: number;
}

class InvalidAsyncLifecycle {
  async Awake(): Promise<void> {}
}

class InvalidThenableLifecycle {
  CaptureTransfer(): Promise<{ value: number }> {
    return Promise.resolve({ value: 1 });
  }
}

class InvalidTimerContracts {
  NewOnceTimer<TArgs>(
    _delayMs: number,
    _methodName: string,
    _args?: TArgs,
    _options: TimerOptions = {},
  ): number {
    return 1;
  }

  Schedule(): void {
    const dynamicMethod = "Tick";
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
void InvalidTimerContracts;

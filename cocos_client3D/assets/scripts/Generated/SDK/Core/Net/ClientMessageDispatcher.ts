import type {
  IMessage,
  MessageDescriptor,
} from "../Protocol/Message";

export type ClientMessageResult = void | Promise<void>;

export interface ClientMessageSource {
  on<TMessage extends IMessage>(
    descriptor: MessageDescriptor<TMessage>,
    handler: (message: TMessage) => void,
  ): () => void;
}

export class ClientMessageScope<TContext> {
  declare readonly __contextType?: TContext;

  constructor(readonly name: string) {
    if (!name) throw new Error("客户端消息作用域名称不能为空");
  }
}

export interface ClientMessageHandler<TContext, TMessage extends IMessage> {
  handle(context: TContext, message: TMessage): ClientMessageResult;
}

type ClientMessageHandlerCtor<TContext, TMessage extends IMessage> =
  new () => ClientMessageHandler<TContext, TMessage>;

interface ClientMessageBinding {
  readonly scope: ClientMessageScope<unknown>;
  readonly descriptor: MessageDescriptor<IMessage>;
  readonly handlerCtor: ClientMessageHandlerCtor<unknown, IMessage>;
}

export interface ClientMessageDispatcherOptions {
  onError?: (
    descriptor: MessageDescriptor<IMessage>,
    error: unknown,
  ) => void;
}

const bindings: ClientMessageBinding[] = [];

export function clientMessageHandler<
  TContext,
  TMessage extends IMessage,
>(
  scope: ClientMessageScope<TContext>,
  descriptor: MessageDescriptor<TMessage>,
): (handlerCtor: ClientMessageHandlerCtor<TContext, TMessage>) => void {
  return (handlerCtor) => {
    const duplicate = bindings.find(
      (binding) =>
        binding.scope === scope &&
        binding.descriptor.msgcode === descriptor.msgcode,
    );
    if (duplicate) {
      throw new Error(
        `客户端消息作用域 ${scope.name} 重复注册 ${descriptor.name}`,
      );
    }
    bindings.push({
      scope: scope as ClientMessageScope<unknown>,
      descriptor: descriptor as MessageDescriptor<IMessage>,
      handlerCtor: handlerCtor as ClientMessageHandlerCtor<unknown, IMessage>,
    });
  };
}

export class ClientMessageDispatcher<TContext> {
  private readonly unsubscribers: Array<() => void> = [];
  private readonly onError: (
    descriptor: MessageDescriptor<IMessage>,
    error: unknown,
  ) => void;
  private disposed = false;

  constructor(
    source: ClientMessageSource,
    scope: ClientMessageScope<TContext>,
    context: TContext,
    options: ClientMessageDispatcherOptions = {},
  ) {
    this.onError = options.onError ?? ((descriptor, error) => {
      console.error(`客户端消息 Handler 执行失败：${descriptor.name}`, error);
    });

    const scopedBindings = bindings.filter((binding) => binding.scope === scope);
    if (scopedBindings.length === 0) {
      throw new Error(
        `客户端消息作用域 ${scope.name} 没有 Handler；请检查 codegen 生成的 Handler imports`,
      );
    }
    try {
      for (const binding of scopedBindings) {
        const handler = new binding.handlerCtor() as ClientMessageHandler<
          TContext,
          IMessage
        >;
        this.unsubscribers.push(
          source.on(binding.descriptor, (message) => {
            this.invoke(binding.descriptor, handler, context, message);
          }),
        );
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
  }

  private invoke(
    descriptor: MessageDescriptor<IMessage>,
    handler: ClientMessageHandler<TContext, IMessage>,
    context: TContext,
    message: IMessage,
  ): void {
    if (this.disposed) return;
    try {
      const result = handler.handle(context, message);
      if (result && typeof result.then === "function") {
        void result.catch((error) => this.onError(descriptor, error));
      }
    } catch (error) {
      this.onError(descriptor, error);
    }
  }
}

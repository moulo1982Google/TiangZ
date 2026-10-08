import { rpcHandler as bindRpc } from "../../app/model/public";
import * as model from "../../app/model/public";

@bindRpc(null as never, null as never)
class AliasHandler {
  private count = 0;
}

@model.rpcHandler(null as never, null as never)
class NamespaceHandler {
  private count = 0;
}

void AliasHandler;
void NamespaceHandler;

function rpcHandler() { return (_target: Function): void => {}; }
@rpcHandler()
class UnrelatedDecoratorClass {
  private count = 0;
}
void UnrelatedDecoratorClass;

@model.entityExtensionHandler(null as never, { id: "org.tiangz.fixture.extension" })
class ExtensionHandler {
  private count = 0;
  constructor() {}
  static { }
  static method(): void {}
  static get value(): number { return 1; }
  Attach(): void {}
  get instanceValue(): number { return 1; }
}
void ExtensionHandler;

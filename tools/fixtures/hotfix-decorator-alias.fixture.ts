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

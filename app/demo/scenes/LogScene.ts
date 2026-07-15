import { rpc } from "../../core/protocol/rpc";
import { entryScene } from "../../core/process/registry";
import { EntryScene } from "../../core/process/types";
import {
  C2S_Log,
  L2L_LogWriteRequest,
  L2L_LogWriteResponse,
  S2C_Log,
} from "../../generated/model/server/demo/protocol/messages";
import {
  InnerLogProtocol,
  LogProtocol,
} from "../../generated/model/server/demo/protocol/rpcs";

@entryScene()
export class LogScene extends EntryScene {
  @rpc(LogProtocol.Log)
  private log(request: C2S_Log): S2C_Log {
    this.write(request.message);
    return {};
  }

  @rpc(InnerLogProtocol.Write)
  private writeInner(request: L2L_LogWriteRequest): L2L_LogWriteResponse {
    this.write(request.message);
    return {};
  }

  private write(message: string): void {
    console.log(`[${this.self.name}]`, message);
  }
}

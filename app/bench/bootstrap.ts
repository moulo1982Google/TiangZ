import { registerKnownMessages } from "../core/protocol/message";
import { registerKnownRpcs } from "../core/protocol/rpc";
import { AllMessageDescriptors } from "../generated/model/server/bench/protocol/messageDescriptors";
import { AllRpcDescriptors } from "../generated/model/server/bench/protocol/rpcs";
import "./handlers/C2M_StateSyncBenchHandler";
import "./scenes/BenchScene";
import "./scenes/MailboxParityScene";

registerKnownRpcs(AllRpcDescriptors);
registerKnownMessages(AllMessageDescriptors);

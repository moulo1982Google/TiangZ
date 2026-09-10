import { afterEach, expect, test, vi } from "vitest";
import { HostDbProxyRecords, CreateOutboxEvent, type DbProxyRecordCommit } from "../../app/core/persistence/HostDbProxyRecords";
import { HostStreamConsumer } from "../../app/core/persistence/HostStreamConsumer";

afterEach(() => vi.unstubAllGlobals());

function commit(): DbProxyRecordCommit {
  return { operationId:"unit-commit", writes:[{record:{namespace:"test",key:"one"},schema:"test",schemaVersion:1,expectedRevision:0n,payload:new Uint8Array([1]),updatedAtUnixMs:1n}],
    result:new Uint8Array(),appends:[],outboxEvents:[CreateOutboxEvent({eventId:"event-1",producer:"test",eventType:"changed",aggregateType:"record",aggregateId:"one",partitionKey:"one",
      schemaVersion:1,contentType:"application/json",payload:new Uint8Array([123,125]),occurredAtUnixMs:1n,routeVersion:1})] };
}
test("relay events fail closed on older Host without dropping effects", () => {
  const nativeCommit=vi.fn(); vi.stubGlobal("__hostDbProxy",{commitRecords:nativeCommit});
  expect(()=>new HostDbProxyRecords().CommitRecords(commit())).toThrow(/verified Outbox Relay/);
  expect(nativeCommit).not.toHaveBeenCalled();
});
test("record commit preserves effects and validates authoritative receipt", async () => {
  const nativeCommit=vi.fn(async()=>({disposition:"applied",records:[{namespace:"test",key:"one",newRevision:"1"}],result:[]}));
  vi.stubGlobal("__hostDbProxy",{supportsOutboxRelay:true,commitRecords:nativeCommit});
  const records=new HostDbProxyRecords(), request=commit();
  expect((await records.CommitRecords(request)).records[0].newRevision).toBe(1n);
  expect(nativeCommit.mock.calls[0]).toEqual([request]);
});
test("poll never ACKs and explicit ACK failure is visible to the domain", async () => {
  const ack=vi.fn(async()=>{throw new Error("ACK unavailable");});
  vi.stubGlobal("__hostEventStream",{configured:()=>true,poll:async()=>[{streamId:"1-0",event:"{}"}],ack});
  const stream=new HostStreamConsumer();expect(HostStreamConsumer.IsAvailable()).toBe(true);
  expect(await stream.Poll()).toEqual([{streamId:"1-0",event:"{}"}]);expect(ack).not.toHaveBeenCalled();
  await expect(stream.Ack("1-0")).rejects.toThrow("ACK unavailable");
});

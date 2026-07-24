import { Logger } from "../app/core/logging/Logger";

interface CapturedLog {
  level: number;
  target: string;
  category: string;
  message: string;
  attributes: string;
}

const captured: CapturedLog[] = [];
(globalThis as typeof globalThis & {
  __hostLog: (
    level: number,
    target: string,
    category: string,
    message: string,
    attributes: string,
  ) => void;
}).__hostLog = (level, target, category, message, attributes) => {
  captured.push({ level, target, category, message, attributes });
};
(globalThis as typeof globalThis & { __hostLogMinLevel: number }).__hostLogMinLevel = 3;

const logger = new Logger("scene:MapHost", {
  category: "business",
  process: "map1",
  scene: "map_1",
}).child({ actorId: 1001 });
logger.debug("this must not cross the host bridge", {
  expensive: { nested: true },
});
logger.error("use item failed", {
  rpcId: 17,
  itemId: 2001,
  error: new Error("insufficient item count"),
});

if (captured.length !== 1) throw new Error(`expected one log, got ${captured.length}`);
const event = captured[0];
if (event.level !== 4 || event.target !== "scene:MapHost") {
  throw new Error(`unexpected log routing: ${JSON.stringify(event)}`);
}
if (event.category !== "business" || event.message !== "use item failed") {
  throw new Error(`unexpected log metadata: ${JSON.stringify(event)}`);
}
const attributes = JSON.parse(event.attributes) as Record<string, unknown>;
if (
  attributes.process !== "map1"
  || attributes.scene !== "map_1"
  || attributes.actorId !== 1001
  || attributes.rpcId !== 17
  || attributes.itemId !== 2001
) {
  throw new Error(`bound log fields were lost: ${event.attributes}`);
}
const error = attributes.error as { message?: string; stack?: string };
if (error.message !== "insufficient item count" || !error.stack) {
  throw new Error(`error details were lost: ${event.attributes}`);
}

console.log("logger self-test passed");

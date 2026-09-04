/** Core内部传输信封的保留msgcode；业务protobuf不得占用。 / Reserved msgcodes for Core-internal transport envelopes; business protobuf must not use them. */
export const InternalFrameMsgCode = Object.freeze({
  Trace: 29_996,
  ActorLocationBatch: 29_997,
  ActorLocation: 29_999,
} as const);

/** ActorLocation单帧固定布局。 / Fixed layout of one ActorLocation envelope. */
export const ActorLocationEnvelopeLayout = Object.freeze({
  msgCodeOffset: 0,
  instanceIdOffset: 2,
  rpcIdOffset: 10,
  fenceTokenOffset: 14,
  headerBytes: 22,
} as const);

/** ActorLocation批量信封及条目固定布局。 / Fixed layouts of an ActorLocation batch and each entry. */
export const ActorLocationBatchEnvelopeLayout = Object.freeze({
  msgCodeOffset: 0,
  countOffset: 2,
  headerBytes: 6,
  entry: Object.freeze({
    instanceIdOffset: 0,
    fenceTokenOffset: 8,
    frameLengthOffset: 16,
    headerBytes: 20,
  }),
} as const);

/** Trace信封固定布局。 / Fixed layout of a Trace envelope. */
export const TraceEnvelopeLayout = Object.freeze({
  msgCodeOffset: 0,
  traceIdOffset: 2,
  spanIdOffset: 18,
  flagsOffset: 26,
  headerBytes: 27,
} as const);

const internalCodes = Object.values(InternalFrameMsgCode);
if (new Set(internalCodes).size !== internalCodes.length) {
  throw new Error("duplicate Core internal frame msgcode");
}

#nullable enable
using System;

namespace TiangZ.Client
{

public static class Frame
{
    public static byte[] Pack(ushort messageCode, byte[] payload)
    {
        var frame = new byte[payload.Length + 2];
        frame[0] = (byte)(messageCode >> 8);
        frame[1] = (byte)messageCode;
        Buffer.BlockCopy(payload, 0, frame, 2, payload.Length);
        return frame;
    }

    public static ushort ReadMessageCode(byte[] frame)
    {
        if (frame.Length < 2) throw new InvalidOperationException("TiangZ frame is shorter than msgcode");
        return (ushort)((frame[0] << 8) | frame[1]);
    }

    public static byte[] Payload(byte[] frame)
    {
        if (frame.Length < 2) throw new InvalidOperationException("TiangZ frame is shorter than msgcode");
        var payload = new byte[frame.Length - 2];
        Buffer.BlockCopy(frame, 2, payload, 0, payload.Length);
        return payload;
    }
}
}

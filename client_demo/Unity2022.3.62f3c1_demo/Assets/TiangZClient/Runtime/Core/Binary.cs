#nullable enable
using System;
using System.Collections.Generic;
using System.Text;

namespace TiangZ.Client
{

public readonly struct FieldTag
{
    public FieldTag(uint fieldNumber, byte wireType)
    {
        FieldNumber = fieldNumber;
        WireType = wireType;
    }

    public uint FieldNumber { get; }
    public byte WireType { get; }
}

/// <summary>
/// Minimal protobuf wire reader used by the generated Unity SDK.
/// 生成 SDK 使用的最小 protobuf Wire Reader；未知字段会由 Skip 安全跳过。
/// </summary>
public sealed class BinaryReader
{
    private readonly byte[] bytes;
    private int offset;

    public BinaryReader(byte[] bytes)
    {
        this.bytes = bytes ?? throw new ArgumentNullException(nameof(bytes));
    }

    public bool EndOfMessage => offset >= bytes.Length;

    public FieldTag ReadTag()
    {
        var raw = ReadVarint();
        var fieldNumber = checked((uint)(raw >> 3));
        if (fieldNumber == 0) throw new InvalidOperationException("protobuf field number cannot be zero");
        return new FieldTag(fieldNumber, (byte)(raw & 7));
    }

    public string ReadString() => Encoding.UTF8.GetString(ReadBytes());

    public byte[] ReadBytes()
    {
        var length = checked((int)ReadVarint());
        Require(length);
        var value = new byte[length];
        Buffer.BlockCopy(bytes, offset, value, 0, length);
        offset += length;
        return value;
    }

    public uint ReadUInt32() => checked((uint)ReadVarint());
    public int ReadInt32() => unchecked((int)ReadVarint());

    public int ReadSInt32()
    {
        var value = ReadUInt32();
        return unchecked((int)((value >> 1) ^ (uint)-(int)(value & 1)));
    }

    public ulong ReadUInt64() => ReadVarint();
    public long ReadInt64() => unchecked((long)ReadVarint());
    public bool ReadBool() => ReadVarint() != 0;

    public float ReadFloat() => BitConverter.Int32BitsToSingle(unchecked((int)ReadFixed(4)));
    public double ReadDouble() => BitConverter.Int64BitsToDouble(unchecked((long)ReadFixed(8)));

    public void Skip(byte wireType)
    {
        switch (wireType)
        {
            case 0:
                _ = ReadVarint();
                return;
            case 1:
                RequireAndAdvance(8);
                return;
            case 2:
                RequireAndAdvance(checked((int)ReadVarint()));
                return;
            case 5:
                RequireAndAdvance(4);
                return;
            default:
                throw new InvalidOperationException($"unsupported protobuf wire type: {wireType}");
        }
    }

    private ulong ReadVarint()
    {
        ulong value = 0;
        for (var index = 0; index < 10; index++)
        {
            Require(1);
            var current = bytes[offset++];
            if (index == 9 && current > 1) throw new InvalidOperationException("protobuf varint overflow");
            value |= (ulong)(current & 0x7f) << (index * 7);
            if ((current & 0x80) == 0) return value;
        }
        throw new InvalidOperationException("protobuf varint is too long");
    }

    private ulong ReadFixed(int length)
    {
        Require(length);
        ulong value = 0;
        for (var index = 0; index < length; index++) value |= (ulong)bytes[offset++] << (index * 8);
        return value;
    }

    private void Require(int length)
    {
        if (length < 0 || length > bytes.Length - offset) throw new InvalidOperationException("unexpected protobuf EOF");
    }

    private void RequireAndAdvance(int length)
    {
        Require(length);
        offset += length;
    }
}

/// <summary>
/// Allocating writer kept deliberately small; generated codecs write only non-default proto3 fields.
/// 轻量分配型 Writer；生成 Codec 默认只写非默认的 proto3 字段。
/// </summary>
public sealed class BinaryWriter
{
    private readonly List<byte> bytes = new();

    public void WriteString(uint fieldNumber, string? value, bool writeDefault = false)
    {
        if (!writeDefault && string.IsNullOrEmpty(value)) return;
        WriteBytes(fieldNumber, Encoding.UTF8.GetBytes(value ?? string.Empty), true);
    }

    public void WriteBytes(uint fieldNumber, byte[]? value, bool writeDefault = false)
    {
        if (value == null || (!writeDefault && value.Length == 0)) return;
        WriteTag(fieldNumber, 2);
        WriteVarint((ulong)value.Length);
        bytes.AddRange(value);
    }

    public void WriteUInt32(uint fieldNumber, uint value, bool writeDefault = false)
    {
        if (!writeDefault && value == 0) return;
        WriteTag(fieldNumber, 0);
        WriteVarint(value);
    }

    public void WriteInt32(uint fieldNumber, int value, bool writeDefault = false)
    {
        if (!writeDefault && value == 0) return;
        WriteTag(fieldNumber, 0);
        WriteVarint(unchecked((ulong)(long)value));
    }

    public void WriteSInt32(uint fieldNumber, int value, bool writeDefault = false)
    {
        if (!writeDefault && value == 0) return;
        WriteTag(fieldNumber, 0);
        WriteVarint((uint)((value << 1) ^ (value >> 31)));
    }

    public void WriteUInt64(uint fieldNumber, ulong value, bool writeDefault = false)
    {
        if (!writeDefault && value == 0) return;
        WriteTag(fieldNumber, 0);
        WriteVarint(value);
    }

    public void WriteInt64(uint fieldNumber, long value, bool writeDefault = false)
    {
        if (!writeDefault && value == 0) return;
        WriteTag(fieldNumber, 0);
        WriteVarint(unchecked((ulong)value));
    }

    public void WriteBool(uint fieldNumber, bool value, bool writeDefault = false)
    {
        if (!writeDefault && !value) return;
        WriteTag(fieldNumber, 0);
        WriteVarint(value ? 1UL : 0UL);
    }

    public void WriteFloat(uint fieldNumber, float value, bool writeDefault = false)
    {
        if (!writeDefault && value == 0) return;
        WriteTag(fieldNumber, 5);
        WriteFixed(unchecked((uint)BitConverter.SingleToInt32Bits(value)), 4);
    }

    public void WriteDouble(uint fieldNumber, double value, bool writeDefault = false)
    {
        if (!writeDefault && value == 0) return;
        WriteTag(fieldNumber, 1);
        WriteFixed(unchecked((ulong)BitConverter.DoubleToInt64Bits(value)), 8);
    }

    public void WriteMessage(uint fieldNumber, byte[]? payload)
    {
        if (payload == null) return;
        WriteBytes(fieldNumber, payload, true);
    }

    public byte[] ToArray() => bytes.ToArray();

    private void WriteTag(uint fieldNumber, byte wireType) => WriteVarint(((ulong)fieldNumber << 3) | wireType);

    private void WriteVarint(ulong value)
    {
        while (value >= 0x80)
        {
            bytes.Add((byte)((value & 0x7f) | 0x80));
            value >>= 7;
        }
        bytes.Add((byte)value);
    }

    private void WriteFixed(ulong value, int length)
    {
        for (var index = 0; index < length; index++) bytes.Add((byte)(value >> (index * 8)));
    }
}
}

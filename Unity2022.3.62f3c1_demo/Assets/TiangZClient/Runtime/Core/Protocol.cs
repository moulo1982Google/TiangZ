#nullable enable
using System;
using System.Threading;
using System.Threading.Tasks;

namespace TiangZ.Client
{

public interface IRpcRequest
{
    uint RpcId { get; set; }
}

public interface IRpcResponse
{
    uint RpcId { get; set; }
    uint Error { get; set; }
    string? Message { get; set; }
}

public sealed class MessageDescriptor<TMessage>
{
    public MessageDescriptor(string name, ushort messageCode, Func<TMessage, byte[]> encode, Func<byte[], TMessage> decode)
    {
        Name = name;
        MessageCode = messageCode;
        Encode = encode;
        Decode = decode;
    }

    public string Name { get; }
    public ushort MessageCode { get; }
    public Func<TMessage, byte[]> Encode { get; }
    public Func<byte[], TMessage> Decode { get; }
}

public sealed class RpcDescriptor<TRequest, TResponse>
    where TRequest : IRpcRequest
    where TResponse : IRpcResponse
{
    public RpcDescriptor(
        string name,
        ushort requestCode,
        ushort responseCode,
        Func<TRequest, byte[]> encodeRequest,
        Func<byte[], TResponse> decodeResponse,
        Action<TRequest, uint> setRpcId,
        Func<TResponse, uint> getRpcId,
        Func<TResponse, uint> getError,
        Func<TResponse, string?> getMessage)
    {
        Name = name;
        RequestCode = requestCode;
        ResponseCode = responseCode;
        EncodeRequest = encodeRequest;
        DecodeResponse = decodeResponse;
        SetRpcId = setRpcId;
        GetRpcId = getRpcId;
        GetError = getError;
        GetMessage = getMessage;
    }

    public string Name { get; }
    public ushort RequestCode { get; }
    public ushort ResponseCode { get; }
    public Func<TRequest, byte[]> EncodeRequest { get; }
    public Func<byte[], TResponse> DecodeResponse { get; }
    public Action<TRequest, uint> SetRpcId { get; }
    public Func<TResponse, uint> GetRpcId { get; }
    public Func<TResponse, uint> GetError { get; }
    public Func<TResponse, string?> GetMessage { get; }
}

public enum ClientConnectionState
{
    Idle,
    Connecting,
    Connected,
    Closed,
}

public readonly struct ClientEndpoint
{
    public ClientEndpoint(string host, ushort port, bool secure = false)
    {
        Host = host;
        Port = port;
        Secure = secure;
    }

    public string Host { get; }
    public ushort Port { get; }
    public bool Secure { get; }

    public Uri ToUri() => new Uri($"{(Secure ? "wss" : "ws")}://{Host}:{Port}");
}

public sealed class ClientRpcException : Exception
{
    public ClientRpcException(string message) : base(message) { }
}

public delegate Task<TResponse> RpcCall<TRequest, TResponse>(
    RpcDescriptor<TRequest, TResponse> descriptor,
    TRequest request,
    CancellationToken cancellationToken = default)
    where TRequest : IRpcRequest
    where TResponse : IRpcResponse;
}

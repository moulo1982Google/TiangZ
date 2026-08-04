#nullable enable
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Threading;
using System.Threading.Tasks;

namespace TiangZ.Client
{

/// <summary>
/// Unity-safe WebSocket RPC socket. Network callbacks only enqueue frames;
/// business handlers run when Unity calls Update from its main thread.
/// Unity 安全的 WebSocket RPC Socket。网络线程只入队，业务 Handler 由 Unity 主线程 Update 分发。
/// </summary>
public sealed class RpcSocket : IDisposable
{
    private sealed class PendingCall
    {
        public ushort ResponseCode;
        public Action<byte[]>? Resolve;
        public Action<Exception>? Reject;
        public CancellationTokenRegistration Cancellation;
    }

    private readonly ClientEndpoint endpoint;
    private readonly int maxQueuedMessages;
    private readonly int defaultTimeoutMs;
    private readonly ConcurrentQueue<byte[]> inbound = new();
    private readonly Dictionary<uint, PendingCall> pending = new();
    private readonly object pendingLock = new object();
    private readonly Dictionary<ushort, List<Action<byte[]>>> handlers = new();
    private readonly SemaphoreSlim sendLock = new(1, 1);
    private readonly CancellationTokenSource lifetime = new();
    private ClientWebSocket? socket;
    private Task? receiveTask;
    private uint nextRpcId = 1;
    private int queuedMessages;
    private int closed;
    private bool overflowed;

    public RpcSocket(ClientEndpoint endpoint, int maxQueuedMessages = 4096, int defaultTimeoutMs = 5000)
    {
        if (maxQueuedMessages <= 0) throw new ArgumentOutOfRangeException(nameof(maxQueuedMessages));
        if (defaultTimeoutMs <= 0) throw new ArgumentOutOfRangeException(nameof(defaultTimeoutMs));
        this.endpoint = endpoint;
        this.maxQueuedMessages = maxQueuedMessages;
        this.defaultTimeoutMs = defaultTimeoutMs;
    }

    public ClientConnectionState State { get; private set; } = ClientConnectionState.Idle;
    public int QueuedMessages => Math.Max(0, Volatile.Read(ref queuedMessages));
    public event Action<Exception?>? Closed;
    public event Action<Exception>? HandlerError;

    public async Task ConnectAsync(CancellationToken cancellationToken = default)
    {
        if (State == ClientConnectionState.Connected) return;
        if (State == ClientConnectionState.Closed || Volatile.Read(ref closed) != 0) throw new ClientRpcException("RPC socket is closed");
        State = ClientConnectionState.Connecting;
        socket = new ClientWebSocket();
        try
        {
            await socket.ConnectAsync(endpoint.ToUri(), cancellationToken).ConfigureAwait(false);
            State = ClientConnectionState.Connected;
            receiveTask = ReceiveLoopAsync(socket, lifetime.Token);
        }
        catch (Exception error)
        {
            State = ClientConnectionState.Closed;
            socket.Dispose();
            socket = null;
            throw new ClientRpcException($"无法连接 {endpoint.ToUri()}: {error.Message}");
        }
    }

    public async Task<TResponse> CallAsync<TRequest, TResponse>(
        RpcDescriptor<TRequest, TResponse> descriptor,
        TRequest request,
        CancellationToken cancellationToken = default)
        where TRequest : IRpcRequest
        where TResponse : IRpcResponse
    {
        EnsureConnected();
        var completion = new TaskCompletionSource<TResponse>(TaskCreationOptions.RunContinuationsAsynchronously);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(defaultTimeoutMs);
        var rpcId = 0u;
        var pendingCall = new PendingCall
        {
            ResponseCode = descriptor.ResponseCode,
            Resolve = payload =>
            {
                try
                {
                    var response = descriptor.DecodeResponse(payload);
                    if (descriptor.GetRpcId(response) != rpcId) throw new ClientRpcException($"{descriptor.Name} rpcId 不匹配");
                    if (descriptor.GetError(response) != 0) throw new ClientRpcException(descriptor.GetMessage(response) ?? descriptor.Name);
                    completion.TrySetResult(response);
                }
                catch (Exception error)
                {
                    completion.TrySetException(error);
                }
            },
            Reject = error => completion.TrySetException(error),
        };
        lock (pendingLock)
        {
            rpcId = AllocateRpcIdLocked();
            pending[rpcId] = pendingCall;
        }
        descriptor.SetRpcId(request, rpcId);
        pendingCall.Cancellation = timeout.Token.Register(() => CancelPending(rpcId, new TimeoutException($"{descriptor.Name} 超时")));
        try
        {
            await SendFrameAsync(Frame.Pack(descriptor.RequestCode, descriptor.EncodeRequest(request)), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception error)
        {
            if (TakePending(rpcId, out var removed))
            {
                removed.Cancellation.Dispose();
                removed.Reject?.Invoke(error);
            }
        }
        return await completion.Task.ConfigureAwait(false);
    }

    public async Task SendAsync<TMessage>(MessageDescriptor<TMessage> descriptor, TMessage message, CancellationToken cancellationToken = default)
    {
        EnsureConnected();
        await SendFrameAsync(Frame.Pack(descriptor.MessageCode, descriptor.Encode(message)), cancellationToken).ConfigureAwait(false);
    }

    public Action On<TMessage>(MessageDescriptor<TMessage> descriptor, Action<TMessage> handler)
    {
        if (!handlers.TryGetValue(descriptor.MessageCode, out var list))
        {
            list = new List<Action<byte[]>>();
            handlers.Add(descriptor.MessageCode, list);
        }
        Action<byte[]> wrapped = payload => handler(descriptor.Decode(payload));
        list.Add(wrapped);
        return () =>
        {
            if (handlers.TryGetValue(descriptor.MessageCode, out var current))
            {
                current.Remove(wrapped);
                if (current.Count == 0) handlers.Remove(descriptor.MessageCode);
            }
        };
    }

    public Task<TMessage> WaitForMessageAsync<TMessage>(MessageDescriptor<TMessage> descriptor, CancellationToken cancellationToken = default)
    {
        var completion = new TaskCompletionSource<TMessage>(TaskCreationOptions.RunContinuationsAsynchronously);
        Action? unsubscribe = null;
        unsubscribe = On(descriptor, message =>
        {
            unsubscribe?.Invoke();
            completion.TrySetResult(message);
        });
        cancellationToken.Register(() =>
        {
            unsubscribe?.Invoke();
            completion.TrySetCanceled(cancellationToken);
        });
        return completion.Task;
    }

    public int Update(int maxMessages = 256)
    {
        if (maxMessages <= 0) throw new ArgumentOutOfRangeException(nameof(maxMessages));
        if (overflowed)
        {
            overflowed = false;
            Close(new ClientRpcException("客户端入站队列已满"));
            return 0;
        }
        var handled = 0;
        while (handled < maxMessages && inbound.TryDequeue(out var frame))
        {
            Interlocked.Decrement(ref queuedMessages);
            handled++;
            HandleFrame(frame);
        }
        return handled;
    }

    public void Close(Exception? reason = null)
    {
        if (Interlocked.Exchange(ref closed, 1) != 0) return;
        State = ClientConnectionState.Closed;
        lifetime.Cancel();
        socket?.Abort();
        socket?.Dispose();
        socket = null;
        PendingCall[] calls;
        lock (pendingLock)
        {
            calls = new PendingCall[pending.Count];
            pending.Values.CopyTo(calls, 0);
            pending.Clear();
        }
        foreach (var item in calls)
        {
            item.Cancellation.Dispose();
            item.Reject?.Invoke(reason ?? new ClientRpcException("RPC socket closed"));
        }
        while (inbound.TryDequeue(out _)) Interlocked.Decrement(ref queuedMessages);
        Closed?.Invoke(reason);
    }

    public void Dispose() => Close();

    private async Task SendFrameAsync(byte[] frame, CancellationToken cancellationToken)
    {
        var current = socket ?? throw new ClientRpcException("RPC socket is not connected");
        await sendLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await current.SendAsync(new ArraySegment<byte>(frame), WebSocketMessageType.Binary, true, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            sendLock.Release();
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket current, CancellationToken cancellationToken)
    {
        var buffer = new byte[16 * 1024];
        try
        {
            while (!cancellationToken.IsCancellationRequested && current.State == WebSocketState.Open)
            {
                using var message = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await current.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken).ConfigureAwait(false);
                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        Close(new ClientRpcException("服务器关闭了 WebSocket"));
                        return;
                    }
                    message.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                if (message.Length > int.MaxValue) throw new ClientRpcException("WebSocket 消息过大");
                if (Interlocked.Increment(ref queuedMessages) > maxQueuedMessages)
                {
                    overflowed = true;
                    Interlocked.Decrement(ref queuedMessages);
                    return;
                }
                inbound.Enqueue(message.ToArray());
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception error)
        {
            Close(error);
        }
    }

    private void HandleFrame(byte[] frame)
    {
        try
        {
            var messageCode = Frame.ReadMessageCode(frame);
            var payload = Frame.Payload(frame);
            var rpcId = ExtractRpcId(payload);
            if (rpcId.HasValue && TakePending(rpcId.Value, out var call))
            {
                call.Cancellation.Dispose();
                if (call.ResponseCode != messageCode) call.Reject?.Invoke(new ClientRpcException("RPC响应消息码不匹配"));
                else call.Resolve?.Invoke(payload);
                return;
            }
            if (!handlers.TryGetValue(messageCode, out var list)) return;
            foreach (var handler in list.ToArray()) handler(payload);
        }
        catch (Exception error)
        {
            HandlerError?.Invoke(error);
        }
    }

    private static uint? ExtractRpcId(byte[] payload)
    {
        try
        {
            var reader = new BinaryReader(payload);
            while (!reader.EndOfMessage)
            {
                var tag = reader.ReadTag();
                if (tag.FieldNumber == 90 && tag.WireType == 0) return reader.ReadUInt32();
                reader.Skip(tag.WireType);
            }
        }
        catch { }
        return null;
    }

    private void CancelPending(uint rpcId, Exception error)
    {
        if (TakePending(rpcId, out var call)) call.Reject?.Invoke(error);
    }

    private bool TakePending(uint rpcId, out PendingCall call)
    {
        lock (pendingLock)
        {
            if (pending.TryGetValue(rpcId, out call!))
            {
                pending.Remove(rpcId);
                return true;
            }
        }
        call = null!;
        return false;
    }

    private uint AllocateRpcIdLocked()
    {
        for (var attempt = 0UL; attempt < uint.MaxValue; attempt++)
        {
            var value = nextRpcId++;
            if (nextRpcId == 0) nextRpcId = 1;
            if (!pending.ContainsKey(value)) return value;
        }
        throw new ClientRpcException("没有可用的 RPC id");
    }

    private void EnsureConnected()
    {
        if (State != ClientConnectionState.Connected || socket == null) throw new ClientRpcException("RPC socket 尚未连接");
    }
}
}

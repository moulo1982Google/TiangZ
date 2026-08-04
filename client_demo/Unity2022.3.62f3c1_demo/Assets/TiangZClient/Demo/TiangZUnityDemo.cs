using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using TiangZ.Client;
using TiangZ.Client.Demo;
using TiangZ.Client.Generated.Demo;
using UnityEngine;

/// <summary>
/// Unity 3D gray-box client for the TiangZ SDK.
/// TiangZ SDK 的 Unity 3D 灰盒客户端：只负责场景、输入、相机和表现。
/// </summary>
public sealed class TiangZUnityDemo : MonoBehaviour
{
    [Header("TiangZ LoginMgr / TiangZ LoginMgr 配置")]
    [SerializeField] private string loginMgrHost = "127.0.0.1";
    [SerializeField] private ushort loginMgrPort = 7000;
    [SerializeField] private string account = "unity-demo";
    [SerializeField] private uint mapId = 100;
    [SerializeField] private bool autoConnect = true;
    [SerializeField] private float turnSpeedDegreesPerSecond = 180f;
    [SerializeField] private float cameraOrbitDegreesPerMouseUnit = 3f;
    [SerializeField] private float cameraMinDistance = 6f;
    [SerializeField] private float cameraMaxDistance = 24f;

    private readonly Dictionary<uint, Transform> entities = new Dictionary<uint, Transform>();
    private readonly Dictionary<uint, Vector3> targetPositions = new Dictionary<uint, Vector3>();
    private readonly Dictionary<uint, float> targetYaw = new Dictionary<uint, float>();
    private LoginFlow loginFlow;
    private EnterGameResult game;
    private Transform localPlayer;
    private Camera mainCamera;
    private GameObject ground;
    private GameObject middleObstacle;
    private GameObject dynamicDoor;
    private Action unsubscribeNavigate;
    private Action unsubscribeAoi;
    private Action unsubscribeDoor;
    private string status = "未连接 / Disconnected";
    private string lastError = "";
    private int sequence;
    private float nextInputAt;
    private float nextPingAt;
    private bool inputInFlight;
    private int lastForward;
    private int lastStrafe;
    private int lastTurn;
    private uint lastSentInputSequence;
    private uint lastAcknowledgedInputSequence;
    private uint pathNavigationSequence;
    private bool pathNavigationActive;
    private float playerYaw;
    private float cameraPitchDegrees = 38f;
    private float cameraDistance = 12f;
    private float lastSentYaw;
    private bool doorClosed;
    private bool doorRequestInFlight;

    private void Start()
    {
        BuildGrayBox();
        if (autoConnect) _ = ConnectAsync();
    }

    private void Update()
    {
        if (loginFlow != null) loginFlow.Update(256);
        if (game == null) return;

        UpdateInput();
        UpdateEntityPresentation();
        UpdateCamera();
        UpdateDoorInput();
        UpdatePing();
        UpdateClickNavigation();
    }

    private async Task ConnectAsync()
    {
        try
        {
            status = "连接 LoginMgr... / Connecting LoginMgr...";
            loginFlow = new LoginFlow(new ClientEndpoint(loginMgrHost, loginMgrPort));
            game = await loginFlow.EnterGameAsync(account, mapId, CancellationToken.None);
            AttachHandlers();

            foreach (var entity in game.EnterMap.Entities) ApplySnapshot(entity);
            EnsureEntity(game.EnterMap.UnitId, true).position = new Vector3(game.EnterMap.X, game.EnterMap.Y, game.EnterMap.Z);
            localPlayer = entities[game.EnterMap.UnitId];

            // 先注册 Push Handler，再确认初始视野可以发送。
            // Register Push handlers before asking Gate for the initial snapshot.
            var snapshotReady = await game.Gate.MapSnapshotReadyAsync(
                new C2G_MapSnapshotReady { UnitId = game.EnterMap.UnitId },
                CancellationToken.None);
            ApplyDoorState(snapshotReady.DemoDoorClosed);
            status = $"已进入 Map {game.EnterMap.MapId} / Connected, Unit {game.EnterMap.UnitId}";
            nextPingAt = Time.time;
        }
        catch (Exception error)
        {
            lastError = error.Message;
            status = "连接失败 / Connection failed";
            Debug.LogException(error);
        }
    }

    private void AttachHandlers()
    {
        unsubscribeNavigate = game.GateSocket.On(ClientMessages.EntityNavigate, HandleEntityNavigate);
        unsubscribeAoi = game.GateSocket.On(ClientMessages.AoiDelta, HandleAoiDelta);
        unsubscribeDoor = game.GateSocket.On(ClientMessages.DemoDoorState, message =>
        {
            ApplyDoorState(message.Closed);
            status = message.Closed ? "动态门：关闭 / Door: Closed" : "动态门：打开 / Door: Open";
        });
    }

    private void HandleEntityNavigate(G2C_EntityNavigate message)
    {
        foreach (var movement in message.Movements)
        {
            var entity = EnsureEntity(movement.UnitId, movement.UnitId == game.EnterMap.UnitId);
            targetPositions[movement.UnitId] = new Vector3(movement.X, movement.Y, movement.Z);
            targetYaw[movement.UnitId] = movement.Yaw;
            if (movement.UnitId == game.EnterMap.UnitId)
            {
                localPlayer = entity;
                var isPathMovement = pathNavigationActive &&
                    movement.AcknowledgedSequence == pathNavigationSequence;
                var isNewDirectionalAcknowledgement = !pathNavigationActive &&
                    movement.AcknowledgedSequence > lastAcknowledgedInputSequence &&
                    movement.AcknowledgedSequence >= lastSentInputSequence;
                // 寻路的一整条路径共用一个序号，但每个Tick都可能产生新的朝向。
                // Directional input still only accepts newer acknowledgements so stale packets cannot rewind local turning.
                if (isPathMovement || isNewDirectionalAcknowledgement)
                {
                    lastAcknowledgedInputSequence = movement.AcknowledgedSequence;
                    playerYaw = movement.Yaw;
                    lastSentYaw = movement.Yaw;
                    localPlayer.rotation = Quaternion.Euler(0, playerYaw * Mathf.Rad2Deg, 0);
                }
            }
        }
    }

    private void HandleAoiDelta(G2C_AoiDelta message)
    {
        foreach (var entity in message.Enters) ApplySnapshot(entity);
        foreach (var unitId in message.Leaves)
        {
            if (game != null && unitId == game.EnterMap.UnitId) continue;
            if (entities.TryGetValue(unitId, out var entity))
            {
                Destroy(entity.gameObject);
                entities.Remove(unitId);
                targetPositions.Remove(unitId);
                targetYaw.Remove(unitId);
            }
        }
    }

    private void ApplySnapshot(MapEntitySnapshot snapshot)
    {
        var entity = EnsureEntity(snapshot.UnitId, game != null && snapshot.UnitId == game.EnterMap.UnitId);
        var position = new Vector3(snapshot.X, snapshot.Y, snapshot.Z);
        entity.position = position;
        entity.rotation = Quaternion.Euler(0, snapshot.Yaw * Mathf.Rad2Deg, 0);
        targetPositions[snapshot.UnitId] = position;
        targetYaw[snapshot.UnitId] = snapshot.Yaw;
        if (game != null && snapshot.UnitId == game.EnterMap.UnitId)
        {
            playerYaw = snapshot.Yaw;
            lastSentYaw = snapshot.Yaw;
        }
    }

    private Transform EnsureEntity(uint unitId, bool isLocal)
    {
        if (entities.TryGetValue(unitId, out var existing)) return existing;
        var value = GameObject.CreatePrimitive(PrimitiveType.Cube);
        value.name = isLocal ? $"LocalPlayer_{unitId}" : $"RemoteUnit_{unitId}";
        // 使用沿本地前方（+Z）拉长的四棱柱，让玩家朝向在镜头中清晰可见。
        // Use a cuboid elongated along local forward (+Z), so facing changes are obvious.
        value.transform.localScale = isLocal
            ? new Vector3(1.2f, 1.8f, 2.4f)
            : new Vector3(1f, 1.2f, 1.6f);
        value.GetComponent<Renderer>().material.color = isLocal ? new Color(0.15f, 0.75f, 1f) : new Color(1f, 0.55f, 0.2f);
        entities.Add(unitId, value.transform);
        return value.transform;
    }

    private void UpdateEntityPresentation()
    {
        foreach (var pair in entities)
        {
            if (!targetPositions.TryGetValue(pair.Key, out var target)) continue;
            var transform = pair.Value;
            transform.position = Vector3.Lerp(transform.position, target, 1f - Mathf.Exp(-12f * Time.deltaTime));
            if (game != null && pair.Key == game.EnterMap.UnitId)
            {
                // 本地朝向由输入立即驱动；服务端只通过 HandleEntityNavigate 做权威纠正。
                // The local facing is input-driven immediately; authoritative corrections arrive through HandleEntityNavigate.
                continue;
            }
            if (targetYaw.TryGetValue(pair.Key, out var yaw))
            {
                var targetRotation = Quaternion.Euler(0, yaw * Mathf.Rad2Deg, 0);
                transform.rotation = Quaternion.Slerp(transform.rotation, targetRotation, 1f - Mathf.Exp(-12f * Time.deltaTime));
            }
        }
    }

    private void UpdateInput()
    {
        if (localPlayer == null) return;
        var forward = ReadDigitalAxis(KeyCode.W, KeyCode.S);
        var horizontal = ReadDigitalAxis(KeyCode.D, KeyCode.A);
        var rightMouseHeld = Input.GetMouseButton(1);
        var mouseX = rightMouseHeld ? Input.GetAxisRaw("Mouse X") : 0f;
        var turn = rightMouseHeld ? 0 : horizontal;
        // Rust协议正 strafe 表示角色右侧；后端必须使用与当前源码一致的新构建。
        // Positive Rust strafe means the unit's right side; the backend must be rebuilt from the current source.
        var strafe = rightMouseHeld ? horizontal : 0;
        if (Mathf.Abs(mouseX) > 0.0001f)
        {
            // 右键拖动同时改变角色朝向和镜头方向，避免只转镜头而角色仍朝原方向。
            // Right-drag changes both character facing and camera direction instead of only orbiting the camera.
            playerYaw = NormalizeRadians(
                playerYaw + mouseX * cameraOrbitDegreesPerMouseUnit * Mathf.Deg2Rad);
            localPlayer.rotation = Quaternion.Euler(0, playerYaw * Mathf.Rad2Deg, 0);
        }
        if (turn != 0)
        {
            playerYaw = NormalizeRadians(
                playerYaw + turn * turnSpeedDegreesPerSecond * Mathf.Deg2Rad * Time.deltaTime);
            localPlayer.rotation = Quaternion.Euler(0, playerYaw * Mathf.Rad2Deg, 0);
        }

        var changed = forward != lastForward || strafe != lastStrafe || turn != lastTurn;
        var yawChanged = Mathf.Abs(Mathf.DeltaAngle(
            lastSentYaw * Mathf.Rad2Deg,
            playerYaw * Mathf.Rad2Deg)) > 0.01f;
        var continuing = forward != 0 || strafe != 0 || turn != 0;
        var refreshReady = continuing && Time.time >= nextInputAt;
        if ((!changed && !yawChanged && !refreshReady) || inputInFlight) return;
        lastForward = forward;
        lastStrafe = strafe;
        lastTurn = turn;
        nextInputAt = Time.time + 0.1f;
        inputInFlight = true;
        _ = SendNavigateInputAsync(forward, strafe, playerYaw);
    }

    private async Task SendNavigateInputAsync(int forward, int strafe, float yaw)
    {
        try
        {
            var requestSequence = unchecked((uint)++sequence);
            lastSentInputSequence = requestSequence;
            pathNavigationActive = false;
            await game.Map.NavigateInputAsync(new C2M_NavigateInput
            {
                Forward = forward,
                Strafe = strafe,
                Yaw = yaw,
                Sequence = requestSequence,
            }, CancellationToken.None);
            lastSentYaw = yaw;
        }
        catch (Exception error)
        {
            lastError = error.Message;
        }
        finally
        {
            inputInFlight = false;
        }
    }

    private void UpdateDoorInput()
    {
        if (Input.GetKeyDown(KeyCode.E)) _ = ToggleDemoDoorAsync();
    }

    private async Task ToggleDemoDoorAsync()
    {
        if (game == null || doorRequestInFlight) return;
        doorRequestInFlight = true;
        try
        {
            var response = await game.Map.ToggleDemoDoorAsync(
                new C2M_ToggleDemoDoor { Closed = !doorClosed },
                CancellationToken.None);
            ApplyDoorState(response.Closed);
            status = response.Closed
                ? "动态门：关闭 / Door: Closed"
                : "动态门：打开 / Door: Open";
        }
        catch (Exception error)
        {
            lastError = error.Message;
        }
        finally
        {
            doorRequestInFlight = false;
        }
    }

    private void ApplyDoorState(bool closed)
    {
        doorClosed = closed;
        if (dynamicDoor != null) dynamicDoor.SetActive(closed);
    }

    private void UpdateClickNavigation()
    {
        if (!Input.GetMouseButtonDown(0) || mainCamera == null) return;
        var ray = mainCamera.ScreenPointToRay(Input.mousePosition);
        if (!Physics.Raycast(ray, out var hit, 500f) || hit.collider.gameObject != ground) return;
        _ = SendNavigateToAsync(hit.point);
    }

    private async Task SendNavigateToAsync(Vector3 target)
    {
        try
        {
            var requestSequence = unchecked((uint)++sequence);
            lastSentInputSequence = requestSequence;
            pathNavigationSequence = requestSequence;
            pathNavigationActive = true;
            await game.Map.NavigateToAsync(new C2M_NavigateTo
            {
                TargetX = target.x,
                TargetY = target.y,
                TargetZ = target.z,
                Sequence = requestSequence,
            }, CancellationToken.None);
            status = $"寻路目标：{target.x:0.0}, {target.y:0.0}, {target.z:0.0}";
        }
        catch (Exception error)
        {
            lastError = error.Message;
        }
    }

    private void UpdatePing()
    {
        if (Time.time < nextPingAt) return;
        nextPingAt = Time.time + 5f;
        _ = PingAsync();
    }

    private async Task PingAsync()
    {
        try
        {
            var sentAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var response = await game.Gate.PingAsync(new C2G_Ping(), CancellationToken.None);
            var receivedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            status = $"Map {game.EnterMap.MapId}  Ping {receivedAt - sentAt}ms  Server {response.ServerTime}";
        }
        catch (Exception error)
        {
            lastError = error.Message;
        }
    }

    private void BuildGrayBox()
    {
        ground = GameObject.CreatePrimitive(PrimitiveType.Plane);
        ground.name = "TiangZ_GrayBox_Ground";
        ground.transform.localScale = new Vector3(10, 1, 10);
        ground.GetComponent<Renderer>().material.color = new Color(0.18f, 0.24f, 0.28f);
        middleObstacle = CreateBox(
            "TiangZ_MiddleObstacle",
            new Vector3(0f, 1.5f, 0f),
            new Vector3(6f, 3f, 10f),
            new Color(0.48f, 0.38f, 0.28f));
        dynamicDoor = CreateBox(
            "TiangZ_DynamicDoor",
            new Vector3(-12f, 1.5f, 0f),
            new Vector3(8f, 3f, 2f),
            new Color(0.78f, 0.22f, 0.18f));
        dynamicDoor.SetActive(false);
        mainCamera = Camera.main;
        if (mainCamera == null)
        {
            var cameraObject = new GameObject("Main Camera");
            mainCamera = cameraObject.AddComponent<Camera>();
            cameraObject.tag = "MainCamera";
        }
        mainCamera.transform.position = new Vector3(0, 12, -14);
        mainCamera.transform.rotation = Quaternion.Euler(38, 0, 0);
    }

    private static GameObject CreateBox(string name, Vector3 position, Vector3 scale, Color color)
    {
        var value = GameObject.CreatePrimitive(PrimitiveType.Cube);
        value.name = name;
        value.transform.position = position;
        value.transform.localScale = scale;
        value.GetComponent<Renderer>().material.color = color;
        return value;
    }

    private void UpdateCamera()
    {
        if (localPlayer == null || mainCamera == null) return;
        if (Input.GetMouseButton(1))
        {
            cameraPitchDegrees = Mathf.Clamp(
                cameraPitchDegrees - Input.GetAxisRaw("Mouse Y") * cameraOrbitDegreesPerMouseUnit,
                20f,
                70f);
        }

        var scroll = Input.mouseScrollDelta.y;
        if (Mathf.Abs(scroll) > 0.001f)
        {
            cameraDistance = Mathf.Clamp(cameraDistance - scroll * 2f, cameraMinDistance, cameraMaxDistance);
        }

        var pivot = localPlayer.position + Vector3.up;
        var cameraRotation = Quaternion.Euler(
            cameraPitchDegrees,
            playerYaw * Mathf.Rad2Deg,
            0f);
        var wanted = pivot + cameraRotation * (Vector3.back * cameraDistance);
        mainCamera.transform.position = Vector3.Lerp(
            mainCamera.transform.position,
            wanted,
            1f - Mathf.Exp(-8f * Time.deltaTime));
        mainCamera.transform.LookAt(pivot);
    }

    private static int ReadDigitalAxis(KeyCode positive, KeyCode negative)
    {
        var value = 0;
        if (Input.GetKey(positive)) value += 1;
        if (Input.GetKey(negative)) value -= 1;
        return value;
    }

    private void OnGUI()
    {
        GUILayout.BeginArea(new Rect(16, 16, 560, 180), GUI.skin.box);
        GUILayout.Label("TiangZ Unity 3D Demo / Unity 3D 示例");
        GUILayout.Label(status);
        GUILayout.Label("W/S：前进后退    A/D：转向");
        GUILayout.Label("按住鼠标右键：拖动镜头并带动角色朝向；A/D横移    滚轮：缩放");
        GUILayout.Label("鼠标左键：服务器寻路    E：开关门    F5：重连");
        if (!string.IsNullOrEmpty(lastError)) GUILayout.Label($"Error: {lastError}");
        GUILayout.EndArea();
        if (Event.current.type == EventType.KeyDown && Event.current.keyCode == KeyCode.F5)
        {
            Event.current.Use();
            loginFlow?.Close();
            game = null;
            _ = ConnectAsync();
        }
    }

    private void OnDestroy()
    {
        unsubscribeNavigate?.Invoke();
        unsubscribeAoi?.Invoke();
        unsubscribeDoor?.Invoke();
        loginFlow?.Close();
    }

    private static float NormalizeRadians(float value)
    {
        return Mathf.Repeat(value + Mathf.PI, Mathf.PI * 2f) - Mathf.PI;
    }
}

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
    private readonly Dictionary<uint, uint> entityTypes = new Dictionary<uint, uint>();
    private readonly Dictionary<uint, uint> entityConfigIds = new Dictionary<uint, uint>();
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
    private Action unsubscribeNumeric;
    private Action unsubscribeAutoAttack;
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
    private uint selectedMonsterUnitId;
    private bool autoAttackEnabled;
    private uint autoAttackTargetUnitId;
    private uint autoAttackPhase;
    private long autoAttackSwingStartAtMs;
    private uint autoAttackSwingIntervalMs = 2000;
    private long serverClockOffsetMs;
    private bool autoAttackRequestInFlight;
    private GameObject selectedMonsterMarker;
    private long currentHp;
    private long maxHp;
    private long currentMp;
    private long maxMp;

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
        unsubscribeNumeric = game.GateSocket.On(ClientMessages.EntityNumeric, HandleNumeric);
        unsubscribeAutoAttack = game.GateSocket.On(ClientMessages.AutoAttackState, HandleAutoAttackState);
    }

    /// <summary>
    /// Applies server-authoritative local HP/MP deltas to the presentation HUD.
    /// 将服务端权威的玩家HP/MP增量应用到表现层HUD；客户端不自行扣血或恢复资源。
    /// </summary>
    private void HandleNumeric(G2C_EntityNumeric message)
    {
        if (game == null) return;
        foreach (var numeric in message.Numerics)
        {
            if (numeric.UnitId != game.EnterMap.UnitId) continue;
            ApplyLocalNumeric(numeric.NumericType, numeric.Value);
        }
    }

    /// <summary>
    /// Stores one local Numeric value from either the entry snapshot or a delta push.
    /// 保存进入快照或增量推送中的一个本地Numeric值，保证重连后HUD从完整快照重新开始。
    /// </summary>
    private void ApplyLocalNumeric(uint numericType, long value)
    {
        switch (numericType)
        {
            case 1:
                currentHp = value;
                break;
            case 2:
                currentMp = value;
                break;
            case 1000:
                maxHp = value;
                break;
            case 1001:
                maxMp = value;
                break;
        }
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
                if (unitId == selectedMonsterUnitId) ClearMonsterSelection();
                Destroy(entity.gameObject);
                entities.Remove(unitId);
                targetPositions.Remove(unitId);
                targetYaw.Remove(unitId);
                entityTypes.Remove(unitId);
                entityConfigIds.Remove(unitId);
            }
        }
    }

    private void ApplySnapshot(MapEntitySnapshot snapshot)
    {
        var entity = EnsureEntity(snapshot.UnitId, game != null && snapshot.UnitId == game.EnterMap.UnitId);
        entityTypes[snapshot.UnitId] = snapshot.EntityType;
        entityConfigIds[snapshot.UnitId] = snapshot.ConfigId;
        ApplyEntityColor(snapshot.UnitId, entity, snapshot.EntityType, snapshot.ConfigId);
        var position = new Vector3(snapshot.X, snapshot.Y, snapshot.Z);
        entity.position = position;
        entity.rotation = Quaternion.Euler(0, snapshot.Yaw * Mathf.Rad2Deg, 0);
        targetPositions[snapshot.UnitId] = position;
        targetYaw[snapshot.UnitId] = snapshot.Yaw;
        if (game != null && snapshot.UnitId == game.EnterMap.UnitId)
        {
            foreach (var numeric in snapshot.Numerics)
            {
                ApplyLocalNumeric(numeric.NumericType, numeric.Value);
            }
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
        UpdateAutoAttackInput();
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
        if (!Physics.Raycast(ray, out var hit, 500f)) return;
        var monsterUnitId = FindMonsterUnitId(hit.transform);
        if (monsterUnitId != 0)
        {
            SelectMonster(monsterUnitId);
            return;
        }
        if (hit.collider.gameObject != ground) return;
        _ = SendNavigateToAsync(hit.point);
    }

    /// <summary>
    /// Finds a monster from the clicked presentation object; a monster hit is consumed and never falls through to navigation.
    /// 根据点击到的表现物体查找怪物；命中怪物后消费本次点击，不继续触发寻路。
    /// </summary>
    private uint FindMonsterUnitId(Transform hitTransform)
    {
        foreach (var pair in entities)
        {
            if (entityTypes.TryGetValue(pair.Key, out var entityType) && entityType == 2 &&
                pair.Value == hitTransform)
            {
                return pair.Key;
            }
        }
        return 0;
    }

    /// <summary>
    /// Selects one visible monster and creates an independent foot marker.
    /// 选中一个当前可见怪物，并创建独立的脚下标记；不修改怪物颜色、大小或服务端战斗状态。
    /// </summary>
    private void SelectMonster(uint unitId)
    {
        if (selectedMonsterUnitId == unitId) return;
        ClearMonsterSelection();
        if (!entities.TryGetValue(unitId, out var entity) ||
            !entityTypes.TryGetValue(unitId, out var entityType) || entityType != 2)
        {
            return;
        }
        selectedMonsterUnitId = unitId;
        CreateSelectedMonsterMarker(entity);
        ApplyEntityColor(unitId, entity, entityTypes[unitId], entityConfigIds.GetValueOrDefault(unitId));
    }

    /// <summary>
    /// Removes the independent marker when the target leaves AOI or a new target is selected.
    /// 目标离开AOI或切换目标时移除独立标记，不触碰怪物本体表现。
    /// </summary>
    private void ClearMonsterSelection()
    {
        if (selectedMonsterUnitId != 0 && entities.TryGetValue(selectedMonsterUnitId, out var entity))
        {
            ApplyEntityColor(
                selectedMonsterUnitId,
                entity,
                entityTypes.GetValueOrDefault(selectedMonsterUnitId),
                entityConfigIds.GetValueOrDefault(selectedMonsterUnitId));
        }
        if (selectedMonsterMarker != null) Destroy(selectedMonsterMarker);
        selectedMonsterMarker = null;
        selectedMonsterUnitId = 0;
    }

    private void ApplyEntityColor(uint unitId, Transform entity, uint entityType, uint configId)
    {
        var renderer = entity.GetComponent<Renderer>();
        if (renderer == null) return;
        var isLocal = game != null && unitId == game.EnterMap.UnitId;
        renderer.material.color = isLocal
                ? new Color(0.15f, 0.75f, 1f)
                : entityType == 2
                    ? (configId == 2 ? new Color(0.95f, 0.25f, 0.2f) : new Color(1f, 0.82f, 0.2f))
                    : new Color(0.3f, 0.85f, 0.5f);
    }

    /// <summary>
    /// Creates a lightweight ring under the selected monster instead of changing its model scale.
    /// 在选中怪物脚下创建轻量环形线框，不改变怪物模型大小；标记跟随怪物Transform移动。
    /// </summary>
    private void CreateSelectedMonsterMarker(Transform target)
    {
        if (selectedMonsterMarker != null) Destroy(selectedMonsterMarker);
        selectedMonsterMarker = new GameObject("SelectedMonsterMarker");
        selectedMonsterMarker.transform.SetParent(target, false);
        selectedMonsterMarker.transform.localPosition = new Vector3(0f, -0.61f, 0f);
        var line = selectedMonsterMarker.AddComponent<LineRenderer>();
        line.useWorldSpace = false;
        line.loop = true;
        line.positionCount = 32;
        line.widthMultiplier = 0.05f;
        line.numCapVertices = 2;
        line.startColor = new Color(0.1f, 0.95f, 1f, 0.95f);
        line.endColor = line.startColor;
        line.material = new Material(Shader.Find("Sprites/Default"));
        const float radius = 0.72f;
        for (var index = 0; index < line.positionCount; index++)
        {
            var angle = index * Mathf.PI * 2f / line.positionCount;
            line.SetPosition(index, new Vector3(Mathf.Cos(angle) * radius, 0f, Mathf.Sin(angle) * radius));
        }
    }

    /// <summary>
    /// Applies the server-pushed auto-attack state to the local HUD.
    /// 将服务端推送的平A状态保存到本地HUD；读条时间使用服务器时钟，避免客户端时钟偏差造成进度跳动。
    /// </summary>
    private void HandleAutoAttackState(G2C_AutoAttackState message)
    {
        autoAttackEnabled = message.Enabled;
        autoAttackTargetUnitId = message.TargetUnitId;
        autoAttackPhase = message.Phase;
        autoAttackSwingStartAtMs = checked((long)message.SwingStartAtMs);
        autoAttackSwingIntervalMs = message.SwingIntervalMs == 0 ? 2000u : message.SwingIntervalMs;
    }

    private void UpdateAutoAttackInput()
    {
        if (!Input.GetKeyDown(KeyCode.Alpha1) || autoAttackRequestInFlight || game == null) return;
        var targetUnitId = selectedMonsterUnitId != 0 ? selectedMonsterUnitId : FindFirstMonsterUnitId();
        var enabled = !autoAttackEnabled;
        if (enabled && targetUnitId == 0)
        {
            status = "请先选择一个可见怪物 / Select a visible monster first";
            return;
        }
        _ = ToggleAutoAttackAsync(enabled, targetUnitId);
    }

    private uint FindFirstMonsterUnitId()
    {
        foreach (var pair in entityTypes)
        {
            if (pair.Value == 2 && entities.ContainsKey(pair.Key)) return pair.Key;
        }
        return 0;
    }

    private async Task ToggleAutoAttackAsync(bool enabled, uint targetUnitId)
    {
        autoAttackRequestInFlight = true;
        try
        {
            var response = await game.Map.ToggleAutoAttackAsync(
                new C2M_ToggleAutoAttack { Enabled = enabled, TargetUnitId = targetUnitId },
                CancellationToken.None);
            HandleAutoAttackState(new G2C_AutoAttackState
            {
                Enabled = response.Enabled,
                TargetUnitId = response.TargetUnitId,
                Phase = response.Phase,
                SwingStartAtMs = response.SwingStartAtMs,
                SwingIntervalMs = response.SwingIntervalMs,
            });
        }
        catch (Exception error)
        {
            lastError = error.Message;
        }
        finally
        {
            autoAttackRequestInFlight = false;
        }
    }

    private string AutoAttackProgressText()
    {
        if (!autoAttackEnabled) return "平A：未激活（按 1 开始） / Auto attack: off (press 1)";
        if (autoAttackSwingStartAtMs <= 0 || autoAttackSwingIntervalMs == 0)
            return $"平A：已激活，目标 {autoAttackTargetUnitId} / Auto attack: active";
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + serverClockOffsetMs;
        var progress = Mathf.Clamp01((float)(now - autoAttackSwingStartAtMs) / autoAttackSwingIntervalMs);
        var filled = Mathf.Clamp(Mathf.RoundToInt(progress * 20f), 0, 20);
        return $"平A：[{new string('#', filled)}{new string('-', 20 - filled)}] {progress * 100f:0}%  目标 {autoAttackTargetUnitId}";
    }

    private static string MonsterName(uint configId)
    {
        return configId switch
        {
            1 => "怪A",
            2 => "怪B",
            _ => $"MonsterConfig#{configId}",
        };
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
            serverClockOffsetMs = response.ServerTime - ((sentAt + receivedAt) / 2);
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
        GUILayout.Label("鼠标左键：选怪物或服务器寻路    E：开关门    F5：重连");
        GUILayout.Label(selectedMonsterUnitId == 0
            ? "目标：未选择怪物"
            : $"目标：{MonsterName(entityConfigIds.GetValueOrDefault(selectedMonsterUnitId))}    实例ID：{selectedMonsterUnitId}");
        var previousColor = GUI.color;
        GUI.color = new Color(0.95f, 0.35f, 0.4f);
        GUILayout.Label($"玩家 HP：{currentHp} / {maxHp}");
        GUI.color = new Color(0.3f, 0.55f, 1f);
        GUILayout.Label($"玩家 MP：{currentMp} / {maxMp}");
        GUI.color = previousColor;
        GUILayout.Label(AutoAttackProgressText());
        GUILayout.Label("按 1：激活/取消平A；服务端控制读条与攻击节奏");
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
        unsubscribeNumeric?.Invoke();
        unsubscribeAutoAttack?.Invoke();
        if (selectedMonsterMarker != null) Destroy(selectedMonsterMarker);
        loginFlow?.Close();
    }

    private static float NormalizeRadians(float value)
    {
        return Mathf.Repeat(value + Mathf.PI, Mathf.PI * 2f) - Mathf.PI;
    }
}

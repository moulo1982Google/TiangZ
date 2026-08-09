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
    private Action unsubscribeEntityState;
    private Action unsubscribeItemChanged;
    private Action unsubscribeBuffAdded;
    private Action unsubscribeBuffRemoved;
    private Action unsubscribeBuffDetail;
    private Action unsubscribeQuestProgress;
    private Action unsubscribeSkillCastState;
    private Action unsubscribeSkillProjectile;
    private Action unsubscribeSkillImpact;
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
    private readonly Dictionary<uint, long> entityCurrentHp = new Dictionary<uint, long>();
    private readonly Dictionary<uint, long> entityMaxHp = new Dictionary<uint, long>();
    private readonly Dictionary<ulong, BuffPublicView> activeBuffs = new Dictionary<ulong, BuffPublicView>();
    private readonly Dictionary<uint, QuestSnapshot> activeQuests = new Dictionary<uint, QuestSnapshot>();
    private readonly HashSet<uint> completedQuestConfigIds = new HashSet<uint>();
    private readonly Dictionary<uint, ItemSnapshot> inventoryItems = new Dictionary<uint, ItemSnapshot>();
    private readonly Dictionary<ulong, GameObject> skillProjectiles = new Dictionary<ulong, GameObject>();
    private readonly Dictionary<ulong, uint> skillProjectileTargets = new Dictionary<ulong, uint>();
    private uint castingSkillId;
    private uint castingTargetUnitId;
    private ulong castingStartedAtMs;
    private ulong castingFinishAtMs;
    private ulong globalCooldownEndAtMs;
    private ulong skillCooldownEndAtMs;
    private bool skillRequestInFlight;
    private uint questRequestInFlight;

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
        UpdateFeatureInput();
        UpdateEntityPresentation();
        UpdateCamera();
        UpdateDoorInput();
        UpdatePing();
        UpdateClickNavigation();
        UpdateSkillProjectiles();
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
            foreach (var item in game.EnterMap.Items) inventoryItems[item.ConfigId] = item;
            foreach (var quest in game.EnterMap.Quests) activeQuests[quest.QuestConfigId] = quest;
            foreach (var questConfigId in game.EnterMap.CompletedQuestConfigIds) completedQuestConfigIds.Add(questConfigId);
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
        unsubscribeEntityState = game.GateSocket.On(ClientMessages.EntityState, HandleEntityState);
        unsubscribeItemChanged = game.GateSocket.On(ClientMessages.ItemChanged, HandleItemChanged);
        unsubscribeBuffAdded = game.GateSocket.On(ClientMessages.BuffAdded, HandleBuffAdded);
        unsubscribeBuffRemoved = game.GateSocket.On(ClientMessages.BuffRemoved, HandleBuffRemoved);
        unsubscribeBuffDetail = game.GateSocket.On(ClientMessages.BuffDetail, HandleBuffDetail);
        unsubscribeQuestProgress = game.GateSocket.On(ClientMessages.QuestProgress, HandleQuestProgress);
        unsubscribeSkillCastState = game.GateSocket.On(ClientMessages.SkillCastState, HandleSkillCastState);
        unsubscribeSkillProjectile = game.GateSocket.On(ClientMessages.SkillProjectile, HandleSkillProjectile);
        unsubscribeSkillImpact = game.GateSocket.On(ClientMessages.SkillImpact, HandleSkillImpact);
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
            ApplyEntityNumeric(numeric.UnitId, numeric.NumericType, numeric.Value);
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
        foreach (var numeric in snapshot.Numerics)
        {
            ApplyEntityNumeric(snapshot.UnitId, numeric.NumericType, numeric.Value);
        }
        foreach (var buff in snapshot.Buffs)
        {
            activeBuffs[buff.BuffInstanceId] = buff;
        }
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

    /// <summary>
    /// Applies a public Numeric delta to the matching presentation entity.
    /// 将公开Numeric增量应用到对应表现实体；客户端只保存显示值，不参与战斗计算。
    /// </summary>
    private void ApplyEntityNumeric(uint unitId, uint numericType, long value)
    {
        if (numericType == 1) entityCurrentHp[unitId] = value;
        if (numericType == 1000) entityMaxHp[unitId] = value;
        if (game != null && unitId == game.EnterMap.UnitId) ApplyLocalNumeric(numericType, value);
    }

    private void HandleEntityState(G2C_EntityState message)
    {
        foreach (var state in message.States)
        {
            if (!entities.TryGetValue(state.UnitId, out var entity)) continue;
            entity.gameObject.SetActive(state.Alive);
            if (state.UnitId == selectedMonsterUnitId && !state.Alive) ClearMonsterSelection();
        }
    }

    private void HandleItemChanged(G2C_ItemChanged message)
    {
        if (message.Item == null) return;
        inventoryItems[message.Item.ConfigId] = message.Item;
    }

    private void HandleBuffAdded(G2C_BuffAdded message)
    {
        if (message.Buff == null) return;
        activeBuffs[message.Buff.BuffInstanceId] = message.Buff;
    }

    private void HandleBuffRemoved(G2C_BuffRemoved message)
    {
        activeBuffs.Remove(message.BuffInstanceId);
    }

    private void HandleBuffDetail(G2C_BuffDetail message)
    {
        // BuffDetail carries private fields such as shield absorption. The demo keeps
        // the public Buff row authoritative and only reports the private value in HUD.
        // BuffDetail包含护盾吸收量等私有字段；演示保留公开Buff行作为权威，只在HUD展示私有值。
        if (message.Buffs.Count > 0) status = $"Buff私有状态已同步：{message.Buffs.Count}项";
    }

    private void HandleQuestProgress(G2C_QuestProgress message)
    {
        activeQuests.Clear();
        foreach (var quest in message.Quests) activeQuests[quest.QuestConfigId] = quest;
    }

    private void HandleSkillCastState(G2C_SkillCastState message)
    {
        castingSkillId = message.SkillId;
        castingTargetUnitId = message.TargetUnitId;
        castingStartedAtMs = message.StartedAtMs;
        castingFinishAtMs = message.FinishAtMs;
        globalCooldownEndAtMs = message.GlobalCooldownEndAtMs;
        skillCooldownEndAtMs = message.SkillCooldownEndAtMs;
        if (message.Phase == 0 && !string.IsNullOrEmpty(message.InterruptReason))
        {
            status = $"施法被打断：{message.InterruptReason}";
        }
    }

    private void HandleSkillProjectile(G2C_SkillProjectile message)
    {
        if (!entities.TryGetValue(message.SourceUnitId, out var source) ||
            !entities.TryGetValue(message.TargetUnitId, out var target)) return;
        var projectile = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        projectile.name = $"SkillProjectile_{message.CastId}";
        projectile.transform.localScale = Vector3.one * 0.35f;
        projectile.GetComponent<Renderer>().material.color = message.SkillId == 3001
            ? new Color(0.2f, 0.75f, 1f)
            : new Color(1f, 0.65f, 0.15f);
        projectile.transform.position = source.position + Vector3.up * 0.8f;
        skillProjectiles[message.CastId] = projectile;
        skillProjectileTargets[message.CastId] = message.TargetUnitId;
    }

    private void HandleSkillImpact(G2C_SkillImpact message)
    {
        if (skillProjectiles.TryGetValue(message.CastId, out var projectile))
        {
            Destroy(projectile);
            skillProjectiles.Remove(message.CastId);
            skillProjectileTargets.Remove(message.CastId);
        }
        status = $"{SkillName(message.SkillId)} 命中 {message.TargetUnitId}，伤害 {message.Damage}";
        if (message.Killed && entities.TryGetValue(message.TargetUnitId, out var target)) target.gameObject.SetActive(false);
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

    /// <summary>
    /// Handles the non-movement demo controls: 2/3 items, 4-8 skills, Q accept and R turn in.
    /// 处理非移动演示输入：2/3使用道具，4-8施放技能，Q接取任务，R领取奖励。
    /// </summary>
    private void UpdateFeatureInput()
    {
        if (game == null) return;
        if (Input.GetKeyDown(KeyCode.Alpha2)) _ = UseItemAsync(1001);
        if (Input.GetKeyDown(KeyCode.Alpha3)) _ = UseItemAsync(1002);
        if (Input.GetKeyDown(KeyCode.Alpha4)) _ = CastSkillAsync(3001);
        if (Input.GetKeyDown(KeyCode.Alpha5)) _ = CastSkillAsync(3002);
        if (Input.GetKeyDown(KeyCode.Alpha6)) _ = CastSkillAsync(3003);
        if (Input.GetKeyDown(KeyCode.Alpha7)) _ = CastSkillAsync(3004);
        if (Input.GetKeyDown(KeyCode.Alpha8)) _ = CastSkillAsync(3005);
        if (Input.GetKeyDown(KeyCode.Q))
        {
            var quest = FindQuestToAccept();
            if (quest != 0) _ = AcceptQuestAsync(quest);
        }
        if (Input.GetKeyDown(KeyCode.R))
        {
            var quest = FindQuestToComplete();
            if (quest != 0) _ = CompleteQuestAsync(quest);
        }
    }

    private async Task UseItemAsync(uint itemConfigId)
    {
        if (game == null || !inventoryItems.TryGetValue(itemConfigId, out var item) || item.Count == 0) return;
        try
        {
            var response = await game.Map.UseItemAsync(new C2M_UseItem
            {
                ItemId = item.ItemId,
                OperationId = $"item-{Guid.NewGuid():N}",
            }, CancellationToken.None);
            if (response.Item != null) inventoryItems[response.Item.ConfigId] = response.Item;
            if (response.Buff != null) activeBuffs[response.Buff.BuffInstanceId] = response.Buff;
            status = $"使用道具：{ItemName(itemConfigId)}";
        }
        catch (Exception error)
        {
            lastError = $"使用{ItemName(itemConfigId)}失败：{error.Message}";
        }
    }

    private async Task CastSkillAsync(uint skillId)
    {
        if (game == null || skillRequestInFlight) return;
        var targetUnitId = IsSelfSkill(skillId)
            ? game.EnterMap.UnitId
            : selectedMonsterUnitId != 0 ? selectedMonsterUnitId : FindFirstMonsterUnitId();
        if (targetUnitId == 0)
        {
            status = "请先选择一个可见怪物 / Select a visible monster first";
            return;
        }
        skillRequestInFlight = true;
        try
        {
            var response = await game.Map.CastSkillAsync(
                new C2M_CastSkill { SkillId = skillId, TargetUnitId = targetUnitId },
                CancellationToken.None);
            ApplySkillCastState(new G2C_SkillCastState
            {
                Phase = response.Phase,
                CastId = response.CastId,
                SkillId = response.SkillId,
                TargetUnitId = response.TargetUnitId,
                StartedAtMs = response.StartedAtMs,
                FinishAtMs = response.FinishAtMs,
                GlobalCooldownEndAtMs = response.GlobalCooldownEndAtMs,
                SkillCooldownEndAtMs = response.SkillCooldownEndAtMs,
                InterruptReason = response.InterruptReason,
            });
            status = $"开始施法：{SkillName(skillId)}";
        }
        catch (Exception error)
        {
            lastError = $"施放{SkillName(skillId)}失败：{error.Message}";
        }
        finally
        {
            skillRequestInFlight = false;
        }
    }

    private async Task AcceptQuestAsync(uint questConfigId)
    {
        if (game == null || questRequestInFlight != 0) return;
        questRequestInFlight = questConfigId;
        try
        {
            var response = await game.Map.AcceptQuestAsync(new C2M_AcceptQuest { QuestConfigId = questConfigId }, CancellationToken.None);
            if (response.Quest != null) activeQuests[response.Quest.QuestConfigId] = response.Quest;
            status = $"已接取任务：{QuestName(questConfigId)}";
        }
        catch (Exception error)
        {
            lastError = $"接取任务失败：{error.Message}";
        }
        finally
        {
            questRequestInFlight = 0;
        }
    }

    private async Task CompleteQuestAsync(uint questConfigId)
    {
        if (game == null || questRequestInFlight != 0) return;
        questRequestInFlight = questConfigId;
        try
        {
            var response = await game.Map.CompleteQuestAsync(new C2M_CompleteQuest { QuestConfigId = questConfigId }, CancellationToken.None);
            activeQuests.Remove(questConfigId);
            completedQuestConfigIds.Add(response.QuestConfigId);
            status = $"任务完成：{QuestName(questConfigId)}";
        }
        catch (Exception error)
        {
            lastError = $"领取任务奖励失败：{error.Message}";
        }
        finally
        {
            questRequestInFlight = 0;
        }
    }

    private uint FindQuestToAccept()
    {
        foreach (var questConfigId in new[] { 5001u, 5002u, 5003u, 5004u })
        {
            if (!activeQuests.ContainsKey(questConfigId) && !completedQuestConfigIds.Contains(questConfigId)) return questConfigId;
        }
        return 0;
    }

    private uint FindQuestToComplete()
    {
        foreach (var quest in activeQuests.Values)
        {
            if (quest.ReadyToComplete || quest.Status == 2) return quest.QuestConfigId;
        }
        return 0;
    }

    private void ApplySkillCastState(G2C_SkillCastState message)
    {
        castingSkillId = message.SkillId;
        castingTargetUnitId = message.TargetUnitId;
        castingStartedAtMs = message.StartedAtMs;
        castingFinishAtMs = message.FinishAtMs;
        globalCooldownEndAtMs = message.GlobalCooldownEndAtMs;
        skillCooldownEndAtMs = message.SkillCooldownEndAtMs;
        if (!string.IsNullOrEmpty(message.InterruptReason)) status = $"施法被打断：{message.InterruptReason}";
    }

    private void UpdateSkillProjectiles()
    {
        foreach (var pair in skillProjectiles)
        {
            if (!pair.Value || !skillProjectileTargets.TryGetValue(pair.Key, out var targetUnitId) ||
                !entities.TryGetValue(targetUnitId, out var target)) continue;
            pair.Value.transform.position = Vector3.MoveTowards(
                pair.Value.transform.position, target.position + Vector3.up * 0.8f, 10f * Time.deltaTime);
        }
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

    private static string SkillName(uint skillId)
    {
        return skillId switch
        {
            3001 => "寒冰箭",
            3002 => "火焰冲击",
            3003 => "惩击",
            3004 => "真言术·盾",
            3005 => "真言术·韧",
            _ => $"技能#{skillId}",
        };
    }

    private static string ItemName(uint itemConfigId)
    {
        return itemConfigId switch
        {
            1001 => "小型生命药水",
            1002 => "大型生命药水",
            _ => $"道具#{itemConfigId}",
        };
    }

    private static string BuffName(uint buffConfigId)
    {
        return buffConfigId switch
        {
            2001 => "持续恢复",
            4001 => "冰冷",
            4002 => "灼烧",
            4003 => "真言术·盾",
            4004 => "虚弱灵魂",
            4005 => "真言术·韧",
            _ => $"Buff#{buffConfigId}",
        };
    }

    private static string QuestName(uint questConfigId)
    {
        return questConfigId switch
        {
            5001 => "清理怪物",
            5002 => "试用药水",
            5003 => "前往地图2",
            5004 => "进阶试炼",
            _ => $"任务#{questConfigId}",
        };
    }

    private static bool IsSelfSkill(uint skillId) => skillId == 3004 || skillId == 3005;

    private long ServerNowMs() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() + serverClockOffsetMs;

    private static string FormatRemaining(ulong expireTimeMs, long serverNowMs)
    {
        if (expireTimeMs == 0) return "永久";
        var seconds = Math.Max(0L, ((long)expireTimeMs - serverNowMs + 999) / 1000);
        return $"{seconds / 60:00}:{seconds % 60:00}";
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
            : $"目标：{MonsterName(entityConfigIds.GetValueOrDefault(selectedMonsterUnitId))}    实例ID：{selectedMonsterUnitId}    HP：{entityCurrentHp.GetValueOrDefault(selectedMonsterUnitId)}/{entityMaxHp.GetValueOrDefault(selectedMonsterUnitId)}");
        var previousColor = GUI.color;
        GUI.color = new Color(0.95f, 0.35f, 0.4f);
        GUILayout.Label($"玩家 HP：{currentHp} / {maxHp}");
        GUI.color = new Color(0.3f, 0.55f, 1f);
        GUILayout.Label($"玩家 MP：{currentMp} / {maxMp}");
        GUI.color = previousColor;
        GUILayout.Label(AutoAttackProgressText());
        GUILayout.Label("按 1：激活/取消平A；服务端控制读条与攻击节奏");
        GUILayout.Label(SkillCastText());
        GUILayout.Label("技能：4寒冰箭 5火焰冲击 6惩击 7真言术·盾 8真言术·韧");
        GUILayout.Label(SkillCooldownText());
        GUILayout.Label(BuffText());
        GUILayout.Label(QuestText());
        if (GUILayout.Button("Q 接取下一个任务"))
        {
            var quest = FindQuestToAccept();
            if (quest != 0) _ = AcceptQuestAsync(quest);
        }
        if (GUILayout.Button("R 领取已完成任务奖励"))
        {
            var quest = FindQuestToComplete();
            if (quest != 0) _ = CompleteQuestAsync(quest);
        }
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

    private string SkillCastText()
    {
        if (castingSkillId == 0) return "施法：空闲 / Cast: idle";
        if (castingFinishAtMs <= castingStartedAtMs) return $"施法：{SkillName(castingSkillId)}（瞬发）";
        var progress = Mathf.Clamp01((float)(ServerNowMs() - (long)castingStartedAtMs) /
            Math.Max(1L, (long)castingFinishAtMs - (long)castingStartedAtMs));
        return $"施法：{SkillName(castingSkillId)} [{progress * 100f:0}%] 目标：{castingTargetUnitId}";
    }

    private string SkillCooldownText()
    {
        var now = (ulong)Math.Max(0L, ServerNowMs());
        var global = globalCooldownEndAtMs > now ? (globalCooldownEndAtMs - now + 999) / 1000 : 0;
        var skill = skillCooldownEndAtMs > now ? (skillCooldownEndAtMs - now + 999) / 1000 : 0;
        return $"公共CD：{global}s  当前技能CD：{skill}s";
    }

    private string BuffText()
    {
        if (game == null) return "Buff：--";
        var visible = new List<string>();
        foreach (var buff in activeBuffs.Values)
        {
            if (buff.UnitId != game.EnterMap.UnitId) continue;
            visible.Add($"{BuffName(buff.BuffConfigId)} {FormatRemaining(buff.ExpireTimeMs, ServerNowMs())}");
        }
        return visible.Count == 0 ? "Buff：无" : $"Buff：{string.Join(" | ", visible)}";
    }

    private string QuestText()
    {
        if (activeQuests.Count == 0) return "任务：无（Q接取）";
        var lines = new List<string>();
        foreach (var quest in activeQuests.Values)
        {
            var objective = quest.Objectives.Count == 0 ? null : quest.Objectives[0];
            var progress = objective == null ? "-" : $"{objective.Current}/{objective.Required}";
            lines.Add($"{QuestName(quest.QuestConfigId)} {progress}{(quest.ReadyToComplete || quest.Status == 2 ? " 可领取" : "")}");
        }
        return $"任务：{string.Join(" | ", lines)}";
    }

    private void OnDestroy()
    {
        unsubscribeNavigate?.Invoke();
        unsubscribeAoi?.Invoke();
        unsubscribeDoor?.Invoke();
        unsubscribeNumeric?.Invoke();
        unsubscribeAutoAttack?.Invoke();
        unsubscribeEntityState?.Invoke();
        unsubscribeItemChanged?.Invoke();
        unsubscribeBuffAdded?.Invoke();
        unsubscribeBuffRemoved?.Invoke();
        unsubscribeBuffDetail?.Invoke();
        unsubscribeQuestProgress?.Invoke();
        unsubscribeSkillCastState?.Invoke();
        unsubscribeSkillProjectile?.Invoke();
        unsubscribeSkillImpact?.Invoke();
        foreach (var projectile in skillProjectiles.Values)
        {
            if (projectile != null) Destroy(projectile);
        }
        skillProjectiles.Clear();
        skillProjectileTargets.Clear();
        if (selectedMonsterMarker != null) Destroy(selectedMonsterMarker);
        loginFlow?.Close();
    }

    private static float NormalizeRadians(float value)
    {
        return Mathf.Repeat(value + Mathf.PI, Mathf.PI * 2f) - Mathf.PI;
    }
}

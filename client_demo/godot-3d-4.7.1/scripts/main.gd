extends Node3D

## Godot 3D演示：表现层只消费SDK事件，不复制服务端NavMesh和碰撞。
## Godot 3D demo: presentation consumes SDK events without copying server NavMesh or collision.

const MAP_SIZE := 48.0
const PLAYER_HEIGHT := 1.8
const PLAYER_HALF_WIDTH := 0.4
const POSITION_SMOOTH_SPEED := 12.0
const ROTATION_SMOOTH_SPEED := 10.0
const MOUSE_LOOK_SENSITIVITY := 0.008
const MOUSE_LOOK_SEND_INTERVAL := 0.05
const VERTICAL_SAMPLE_CONFIRMATIONS := 3
const VERTICAL_SAMPLE_EPSILON := 0.01
const DOOR_CENTER := Vector3(-12.0, 1.5, 0.0)
const DOOR_SIZE := Vector3(8.0, 3.0, 2.0)

var client: TiangZClient
var camera: Camera3D
var local_unit_id := 0
var units: Dictionary = {}
var unit_nodes: Dictionary = {}
var stable_ground_y: Dictionary = {}
var pending_ground_y: Dictionary = {}
var door: MeshInstance3D
var door_closed := false
var player_yaw := 0.0
var camera_distance := 18.0
var sequence := 1
var input_cooldown := 0.0
var right_mouse_held := false
var look_changed := false
var look_send_cooldown := 0.0
var last_forward := 0
var last_strafe := 0
var last_turning := 0
var last_strafe_mode := false
var last_server_time := 0
var status_label: Label
var latency_label: Label
var selected_monster_label: Label
var player_hp_label: Label
var player_mp_label: Label
var auto_attack_label: Label
var local_numerics: Dictionary = {}
var selected_monster_unit_id := 0
var selected_monster_marker: MeshInstance3D
var auto_attack_enabled := false
var auto_attack_target_unit_id := 0
var auto_attack_swing_start_at_ms := 0
var auto_attack_swing_interval_ms := 2000
var auto_attack_phase := 0
var server_clock_offset_ms := 0
var auto_attack_request_pending := false
var inventory_items: Dictionary = {}
var active_buffs: Dictionary = {}
var quests: Dictionary = {}
var completed_quest_config_ids: Dictionary = {}
var skill_cast_state: Dictionary = {}
var skill_projectiles: Dictionary = {}
var skill_label: Label
var buff_label: Label
var quest_label: Label

func _ready() -> void:
	_build_world()
	_build_ui()
	client = TiangZClient.new()
	add_child(client)
	client.status_changed.connect(_on_status)
	client.map_entered.connect(_on_map_entered)
	client.map_ready.connect(_on_map_ready)
	client.navigate_push.connect(_on_navigate_push)
	client.aoi_delta.connect(_on_aoi_delta)
	client.entity_enter.connect(_on_entity_enter)
	client.entity_leave.connect(_on_entity_leave)
	client.entity_numeric.connect(_on_entity_numeric)
	client.entity_state.connect(_on_entity_state)
	client.door_changed.connect(_on_door_changed)
	client.ping_result.connect(_on_ping_result)
	client.auto_attack_state_changed.connect(_on_auto_attack_state)
	client.item_changed.connect(_on_item_changed)
	client.buff_added.connect(_on_buff_added)
	client.buff_removed.connect(_on_buff_removed)
	client.buff_detail.connect(_on_buff_detail)
	client.quest_progress.connect(_on_quest_progress)
	client.skill_cast_state.connect(_on_skill_cast_state)
	client.skill_projectile.connect(_on_skill_projectile)
	client.skill_impact.connect(_on_skill_impact)
	client.start("godot_%d" % Time.get_ticks_msec())

func _process(delta: float) -> void:
	_update_direction_input(delta)
	_update_units(delta)
	_update_camera(delta)
	_update_auto_attack_hud()
	_update_skill_hud()
	_update_buff_hud()
	_update_quest_hud()
	_update_skill_projectiles(delta)

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_RIGHT:
			right_mouse_held = event.pressed
			Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED if event.pressed else Input.MOUSE_MODE_VISIBLE)
		elif event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
			_navigate_from_screen(event.position)
		elif event.pressed and event.button_index == MOUSE_BUTTON_WHEEL_UP:
			camera_distance = maxf(7.0, camera_distance - 1.0)
		elif event.pressed and event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			camera_distance = minf(35.0, camera_distance + 1.0)
	if event is InputEventMouseMotion and right_mouse_held:
		# 右键拖拽只改变水平朝向；与D键使用同一正方向，摄像机因此围绕玩家旋转。
		# Right-drag changes horizontal facing only; it shares D's sign so the camera orbits consistently.
		player_yaw = wrapf(player_yaw - event.relative.x * MOUSE_LOOK_SENSITIVITY, -PI, PI)
		look_changed = true
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_E:
		client.toggle_demo_door(not door_closed)
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_1:
		_toggle_auto_attack()
	if event is InputEventKey and event.pressed and not event.echo:
		if event.keycode == KEY_2 or event.keycode == KEY_3:
			_use_item_slot(event.keycode - KEY_0)
		elif event.keycode >= KEY_4 and event.keycode <= KEY_8:
			_cast_skill_slot(event.keycode - KEY_0)
		elif event.keycode == KEY_Q:
			_accept_first_quest()
		elif event.keycode == KEY_R:
			_complete_first_quest()

func _build_world() -> void:
	var environment_node := WorldEnvironment.new()
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#17212b")
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color("#a9bdd0")
	environment.ambient_light_energy = 0.75
	environment_node.environment = environment
	add_child(environment_node)

	var light := DirectionalLight3D.new()
	light.rotation_degrees = Vector3(-55.0, -35.0, 0.0)
	light.light_energy = 1.2
	add_child(light)

	var navigation_floor := _create_box(Vector3(MAP_SIZE, 0.2, MAP_SIZE), Color("#395b59"))
	navigation_floor.position = Vector3(0.0, -0.1, 0.0)
	navigation_floor.name = "NavigationFloor"
	add_child(navigation_floor)

	var obstacle := _create_box(Vector3(6.0, 3.0, 10.0), Color("#89725e"))
	obstacle.position = Vector3(0.0, 1.5, 0.0)
	obstacle.name = "StaticNavigationObstacle"
	add_child(obstacle)

	door = _create_box(DOOR_SIZE, Color("#c64e46"))
	door.position = DOOR_CENTER
	door.name = "ServerDoorVisual"
	door.visible = false
	add_child(door)

	camera = Camera3D.new()
	camera.current = true
	camera.fov = 55.0
	camera.position = Vector3(0.0, 12.0, 18.0)
	add_child(camera)

func _build_ui() -> void:
	var canvas := CanvasLayer.new()
	add_child(canvas)
	status_label = Label.new()
	status_label.position = Vector2(24.0, 20.0)
	status_label.add_theme_font_size_override("font_size", 20)
	status_label.text = "正在连接 TiangZ..."
	canvas.add_child(status_label)
	latency_label = Label.new()
	latency_label.position = Vector2(24.0, 54.0)
	latency_label.add_theme_font_size_override("font_size", 16)
	latency_label.text = "Ping: --"
	canvas.add_child(latency_label)
	selected_monster_label = Label.new()
	selected_monster_label.position = Vector2(24.0, 88.0)
	selected_monster_label.add_theme_font_size_override("font_size", 16)
	selected_monster_label.text = "目标：未选择怪物"
	canvas.add_child(selected_monster_label)
	player_hp_label = Label.new()
	player_hp_label.position = Vector2(24.0, 156.0)
	player_hp_label.add_theme_font_size_override("font_size", 16)
	player_hp_label.modulate = Color("#ff5964")
	player_hp_label.text = "玩家 HP：-- / --"
	canvas.add_child(player_hp_label)
	player_mp_label = Label.new()
	player_mp_label.position = Vector2(24.0, 180.0)
	player_mp_label.add_theme_font_size_override("font_size", 16)
	player_mp_label.modulate = Color("#5b9cff")
	player_mp_label.text = "玩家 MP：-- / --"
	canvas.add_child(player_mp_label)
	auto_attack_label = Label.new()
	auto_attack_label.position = Vector2(24.0, 204.0)
	auto_attack_label.add_theme_font_size_override("font_size", 16)
	auto_attack_label.text = "平A：未激活（按 1 开始）"
	canvas.add_child(auto_attack_label)
	skill_label = Label.new()
	skill_label.position = Vector2(24.0, 238.0)
	skill_label.add_theme_font_size_override("font_size", 15)
	skill_label.text = "技能：空闲（4-8施法）"
	canvas.add_child(skill_label)
	buff_label = Label.new()
	buff_label.position = Vector2(24.0, 282.0)
	buff_label.add_theme_font_size_override("font_size", 15)
	buff_label.text = "Buff：无"
	canvas.add_child(buff_label)
	quest_label = Label.new()
	quest_label.position = Vector2(24.0, 350.0)
	quest_label.add_theme_font_size_override("font_size", 15)
	quest_label.text = "任务：无（Q接取，R交付）"
	canvas.add_child(quest_label)
	var help := Label.new()
	help.position = Vector2(24.0, 650.0)
	help.add_theme_font_size_override("font_size", 16)
	help.text = "左键：选怪物或服务端寻路    W/S：前后移动    A/D：转身    按住右键时 A/D：平移    1平A  2/3道具  4-8技能  Q/R任务    E：动态门    滚轮：镜头距离"
	canvas.add_child(help)

func _update_direction_input(delta: float) -> void:
	if client == null or client.phase != "map":
		return
	var forward := int(Input.is_key_pressed(KEY_W)) - int(Input.is_key_pressed(KEY_S))
	# 转身和横移使用不同的局部坐标正方向：转身保持D为正，横移保持A为正。
	# Turning and strafing intentionally use different local-axis signs: D is positive for turning, A is positive for strafing.
	var turning_input := int(Input.is_key_pressed(KEY_D)) - int(Input.is_key_pressed(KEY_A))
	var strafe_input := int(Input.is_key_pressed(KEY_A)) - int(Input.is_key_pressed(KEY_D))
	var turning := 0 if right_mouse_held else turning_input
	var strafe := strafe_input if right_mouse_held else 0
	if turning != 0:
		player_yaw -= float(turning) * 2.8 * delta
	look_send_cooldown = maxf(0.0, look_send_cooldown - delta)
	var mode_changed := right_mouse_held != last_strafe_mode
	var changed := forward != last_forward or strafe != last_strafe or turning != last_turning or mode_changed
	var look_ready := look_changed and look_send_cooldown <= 0.0
	input_cooldown -= delta
	var active := forward != 0 or strafe != 0
	if (changed or look_ready or (active and input_cooldown <= 0.0)) and client.navigate_input(forward, strafe, player_yaw, sequence):
		sequence += 1
		last_forward = forward
		last_strafe = strafe
		last_turning = turning
		last_strafe_mode = right_mouse_held
		input_cooldown = 0.25
		if look_changed:
			look_changed = false
			look_send_cooldown = MOUSE_LOOK_SEND_INTERVAL

func _navigate_from_screen(screen_position: Vector2) -> void:
	if client == null or client.phase != "map" or camera == null:
		return
	var origin := camera.project_ray_origin(screen_position)
	var direction := camera.project_ray_normal(screen_position)
	var monster_unit_id := _pick_monster_from_screen(origin, direction)
	if monster_unit_id != 0:
		_select_monster(monster_unit_id)
		return
	var hit = Plane(Vector3.UP, 0.0).intersects_ray(origin, direction)
	if hit is Vector3 and absf(hit.x) <= MAP_SIZE * 0.5 and absf(hit.z) <= MAP_SIZE * 0.5:
		client.navigate_to(hit.x, 0.0, hit.z, sequence)
		sequence += 1

## 用射线和怪物表现方块做AABB相交；命中怪物后不再进入地面寻路。
## Uses ray/AABB intersection against monster grayboxes so a monster click never falls through to ground navigation.
func _pick_monster_from_screen(origin: Vector3, direction: Vector3) -> int:
	var nearest_unit_id := 0
	var nearest_distance := INF
	for unit_id in units:
		var state: Dictionary = units[unit_id]
		if int(state.get("entity_type", 0)) != 2 or not unit_nodes.has(unit_id):
			continue
		var node: Node3D = unit_nodes[unit_id]
		var distance := _intersect_ray_box(origin, direction, node.position, PLAYER_HALF_WIDTH, PLAYER_HEIGHT * 0.5, PLAYER_HALF_WIDTH)
		if distance >= 0.0 and distance < nearest_distance:
			nearest_distance = distance
			nearest_unit_id = int(unit_id)
	return nearest_unit_id

func _intersect_ray_box(origin: Vector3, direction: Vector3, center: Vector3, half_x: float, half_y: float, half_z: float) -> float:
	var x_interval := _ray_axis_interval(origin.x, direction.x, center.x - half_x, center.x + half_x)
	var y_interval := _ray_axis_interval(origin.y, direction.y, center.y - half_y, center.y + half_y)
	var z_interval := _ray_axis_interval(origin.z, direction.z, center.z - half_z, center.z + half_z)
	var near_distance := maxf(x_interval.x, maxf(y_interval.x, z_interval.x))
	var far_distance := minf(x_interval.y, minf(y_interval.y, z_interval.y))
	if near_distance > far_distance or far_distance < 0.0:
		return -1.0
	return maxf(0.0, near_distance)

func _ray_axis_interval(origin: float, direction: float, min_value: float, max_value: float) -> Vector2:
	if absf(direction) < 0.000001:
		return Vector2(-INF, INF) if origin >= min_value and origin <= max_value else Vector2(INF, -INF)
	var first := (min_value - origin) / direction
	var second := (max_value - origin) / direction
	if first > second:
		var temporary := first
		first = second
		second = temporary
	return Vector2(first, second)

func _select_monster(unit_id: int) -> void:
	if selected_monster_unit_id == unit_id:
		return
	_clear_monster_selection()
	if not units.has(unit_id) or not unit_nodes.has(unit_id):
		return
	var state: Dictionary = units[unit_id]
	if int(state.get("entity_type", 0)) != 2:
		return
	selected_monster_unit_id = unit_id
	var node: Node3D = unit_nodes[unit_id]
	_create_selection_marker(node)
	_set_unit_color(unit_id)
	selected_monster_label.text = "目标：%s\n实例ID：%d" % [_monster_name(int(state.get("config_id", 0))), unit_id]

func _clear_monster_selection() -> void:
	if selected_monster_unit_id != 0 and unit_nodes.has(selected_monster_unit_id):
		_set_unit_color(selected_monster_unit_id)
	if selected_monster_marker:
		selected_monster_marker.queue_free()
		selected_monster_marker = null
	selected_monster_unit_id = 0
	if selected_monster_label:
		selected_monster_label.text = "目标：未选择怪物"

func _monster_name(config_id: int) -> String:
	match config_id:
		1:
			return "怪A"
		2:
			return "怪B"
		_:
			return "MonsterConfig#%d" % config_id

func _set_unit_color(unit_id: int) -> void:
	if not unit_nodes.has(unit_id) or not units.has(unit_id):
		return
	var state: Dictionary = units[unit_id]
	var entity_type := int(state.get("entity_type", 0))
	var config_id := int(state.get("config_id", 0))
	var color := (
		Color("#36b7e8") if unit_id == local_unit_id else
		Color("#ef4d47") if entity_type == 2 and config_id == 2 else
		Color("#ffd746") if entity_type == 2 else
		Color("#50d77d")
	)
	var material := unit_nodes[unit_id].material_override as StandardMaterial3D
	if material:
		material.albedo_color = color

func _create_selection_marker(target: Node3D) -> void:
	if selected_monster_marker:
		selected_monster_marker.queue_free()
	var marker := MeshInstance3D.new()
	marker.name = "SelectedMonsterMarker"
	var torus := TorusMesh.new()
	torus.inner_radius = 0.48
	torus.outer_radius = 0.58
	torus.rings = 32
	torus.ring_segments = 8
	marker.mesh = torus
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#27e7ff")
	material.emission_enabled = true
	material.emission = Color("#0b8fa8")
	material.emission_energy_multiplier = 2.0
	marker.material_override = material
	marker.position = Vector3(0.0, -PLAYER_HEIGHT * 0.5 + 0.04, 0.0)
	target.add_child(marker)
	selected_monster_marker = marker

func _update_units(delta: float) -> void:
	for unit_id in units:
		var state: Dictionary = units[unit_id]
		var node: Node3D = unit_nodes[unit_id]
		var target := Vector3(state.x, _render_ground_y(unit_id, state) + PLAYER_HEIGHT * 0.5, state.z)
		node.position = node.position.lerp(target, minf(1.0, delta * POSITION_SMOOTH_SPEED))
		# 服务端与Godot都约定Yaw=0指向+Z，不能再次取反，否则转身方向与移动方向相反。
		# Both server and Godot define yaw=0 as +Z; negating it here reverses facing.
		node.rotation.y = lerp_angle(node.rotation.y, float(state.yaw), minf(1.0, delta * ROTATION_SMOOTH_SPEED))

func _update_camera(delta: float) -> void:
	if not units.has(local_unit_id) or not unit_nodes.has(local_unit_id):
		return
	# 摄像机跟随已经渲染出来的Unit，而不是直接追服务端目标点；否则Unit在插值追赶时，镜头会产生视觉抖动。
	# Follow the rendered Unit instead of the raw server target; otherwise the camera outruns the interpolated Unit and causes visible jitter.
	var player_node: Node3D = unit_nodes[local_unit_id]
	var target := player_node.position + Vector3.UP * (1.0 - PLAYER_HEIGHT * 0.5)
	var forward := Vector3(sin(player_yaw), 0.0, cos(player_yaw))
	var desired := target - forward * camera_distance + Vector3.UP * camera_distance * 0.52
	camera.position = camera.position.lerp(desired, minf(1.0, delta * 8.0))
	camera.look_at(target, Vector3.UP)

func _on_map_entered(snapshot: Dictionary) -> void:
	local_unit_id = snapshot.unit_id
	local_numerics.clear()
	inventory_items.clear()
	for item in snapshot.get("items", []):
		inventory_items[int(item.get("config_id", 0))] = item
	quests.clear()
	for quest in snapshot.get("quests", []):
		quests[int(quest.get("quest_config_id", 0))] = quest
	completed_quest_config_ids.clear()
	for quest_id in snapshot.get("completed_quest_config_ids", []):
		completed_quest_config_ids[int(quest_id)] = true
	_upsert_unit({"unit_id": snapshot.unit_id, "x": snapshot.x, "y": snapshot.y, "z": snapshot.z, "yaw": 0.0, "alive": true, "entity_type": 1, "config_id": 0}, true)
	for entity in snapshot.entities:
		_upsert_unit(entity, true)
		for numeric in entity.get("numerics", []):
			_apply_entity_numeric(numeric)
		for buff in entity.get("buffs", []):
			_on_buff_added(buff)
	_update_player_stats_hud()
	_update_quest_hud()

func _on_map_ready(snapshot: Dictionary) -> void:
	_upsert_unit({"unit_id": snapshot.unit_id, "x": snapshot.x, "y": snapshot.y, "z": snapshot.z, "yaw": player_yaw}, false)

func _on_navigate_push(message: Dictionary) -> void:
	for movement in message.movements:
		_upsert_unit(movement, false)
		if movement.unit_id == local_unit_id:
			if not bool(movement.moving):
				player_yaw = movement.yaw

func _on_aoi_delta(message: Dictionary) -> void:
	for entity in message.enters:
		# AOI快照可能早于移动帧生成，只更新目标状态，不硬传送已有节点。
		# An AOI snapshot may be older than the movement frame; update the target without teleporting an existing node.
		_upsert_unit(entity, false)
	for unit_id in message.leaves:
		_remove_unit(unit_id)

func _on_entity_enter(entity: Dictionary) -> void:
	_upsert_unit(entity, false)

func _on_entity_leave(unit_id: int) -> void:
	_remove_unit(unit_id)

func _on_entity_numeric(message: Dictionary) -> void:
	for numeric in message.get("numerics", []):
		_apply_entity_numeric(numeric)
	_update_player_stats_hud()

func _apply_local_numeric(numeric: Dictionary) -> void:
	local_numerics[int(numeric.get("numeric_type", 0))] = int(numeric.get("value", 0))

func _apply_entity_numeric(numeric: Dictionary) -> void:
	var unit_id := int(numeric.get("unit_id", 0))
	var numeric_type := int(numeric.get("numeric_type", 0))
	var value := int(numeric.get("value", 0))
	if unit_id == local_unit_id:
		_apply_local_numeric(numeric)
	if units.has(unit_id):
		var state: Dictionary = units[unit_id]
		var numerics: Dictionary = state.get("numeric_values", {})
		numerics[numeric_type] = value
		state["numeric_values"] = numerics
		if numeric_type == 1:
			state["current_hp"] = value
		elif numeric_type == 1000:
			state["max_hp"] = value

func _on_entity_state(message: Dictionary) -> void:
	for state_delta in message.get("states", []):
		var unit_id := int(state_delta.get("unit_id", 0))
		if not units.has(unit_id):
			continue
		var state: Dictionary = units[unit_id]
		var dirty := int(state_delta.get("dirty_mask_low", 0))
		if dirty & (1 << 6):
			state["alive"] = bool(state_delta.get("alive", false))
			unit_nodes[unit_id].visible = bool(state.get("alive", true))
			if not bool(state.get("alive", true)) and unit_id == selected_monster_unit_id:
				_clear_monster_selection()

func _update_player_stats_hud() -> void:
	if player_hp_label == null or player_mp_label == null:
		return
	player_hp_label.text = "玩家 HP：%d / %d" % [int(local_numerics.get(1, 0)), int(local_numerics.get(1000, 0))]
	player_mp_label.text = "玩家 MP：%d / %d" % [int(local_numerics.get(2, 0)), int(local_numerics.get(1001, 0))]

func _upsert_unit(state: Dictionary, snap: bool) -> void:
	var unit_id: int = state.unit_id
	var created := false
	if not units.has(unit_id):
		var entity_type := int(state.get("entity_type", 0))
		var config_id := int(state.get("config_id", 0))
		var color := Color("#36b7e8") if unit_id == local_unit_id else (Color("#ef4d47") if entity_type == 2 and config_id == 2 else Color("#ffd746") if entity_type == 2 else Color("#50d77d"))
		var node := _create_box(Vector3(0.8, PLAYER_HEIGHT, 0.8), color)
		node.name = "Unit_%d" % unit_id
		add_child(node)
		unit_nodes[unit_id] = node
		units[unit_id] = state.duplicate()
		units[unit_id]["alive"] = bool(state.get("alive", true))
		stable_ground_y[unit_id] = float(state.y)
		pending_ground_y.erase(unit_id)
		created = true
	else:
		for key in state:
			units[unit_id][key] = state[key]
	unit_nodes[unit_id].visible = bool(units[unit_id].get("alive", true))
	_set_unit_color(unit_id)
	_accept_ground_y(unit_id, float(state.y))
	if created or snap:
		var current: Dictionary = units[unit_id]
		unit_nodes[unit_id].position = Vector3(current.x, _render_ground_y(unit_id, current) + PLAYER_HEIGHT * 0.5, current.z)

func _render_ground_y(unit_id: int, state: Dictionary) -> float:
	return float(stable_ground_y.get(unit_id, state.y))

func _accept_ground_y(unit_id: int, incoming_y: float) -> void:
	if not stable_ground_y.has(unit_id):
		stable_ground_y[unit_id] = incoming_y
		return
	var current_y := float(stable_ground_y[unit_id])
	if absf(incoming_y - current_y) <= VERTICAL_SAMPLE_EPSILON:
		pending_ground_y.erase(unit_id)
		return
	var pending: Dictionary = pending_ground_y.get(unit_id, {"value": incoming_y, "streak": 0})
	if absf(float(pending.value) - incoming_y) <= VERTICAL_SAMPLE_EPSILON:
		pending.streak = int(pending.streak) + 1
	else:
		pending = {"value": incoming_y, "streak": 1}
	if int(pending.streak) >= VERTICAL_SAMPLE_CONFIRMATIONS:
		stable_ground_y[unit_id] = incoming_y
		pending_ground_y.erase(unit_id)
	else:
		pending_ground_y[unit_id] = pending

func _remove_unit(unit_id: int) -> void:
	if unit_id == local_unit_id:
		return
	if unit_id == selected_monster_unit_id:
		_clear_monster_selection()
	if unit_nodes.has(unit_id):
		unit_nodes[unit_id].queue_free()
		unit_nodes.erase(unit_id)
	units.erase(unit_id)
	stable_ground_y.erase(unit_id)
	pending_ground_y.erase(unit_id)

func _on_door_changed(closed: bool, changed: bool) -> void:
	door_closed = closed
	door.visible = closed
	_on_status("动态门已%s%s" % ["关闭" if closed else "打开", "" if changed else "（状态未改变）"], false)

func _on_ping_result(latency_ms: int, server_time_ms: int) -> void:
	last_server_time = server_time_ms
	server_clock_offset_ms = server_time_ms - int(Time.get_unix_time_from_system() * 1000.0)
	latency_label.text = "Ping: %d ms    ServerTime: %d" % [latency_ms, server_time_ms]

func _on_auto_attack_state(state: Dictionary) -> void:
	auto_attack_request_pending = false
	auto_attack_enabled = bool(state.get("enabled", false))
	auto_attack_target_unit_id = int(state.get("target_unit_id", 0))
	auto_attack_phase = int(state.get("phase", 0))
	auto_attack_swing_start_at_ms = int(state.get("swing_start_at_ms", 0))
	auto_attack_swing_interval_ms = max(1, int(state.get("swing_interval_ms", 2000)))

func _on_item_changed(item: Dictionary) -> void:
	if item == null:
		return
	inventory_items[int(item.get("config_id", 0))] = item
	_on_status("道具数量已更新：%s x%d" % [_item_name(int(item.get("config_id", 0))), int(item.get("count", 0))], false)

func _on_buff_added(buff: Dictionary) -> void:
	if buff == null or int(buff.get("unit_id", 0)) != local_unit_id:
		return
	active_buffs[int(buff.get("buff_instance_id", 0))] = buff.duplicate()

func _on_buff_removed(message: Dictionary) -> void:
	if int(message.get("unit_id", 0)) == local_unit_id:
		active_buffs.erase(int(message.get("buff_instance_id", 0)))

func _on_buff_detail(message: Dictionary) -> void:
	for detail in message.get("buffs", []):
		var instance_id := int(detail.get("buff_instance_id", 0))
		if active_buffs.has(instance_id):
			var buff: Dictionary = active_buffs[instance_id]
			buff["absorb_remaining"] = int(detail.get("absorb_remaining", 0))
			buff["revision"] = int(detail.get("revision", buff.get("revision", 0)))

func _on_quest_progress(message: Dictionary) -> void:
	for quest in message.get("quests", []):
		if quest == null:
			continue
		quests[int(quest.get("quest_config_id", 0))] = quest
	for quest_id in message.get("completed", []):
		quests.erase(int(quest_id))
		completed_quest_config_ids[int(quest_id)] = true
	_update_quest_hud()

func _on_skill_cast_state(state: Dictionary) -> void:
	skill_cast_state = state.duplicate()
	if not String(state.get("interrupt_reason", "")).is_empty():
		_on_status("施法被打断：%s" % String(state.get("interrupt_reason", "")), true)

func _on_skill_projectile(message: Dictionary) -> void:
	var cast_id := int(message.get("cast_id", 0))
	if cast_id == 0 or skill_projectiles.has(cast_id):
		return
	var source_id := int(message.get("source_unit_id", 0))
	var target_id := int(message.get("target_unit_id", 0))
	if not unit_nodes.has(source_id):
		return
	var projectile := _create_sphere(0.22, Color("#8fd8ff"))
	projectile.name = "SkillProjectile_%d" % cast_id
	projectile.position = unit_nodes[source_id].position + Vector3.UP * 0.7
	add_child(projectile)
	skill_projectiles[cast_id] = {
		"node": projectile,
		"target_unit_id": target_id,
		"impact_at_ms": int(message.get("impact_at_ms", 0)),
	}

func _on_skill_impact(message: Dictionary) -> void:
	var cast_id := int(message.get("cast_id", 0))
	if skill_projectiles.has(cast_id):
		var flight: Dictionary = skill_projectiles[cast_id]
		var projectile: Node3D = flight.get("node")
		if is_instance_valid(projectile):
			projectile.queue_free()
		skill_projectiles.erase(cast_id)
	var target_id := int(message.get("target_unit_id", 0))
	_on_status("技能命中：%s，伤害 %d" % [_skill_name(int(message.get("skill_id", 0))), int(message.get("damage", 0))], false)
	if bool(message.get("killed", false)) and unit_nodes.has(target_id):
		unit_nodes[target_id].visible = false

func _use_item_slot(slot: int) -> void:
	var config_id := 1001 if slot == 2 else 1002
	if not inventory_items.has(config_id):
		_on_status("没有可用的%s" % _item_name(config_id), true)
		return
	var item: Dictionary = inventory_items[config_id]
	if int(item.get("count", 0)) <= 0:
		_on_status("%s数量不足" % _item_name(config_id), true)
		return
	if client.use_item(int(item.get("item_id", 0))):
		_on_status("正在使用%s" % _item_name(config_id), false)

func _cast_skill_slot(slot: int) -> void:
	# Dictionary.get() returns Variant in Godot; convert explicitly so strict warnings do not stop the demo.
	# Godot 的 Dictionary.get() 返回 Variant，这里显式转成 int，避免严格警告被当成错误。
	var skill_id: int = int({4: 3001, 5: 3002, 6: 3003, 7: 3004, 8: 3005}.get(slot, 0))
	if skill_id == 0:
		return
	var target_id := selected_monster_unit_id
	if target_id == 0:
		_on_status("请先选择一个可见怪物", true)
		return
	if client.cast_skill(skill_id, target_id):
		_on_status("请求施放%s" % _skill_name(skill_id), false)

func _accept_first_quest() -> void:
	for quest_id in [5001, 5002, 5003, 5004]:
		if not quests.has(quest_id) and not completed_quest_config_ids.has(quest_id):
			if client.accept_quest(quest_id):
				_on_status("正在接取任务：%s" % _quest_name(quest_id), false)
			return
	_on_status("没有可接取的任务", false)

func _complete_first_quest() -> void:
	for quest_id in quests:
		var quest: Dictionary = quests[quest_id]
		if bool(quest.get("ready_to_complete", false)):
			if client.complete_quest(int(quest_id)):
				_on_status("正在交付任务：%s" % _quest_name(int(quest_id)), false)
			return
	_on_status("没有可交付的任务", false)

func _update_skill_hud() -> void:
	if skill_label == null:
		return
	var now_ms := _server_now_ms()
	var finish_at := int(skill_cast_state.get("finish_at_ms", 0))
	var skill_id := int(skill_cast_state.get("skill_id", 0))
	var text := "技能：空闲（4-8施法）"
	if not String(skill_cast_state.get("interrupt_reason", "")).is_empty():
		text = "技能：已打断"
	elif skill_id != 0 and finish_at > now_ms:
		var started_at := int(skill_cast_state.get("started_at_ms", now_ms))
		var progress := clampf(float(now_ms - started_at) / float(max(1, finish_at - started_at)), 0.0, 1.0)
		text = "技能：%s 读条 %d%%" % [_skill_name(skill_id), roundi(progress * 100.0)]
	else:
		var gcd_end := int(skill_cast_state.get("global_cooldown_end_at_ms", 0))
		if gcd_end > now_ms:
			text = "技能：公共CD %.1fs" % (float(gcd_end - now_ms) / 1000.0)
	skill_label.text = text

func _update_buff_hud() -> void:
	if buff_label == null:
		return
	if active_buffs.is_empty():
		buff_label.text = "Buff：无"
		return
	var entries: Array[String] = []
	var now_ms := _server_now_ms()
	for buff_id in active_buffs:
		var buff: Dictionary = active_buffs[buff_id]
		var expire_at := int(buff.get("expire_time_ms", 0))
		var remaining := "∞"
		if expire_at > 0:
			var total_seconds := maxi(0, ceili(float(expire_at - now_ms) / 1000.0))
			remaining = "%02d:%02d" % [total_seconds / 60, total_seconds % 60]
		entries.append("%s %s" % [_buff_name(int(buff.get("buff_config_id", 0))), remaining])
	buff_label.text = "Buff：" + " | ".join(entries)

func _update_quest_hud() -> void:
	if quest_label == null:
		return
	if quests.is_empty():
		quest_label.text = "任务：无（Q接取，R交付）"
		return
	var entries: Array[String] = []
	for quest_id in quests:
		var quest: Dictionary = quests[quest_id]
		var progress: Array[String] = []
		for objective in quest.get("objectives", []):
			progress.append("%d/%d" % [int(objective.get("current", 0)), int(objective.get("required", 0))])
		entries.append("%s %s%s" % [_quest_name(int(quest_id)), ",".join(progress), "（可交付）" if bool(quest.get("ready_to_complete", false)) else ""])
	quest_label.text = "任务：" + " | ".join(entries)

func _update_skill_projectiles(_delta: float) -> void:
	var remove_ids: Array[int] = []
	for cast_id in skill_projectiles:
		var flight: Dictionary = skill_projectiles[cast_id]
		var projectile: Node3D = flight.get("node")
		var target_id := int(flight.get("target_unit_id", 0))
		if not is_instance_valid(projectile) or not unit_nodes.has(target_id):
			remove_ids.append(int(cast_id))
			continue
		var target: Node3D = unit_nodes[target_id]
		projectile.position = projectile.position.lerp(target.position + Vector3.UP * 0.7, 0.25)
		if _server_now_ms() >= int(flight.get("impact_at_ms", 0)):
			remove_ids.append(int(cast_id))
	for cast_id in remove_ids:
		var flight: Dictionary = skill_projectiles[cast_id]
		var projectile: Node3D = flight.get("node")
		if is_instance_valid(projectile):
			projectile.queue_free()
		skill_projectiles.erase(cast_id)

func _server_now_ms() -> int:
	return int(Time.get_unix_time_from_system() * 1000.0) + server_clock_offset_ms

func _skill_name(skill_id: int) -> String:
	return {3001: "寒冰箭", 3002: "火焰冲击", 3003: "惩击", 3004: "真言术·盾", 3005: "真言术·韧", 3006: "引导治疗"}.get(skill_id, "Skill#%d" % skill_id)

func _item_name(config_id: int) -> String:
	return {1001: "小型生命药水", 1002: "大型生命药水"}.get(config_id, "Item#%d" % config_id)

func _buff_name(buff_id: int) -> String:
	return {2001: "持续恢复", 4001: "冰冷", 4002: "灼烧", 4003: "真言术·盾", 4004: "虚弱灵魂", 4005: "真言术·韧"}.get(buff_id, "Buff#%d" % buff_id)

func _quest_name(quest_id: int) -> String:
	return {5001: "清理怪物", 5002: "试用药水", 5003: "前往地图2", 5004: "进阶试炼"}.get(quest_id, "Quest#%d" % quest_id)

func _toggle_auto_attack() -> void:
	if client == null or client.phase != "map" or auto_attack_request_pending:
		return
	var target_unit_id := selected_monster_unit_id if selected_monster_unit_id != 0 else _find_first_monster_unit_id()
	var enabled := not auto_attack_enabled
	if enabled and target_unit_id == 0:
		_on_status("请先选择一个可见怪物 / Select a visible monster first", true)
		return
	if client.toggle_auto_attack(enabled, target_unit_id):
		auto_attack_request_pending = true

func _find_first_monster_unit_id() -> int:
	for unit_id in units:
		if int(units[unit_id].get("entity_type", 0)) == 2:
			return int(unit_id)
	return 0

func _update_auto_attack_hud() -> void:
	if auto_attack_label == null:
		return
	if not auto_attack_enabled:
		auto_attack_label.text = "平A：未激活（按 1 开始） / Auto attack: off (press 1)"
		return
	var now_ms := int(Time.get_unix_time_from_system() * 1000.0) + server_clock_offset_ms
	var progress := 0.0
	if auto_attack_swing_start_at_ms > 0:
		progress = clampf(float(now_ms - auto_attack_swing_start_at_ms) / float(auto_attack_swing_interval_ms), 0.0, 1.0)
	var filled := clampi(roundi(progress * 20.0), 0, 20)
	var bar := "[" + "#".repeat(filled) + "-".repeat(20 - filled) + "]"
	auto_attack_label.text = "平A：%s %d%%  目标：%d" % [bar, roundi(progress * 100.0), auto_attack_target_unit_id]

func _on_status(text: String, is_error: bool) -> void:
	status_label.text = text
	status_label.modulate = Color("#ff8c78") if is_error else Color.WHITE

func _create_box(size: Vector3, color: Color) -> MeshInstance3D:
	var node := MeshInstance3D.new()
	var mesh := BoxMesh.new()
	mesh.size = size
	node.mesh = mesh
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	node.material_override = material
	return node

func _create_sphere(radius: float, color: Color) -> MeshInstance3D:
	var node := MeshInstance3D.new()
	var mesh := SphereMesh.new()
	mesh.radius = radius
	mesh.height = radius * 2.0
	node.mesh = mesh
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.emission_enabled = true
	material.emission = color
	material.emission_energy_multiplier = 1.5
	node.material_override = material
	return node

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
	client.door_changed.connect(_on_door_changed)
	client.ping_result.connect(_on_ping_result)
	client.start("godot_%d" % Time.get_ticks_msec())

func _process(delta: float) -> void:
	_update_direction_input(delta)
	_update_units(delta)
	_update_camera(delta)

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

	var floor := _create_box(Vector3(MAP_SIZE, 0.2, MAP_SIZE), Color("#395b59"))
	floor.position = Vector3(0.0, -0.1, 0.0)
	floor.name = "NavigationFloor"
	add_child(floor)

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
	var help := Label.new()
	help.position = Vector2(24.0, 650.0)
	help.add_theme_font_size_override("font_size", 16)
	help.text = "左键：服务端寻路    W/S：前后移动    A/D：转身    按住右键时 A/D：平移    E：动态门    滚轮：镜头距离"
	canvas.add_child(help)

func _update_direction_input(delta: float) -> void:
	if client == null or client.phase != "map":
		return
	var forward := int(Input.is_key_pressed(KEY_W)) - int(Input.is_key_pressed(KEY_S))
	var horizontal := int(Input.is_key_pressed(KEY_D)) - int(Input.is_key_pressed(KEY_A))
	var turning := 0 if right_mouse_held else horizontal
	var strafe := horizontal if right_mouse_held else 0
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
	var hit = Plane(Vector3.UP, 0.0).intersects_ray(origin, direction)
	if hit is Vector3 and absf(hit.x) <= MAP_SIZE * 0.5 and absf(hit.z) <= MAP_SIZE * 0.5:
		client.navigate_to(hit.x, 0.0, hit.z, sequence)
		sequence += 1

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
	_upsert_unit({"unit_id": snapshot.unit_id, "x": snapshot.x, "y": snapshot.y, "z": snapshot.z, "yaw": 0.0}, true)
	for entity in snapshot.entities:
		_upsert_unit(entity, true)

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

func _upsert_unit(state: Dictionary, snap: bool) -> void:
	var unit_id: int = state.unit_id
	var created := false
	if not units.has(unit_id):
		var node := _create_box(Vector3(0.8, PLAYER_HEIGHT, 0.8), Color("#e6cf58") if unit_id == local_unit_id else Color("#70a7d8"))
		node.name = "Unit_%d" % unit_id
		add_child(node)
		unit_nodes[unit_id] = node
		units[unit_id] = state.duplicate()
		stable_ground_y[unit_id] = float(state.y)
		pending_ground_y.erase(unit_id)
		created = true
	else:
		for key in state:
			units[unit_id][key] = state[key]
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
	latency_label.text = "Ping: %d ms    ServerTime: %d" % [latency_ms, server_time_ms]

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

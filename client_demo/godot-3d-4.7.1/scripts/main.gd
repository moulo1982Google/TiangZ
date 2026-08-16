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
var game_ui_root: Control
var auth_ui_root: Control
var auth_panel: Panel
var auth_title: Label
var auth_subtitle: Label
var auth_account_input: LineEdit
var auth_password_input: LineEdit
var auth_confirm_input: LineEdit
var auth_confirm_label: Label
var auth_submit_button: Button
var auth_mode_button: Button
var auth_error_label: Label
var auth_register_mode := false
var local_numerics: Dictionary = {}
var selected_monster_unit_id := 0
var selected_npc_unit_id := 0
var nearby_npc_unit_id := 0
var selected_monster_marker: MeshInstance3D
var entity_name_labels: Dictionary = {}
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
var skill_progress_bar: ProgressBar
var skill_buttons: Dictionary = {}
var item_buttons: Dictionary = {}
var inventory_toggle_button: Button
var inventory_panel: Panel
var inventory_list: VBoxContainer
var npc_interaction_button: Button
var npc_dialog: Panel
var npc_dialog_text: Label
var npc_dialog_action_button: Button
var npc_dialog_close_button: Button
var loot_interaction_button: Button
var loot_panel: Panel
var loot_title: Label
var loot_list: VBoxContainer
var loot_result: Label
var loot_all_button: Button
var inspected_loot: Array = []
var inspected_loot_monster_id := 0
var loot_operation_id := ""
var skill_channel_beam: MeshInstance3D

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
	client.loot_inspected.connect(_on_loot_inspected)
	client.loot_result.connect(_on_loot_result)
	client.session_replaced.connect(_on_session_replaced)
	_build_auth_ui()
	_set_game_ui_visible(false)

func _process(delta: float) -> void:
	_update_direction_input(delta)
	_update_units(delta)
	_update_camera(delta)
	_update_auto_attack_hud()
	_update_skill_hud()
	_update_buff_hud()
	_update_quest_hud()
	_update_skill_projectiles(delta)
	_update_skill_channel_beam()
	_update_npc_interaction_hud()
	_update_loot_interaction_hud()

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseButton:
		if event.button_index == MOUSE_BUTTON_RIGHT:
			right_mouse_held = event.pressed
			Input.set_mouse_mode(Input.MOUSE_MODE_CAPTURED if event.pressed else Input.MOUSE_MODE_VISIBLE)
		elif event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
			if not _is_pointer_over_game_ui(event.position):
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
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_F:
		_interact_nearby()
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_1:
		_toggle_auto_attack()
	if event is InputEventKey and event.pressed and not event.echo:
		if event.keycode == KEY_2 or event.keycode == KEY_3:
			_use_item_slot(event.keycode - KEY_0)
		elif event.keycode == KEY_B:
			_toggle_inventory()
		elif event.keycode >= KEY_4 and event.keycode <= KEY_8:
			_cast_skill_slot(event.keycode - KEY_0)
		elif event.keycode == KEY_9:
			_cast_skill_slot(9)
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
	game_ui_root = Control.new()
	game_ui_root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	game_ui_root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	canvas.add_child(game_ui_root)
	status_label = Label.new()
	status_label.position = Vector2(24.0, 20.0)
	status_label.add_theme_font_size_override("font_size", 20)
	status_label.text = "正在连接 TiangZ..."
	game_ui_root.add_child(status_label)
	latency_label = Label.new()
	latency_label.position = Vector2(24.0, 54.0)
	latency_label.add_theme_font_size_override("font_size", 16)
	latency_label.text = "Ping: --"
	game_ui_root.add_child(latency_label)
	selected_monster_label = Label.new()
	selected_monster_label.position = Vector2(24.0, 88.0)
	selected_monster_label.add_theme_font_size_override("font_size", 16)
	selected_monster_label.text = "目标：未选择怪物"
	game_ui_root.add_child(selected_monster_label)
	player_hp_label = Label.new()
	player_hp_label.position = Vector2(24.0, 156.0)
	player_hp_label.add_theme_font_size_override("font_size", 16)
	player_hp_label.modulate = Color("#ff5964")
	player_hp_label.text = "玩家 HP：-- / --"
	game_ui_root.add_child(player_hp_label)
	player_mp_label = Label.new()
	player_mp_label.position = Vector2(24.0, 180.0)
	player_mp_label.add_theme_font_size_override("font_size", 16)
	player_mp_label.modulate = Color("#5b9cff")
	player_mp_label.text = "玩家 MP：-- / --"
	game_ui_root.add_child(player_mp_label)
	auto_attack_label = Label.new()
	auto_attack_label.position = Vector2(24.0, 204.0)
	auto_attack_label.add_theme_font_size_override("font_size", 16)
	auto_attack_label.text = "平A：未激活（按 1 开始）"
	game_ui_root.add_child(auto_attack_label)
	skill_label = Label.new()
	skill_label.position = Vector2(24.0, 238.0)
	skill_label.add_theme_font_size_override("font_size", 15)
	skill_label.text = "技能：空闲（4-9施法）"
	game_ui_root.add_child(skill_label)
	buff_label = Label.new()
	buff_label.position = Vector2(24.0, 282.0)
	buff_label.add_theme_font_size_override("font_size", 15)
	buff_label.text = "Buff：无"
	game_ui_root.add_child(buff_label)
	quest_label = Label.new()
	quest_label.position = Vector2(24.0, 350.0)
	quest_label.add_theme_font_size_override("font_size", 15)
	quest_label.text = "任务：无（Q接取，R交付）"
	game_ui_root.add_child(quest_label)
	var help := Label.new()
	help.position = Vector2(24.0, 650.0)
	help.add_theme_font_size_override("font_size", 16)
	help.text = "左键：选择实体    W/S：前后移动    A/D：转身    按住右键时 A/D：平移    1平A  2/3道具  4-9技能  B：背包  F：NPC交互/拾取全部    E：动态门    滚轮：镜头距离"
	help.position = Vector2(24.0, 620.0)
	game_ui_root.add_child(help)

	# 技能和道具使用按钮只负责调用同一套键盘入口，避免桌面按钮与快捷键产生两套语义。
	# Skill and item buttons call the same keyboard paths so mouse and hotkeys share one behavior.
	var skill_bar := HBoxContainer.new()
	skill_bar.position = Vector2(280.0, 620.0)
	game_ui_root.add_child(skill_bar)
	for slot in [4, 5, 6, 7, 8, 9]:
		var button := Button.new()
		button.text = "%d %s" % [slot, _skill_name(_skill_id_for_slot(slot))]
		button.custom_minimum_size = Vector2(118.0, 42.0)
		button.pressed.connect(_cast_skill_slot.bind(slot))
		skill_bar.add_child(button)
		skill_buttons[slot] = button

	var item_bar := HBoxContainer.new()
	item_bar.position = Vector2(500.0, 670.0)
	game_ui_root.add_child(item_bar)
	for slot in [2, 3]:
		var item_button := Button.new()
		item_button.text = "%d %s" % [slot, _item_name(1001 if slot == 2 else 1002)]
		item_button.custom_minimum_size = Vector2(150.0, 42.0)
		item_button.pressed.connect(_use_item_slot.bind(slot))
		item_bar.add_child(item_button)
		item_buttons[slot] = item_button

	skill_progress_bar = ProgressBar.new()
	skill_progress_bar.position = Vector2(330.0, 570.0)
	skill_progress_bar.size = Vector2(420.0, 28.0)
	skill_progress_bar.min_value = 0.0
	skill_progress_bar.max_value = 1.0
	skill_progress_bar.value = 0.0
	game_ui_root.add_child(skill_progress_bar)

	npc_interaction_button = Button.new()
	npc_interaction_button.position = Vector2(380.0, 420.0)
	npc_interaction_button.size = Vector2(260.0, 48.0)
	npc_interaction_button.text = "交互：任务使者（F）"
	npc_interaction_button.visible = false
	npc_interaction_button.pressed.connect(_interact_nearby)
	game_ui_root.add_child(npc_interaction_button)

	loot_interaction_button = Button.new()
	loot_interaction_button.position = Vector2(380.0, 470.0)
	loot_interaction_button.size = Vector2(260.0, 42.0)
	loot_interaction_button.text = "查看尸体掉落"
	loot_interaction_button.visible = false
	loot_interaction_button.pressed.connect(_inspect_selected_loot)
	game_ui_root.add_child(loot_interaction_button)

	_build_npc_dialog()
	_build_loot_panel()
	_build_inventory_panel()

## 构建桌面版登录/注册面板；默认是登录，注册只是显式切换，不会打开页面就自动注册。
## Builds the desktop login/register panel; login is the default and registration is explicit.
func _build_auth_ui() -> void:
	auth_ui_root = Control.new()
	auth_ui_root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	auth_ui_root.mouse_filter = Control.MOUSE_FILTER_STOP
	add_child(auth_ui_root)
	auth_panel = Panel.new()
	auth_panel.position = Vector2(300.0, 170.0)
	auth_panel.size = Vector2(400.0, 360.0)
	auth_ui_root.add_child(auth_panel)
	var box := VBoxContainer.new()
	box.position = Vector2(28.0, 24.0)
	box.size = Vector2(344.0, 312.0)
	auth_panel.add_child(box)
	auth_title = Label.new()
	auth_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	auth_title.add_theme_font_size_override("font_size", 26)
	box.add_child(auth_title)
	auth_subtitle = Label.new()
	auth_subtitle.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	box.add_child(auth_subtitle)
	auth_account_input = LineEdit.new()
	auth_account_input.placeholder_text = "用户名"
	auth_account_input.text = "godot_%d" % Time.get_ticks_msec()
	box.add_child(auth_account_input)
	auth_password_input = LineEdit.new()
	auth_password_input.placeholder_text = "密码（6-64个字符）"
	auth_password_input.secret = true
	box.add_child(auth_password_input)
	auth_confirm_label = Label.new()
	auth_confirm_label.text = "确认密码"
	box.add_child(auth_confirm_label)
	auth_confirm_input = LineEdit.new()
	auth_confirm_input.placeholder_text = "确认密码"
	auth_confirm_input.secret = true
	box.add_child(auth_confirm_input)
	auth_error_label = Label.new()
	auth_error_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	auth_error_label.modulate = Color("#ff8c78")
	box.add_child(auth_error_label)
	var actions := HBoxContainer.new()
	box.add_child(actions)
	auth_submit_button = Button.new()
	auth_submit_button.custom_minimum_size = Vector2(165.0, 44.0)
	auth_submit_button.pressed.connect(_submit_auth)
	actions.add_child(auth_submit_button)
	auth_mode_button = Button.new()
	auth_mode_button.custom_minimum_size = Vector2(165.0, 44.0)
	auth_mode_button.pressed.connect(_toggle_auth_mode)
	actions.add_child(auth_mode_button)
	_set_auth_mode(false)

func _set_auth_mode(registering: bool) -> void:
	auth_register_mode = registering
	auth_title.text = "注册 TiangZ Godot Demo" if registering else "TiangZ Godot Demo"
	auth_subtitle.text = "用户名同时作为角色名" if registering else "请输入账号和密码登录"
	auth_confirm_label.visible = registering
	auth_confirm_input.visible = registering
	auth_submit_button.text = "注册并进入游戏" if registering else "登录"
	auth_mode_button.text = "返回登录" if registering else "注册"
	auth_error_label.text = ""

func _toggle_auth_mode() -> void:
	_set_auth_mode(not auth_register_mode)

func _submit_auth() -> void:
	var account := auth_account_input.text.strip_edges()
	var password := auth_password_input.text
	if account.is_empty():
		_set_auth_error("请输入用户名")
		return
	if password.length() < 6 or password.length() > 64:
		_set_auth_error("密码长度必须是6到64个字符")
		return
	if auth_register_mode and password != auth_confirm_input.text:
		_set_auth_error("两次密码不一致")
		return
	auth_submit_button.disabled = true
	_set_auth_error("正在连接服务器...", false)
	if auth_register_mode:
		client.register(account, password)
	else:
		client.start(account, password)

func _set_auth_error(message: String, is_error: bool = true) -> void:
	if auth_error_label:
		auth_error_label.text = message
		auth_error_label.modulate = Color("#ff8c78") if is_error else Color("#b4d7ff")

func _set_game_ui_visible(visible: bool) -> void:
	if game_ui_root:
		game_ui_root.visible = visible
	if auth_ui_root:
		auth_ui_root.visible = not visible
	if auth_submit_button:
		auth_submit_button.disabled = false

func _is_pointer_over_game_ui(_position: Vector2) -> bool:
	# Godot的Button会消费已处理输入；保留这个边界，便于以后接入可点击的3D HUD。
	# Godot Buttons consume handled input; keep this boundary for future interactive 3D HUDs.
	return false

func _build_npc_dialog() -> void:
	npc_dialog = Panel.new()
	npc_dialog.position = Vector2(330.0, 260.0)
	npc_dialog.size = Vector2(420.0, 210.0)
	npc_dialog.visible = false
	game_ui_root.add_child(npc_dialog)
	var box := VBoxContainer.new()
	box.position = Vector2(24.0, 18.0)
	box.size = Vector2(372.0, 174.0)
	npc_dialog.add_child(box)
	npc_dialog_text = Label.new()
	npc_dialog_text.custom_minimum_size = Vector2(372.0, 90.0)
	npc_dialog_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(npc_dialog_text)
	var actions := HBoxContainer.new()
	box.add_child(actions)
	npc_dialog_action_button = Button.new()
	npc_dialog_action_button.custom_minimum_size = Vector2(280.0, 44.0)
	npc_dialog_action_button.pressed.connect(_npc_quest_action)
	actions.add_child(npc_dialog_action_button)
	npc_dialog_close_button = Button.new()
	npc_dialog_close_button.text = "关闭"
	npc_dialog_close_button.custom_minimum_size = Vector2(80.0, 44.0)
	npc_dialog_close_button.pressed.connect(_close_npc_dialog)
	actions.add_child(npc_dialog_close_button)

func _build_loot_panel() -> void:
	loot_panel = Panel.new()
	loot_panel.position = Vector2(760.0, 210.0)
	loot_panel.size = Vector2(360.0, 320.0)
	loot_panel.visible = false
	game_ui_root.add_child(loot_panel)
	var box := VBoxContainer.new()
	box.position = Vector2(18.0, 14.0)
	box.size = Vector2(324.0, 292.0)
	loot_panel.add_child(box)
	loot_title = Label.new()
	loot_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	loot_title.text = "尸体掉落"
	box.add_child(loot_title)
	loot_list = VBoxContainer.new()
	loot_list.custom_minimum_size = Vector2(324.0, 170.0)
	box.add_child(loot_list)
	loot_result = Label.new()
	loot_result.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	box.add_child(loot_result)
	var actions := HBoxContainer.new()
	box.add_child(actions)
	loot_all_button = Button.new()
	loot_all_button.text = "全部拾取"
	loot_all_button.pressed.connect(_loot_all)
	actions.add_child(loot_all_button)
	var close := Button.new()
	close.text = "关闭"
	close.pressed.connect(_close_loot_panel)
	actions.add_child(close)

## 构建桌面版背包；背包只展示服务端快照，使用按钮仍调用同一个UseItem RPC。
## Builds the desktop inventory; it only displays server snapshots and uses the same UseItem RPC as the hotbar.
func _build_inventory_panel() -> void:
	inventory_toggle_button = Button.new()
	inventory_toggle_button.position = Vector2(24.0, 392.0)
	inventory_toggle_button.size = Vector2(160.0, 40.0)
	inventory_toggle_button.text = "背包（B）"
	inventory_toggle_button.pressed.connect(_toggle_inventory)
	game_ui_root.add_child(inventory_toggle_button)

	inventory_panel = Panel.new()
	inventory_panel.position = Vector2(280.0, 150.0)
	inventory_panel.size = Vector2(680.0, 410.0)
	inventory_panel.visible = false
	game_ui_root.add_child(inventory_panel)
	var box := VBoxContainer.new()
	box.position = Vector2(20.0, 16.0)
	box.size = Vector2(640.0, 378.0)
	inventory_panel.add_child(box)
	var header := HBoxContainer.new()
	box.add_child(header)
	var title := Label.new()
	title.text = "背包 / Inventory"
	title.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	title.add_theme_font_size_override("font_size", 22)
	header.add_child(title)
	var close := Button.new()
	close.text = "关闭"
	close.pressed.connect(_close_inventory)
	header.add_child(close)
	var scroll := ScrollContainer.new()
	scroll.custom_minimum_size = Vector2(640.0, 330.0)
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	box.add_child(scroll)
	inventory_list = VBoxContainer.new()
	inventory_list.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	inventory_list.add_theme_constant_override("separation", 8)
	scroll.add_child(inventory_list)
	_render_inventory_panel()

func _toggle_inventory() -> void:
	if client == null or client.phase != "map":
		return
	if inventory_panel:
		inventory_panel.visible = not inventory_panel.visible
		if inventory_panel.visible:
			_render_inventory_panel()

func _close_inventory() -> void:
	if inventory_panel:
		inventory_panel.visible = false

## 以ItemConfig分组展示背包；数量和可用性来自服务端，客户端不预扣、不猜测事务结果。
## Renders inventory entries by ItemConfig; count and usability are server-authoritative.
func _render_inventory_panel() -> void:
	if inventory_list == null:
		return
	for child in inventory_list.get_children():
		child.queue_free()
	var config_ids: Array[int] = []
	for key in inventory_items.keys():
		var config_id: int = int(key)
		var item: Dictionary = inventory_items[key]
		if int(item.get("count", 0)) > 0:
			config_ids.append(config_id)
	config_ids.sort()
	if config_ids.is_empty():
		var empty_label := Label.new()
		empty_label.text = "背包是空的"
		empty_label.add_theme_font_size_override("font_size", 18)
		inventory_list.add_child(empty_label)
		return
	for config_id in config_ids:
		var item: Dictionary = inventory_items[config_id]
		var row := HBoxContainer.new()
		row.custom_minimum_size = Vector2(600.0, 52.0)
		var label := Label.new()
		label.text = "%s    数量：%d" % [_item_name(config_id), int(item.get("count", 0))]
		label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		row.add_child(label)
		var use_button := Button.new()
		use_button.text = "使用"
		use_button.custom_minimum_size = Vector2(90.0, 42.0)
		use_button.pressed.connect(_use_inventory_config.bind(config_id))
		row.add_child(use_button)
		inventory_list.add_child(row)

func _use_inventory_config(config_id: int) -> void:
	if not inventory_items.has(config_id):
		_on_status("没有可用的%s" % _item_name(config_id), true)
		return
	var item: Dictionary = inventory_items[config_id]
	if int(item.get("count", 0)) <= 0:
		_on_status("%s数量不足" % _item_name(config_id), true)
		return
	if client.use_item(int(item.get("item_id", 0))):
		_on_status("正在使用%s" % _item_name(config_id), false)

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
	var selected_unit_id: int = _pick_selectable_from_screen(origin, direction)
	if selected_unit_id != 0:
		_select_unit(selected_unit_id)
		return
	# 与Cocos3D桌面演示保持一致：当前版本暂时关闭点击地面寻路，保留原计算代码供以后恢复。
	# Match the Cocos3D desktop demo: ground-click navigation is temporarily disabled; keep the old calculation for a future restore.
	# var hit = Plane(Vector3.UP, 0.0).intersects_ray(origin, direction)
	# if hit is Vector3 and absf(hit.x) <= MAP_SIZE * 0.5 and absf(hit.z) <= MAP_SIZE * 0.5:
	# 	client.navigate_to(hit.x, 0.0, hit.z, sequence)
	# 	sequence += 1

## 用射线和怪物表现方块做AABB相交；命中怪物后不再进入地面寻路。
## Uses ray/AABB intersection against monster grayboxes so a monster click never falls through to ground navigation.
func _pick_monster_from_screen(origin: Vector3, direction: Vector3) -> int:
	return _pick_selectable_from_screen(origin, direction)

## 选择可见的怪物或NPC；点击实体后绝不能穿透到地面行为。
## Picks a visible monster or NPC; an entity hit must never fall through to ground behavior.
func _pick_selectable_from_screen(origin: Vector3, direction: Vector3) -> int:
	var nearest_unit_id := 0
	var nearest_distance := INF
	for unit_id in units:
		var state: Dictionary = units[unit_id]
		var entity_type: int = int(state.get("entity_type", 0))
		if (entity_type != 2 and entity_type != 3) or not unit_nodes.has(unit_id):
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
	_select_unit(unit_id)

## 统一选择怪物/NPC；两种实体共用脚底标记和目标HUD，技能只读取怪物目标。
## Selects monster/NPC through one path; both share the marker/target HUD while skills only consume monster targets.
func _select_unit(unit_id: int) -> void:
	if selected_monster_unit_id == unit_id or selected_npc_unit_id == unit_id:
		return
	_clear_monster_selection()
	if not units.has(unit_id) or not unit_nodes.has(unit_id):
		return
	var state: Dictionary = units[unit_id]
	var entity_type: int = int(state.get("entity_type", 0))
	if entity_type != 2 and entity_type != 3:
		return
	if entity_type == 2:
		selected_monster_unit_id = unit_id
	else:
		selected_npc_unit_id = unit_id
	var node: Node3D = unit_nodes[unit_id]
	_create_selection_marker(node)
	_set_unit_color(unit_id)
	selected_monster_label.text = "%s：%s\n实例ID：%d" % ["NPC" if entity_type == 3 else "目标", _entity_name(state), unit_id]

func _clear_monster_selection() -> void:
	if selected_monster_unit_id != 0 and unit_nodes.has(selected_monster_unit_id):
		_set_unit_color(selected_monster_unit_id)
	if selected_npc_unit_id != 0 and unit_nodes.has(selected_npc_unit_id):
		_set_unit_color(selected_npc_unit_id)
	if selected_monster_marker:
		selected_monster_marker.queue_free()
		selected_monster_marker = null
	selected_monster_unit_id = 0
	selected_npc_unit_id = 0
	if selected_monster_label:
		selected_monster_label.text = "目标：未选择实体"
	if npc_dialog:
		npc_dialog.visible = false
	if loot_panel:
		loot_panel.visible = false
	inspected_loot.clear()
	inspected_loot_monster_id = 0

func _monster_name(config_id: int) -> String:
	match config_id:
		1:
			return "怪A"
		2:
			return "怪B"
		_:
			return "MonsterConfig#%d" % config_id

func _npc_name(config_id: int) -> String:
	match config_id:
		9001:
			return "任务使者"
		_:
			return "NpcConfig#%d" % config_id

func _entity_name(state: Dictionary) -> String:
	var display_name: String = String(state.get("display_name", "")).strip_edges()
	if not display_name.is_empty():
		return display_name
	var entity_type: int = int(state.get("entity_type", 0))
	var config_id: int = int(state.get("config_id", 0))
	if entity_type == 1:
		var account: String = String(state.get("account", "玩家"))
		return account if not account.is_empty() else "玩家"
	if entity_type == 2:
		return _monster_name(config_id)
	if entity_type == 3:
		return _npc_name(config_id)
	return "Entity#%d" % int(state.get("unit_id", 0))

func _set_unit_color(unit_id: int) -> void:
	if not unit_nodes.has(unit_id) or not units.has(unit_id):
		return
	var state: Dictionary = units[unit_id]
	var entity_type := int(state.get("entity_type", 0))
	var config_id := int(state.get("config_id", 0))
	var color := (
		Color("#36b7e8") if unit_id == local_unit_id else
		Color("#af50e6") if entity_type == 3 else
		Color("#ef4d47") if entity_type == 2 and config_id == 2 else
		Color("#ffd746") if entity_type == 2 else
		Color("#50d77d")
	)
	if not bool(state.get("alive", true)) and entity_type == 2:
		color = Color("#777777")
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
	_clear_monster_selection()
	for old_unit_id in unit_nodes.keys():
		var old_node: Node3D = unit_nodes[old_unit_id]
		if is_instance_valid(old_node):
			old_node.queue_free()
	units.clear()
	unit_nodes.clear()
	stable_ground_y.clear()
	pending_ground_y.clear()
	entity_name_labels.clear()
	for cast_id in skill_projectiles.keys():
		var flight: Dictionary = skill_projectiles[cast_id]
		var projectile: Node3D = flight.get("node")
		if is_instance_valid(projectile):
			projectile.queue_free()
	skill_projectiles.clear()
	if skill_channel_beam and is_instance_valid(skill_channel_beam):
		skill_channel_beam.queue_free()
	skill_channel_beam = null
	skill_cast_state.clear()
	active_buffs.clear()
	auto_attack_enabled = false
	auto_attack_target_unit_id = 0
	local_unit_id = snapshot.unit_id
	_set_game_ui_visible(true)
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
	_upsert_unit({"unit_id": snapshot.unit_id, "x": snapshot.x, "y": snapshot.y, "z": snapshot.z, "yaw": 0.0, "alive": true, "entity_type": 1, "config_id": 0, "account": snapshot.get("account", "玩家"), "display_name": snapshot.get("account", "玩家")}, true)
	for entity in snapshot.entities:
		_upsert_unit(entity, true)
		for numeric in entity.get("numerics", []):
			_apply_entity_numeric(numeric)
		for buff in entity.get("buffs", []):
			_on_buff_added(buff)
	_update_player_stats_hud()
	_update_item_buttons()
	_render_inventory_panel()
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
			# 尸体仍是可拾取实体；只改变颜色，不隐藏也不清除选中状态。
			# A corpse remains a lootable entity; change its color but keep it visible and selectable.
			unit_nodes[unit_id].visible = true
			_set_unit_color(unit_id)
	_update_loot_interaction_hud()

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
	unit_nodes[unit_id].visible = true
	_set_unit_color(unit_id)
	_ensure_entity_name_label(unit_id)
	_accept_ground_y(unit_id, float(state.y))
	if created or snap:
		var current: Dictionary = units[unit_id]
		unit_nodes[unit_id].position = Vector3(current.x, _render_ground_y(unit_id, current) + PLAYER_HEIGHT * 0.5, current.z)

## 为玩家、NPC和怪物创建头顶名称；名称来自服务端快照，配置名只作为兼容回退。
## Creates overhead names for players, NPCs, and monsters; server display_name is authoritative, config names are fallback only.
func _ensure_entity_name_label(unit_id: int) -> void:
	if not units.has(unit_id) or not unit_nodes.has(unit_id):
		return
	var state: Dictionary = units[unit_id]
	var entity_type: int = int(state.get("entity_type", 0))
	if entity_type < 1 or entity_type > 3:
		return
	var label: Label3D
	if entity_name_labels.has(unit_id) and is_instance_valid(entity_name_labels[unit_id]):
		label = entity_name_labels[unit_id]
	else:
		label = Label3D.new()
		label.name = "EntityName_%d" % unit_id
		label.position = Vector3(0.0, PLAYER_HEIGHT * 0.7 + 0.25, 0.0)
		label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
		label.no_depth_test = true
		label.font_size = 32
		label.outline_size = 8
		unit_nodes[unit_id].add_child(label)
		entity_name_labels[unit_id] = label
	label.text = _entity_name(state)
	label.modulate = Color("#d9f4ff") if entity_type == 1 else Color("#f5e6b5") if entity_type == 2 else Color("#f0c7ff")

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
	if unit_id == selected_monster_unit_id or unit_id == selected_npc_unit_id:
		_clear_monster_selection()
	if entity_name_labels.has(unit_id):
		var label: Label3D = entity_name_labels[unit_id]
		if is_instance_valid(label):
			label.queue_free()
		entity_name_labels.erase(unit_id)
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
	_update_item_buttons()
	_render_inventory_panel()
	_on_status("道具数量已更新：%s x%d" % [_item_name(int(item.get("config_id", 0))), int(item.get("count", 0))], false)

func _update_item_buttons() -> void:
	for slot in [2, 3]:
		if not item_buttons.has(slot):
			continue
		var config_id: int = 1001 if slot == 2 else 1002
		var count := 0
		if inventory_items.has(config_id):
			var item: Dictionary = inventory_items[config_id]
			count = int(item.get("count", 0))
		var button: Button = item_buttons[slot]
		button.text = "%d %s x%d" % [slot, _item_name(config_id), count]
		button.disabled = count <= 0

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
	_refresh_npc_dialog()

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
	# 死亡表现由G2C_EntityState/alive驱动；技能命中不能提前删除尸体，否则掉落窗口无实体可绑定。
	# Death presentation is driven by G2C_EntityState/alive; an impact must not hide the corpse before loot is resolved.
	if bool(message.get("killed", false)) and units.has(target_id):
		var state: Dictionary = units[target_id]
		state["alive"] = false
		_set_unit_color(target_id)
		_update_loot_interaction_hud()

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
	var skill_id: int = _skill_id_for_slot(slot)
	if skill_id == 0:
		return
	var target_id := selected_monster_unit_id
	if target_id == 0:
		_on_status("请先选择一个可见怪物", true)
		return
	if client.cast_skill(skill_id, target_id):
		_on_status("请求施放%s" % _skill_name(skill_id), false)

func _skill_id_for_slot(slot: int) -> int:
	return int({4: 3001, 5: 3002, 6: 3003, 7: 3004, 8: 3005, 9: 3007}.get(slot, 0))

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
	var text := "技能：空闲（4-9施法）"
	var progress := 0.0
	if not String(skill_cast_state.get("interrupt_reason", "")).is_empty():
		text = "技能：已打断"
	elif skill_id != 0 and finish_at > now_ms:
		var started_at := int(skill_cast_state.get("started_at_ms", now_ms))
		progress = clampf(float(now_ms - started_at) / float(max(1, finish_at - started_at)), 0.0, 1.0)
		var channel_count := int(skill_cast_state.get("channel_tick_count", 0))
		if channel_count > 0:
			text = "技能：%s 引导 %d%%（受击/移动会减少剩余时间）" % [_skill_name(skill_id), roundi((1.0 - progress) * 100.0)]
		else:
			text = "技能：%s 读条 %d%%" % [_skill_name(skill_id), roundi(progress * 100.0)]
	else:
		var gcd_end := int(skill_cast_state.get("global_cooldown_end_at_ms", 0))
		if gcd_end > now_ms:
			text = "技能：公共CD %.1fs" % (float(gcd_end - now_ms) / 1000.0)
	skill_label.text = text
	if skill_progress_bar:
		var channel := int(skill_cast_state.get("channel_tick_count", 0)) > 0 and skill_id != 0 and finish_at > now_ms
		skill_progress_bar.value = (1.0 - progress) if channel else progress
		if not skill_cast_state.has("started_at_ms") or finish_at <= now_ms:
			skill_progress_bar.value = 0.0

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

func _find_nearby_npc() -> int:
	if not units.has(local_unit_id):
		return 0
	var player: Dictionary = units[local_unit_id]
	var nearest_id := 0
	var nearest_distance := INF
	for unit_id in units:
		var state: Dictionary = units[unit_id]
		if int(state.get("entity_type", 0)) != 3 or not bool(state.get("alive", true)):
			continue
		var dx := float(state.get("x", 0.0)) - float(player.get("x", 0.0))
		var dz := float(state.get("z", 0.0)) - float(player.get("z", 0.0))
		var distance := sqrt(dx * dx + dz * dz)
		if distance <= 5.0 and distance < nearest_distance:
			nearest_id = int(unit_id)
			nearest_distance = distance
	return nearest_id

func _update_npc_interaction_hud() -> void:
	nearby_npc_unit_id = _find_nearby_npc()
	if npc_interaction_button == null:
		return
	npc_interaction_button.visible = nearby_npc_unit_id != 0
	if nearby_npc_unit_id != 0 and units.has(nearby_npc_unit_id):
		npc_interaction_button.text = "交互：%s（F键）" % _entity_name(units[nearby_npc_unit_id])
	if npc_dialog and npc_dialog.visible:
		if nearby_npc_unit_id == 0 or selected_npc_unit_id != nearby_npc_unit_id:
			_close_npc_dialog()
		else:
			_refresh_npc_dialog()

func _interact_nearby() -> void:
	if nearby_npc_unit_id != 0:
		_select_unit(nearby_npc_unit_id)
		npc_dialog.visible = true
		_refresh_npc_dialog()
		return
	if selected_monster_unit_id != 0 and units.has(selected_monster_unit_id):
		var monster: Dictionary = units[selected_monster_unit_id]
		if not bool(monster.get("alive", true)):
			var player: Dictionary = units.get(local_unit_id, {})
			var dx := float(monster.get("x", 0.0)) - float(player.get("x", 0.0))
			var dz := float(monster.get("z", 0.0)) - float(player.get("z", 0.0))
			if dx * dx + dz * dz > 16.0:
				_on_status("请靠近尸体后拾取", true)
				return
			# F是快捷的全部拾取，不需要先打开预览窗口；先绑定当前尸体，避免空ID请求。
			# F is the quick loot-all path; bind the selected corpse before sending the request.
			inspected_loot_monster_id = selected_monster_unit_id
			# 与Cocos3D一致：F/交互键对尸体执行全部拾取，普通按钮仍然先查看列表。
			# Match Cocos3D: F/interact loots the whole corpse; the normal button opens the list first.
			_loot_all()
			return
	_on_status("附近没有可交互的NPC或尸体", true)

func _refresh_npc_dialog() -> void:
	if npc_dialog_text == null or selected_npc_unit_id == 0 or not units.has(selected_npc_unit_id):
		return
	var action_id := 0
	var action_mode := "none"
	for quest_id in [5001, 5005, 5006]:
		if quests.has(quest_id):
			var active: Dictionary = quests[quest_id]
			if bool(active.get("ready_to_complete", false)) or int(active.get("status", 0)) == 2:
				action_id = quest_id
				action_mode = "complete"
			break
		if not completed_quest_config_ids.has(quest_id):
			action_id = quest_id
			action_mode = "accept"
			break
	var npc_name := _entity_name(units[selected_npc_unit_id])
	if action_mode == "accept":
		npc_dialog_text.text = "%s：我这里有一项任务。\n任务：%s" % [npc_name, _quest_name(action_id)]
		npc_dialog_action_button.text = "领取任务：%s" % _quest_name(action_id)
		npc_dialog_action_button.disabled = false
	elif action_mode == "complete":
		npc_dialog_text.text = "%s：做得很好，请把任务交给我。\n任务：%s" % [npc_name, _quest_name(action_id)]
		npc_dialog_action_button.text = "交付任务：%s" % _quest_name(action_id)
		npc_dialog_action_button.disabled = false
	else:
		npc_dialog_text.text = "%s：任务进行中，请继续完成目标。" % npc_name
		npc_dialog_action_button.text = "任务进行中"
		npc_dialog_action_button.disabled = true

func _npc_quest_action() -> void:
	if selected_npc_unit_id == 0:
		return
	for quest_id in [5001, 5005, 5006]:
		if quests.has(quest_id):
			var active: Dictionary = quests[quest_id]
			if bool(active.get("ready_to_complete", false)) or int(active.get("status", 0)) == 2:
				if client.complete_quest_from_npc(quest_id, selected_npc_unit_id):
					_on_status("正在交付任务：%s" % _quest_name(quest_id), false)
				return
			if not completed_quest_config_ids.has(quest_id):
				if client.accept_quest_from_npc(quest_id, selected_npc_unit_id):
					_on_status("正在接取任务：%s" % _quest_name(quest_id), false)
				return
		_on_status("没有可接取或交付的任务", false)

func _close_npc_dialog() -> void:
	if npc_dialog:
		npc_dialog.visible = false

func _update_loot_interaction_hud() -> void:
	if loot_interaction_button == null:
		return
	if selected_monster_unit_id == 0 or not units.has(selected_monster_unit_id):
		loot_interaction_button.visible = false
		return
	var monster: Dictionary = units[selected_monster_unit_id]
	if bool(monster.get("alive", true)):
		loot_interaction_button.visible = false
		return
	var player: Dictionary = units.get(local_unit_id, {})
	var dx := float(monster.get("x", 0.0)) - float(player.get("x", 0.0))
	var dz := float(monster.get("z", 0.0)) - float(player.get("z", 0.0))
	var in_range := dx * dx + dz * dz <= 16.0
	loot_interaction_button.visible = true
	loot_interaction_button.disabled = not in_range
	loot_interaction_button.text = "查看尸体掉落" if in_range else "靠近尸体后拾取"

func _inspect_selected_loot() -> void:
	if selected_monster_unit_id == 0:
		return
	if client.inspect_loot_monster(selected_monster_unit_id):
		_on_status("正在查看尸体掉落...", false)

func _on_loot_inspected(message: Dictionary) -> void:
	inspected_loot_monster_id = int(message.get("monster_id", 0))
	inspected_loot = message.get("drops", [])
	loot_panel.visible = true
	_render_loot_panel()

func _render_loot_panel() -> void:
	if loot_list == null:
		return
	for child in loot_list.get_children():
		child.queue_free()
	if inspected_loot.is_empty():
		var empty_label := Label.new()
		empty_label.text = "尸体上已经没有可拾取的掉落"
		loot_list.add_child(empty_label)
		loot_all_button.disabled = true
		return
	loot_all_button.disabled = false
	for raw_drop in inspected_loot:
		var drop: Dictionary = raw_drop
		var drop_id := int(drop.get("drop_id", 0))
		var item_id := int(drop.get("item_config_id", 0))
		var row := Button.new()
		row.text = "%s × %d" % [_item_name(item_id), int(drop.get("count", 0))]
		row.pressed.connect(_loot_one.bind(drop_id))
		loot_list.add_child(row)

func _loot_one(drop_id: int) -> void:
	if inspected_loot_monster_id == 0:
		return
	loot_operation_id = "godot-loot-%d" % Time.get_ticks_usec()
	client.loot_monster(inspected_loot_monster_id, loot_operation_id, drop_id, false)

func _loot_all() -> void:
	var monster_id: int = inspected_loot_monster_id if inspected_loot_monster_id != 0 else selected_monster_unit_id
	if monster_id == 0:
		return
	loot_operation_id = "godot-loot-all-%d" % Time.get_ticks_usec()
	client.loot_monster(monster_id, loot_operation_id, 0, true)

func _on_loot_result(message: Dictionary) -> void:
	inspected_loot = message.get("remaining_drops", [])
	_render_loot_panel()
	var items: Array = message.get("items", [])
	_on_status("拾取成功：%d件道具" % items.size(), false)

func _close_loot_panel() -> void:
	if loot_panel:
		loot_panel.visible = false

func _on_session_replaced(message: Dictionary) -> void:
	_set_game_ui_visible(false)
	var reason: String = String(message.get("reason", "账号已在其他位置登录"))
	_on_status("连接已被顶下线：%s" % reason, true)

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
	return {3001: "寒冰箭", 3002: "火焰冲击", 3003: "惩击", 3004: "真言术·盾", 3005: "真言术·韧", 3006: "恢复", 3007: "精神鞭笞"}.get(skill_id, "Skill#%d" % skill_id)

func _item_name(config_id: int) -> String:
	return {1001: "小型生命药水", 1002: "大型生命药水"}.get(config_id, "Item#%d" % config_id)

func _buff_name(buff_id: int) -> String:
	return {2001: "持续恢复", 4001: "冰冷", 4002: "灼烧", 4003: "真言术·盾", 4004: "虚弱灵魂", 4005: "真言术·韧"}.get(buff_id, "Buff#%d" % buff_id)

func _quest_name(quest_id: int) -> String:
	return {5001: "清理怪物", 5002: "试用药水", 5003: "前往地图2", 5004: "进阶试炼", 5005: "清理怪B", 5006: "返回任务使者"}.get(quest_id, "Quest#%d" % quest_id)

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
	if status_label:
		status_label.text = text
		status_label.modulate = Color("#ff8c78") if is_error else Color.WHITE
	if auth_ui_root and auth_ui_root.visible:
		_set_auth_error(text, is_error)
		if is_error and auth_submit_button:
			auth_submit_button.disabled = false

func _update_skill_channel_beam() -> void:
	var skill_id := int(skill_cast_state.get("skill_id", 0))
	var finish_at := int(skill_cast_state.get("finish_at_ms", 0))
	var target_id := int(skill_cast_state.get("target_unit_id", 0))
	var active := skill_id == 3007 and finish_at > _server_now_ms() and unit_nodes.has(local_unit_id) and unit_nodes.has(target_id)
	if not active:
		if skill_channel_beam and is_instance_valid(skill_channel_beam):
			skill_channel_beam.queue_free()
		skill_channel_beam = null
		return
	if skill_channel_beam == null or not is_instance_valid(skill_channel_beam):
		skill_channel_beam = MeshInstance3D.new()
		var material := StandardMaterial3D.new()
		material.albedo_color = Color("#b98cff")
		material.emission_enabled = true
		material.emission = Color("#813bd1")
		material.emission_energy_multiplier = 2.0
		skill_channel_beam.material_override = material
		add_child(skill_channel_beam)
	var source := unit_nodes[local_unit_id].position + Vector3.UP * 0.9
	var target := unit_nodes[target_id].position + Vector3.UP * 0.9
	var distance := source.distance_to(target)
	var mesh := BoxMesh.new()
	mesh.size = Vector3(0.12, 0.12, distance)
	skill_channel_beam.mesh = mesh
	skill_channel_beam.position = (source + target) * 0.5
	skill_channel_beam.look_at(target, Vector3.UP)
	skill_channel_beam.rotate_y(PI)

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

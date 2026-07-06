extends Control
## Walking skeleton for the Godot client.
##
## Proves the agentic workflow: this whole screen — background, phase rail,
## seat panels — is authored in code/text with zero editor GUI, and the CLI can
## verify it visually (`--screenshot=<path>` renders two frames, saves a PNG,
## and quits). The real client keeps this shape: the server's room projection
## (same JSON the SvelteKit client consumes) drives programmatic UI.

const SEAT_COLORS := {
	"Red": Color("#e2574c"),
	"Blue": Color("#4c7de2"),
	"Green": Color("#52b788"),
	"Yellow": Color("#e2b93b")
}
const PHASES := ["Navigation", "Encounter", "Location", "Cleanup"]
const ACTIVE_PHASE := 2

func _ready() -> void:
	_build_ui()
	var shot_path := _screenshot_arg()
	if shot_path != "":
		_capture_and_quit(shot_path)

func _build_ui() -> void:
	var bg := ColorRect.new()
	bg.color = Color("#141021")
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	add_child(bg)

	var root := VBoxContainer.new()
	root.set_anchors_preset(Control.PRESET_FULL_RECT)
	root.offset_left = 48
	root.offset_right = -48
	root.offset_top = 32
	root.offset_bottom = -32
	root.add_theme_constant_override("separation", 24)
	add_child(root)

	var title := Label.new()
	title.text = "ARC SPIRITS"
	title.add_theme_font_size_override("font_size", 44)
	title.add_theme_color_override("font_color", Color("#f2ecff"))
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	root.add_child(title)

	root.add_child(_phase_rail())
	root.add_child(_seat_row())

	var footer := Label.new()
	footer.text = "godot 4.5 · text-authored scene · headless-verified"
	footer.add_theme_font_size_override("font_size", 16)
	footer.add_theme_color_override("font_color", Color("#8d8aa1"))
	footer.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	root.add_child(footer)

func _phase_rail() -> Control:
	var rail := HBoxContainer.new()
	rail.alignment = BoxContainer.ALIGNMENT_CENTER
	rail.add_theme_constant_override("separation", 12)
	for i in PHASES.size():
		var chip := PanelContainer.new()
		var style := StyleBoxFlat.new()
		style.bg_color = Color("#2b2440") if i != ACTIVE_PHASE else Color("#6c4de2")
		style.set_corner_radius_all(14)
		style.content_margin_left = 18
		style.content_margin_right = 18
		style.content_margin_top = 8
		style.content_margin_bottom = 8
		chip.add_theme_stylebox_override("panel", style)
		var label := Label.new()
		label.text = PHASES[i]
		label.add_theme_font_size_override("font_size", 18)
		label.add_theme_color_override(
			"font_color", Color("#ffffff") if i == ACTIVE_PHASE else Color("#8d8aa1")
		)
		chip.add_child(label)
		rail.add_child(chip)
	return rail

func _seat_row() -> Control:
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	row.size_flags_vertical = Control.SIZE_EXPAND_FILL
	row.add_theme_constant_override("separation", 20)
	var vp := 3
	for seat: String in SEAT_COLORS:
		var panel := PanelContainer.new()
		panel.custom_minimum_size = Vector2(240, 0)
		panel.size_flags_vertical = Control.SIZE_EXPAND_FILL
		var style := StyleBoxFlat.new()
		style.bg_color = Color("#1d1830")
		style.border_color = SEAT_COLORS[seat]
		style.set_border_width_all(3)
		style.set_corner_radius_all(18)
		style.content_margin_left = 16
		style.content_margin_right = 16
		style.content_margin_top = 16
		style.content_margin_bottom = 16
		panel.add_theme_stylebox_override("panel", style)

		var col := VBoxContainer.new()
		col.add_theme_constant_override("separation", 10)
		var name_label := Label.new()
		name_label.text = seat
		name_label.add_theme_font_size_override("font_size", 26)
		name_label.add_theme_color_override("font_color", SEAT_COLORS[seat])
		col.add_child(name_label)
		var vp_label := Label.new()
		vp_label.text = "%d VP" % vp
		vp_label.add_theme_font_size_override("font_size", 20)
		vp_label.add_theme_color_override("font_color", Color("#f2ecff"))
		col.add_child(vp_label)
		vp += 4
		panel.add_child(col)
		row.add_child(panel)
	return row

func _screenshot_arg() -> String:
	for arg: String in OS.get_cmdline_user_args():
		if arg.begins_with("--screenshot="):
			return arg.trim_prefix("--screenshot=")
	return ""

func _capture_and_quit(path: String) -> void:
	# Two frames so layout + draw both complete before capture.
	await get_tree().process_frame
	await get_tree().process_frame
	await RenderingServer.frame_post_draw
	var image := get_viewport().get_texture().get_image()
	var err := image.save_png(path)
	print("screenshot: %s (%s)" % [path, error_string(err)])
	get_tree().quit(0 if err == OK else 1)

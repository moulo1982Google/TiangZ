"""Generate the TiangZ Cocos3D blue chibi model and its basic animations.

The generated GLB is intentionally low-poly and uses only embedded materials.
Gameplay movement remains authoritative outside the asset, so every animation
is in-place and the model origin stays at the character's feet.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("--blend")
    parser.add_argument("--preview")
    return parser.parse_args(argv)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for collection in (bpy.data.meshes, bpy.data.curves, bpy.data.armatures, bpy.data.materials):
        for item in list(collection):
            if item.users == 0:
                collection.remove(item)


def make_material(name: str, color: tuple[float, float, float, float], roughness: float = 0.58):
    material = bpy.data.materials.new(name)
    material.diffuse_color = color
    material.use_nodes = True
    shader = material.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = color
    shader.inputs["Roughness"].default_value = roughness
    return material


def finish_mesh(obj, material, *, smooth: bool = True, bevel: float = 0.0):
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    if smooth:
        for polygon in obj.data.polygons:
            polygon.use_smooth = True
    if bevel > 0:
        modifier = obj.modifiers.new("SoftEdges", "BEVEL")
        modifier.width = bevel
        modifier.segments = 2
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.data.materials.append(material)
    return obj


def add_sphere(name, location, scale, material, *, segments=16, rings=10):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish_mesh(obj, material)


def add_rounded_box(name, location, scale, material, *, bevel=0.035):
    bpy.ops.mesh.primitive_cube_add(location=location)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    return finish_mesh(obj, material, smooth=False, bevel=bevel)


def add_cylinder_between(name, start, end, radius, material, *, vertices=14):
    start_vector = Vector(start)
    end_vector = Vector(end)
    direction = end_vector - start_vector
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=direction.length,
        location=(start_vector + end_vector) * 0.5,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = direction.to_track_quat("Z", "Y")
    return finish_mesh(obj, material)


def add_torus(name, location, major_radius, minor_radius, rotation, material):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major_radius,
        minor_radius=minor_radius,
        major_segments=20,
        minor_segments=6,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    return finish_mesh(obj, material)


def create_armature():
    armature_data = bpy.data.armatures.new("BlueChibiSkeleton")
    armature = bpy.data.objects.new("BlueChibiArmature", armature_data)
    bpy.context.scene.collection.objects.link(armature)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")

    bones = {}

    def add_bone(name, head, tail, parent=None):
        bone = armature_data.edit_bones.new(name)
        bone.head = head
        bone.tail = tail
        bone.use_deform = True
        if parent:
            bone.parent = bones[parent]
        bones[name] = bone

    add_bone("Root", (0, 0, 0), (0, 0, 0.12))
    add_bone("Hips", (0, 0, 0.62), (0, 0, 0.82), "Root")
    add_bone("Spine", (0, 0, 0.82), (0, 0, 1.05), "Hips")
    add_bone("Chest", (0, 0, 1.05), (0, 0, 1.24), "Spine")
    add_bone("Neck", (0, 0, 1.24), (0, 0, 1.34), "Chest")
    add_bone("Head", (0, 0, 1.34), (0, 0, 1.68), "Neck")

    add_bone("UpperArm.L", (0.22, 0, 1.18), (0.39, 0, 0.98), "Chest")
    add_bone("LowerArm.L", (0.39, 0, 0.98), (0.49, -0.01, 0.76), "UpperArm.L")
    add_bone("Hand.L", (0.49, -0.01, 0.76), (0.53, -0.05, 0.67), "LowerArm.L")
    add_bone("UpperArm.R", (-0.22, 0, 1.18), (-0.39, 0, 0.98), "Chest")
    add_bone("LowerArm.R", (-0.39, 0, 0.98), (-0.49, -0.01, 0.76), "UpperArm.R")
    add_bone("Hand.R", (-0.49, -0.01, 0.76), (-0.53, -0.05, 0.67), "LowerArm.R")

    add_bone("Thigh.L", (0.13, 0, 0.66), (0.14, 0, 0.42), "Hips")
    add_bone("Shin.L", (0.14, 0, 0.42), (0.14, 0, 0.18), "Thigh.L")
    add_bone("Foot.L", (0.14, 0, 0.18), (0.14, -0.18, 0.10), "Shin.L")
    add_bone("Thigh.R", (-0.13, 0, 0.66), (-0.14, 0, 0.42), "Hips")
    add_bone("Shin.R", (-0.14, 0, 0.42), (-0.14, 0, 0.18), "Thigh.R")
    add_bone("Foot.R", (-0.14, 0, 0.18), (-0.14, -0.18, 0.10), "Shin.R")

    bpy.ops.object.mode_set(mode="OBJECT")
    armature.show_in_front = True
    return armature


def bind_rigid(obj, armature, bone_name: str) -> None:
    obj.parent = armature
    modifier = obj.modifiers.new("Armature", "ARMATURE")
    modifier.object = armature
    vertex_group = obj.vertex_groups.new(name=bone_name)
    vertex_group.add(range(len(obj.data.vertices)), 1.0, "REPLACE")


def build_character(armature):
    skin = make_material("Skin", (1.0, 0.72, 0.62, 1.0), 0.66)
    white = make_material("HoodieWhite", (0.93, 0.95, 0.98, 1.0), 0.72)
    dark = make_material("ClothBlack", (0.035, 0.045, 0.065, 1.0), 0.7)
    blue = make_material("HairBlue", (0.025, 0.22, 0.88, 1.0), 0.42)
    light_blue = make_material("HairHighlight", (0.16, 0.64, 1.0, 1.0), 0.4)
    eye_blue = make_material("EyeBlue", (0.03, 0.34, 0.9, 1.0), 0.3)
    eye_dark = make_material("EyeDark", (0.005, 0.012, 0.03, 1.0), 0.34)
    glasses = make_material("Glasses", (0.012, 0.018, 0.03, 1.0), 0.25)
    shoe_white = make_material("ShoeWhite", (0.88, 0.91, 0.96, 1.0), 0.7)

    pieces = []

    def piece(obj, bone):
        bind_rigid(obj, armature, bone)
        pieces.append(obj)
        return obj

    # Baggy hoodie and hood.
    piece(add_rounded_box("HoodieBody", (0, 0.0, 1.02), (0.28, 0.17, 0.25), white, bevel=0.07), "Chest")
    piece(add_sphere("Hood", (0, 0.12, 1.25), (0.25, 0.12, 0.20), white), "Chest")
    piece(add_rounded_box("HoodiePocket", (0, -0.178, 0.94), (0.17, 0.025, 0.07), white, bevel=0.025), "Spine")
    piece(add_cylinder_between("Drawstring.L", (-0.055, -0.19, 1.18), (-0.055, -0.205, 1.02), 0.009, dark, vertices=8), "Chest")
    piece(add_cylinder_between("Drawstring.R", (0.055, -0.19, 1.18), (0.055, -0.205, 1.02), 0.009, dark, vertices=8), "Chest")

    # Arms are in a relaxed A-pose, making later skinning and attack clips straightforward.
    for side, sign in (("L", 1), ("R", -1)):
        upper_start = (0.22 * sign, 0, 1.17)
        upper_end = (0.39 * sign, 0, 0.98)
        lower_end = (0.49 * sign, -0.01, 0.76)
        hand_end = (0.53 * sign, -0.05, 0.67)
        piece(add_cylinder_between(f"SleeveUpper.{side}", upper_start, upper_end, 0.115, white), f"UpperArm.{side}")
        piece(add_cylinder_between(f"SleeveLower.{side}", upper_end, lower_end, 0.105, white), f"LowerArm.{side}")
        piece(add_cylinder_between(f"Cuff.{side}", (0.47 * sign, -0.01, 0.80), (0.50 * sign, -0.02, 0.73), 0.095, dark, vertices=12), f"LowerArm.{side}")
        piece(add_sphere(f"Hand.{side}", hand_end, (0.075, 0.065, 0.085), skin, segments=12, rings=8), f"Hand.{side}")

    # Loose pants and sneakers.
    for side, sign in (("L", 1), ("R", -1)):
        piece(add_rounded_box(f"Pants.{side}", (0.14 * sign, 0.0, 0.50), (0.145, 0.16, 0.27), dark, bevel=0.07), f"Thigh.{side}")
        piece(add_rounded_box(f"ShoeDark.{side}", (0.14 * sign, -0.035, 0.14), (0.15, 0.20, 0.09), dark, bevel=0.055), f"Foot.{side}")
        piece(add_rounded_box(f"Sole.{side}", (0.14 * sign, -0.075, 0.075), (0.155, 0.205, 0.035), shoe_white, bevel=0.025), f"Foot.{side}")

    # Head, hair cap, bangs and face.
    piece(add_sphere("HeadSkin", (0, -0.025, 1.50), (0.29, 0.245, 0.285), skin, segments=24, rings=14), "Head")
    piece(add_sphere("HairBack", (0, 0.055, 1.57), (0.325, 0.255, 0.31), blue, segments=24, rings=14), "Head")
    for index, x in enumerate((-0.22, -0.12, -0.02, 0.09, 0.20)):
        height = 0.19 if index in (1, 2, 3) else 0.16
        piece(add_sphere(f"Bang.{index}", (x, -0.247, 1.63), (0.085, 0.032, height), blue, segments=12, rings=8), "Head")
    piece(add_sphere("HairHighlight.L", (-0.255, -0.185, 1.50), (0.035, 0.025, 0.14), light_blue, segments=10, rings=8), "Head")
    piece(add_sphere("HairHighlight.R", (0.255, -0.185, 1.50), (0.035, 0.025, 0.14), light_blue, segments=10, rings=8), "Head")

    # Braids use alternating flattened beads; keeping them on the head bone gives a readable rigid low-poly silhouette.
    for side, sign in (("L", 1), ("R", -1)):
        for index in range(5):
            z = 1.27 - index * 0.14
            x = sign * (0.31 + index * 0.025)
            piece(add_sphere(f"Braid.{side}.{index}", (x, 0.02, z), (0.07, 0.06, 0.09), blue, segments=10, rings=7), "Head")
        piece(add_sphere(f"BraidTip.{side}", (sign * 0.42, 0.02, 0.58), (0.075, 0.065, 0.11), blue, segments=10, rings=7), "Head")
        piece(add_cylinder_between(f"BraidBand.{side}", (sign * 0.405, 0.02, 0.70), (sign * 0.415, 0.02, 0.65), 0.045, white, vertices=10), "Head")

    # Eyes and round glasses face Blender -Y, which becomes TiangZ +Z after the Cocos import boundary.
    for side, sign in (("L", 1), ("R", -1)):
        piece(add_sphere(f"EyeWhite.{side}", (0.105 * sign, -0.257, 1.52), (0.068, 0.014, 0.082), white, segments=12, rings=8), "Head")
        piece(add_sphere(f"Iris.{side}", (0.105 * sign, -0.269, 1.515), (0.036, 0.008, 0.052), eye_blue, segments=12, rings=8), "Head")
        piece(add_sphere(f"Pupil.{side}", (0.105 * sign, -0.276, 1.515), (0.016, 0.006, 0.032), eye_dark, segments=10, rings=6), "Head")
        piece(add_torus(f"GlassesRing.{side}", (0.115 * sign, -0.285, 1.55), 0.105, 0.012, (math.pi / 2, 0, 0), glasses), "Head")
    piece(add_cylinder_between("GlassesBridge", (-0.012, -0.286, 1.55), (0.012, -0.286, 1.55), 0.009, glasses, vertices=8), "Head")
    piece(add_cylinder_between("Mouth", (-0.035, -0.276, 1.40), (0.035, -0.276, 1.40), 0.006, eye_dark, vertices=8), "Head")

    # Small hair antenna and hoodie badge preserve the strongest reference-image cues.
    piece(add_cylinder_between("Ahoge", (0.0, 0.02, 1.86), (0.05, -0.01, 1.94), 0.018, blue, vertices=10), "Head")
    piece(add_sphere("HoodieBadge", (0.17, -0.184, 1.12), (0.035, 0.012, 0.035), dark, segments=12, rings=8), "Chest")
    return pieces


def merge_meshes_by_material(meshes, armature):
    """Merge rigidly weighted pieces into one skinned mesh per material.

    Cocos submits every imported skinned mesh separately. Keeping the modeling
    primitives separate would therefore cost dozens of draw calls per player,
    while joining by material preserves bone groups and reduces that cost to
    the small, predictable material count.
    """
    groups = {}
    for mesh in meshes:
        material = mesh.data.materials[0]
        groups.setdefault(material.name, []).append(mesh)

    merged = []
    for material_name, group in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for mesh in group:
            mesh.select_set(True)
        bpy.context.view_layer.objects.active = group[0]
        if len(group) > 1:
            bpy.ops.object.join()
        mesh = bpy.context.object
        mesh.name = f"BlueChibi_{material_name}"
        mesh.parent = armature
        if not any(modifier.type == "ARMATURE" for modifier in mesh.modifiers):
            modifier = mesh.modifiers.new("Armature", "ARMATURE")
            modifier.object = armature
        merged.append(mesh)
    return merged


def reset_pose(armature) -> None:
    for pose_bone in armature.pose.bones:
        pose_bone.rotation_mode = "XYZ"
        pose_bone.rotation_euler = (0, 0, 0)
        pose_bone.location = (0, 0, 0)
        pose_bone.scale = (1, 1, 1)


def key_pose(armature, frame: int, rotations=None, locations=None) -> None:
    rotations = rotations or {}
    locations = locations or {}
    for name, values in rotations.items():
        bone = armature.pose.bones[name]
        bone.rotation_euler = values
        bone.keyframe_insert(data_path="rotation_euler", frame=frame, group=name)
    for name, values in locations.items():
        bone = armature.pose.bones[name]
        bone.location = values
        bone.keyframe_insert(data_path="location", frame=frame, group=name)


def create_animations(armature) -> None:
    scene = bpy.context.scene
    scene.render.fps = 30
    armature.animation_data_create()

    idle = bpy.data.actions.new("Idle")
    idle.use_fake_user = True
    armature.animation_data.action = idle
    reset_pose(armature)
    for frame, chest, head, hips in ((0, -0.018, -0.012, 0.0), (30, 0.018, 0.012, 0.012), (60, -0.018, -0.012, 0.0)):
        key_pose(
            armature,
            frame,
            rotations={"Chest": (chest, 0, 0), "Head": (0, 0, head)},
            locations={"Hips": (0, 0, hips)},
        )
    idle.frame_start = 0
    idle.frame_end = 60

    walk = bpy.data.actions.new("Walk")
    walk.use_fake_user = True
    armature.animation_data.action = walk
    reset_pose(armature)
    walk_frames = (
        (0, 0.52, -0.52, -0.42, 0.42, 0.0),
        (8, 0.0, 0.0, 0.0, 0.0, 0.035),
        (16, -0.52, 0.52, 0.42, -0.42, 0.0),
        (24, 0.0, 0.0, 0.0, 0.0, 0.035),
        (32, 0.52, -0.52, -0.42, 0.42, 0.0),
    )
    for frame, left_leg, right_leg, left_arm, right_arm, bounce in walk_frames:
        key_pose(
            armature,
            frame,
            rotations={
                "Thigh.L": (left_leg, 0, 0),
                "Thigh.R": (right_leg, 0, 0),
                "UpperArm.L": (left_arm, 0, 0),
                "UpperArm.R": (right_arm, 0, 0),
                "Chest": (0, 0, -0.035 if frame in (0, 32) else 0.035 if frame == 16 else 0),
            },
            locations={"Hips": (0, 0, bounce)},
        )
    walk.frame_start = 0
    walk.frame_end = 32

    reset_pose(armature)
    armature.animation_data.action = idle
    scene.frame_start = 0
    scene.frame_end = 60


def add_preview_scene() -> None:
    floor_material = make_material("PreviewFloor", (0.055, 0.075, 0.085, 1.0), 0.9)
    bpy.ops.mesh.primitive_plane_add(size=8, location=(0, 0, 0))
    floor = bpy.context.object
    floor.name = "PreviewFloor"
    floor.data.materials.append(floor_material)

    bpy.ops.object.light_add(type="AREA", location=(-3.5, -4.0, 6.0))
    key = bpy.context.object
    key.data.energy = 900
    key.data.shape = "DISK"
    key.data.size = 5.0
    bpy.ops.object.light_add(type="AREA", location=(4.0, 1.5, 3.5))
    fill = bpy.context.object
    fill.data.energy = 550
    fill.data.size = 4.0

    bpy.ops.object.camera_add(location=(3.25, -6.2, 2.55))
    camera = bpy.context.object
    camera.name = "PreviewCamera"
    direction = Vector((0, 0, 1.0)) - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 58
    bpy.context.scene.camera = camera


def main() -> None:
    args = parse_args()
    output = Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    clear_scene()
    armature = create_armature()
    meshes = build_character(armature)
    meshes = merge_meshes_by_material(meshes, armature)
    create_animations(armature)

    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    for mesh in meshes:
        mesh.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.export_scene.gltf(
        filepath=str(output),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_skins=True,
        export_yup=True,
        export_leaf_bone=False,
        export_def_bones=False,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )

    add_preview_scene()
    if args.blend:
        blend_path = Path(args.blend).resolve()
        blend_path.parent.mkdir(parents=True, exist_ok=True)
        bpy.context.preferences.filepaths.save_version = 0
        bpy.ops.wm.save_as_mainfile(filepath=str(blend_path))
    if args.preview:
        preview_path = Path(args.preview).resolve()
        preview_path.parent.mkdir(parents=True, exist_ok=True)
        scene = bpy.context.scene
        scene.render.engine = "BLENDER_EEVEE"
        scene.render.resolution_x = 720
        scene.render.resolution_y = 720
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = str(preview_path)
        scene.world.color = (0.025, 0.035, 0.045)
        scene.frame_set(0)
        bpy.ops.render.render(write_still=True)

    print(f"Generated {output}")


if __name__ == "__main__":
    main()

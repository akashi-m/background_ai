# Экспорт данных для физической тени (запускать ВНУТРИ Blender, напр. через MCP).
# Пишет в public/assets/worlds/<world>/:
#   lights.json   — лампы (мировые XYZ + weight), камера (pos/target/fovY/aspect), floorZ
#   roomworld.exr — мировая позиция каждого пикселя (бейк эмиссии = Geometry.Position),
#                   single-layer float EXR (читается three.js EXRLoader).
#
# Blender 5.1: компоситорный File Output умеет только MULTILAYER, поэтому Position
# выгружаем не компоситором, а material-override (эмиссия=Position) + обычный
# single-layer EXR. Позиция геометрична — хватает 1-4 сэмплов (быстро).
import bpy, json, mathutils, os

DEST = os.environ.get("SHADOW_OUT",
    "/Users/iman/Projects/background_ar/public/assets/worlds/living")
LAMP_NAMES = [("Key_Living_Warm", 1.0), ("Spot_LV_1", 0.6)]
EXTRA_LAMPS = [{"name": "Ceiling_LED", "pos": [4.0, 1.5, 3.0], "weight": 0.4}]

sc = bpy.context.scene
cam = bpy.data.objects["Camera"]
fwd = cam.matrix_world.to_quaternion() @ mathutils.Vector((0, 0, -1))

# --- lights.json ---
lamps = []
for name, w in LAMP_NAMES:
    o = bpy.data.objects.get(name)
    if o:
        lamps.append({"name": name, "pos": list(o.location), "weight": w})
lamps += EXTRA_LAMPS
data = {
    "lamps": lamps,
    "camera": {
        "pos": list(cam.location),
        "target": list(cam.location + fwd),
        "fovY": cam.data.angle_y,
        "aspect": sc.render.resolution_x / sc.render.resolution_y,
    },
    "floorZ": 0.0,
}
os.makedirs(DEST, exist_ok=True)
with open(os.path.join(DEST, "lights.json"), "w") as f:
    json.dump(data, f, indent=2)

# --- roomworld.exr (бейк мировой позиции) ---
m = bpy.data.materials.get("WorldPosBake") or bpy.data.materials.new("WorldPosBake")
m.use_nodes = True
nt = m.node_tree
for n in list(nt.nodes):
    nt.nodes.remove(n)
geo = nt.nodes.new("ShaderNodeNewGeometry")
em = nt.nodes.new("ShaderNodeEmission")
out = nt.nodes.new("ShaderNodeOutputMaterial")
nt.links.new(geo.outputs["Position"], em.inputs["Color"])
nt.links.new(em.outputs["Emission"], out.inputs["Surface"])

vl = sc.view_layers[0]
prev = (vl.material_override, sc.use_nodes, sc.cycles.samples, sc.cycles.time_limit,
        sc.render.image_settings.file_format, sc.render.image_settings.color_depth,
        sc.render.filepath)
vl.material_override = m
sc.use_nodes = False
sc.cycles.samples = 4
sc.cycles.time_limit = 0
sc.render.image_settings.file_format = "OPEN_EXR"
sc.render.image_settings.color_depth = "32"
sc.render.filepath = os.path.join(DEST, "roomworld")
bpy.ops.render.render(write_still=True)

(vl.material_override, sc.use_nodes, sc.cycles.samples, sc.cycles.time_limit,
 sc.render.image_settings.file_format, sc.render.image_settings.color_depth,
 sc.render.filepath) = prev
print("exported lights.json + roomworld.exr to", DEST)

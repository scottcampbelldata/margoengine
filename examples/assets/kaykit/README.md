# KayKit assets (Kay Lousberg, CC0 1.0)

For the example game (HANDOFF 5l.q). All files are CC0 1.0 (public domain dedication); credit is optional and given
here: Kay Lousberg, www.kaylousberg.com. Licence texts are kept next to the files.

| File | Source | Size | Contents | glTF-Validator |
| --- | --- | --- | --- | --- |
| `character-animations.glb` | [KayKit Character Animations 1.2](https://opengameart.org/content/kaykit-character-animations), `Animations/gltf/KayKit_AnimatedCharacter_v1.2.glb`, sha256 `9d91991c...0538f1c` | 459,768 B | Prototype Pete: 1 skinned mesh, 6 joints, 30 clips (Idle, Walk, Run, Jump, Roll, Dash*, Attack*, ...), no textures | 0 errors, 1 warning (BUFFER_VIEW_TARGET_MISSING), 1 info |

| `adventurers/characters/*.glb` | [KayKit Character Pack: Adventurers](https://kaylousberg.itch.io/kaykit-adventurers) Free 2.0 (`KayKit_Adventurers_2.0_FREE.zip`, 13,024,345 B, downloaded by Scott), `Characters/gltf` | 2.4 MB | Barbarian, Knight, Mage, Ranger, Rogue, Rogue_Hooded: skinned, 23-joint `Rig_Medium`, one 1024 px texture each, no clips | 0 errors |
| `adventurers/animations/Rig_Medium/*.glb` | same zip, `Animations/gltf` | 1.5 MB | clips for `Rig_Medium` in separate files (bind by joint name): General 15 (Idle_A/B, Hit, Death, Interact, PickUp, Spawn...), MovementBasic 11 (Walking_A/B/C, Running_A/B, Jump_*) | 0 errors |
| `adventurers/props/*.gltf` | same zip, `Assets/gltf` | 0.8 MB | weapons, shields, hats, books (33 props, .gltf + .bin) | 0 errors |
| `dungeon/pieces/*.gltf` | [KayKit Dungeon Pack](https://kaylousberg.itch.io/kaykit-dungeon-pack) (formerly "Dungeon Remastered") Free 1.1 (`KayKit_Dungeon_FREE.zip`, 32,868,755 B), `Assets/gltf` | 6.5 MB | 212 modular pieces: walls, floors, stairs, doors, chests, barrels, tables, banners (.gltf + .bin, shared texture) | 0 errors |

Validator totals over all 251 files: 0 errors, 60 warnings (NODE_SKINNED_MESH_NON_ROOT on skinned exports,
BUFFER_VIEW_TARGET_MISSING), infos for unused objects. FBX/OBJ/Unity copies, sample renders and brand images were not
copied. Downloaded 2026-10-15.

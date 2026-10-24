using System;
using System.Collections.Generic;
using System.Linq;
using GLTFast;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace MargoMesh.Unity.Editor {
    // Native resources: imported graph checks, owned texture/material/mesh/clip copies, saving and saved-prefab verification.
    public static partial class ImportCompanion {
        /// <summary>Temporary owned copies of the imported resources, destroyed after the prefab is saved or the attempt fails.</summary>
        sealed class Prepared {
            internal Texture2D texture;
            internal Material material;
            internal AnimationClip[] clips;
            internal readonly Dictionary<Mesh, Mesh> meshes = new Dictionary<Mesh, Mesh>();
            internal readonly Dictionary<Mesh, string> meshNames = new Dictionary<Mesh, string>();
            internal readonly List<Object> temporary = new List<Object>();

            internal void Destroy() {
                Exception failure = null;
                foreach (var value in temporary)
                    try {
                        if (value != null && !EditorUtility.IsPersistent(value))
                            Object.DestroyImmediate(value);
                    } catch (Exception e) { failure = failure ?? e; }
                if (failure != null)
                    throw new InvalidOperationException("Temporary native resource cleanup failed.", failure);
            }
        }

        /// <summary>Saves <paramref name="value"/> as the owned asset <paramref name="name"/>, updating an existing one in place.</summary>
        static T Save<T>(T value, string source, string name, Owner owner) where T : Object {
            CheckName(source, owner, name, typeof(T));
            string path = OutputPath(source, name);
            value.hideFlags = HideFlags.None;
            var existing = AssetDatabase.LoadAssetAtPath<T>(path);
            string displayName = value.name;
            if (existing == null) {
                AssetDatabase.CreateAsset(value, path);
                existing = value;
            } else {
                EditorUtility.CopySerialized(value, existing);
                Object.DestroyImmediate(value);
            }
            existing.name = displayName;
            EditorUtility.SetDirty(existing);
            Record(owner, source, path, typeof(T));
            return existing;
        }

        static Mesh MeshFor(MeshIndex marker) {
            // Unity's missing/detached native objects use overloaded null equality;
            // C# ?. and ?? only check the managed reference and bypass that rule.
            var skin = marker.GetComponent<SkinnedMeshRenderer>();
            if (skin != null)
                return skin.sharedMesh;
            var filter = marker.GetComponent<MeshFilter>();
            return filter != null ? filter.sharedMesh : null;
        }

        static void SetMesh(MeshIndex marker, Mesh mesh) {
            var skin = marker.GetComponent<SkinnedMeshRenderer>();
            if (skin != null)
                skin.sharedMesh = mesh;
            else
                marker.GetComponent<MeshFilter>().sharedMesh = mesh;
        }

        /// <summary>The isolated import holds exactly the source's nodes, meshes, one texture and material, and no colliders.</summary>
        static void ValidateGraph(ImportProfile p, GltfImport importer, GameObject instance) {
            ImportProfile.Require(importer.TextureCount == 1 && importer.MaterialCount == 1 && importer.GetTexture(0) != null && importer.GetMaterial(0) != null &&
                (importer.GetAnimationClips()?.Length ?? 0) == p.data.clips.Length,
                "Incomplete public target resource inventory.");
            var nodes = instance.GetComponentsInChildren<NodeIndex>(true);
            ImportProfile.Require(nodes.Length == p.glb.nodes.Count && nodes.Select(n => n.nodeIndex).Distinct().Count() == nodes.Length, "Target node inventory is incomplete/duplicate.");
            for (int i = 0; i < p.glb.nodes.Count; i++)
                ImportProfile.Require(nodes.Any(n => n.nodeIndex == i && n.sourceId == p.SourceId(i)), "Target node identity differs from source.");
            var markers = instance.GetComponentsInChildren<MeshIndex>(true);
            foreach (var policy in p.data.nodes) {
                var group = markers.Where(m => m.nodeIndex == policy.nodeIndex).ToArray();
                int count = importer.GetMeshCount(policy.meshIndex);
                ImportProfile.Require(count > 0 && group.Length == count && group.Select(m => m.meshNumeration).Distinct().Count() == count, "Target mesh inventory is incomplete/duplicate.");
                foreach (var m in group)
                    ImportProfile.Require(IsSourceMesh(m, policy, importer, count), "Target mesh/material identity differs from public source resource.");
            }
            ImportProfile.Require(markers.All(m => p.data.nodes.Any(n => n.nodeIndex == m.nodeIndex)), "Target contains an undeclared mesh.");
            ImportProfile.Require(instance.GetComponentsInChildren<Collider>(true).Length == 0, "Unexpected collider in isolated public target import.");
        }

        static bool IsSourceMesh(MeshIndex marker, ImportProfile.Node policy, GltfImport importer, int count) {
            var renderer = marker.GetComponent<Renderer>();
            return marker.sourceId == policy.id && marker.meshNumeration >= 0 && marker.meshNumeration < count &&
                MeshFor(marker) == importer.GetMesh(policy.meshIndex, marker.meshNumeration) && renderer != null &&
                marker.materialIndices != null && marker.materialIndices.All(v => v == 0) && renderer.sharedMaterials.Length == marker.materialIndices.Length;
        }

        /// <summary>Makes owned temporary copies of the atlas, material, clips and meshes and applies the renderer and collider policy.</summary>
        static void Prepare(ImportProfile p, GltfImport importer, GameObject instance, Prepared result, Counts counts) {
            result.texture = PrepareTexture(p, result);
            result.material = PrepareMaterial(importer, result);
            result.clips = PrepareClips(p, importer, result);
            PrepareMeshes(p, instance, result, counts);
            counts.meshNodes = p.data.nodes.Length;
            counts.textures = 1;
            counts.materials = 1;
            counts.clips = result.clips.Length;
        }

        /// <summary>The atlas decoded by Unity's PNG decoder into an exact RGBA32 point-sampled, clamped texture without mipmaps.</summary>
        static Texture2D PrepareTexture(ImportProfile p, Prepared result) {
            var decoded = new Texture2D(2, 2, TextureFormat.RGBA32, false, false);
            result.temporary.Add(decoded);
            ImportProfile.Require(ImageConversion.LoadImage(decoded, p.png, false), "Public Unity PNG decoder rejected exact source atlas.");
            ImportProfile.Require(decoded.width == p.data.source.width && decoded.height == p.data.source.height && decoded.mipmapCount == 1 && decoded.isReadable && decoded.isDataSRGB,
                "Decoded native atlas dimensions/data profile differs.");
            var pixels = decoded.GetPixels32();
            var texture = new Texture2D(decoded.width, decoded.height, TextureFormat.RGBA32, false, false);
            result.temporary.Add(texture);
            texture.name = "Texture_0";
            texture.SetPixels32(pixels);
            texture.Apply(false, false);
            texture.filterMode = FilterMode.Point;
            texture.wrapModeU = TextureWrapMode.Clamp;
            texture.wrapModeV = TextureWrapMode.Clamp;
            texture.anisoLevel = 0;
            ImportProfile.Require(texture.GetPixels32().SequenceEqual(pixels), "Native RGBA32 texture changed PNG-decoded bytes.");
            ValidateTexture(p, texture);
            return texture;
        }

        /// <summary>A copy of the imported material with every texture slot rebound to the owned atlas.</summary>
        static Material PrepareMaterial(GltfImport importer, Prepared result) {
            var sourceMaterial = importer.GetMaterial(0);
            // Public mainTexture follows the shader's [MainTexture] declaration.
            // The pinned glTFast built-in shaders declare baseColorTexture there;
            // unsupported/missing mappings reject rather than guessing a property.
            ImportProfile.Require(sourceMaterial.mainTexture == importer.GetTexture(0), "Public imported material has no exact declared base-color atlas binding.");
            var material = new Material(sourceMaterial);
            result.temporary.Add(material);
            material.name = "Material_0";
            foreach (string property in material.GetTexturePropertyNames()) {
                var bound = material.GetTexture(property);
                if (bound == null)
                    continue;
                ImportProfile.Require(bound == importer.GetTexture(0), "Material references an undeclared imported texture.");
                material.SetTexture(property, result.texture);
            }
            ImportProfile.Require(material.mainTexture == result.texture, "Owned material lost its declared base-color atlas binding.");
            return material;
        }

        /// <summary>Copies of the imported clips with the sidecar's name, rate and loop setting.</summary>
        static AnimationClip[] PrepareClips(ImportProfile p, GltfImport importer, Prepared result) {
            var clips = importer.GetAnimationClips() ?? Array.Empty<AnimationClip>();
            var owned = new AnimationClip[clips.Length];
            for (int i = 0; i < clips.Length; i++) {
                ImportProfile.Require(clips[i] != null, "Missing imported animation clip.");
                var policy = p.data.clips[i];
                var clip = Object.Instantiate(clips[i]);
                result.temporary.Add(clip);
                clip.name = policy.name;
                clip.frameRate = policy.fps;
                var settings = AnimationUtility.GetAnimationClipSettings(clip);
                settings.loopTime = policy.loop;
                AnimationUtility.SetAnimationClipSettings(clip, settings);
                clip.wrapMode = settings.loopTime ? WrapMode.Loop : WrapMode.ClampForever;
                owned[i] = clip;
            }
            return owned;
        }

        /// <summary>One owned mesh copy per native mesh; sets each renderer's material, visibility and requested collider.</summary>
        static void PrepareMeshes(ImportProfile p, GameObject instance, Prepared result, Counts counts) {
            var markers = instance.GetComponentsInChildren<MeshIndex>(true);
            foreach (var policy in p.data.nodes)
                foreach (var marker in markers.Where(m => m.nodeIndex == policy.nodeIndex)) {
                    var original = MeshFor(marker);
                    if (!result.meshes.TryGetValue(original, out var mesh)) {
                        mesh = Object.Instantiate(original);
                        result.temporary.Add(mesh);
                        result.meshes.Add(original, mesh);
                        result.meshNames.Add(original, MeshFile(policy.meshIndex, marker.meshNumeration));
                    }
                    SetMesh(marker, mesh);
                    var renderer = marker.GetComponent<Renderer>();
                    renderer.sharedMaterials = marker.materialIndices.Select(_ => result.material).ToArray();
                    renderer.enabled = policy.rendererVisible && !marker.authoredRendererDisabled;
                    marker.companionGenerated = true;
                    marker.generatedRendererEnabled = policy.rendererVisible;
                    if (!renderer.enabled)
                        counts.hiddenRenderers++;
                    if (!p.data.generateColliders || policy.collider == "none")
                        continue;
                    var body = marker.GetComponentInParent<Rigidbody>();
                    ImportProfile.Require(!(renderer is SkinnedMeshRenderer) && (policy.collider != "concave" || body == null || body.isKinematic),
                        "Requested authored Rigidbody/collider combination is unsupported; make the concave helper's Rigidbody kinematic or remove it.");
                    var collider = marker.gameObject.AddComponent<MeshCollider>();
                    collider.sharedMesh = mesh;
                    collider.convex = policy.collider == "convex";
                    counts.colliders++;
                }
        }

        /// <summary>Saves the texture, material, meshes and clips as owned assets, rebinds the instance to them and wires the controller.</summary>
        static void SaveResources(ImportProfile p, GameObject instance, Prepared prepared, Owner owner) {
            string source = p.sourcePath;
            // Updating an existing texture destroys its temporary clone and clears
            // Material references to it. Preserve the validated binding identities
            // before Save, then rebind every captured property to the owned asset.
            var textureProperties = prepared.material.GetTexturePropertyNames().Where(property => prepared.material.GetTexture(property) != null).ToArray();
            ImportProfile.Require(prepared.material.mainTexture == prepared.texture && textureProperties.Length > 0 &&
                textureProperties.All(property => prepared.material.GetTexture(property) == prepared.texture),
                "Prepared material atlas bindings changed before native resource save.");
            prepared.texture = Save(prepared.texture, source, TextureFile, owner);
            foreach (string property in textureProperties)
                prepared.material.SetTexture(property, prepared.texture);
            ImportProfile.Require(prepared.material.mainTexture == prepared.texture, "Owned material atlas binding was lost during texture save.");
            prepared.material = Save(prepared.material, source, MaterialFile, owner);
            // Updating an existing asset destroys its temporary clone. Capture assignments
            // before that operation so Unity's cleared native references cannot lose identity.
            var assignments = instance.GetComponentsInChildren<MeshIndex>(true).Select(marker => (marker, id: MeshFor(marker).GetEntityId())).ToArray();
            var savedMeshes = new Dictionary<EntityId, Mesh>();
            foreach (var entry in prepared.meshes)
                savedMeshes.Add(entry.Value.GetEntityId(), Save(entry.Value, source, prepared.meshNames[entry.Key], owner));
            foreach (var (marker, id) in assignments) {
                var saved = savedMeshes[id];
                SetMesh(marker, saved);
                marker.GetComponent<Renderer>().sharedMaterials = marker.materialIndices.Select(_ => prepared.material).ToArray();
                var collider = marker.GetComponent<MeshCollider>();
                if (collider != null)
                    collider.sharedMesh = saved;
            }
            for (int i = 0; i < prepared.clips.Length; i++)
                prepared.clips[i] = Save(prepared.clips[i], source, ClipFile(i), owner);
            var resources = instance.AddComponent<ImportIndex>();
            resources.textures = new[] { prepared.texture };
            resources.materials = new[] { prepared.material };
            resources.clips = prepared.clips;
            if (prepared.clips.Length > 0)
                WireController(instance, prepared.clips, source, owner);
        }

        static void ValidateTexture(ImportProfile p, Texture2D t) =>
            ImportProfile.Require(t != null && t.width == p.data.source.width && t.height == p.data.source.height && t.format == TextureFormat.RGBA32 &&
                t.mipmapCount == 1 && t.isReadable && t.isDataSRGB && t.filterMode == FilterMode.Point &&
                t.wrapModeU == TextureWrapMode.Clamp && t.wrapModeV == TextureWrapMode.Clamp && t.anisoLevel == 0,
                "Owned native atlas does not match exact pixel/sampler/data profile.");

        /// <summary>Reloads the saved prefab and checks every owned resource, renderer, collider, clip and the clock against the profile.</summary>
        static void VerifySaved(ImportProfile p, Counts counts, Owner owner) {
            ImportProfile.Require(counts != null && counts.meshNodes == p.data.nodes.Length && counts.textures == 1 && counts.materials == 1 && counts.clips == p.data.clips.Length,
                "Readiness counts differ from complete source policy.");
            string source = p.sourcePath;
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(GetPrefabPath(source));
            ImportProfile.Require(prefab != null, "Generated prefab did not reload.");
            TargetPolicy.ValidateStoredRoot(prefab.activeSelf);
            RequireOwned(prefab, source, owner, PrefabFile(source), typeof(GameObject));
            var resources = prefab.GetComponent<ImportIndex>();
            ImportProfile.Require(resources != null && resources.textures?.Length == 1 && resources.materials?.Length == 1 && resources.clips?.Length == p.data.clips.Length,
                "Saved target resource inventory differs.");
            VerifySavedMaterial(p, resources, owner);
            VerifySavedMeshes(p, prefab, resources.materials[0], counts, owner);
            for (int i = 0; i < resources.clips.Length; i++) {
                var clip = resources.clips[i];
                var policy = p.data.clips[i];
                RequireOwned(clip, source, owner, ClipFile(i), typeof(AnimationClip));
                ImportProfile.Require(clip.name == policy.name && clip.frameRate == policy.fps && AnimationUtility.GetAnimationClipSettings(clip).loopTime == policy.loop && !clip.legacy,
                    "Saved native animation metadata differs.");
            }
            RequireSourceIdentity(p, owner);
            var controller = resources.clips.Length > 0 ? OwnedController(p, owner) : null;
            TargetPolicy.ValidateClock(ClockSnapshot(prefab, controller, resources.clips), owner.clipIdentities);
        }

        static void VerifySavedMaterial(ImportProfile p, ImportIndex resources, Owner owner) {
            var texture = resources.textures[0];
            var material = resources.materials[0];
            ValidateTexture(p, texture);
            RequireOwned(texture, p.sourcePath, owner, TextureFile, typeof(Texture2D));
            RequireOwned(material, p.sourcePath, owner, MaterialFile, typeof(Material));
            ImportProfile.Require(material.mainTexture == texture, "Saved material has no exact owned base-color atlas binding.");
            foreach (string property in material.GetTexturePropertyNames()) {
                var bound = material.GetTexture(property);
                if (bound != null)
                    ImportProfile.Require(bound == texture, "Saved material retained an undeclared/foreign texture.");
            }
        }

        static void VerifySavedMeshes(ImportProfile p, GameObject prefab, Material material, Counts counts, Owner owner) {
            var markers = prefab.GetComponentsInChildren<MeshIndex>(true);
            ImportProfile.Require(markers.Length > 0 && markers.Select(m => m.nodeIndex).Distinct().Count() == p.data.nodes.Length, "Saved mesh node inventory differs.");
            int expectedColliders = 0;
            foreach (var marker in markers) {
                var policy = p.data.nodes.Single(n => n.nodeIndex == marker.nodeIndex);
                var mesh = MeshFor(marker);
                var renderer = marker.GetComponent<Renderer>();
                ImportProfile.Require(marker.sourceId == policy.id && marker.companionGenerated && marker.generatedRendererEnabled == policy.rendererVisible &&
                    renderer.enabled == (policy.rendererVisible && !marker.authoredRendererDisabled) && renderer.sharedMaterials.All(m => m == material),
                    "Saved target mesh/renderer policy differs.");
                RequireOwned(mesh, p.sourcePath, owner, MeshFile(policy.meshIndex, marker.meshNumeration), typeof(Mesh));
                var colliders = marker.GetComponents<Collider>();
                bool required = p.data.generateColliders && policy.collider != "none";
                ImportProfile.Require(colliders.Length == (required ? 1 : 0), "Saved per-mesh collider inventory differs.");
                if (!required)
                    continue;
                expectedColliders++;
                var collider = colliders[0] as MeshCollider;
                ImportProfile.Require(collider != null && collider.enabled && !collider.isTrigger && collider.sharedMesh == mesh && collider.convex == (policy.collider == "convex"),
                    "Saved collider type/mesh/convex policy differs.");
            }
            ImportProfile.Require(prefab.GetComponentsInChildren<Collider>(true).Length == expectedColliders && counts.colliders == expectedColliders &&
                prefab.GetComponentsInChildren<Renderer>(true).Count(r => !r.enabled) == counts.hiddenRenderers,
                "Saved hidden/collider inventory differs.");
        }

        /// <summary>Carries user-added Rigidbodies and hand-disabled renderers from the previous prefab, matched by source id.</summary>
        static void PreserveOverrides(GameObject instance, GameObject previous) {
            if (previous == null)
                return;
            var oldNodes = previous.GetComponentsInChildren<NodeIndex>(true)
                .Where(n => !string.IsNullOrEmpty(n.sourceId))
                .GroupBy(n => n.sourceId)
                .Where(g => g.Count() == 1)
                .ToDictionary(g => g.Key, g => g.Single());
            foreach (var node in instance.GetComponentsInChildren<NodeIndex>(true)) {
                if (string.IsNullOrEmpty(node.sourceId) || !oldNodes.TryGetValue(node.sourceId, out var prior))
                    continue;
                var body = prior.GetComponent<Rigidbody>();
                if (body != null && node.GetComponent<Rigidbody>() == null)
                    EditorUtility.CopySerialized(body, node.gameObject.AddComponent<Rigidbody>());
            }
            var oldMeshes = previous.GetComponentsInChildren<MeshIndex>(true)
                .Where(m => !string.IsNullOrEmpty(m.sourceId))
                .GroupBy(m => (m.sourceId, m.meshNumeration))
                .Where(g => g.Count() == 1)
                .ToDictionary(g => g.Key, g => g.Single());
            foreach (var marker in instance.GetComponentsInChildren<MeshIndex>(true)) {
                if (!oldMeshes.TryGetValue((marker.sourceId, marker.meshNumeration), out var prior))
                    continue;
                var renderer = prior.GetComponent<Renderer>();
                if (renderer != null && !renderer.enabled && prior.companionGenerated && (prior.generatedRendererEnabled || prior.authoredRendererDisabled))
                    marker.authoredRendererDisabled = true;
            }
        }
    }
}

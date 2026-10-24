using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using Object = UnityEngine.Object;

namespace MargoMesh.Unity.Editor {
    // Output-folder ownership: owner.json, identity and output hashes, owned file names.
    public static partial class ImportCompanion {
        const string TextureFile = "Texture_0.asset", MaterialFile = "Material_0.mat";
        static readonly Regex OwnedFileName = new Regex("^[A-Za-z0-9_.-]+$", RegexOptions.CultureInvariant);

        static string ClipFile(int index) => "Animation_" + index + ".anim";
        static string MeshFile(int meshIndex, int numeration) => "Mesh_" + meshIndex + "_" + numeration + ".asset";
        static string PrefabFile(string source) => Path.GetFileNameWithoutExtension(source) + ".prefab";
        static string ControllerFile(string source) => Path.GetFileNameWithoutExtension(source) + ".controller";
        static string OutputPath(string source, string name) => GetOutputDirectory(source) + "/" + name;

        [Serializable]
        sealed class OutputFile {
            public string path, guid, type, sha256, metaSHA256;
            public long bytes;
        }

        [Serializable]
        sealed class Owner {
            public int schema = TargetPolicy.OwnerSchema;
            public string package = ImportProfile.Package, packageVersion = ImportProfile.Version, sourceGuid, source, generationId;
            public string controllerPolicy = TargetPolicy.ControllerPolicy;
            public TargetPolicy.ClipIdentity[] clipIdentities;
            public TargetPolicy.MeshIdentity[] meshIdentities;
            public TargetPolicy.FileIdentity[] intendedFiles;
            public List<OutputFile> files = new List<OutputFile>();
        }

        /// <summary>The owner of an existing output folder, or null when there is no folder yet.</summary>
        static Owner CheckOwner(string path, string guid) {
            string folder = GetOutputDirectory(path), file = folder + "/owner.json";
            ImportProfile.RequireOrdinaryPath(folder);
            if (!Directory.Exists(folder) && !AssetDatabase.IsValidFolder(folder))
                return null;
            ImportProfile.Require(File.Exists(file), "Output folder already exists without a strict ownership marker; move it away or use a fresh target.");
            ValidateStoredIdentity(GlbSource.Parse(File.ReadAllBytes(file)));
            var owner = JsonUtility.FromJson<Owner>(File.ReadAllText(file));
            ImportProfile.Require(IsSupportedOwner(owner, path, guid),
                "Output folder belongs to another or unsupported source/version. Use a fresh target; older ownership is never adopted.");
            IdentityHash(owner);
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in owner.files)
                ImportProfile.Require(item != null && names.Add(item.path) && IsOwnedFileEntry(folder, item),
                    "Owned generated resource identity changed; use a fresh target or restore the recorded file.");
            return owner;
        }

        static bool IsSupportedOwner(Owner owner, string path, string guid) {
            if (owner == null || owner.files == null || string.IsNullOrEmpty(owner.sourceGuid))
                return false;
            bool policy = owner.schema == TargetPolicy.OwnerSchema && owner.package == ImportProfile.Package &&
                owner.packageVersion == ImportProfile.Version && owner.controllerPolicy == TargetPolicy.ControllerPolicy;
            // A deleted source has no GUID; its folder still belongs to the recorded source path.
            bool source = owner.source == path && (string.IsNullOrEmpty(guid) && !File.Exists(path) || owner.sourceGuid == guid);
            return policy && source;
        }

        static bool IsOwnedFileEntry(string folder, OutputFile item) =>
            OwnedFileName.IsMatch(item.path) && item.path != "." && item.path != ".." && !string.IsNullOrEmpty(item.guid) &&
            AssetDatabase.AssetPathToGUID(folder + "/" + item.path) == item.guid;

        /// <summary>Checks the raw owner.json shape; JsonUtility defaults are not evidence of an explicit schema or identity.</summary>
        static void ValidateStoredIdentity(Dictionary<string, object> raw) {
            ImportProfile.Require(ImportProfile.Num(raw, "schema") == TargetPolicy.OwnerSchema, "Unsupported owner schema. Use a fresh target; no old ownership is adopted.");
            foreach (string field in new[] { "package", "packageVersion", "sourceGuid", "source", "controllerPolicy" })
                ImportProfile.Text(raw, field);
            StoredTextIsEmpty(ImportProfile.Get(raw, "generationId"));
            foreach (var value in ImportProfile.Arr(raw, "clipIdentities")) {
                var row = GlbSource.Obj(value);
                ImportProfile.Int(row, "animationIndex");
                ImportProfile.Text(row, "name");
            }
            foreach (var value in ImportProfile.Arr(raw, "meshIdentities")) {
                var row = GlbSource.Obj(value);
                ImportProfile.Int(row, "meshIndex");
                ImportProfile.Int(row, "meshNumeration");
                ImportProfile.Text(row, "path");
                foreach (var id in ImportProfile.Arr(row, "sourceIds"))
                    GlbSource.Text(id);
            }
            foreach (var value in ImportProfile.Arr(raw, "intendedFiles")) {
                var row = GlbSource.Obj(value);
                ImportProfile.Text(row, "path");
                ImportProfile.Text(row, "type");
            }
            foreach (var value in ImportProfile.Arr(raw, "files")) {
                var row = GlbSource.Obj(value);
                foreach (string field in new[] { "path", "guid", "type" })
                    ImportProfile.Text(row, field);
                foreach (string field in new[] { "sha256", "metaSHA256" })
                    StoredTextIsEmpty(ImportProfile.Get(row, field));
                double bytes = ImportProfile.Num(row, "bytes");
                ImportProfile.Require(bytes >= 0 && bytes <= 9007199254740991d && Math.Floor(bytes) == bytes, "Owned file byte count must be an explicit JSON-safe integer.");
            }
        }

        static TargetPolicy.ClipIdentity[] ClipIdentities(ImportProfile profile) =>
            profile.data.clips.Select(c => new TargetPolicy.ClipIdentity { animationIndex = c.animationIndex, name = c.name }).ToArray();

        static TargetPolicy.FileIdentity[] RecordedFiles(Owner owner) =>
            owner.files.Select(f => new TargetPolicy.FileIdentity { path = f.path, type = f.type }).ToArray();

        /// <summary>Every file a complete generation owns, sorted by name.</summary>
        static TargetPolicy.FileIdentity[] IntendedFiles(string source, TargetPolicy.MeshIdentity[] meshes, int clips) {
            TargetPolicy.FileIdentity Entry(string path, Type type) => new TargetPolicy.FileIdentity { path = path, type = type.FullName };
            var files = new List<TargetPolicy.FileIdentity> {
                Entry(TextureFile, typeof(Texture2D)),
                Entry(MaterialFile, typeof(Material)),
                Entry(PrefabFile(source), typeof(GameObject)),
            };
            files.AddRange(meshes.Select(m => Entry(m.path, typeof(Mesh))));
            for (int i = 0; i < clips; i++)
                files.Add(Entry(ClipFile(i), typeof(AnimationClip)));
            if (clips > 0)
                files.Add(Entry(ControllerFile(source), typeof(AnimatorController)));
            return files.OrderBy(f => f.path, StringComparer.Ordinal).ToArray();
        }

        static string IdentityHash(Owner owner) {
            ImportProfile.Require(owner.package == ImportProfile.Package && owner.packageVersion == ImportProfile.Version, "Unsupported owned policy package/version. Use a fresh target.");
            string canonical = TargetPolicy.CanonicalIdentity(owner.controllerPolicy, owner.clipIdentities, owner.meshIdentities);
            TargetPolicy.Files(owner.intendedFiles, IntendedFiles(owner.source, owner.meshIdentities, owner.clipIdentities.Length), false);
            return ImportProfile.Hash(new UTF8Encoding(false, true).GetBytes(canonical + TargetPolicy.CanonicalFiles(owner.intendedFiles)));
        }

        /// <summary>An existing owner must match its last success, or the exact recorded partial attempt being retried.</summary>
        static void ValidateHistory(ImportProfile profile, Owner owner, Report previous) {
            if (owner == null)
                return;
            string identity = IdentityHash(owner);
            TargetPolicy.SameClips(owner.clipIdentities, ClipIdentities(profile));
            var last = previous?.lastSuccessful;
            bool successful = ValidHistoryTuple(last, owner) && owner.generationId == last.generationId &&
                last.identityManifestSHA256 == identity && OutputHash(owner) == last.outputManifestSHA256;
            // A recorded partial retry must bind the exact same attempted source,
            // profile and identity. It cannot establish new compatibility history.
            bool partial = previous != null && previous.status == "stale" && previous.error != null && previous.error.partialOutput &&
                Matches(previous.current, profile) && previous.current.identityManifestSHA256 == identity;
            bool initialPartial = partial && string.IsNullOrEmpty(owner.generationId) && last == null;
            bool boundPartial = partial && ValidHistoryTuple(previous.current, owner) && owner.generationId == previous.current.generationId &&
                OutputHash(owner) == previous.current.outputManifestSHA256;
            ImportProfile.Require(successful || initialPartial || boundPartial,
                "Owned semantic metadata has no matching last-success or exact recorded partial-attempt binding. Use a fresh target or explicit recovery review.");
            TargetPolicy.Files(RecordedFiles(owner), owner.intendedFiles, initialPartial);
        }

        /// <summary>A stored tuple that is complete and consistent with <paramref name="owner"/>.</summary>
        static bool ValidHistoryTuple(Tuple tuple, Owner owner) {
            if (tuple == null || !Guid.TryParseExact(tuple.generationId, "N", out var id) || id == Guid.Empty || tuple.support == null || tuple.source == null || tuple.counts == null)
                return false;
            var s = tuple.source;
            var c = tuple.counts;
            bool hashes = ImportProfile.IsHash(tuple.support.manifestSHA256) && ImportProfile.IsHash(tuple.profileSHA256) &&
                ImportProfile.IsHash(tuple.identityManifestSHA256) && ImportProfile.IsHash(tuple.outputManifestSHA256) &&
                ImportProfile.IsHash(s.glbSHA256) && ImportProfile.IsHash(s.pngSHA256);
            bool source = tuple.support.package == owner.package && tuple.support.version == owner.packageVersion &&
                s.guid == owner.sourceGuid && s.glbPath == owner.source && s.pngPath == Path.GetDirectoryName(owner.source).Replace('\\', '/') + "/atlas.png" &&
                s.width > 0 && s.width <= 16384 && s.height > 0 && s.height <= 16384;
            int markers = owner.meshIdentities.Sum(m => m.sourceIds.Length);
            bool counts = c.meshNodes == owner.meshIdentities.SelectMany(m => m.sourceIds).Distinct(StringComparer.Ordinal).Count() &&
                c.clips == owner.clipIdentities.Length && c.textures == 1 && c.materials == 1 &&
                c.hiddenRenderers >= 0 && c.hiddenRenderers <= markers && c.colliders >= 0 && c.colliders <= markers;
            return hashes && source && counts;
        }

        static void RequireSourceIdentity(ImportProfile profile, Owner owner) {
            TargetPolicy.SameClips(owner.clipIdentities, ClipIdentities(profile));
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(GetPrefabPath(profile.sourcePath));
            ImportProfile.Require(prefab != null, "Owned prefab is missing; import the asset again.");
            TargetPolicy.SameIdentity(owner.controllerPolicy, owner.clipIdentities, owner.meshIdentities, ClipIdentities(profile), MeshIdentities(profile, prefab));
            TargetPolicy.Files(RecordedFiles(owner), IntendedFiles(profile.sourcePath, owner.meshIdentities, profile.data.clips.Length), false);
        }

        /// <summary>One mesh-file identity per native mesh, with the sorted source ids of the nodes sharing it.</summary>
        static TargetPolicy.MeshIdentity[] MeshIdentities(ImportProfile profile, GameObject instance) {
            var rows = instance.GetComponentsInChildren<MeshIndex>(true)
                .Select(m => new { marker = m, policy = profile.data.nodes.Single(n => n.nodeIndex == m.nodeIndex) })
                .GroupBy(x => MeshFile(x.policy.meshIndex, x.marker.meshNumeration), StringComparer.Ordinal)
                .OrderBy(g => g.Key, StringComparer.Ordinal)
                .ToArray();
            var native = new HashSet<Mesh>();
            var result = new List<TargetPolicy.MeshIdentity>();
            foreach (var row in rows) {
                var first = row.First();
                var mesh = MeshFor(first.marker);
                bool unambiguous = row.All(x => x.policy.meshIndex == first.policy.meshIndex && x.marker.meshNumeration == first.marker.meshNumeration && MeshFor(x.marker) == mesh);
                ImportProfile.Require(mesh != null && native.Add(mesh) && unambiguous, "Native mesh alias/split identity is ambiguous; use a supported fresh source.");
                result.Add(new TargetPolicy.MeshIdentity {
                    path = row.Key,
                    meshIndex = first.policy.meshIndex,
                    meshNumeration = first.marker.meshNumeration,
                    sourceIds = row.Select(x => x.policy.id).Distinct(StringComparer.Ordinal).OrderBy(id => id, StringComparer.Ordinal).ToArray(),
                });
            }
            return result.ToArray();
        }

        static void ValidateUpdateIdentity(ImportProfile profile, Owner owner, TargetPolicy.MeshIdentity[] nextMeshes) {
            var clips = ClipIdentities(profile);
            TargetPolicy.CanonicalIdentity(TargetPolicy.ControllerPolicy, clips, nextMeshes);
            if (owner == null)
                return;
            TargetPolicy.SameIdentity(owner.controllerPolicy, owner.clipIdentities, owner.meshIdentities, clips, nextMeshes);
            TargetPolicy.Files(owner.intendedFiles, IntendedFiles(profile.sourcePath, nextMeshes, clips.Length), false);
        }

        static Owner CreateOwnerIdentity(ImportProfile profile, TargetPolicy.MeshIdentity[] meshes) => new Owner {
            source = profile.sourcePath,
            sourceGuid = profile.sourceGuid,
            clipIdentities = ClipIdentities(profile),
            meshIdentities = meshes,
            intendedFiles = IntendedFiles(profile.sourcePath, meshes, profile.data.clips.Length),
        };

        /// <summary>Creates the output folder and owner.json for a new target; an existing owner is returned unchanged.</summary>
        static Owner EstablishOwner(ImportProfile profile, Owner intendedOwner, bool existing) {
            if (existing)
                return intendedOwner;
            string path = profile.sourcePath;
            string folder = GetOutputDirectory(path);
            ImportProfile.Require(!Directory.Exists(folder), "Output ownership changed during validation; import again.");
            ImportProfile.Require(!string.IsNullOrEmpty(AssetDatabase.CreateFolder(Path.GetDirectoryName(folder).Replace('\\', '/'), Path.GetFileName(folder))),
                "Could not create the owned output folder " + folder + ".");
            IdentityHash(intendedOwner);
            WriteOwner(path, intendedOwner);
            return intendedOwner;
        }

        static void WriteOwner(string path, Owner owner) {
            string file = OutputPath(path, "owner.json");
            File.WriteAllText(file, JsonUtility.ToJson(owner, true) + "\n");
            AssetDatabase.ImportAsset(file, ImportAssetOptions.ForceSynchronousImport);
        }

        /// <summary>Records (or updates) the GUID and type of one owned output and saves owner.json.</summary>
        static void Record(Owner owner, string source, string path, Type type) {
            string name = Path.GetFileName(path);
            var value = owner.files.SingleOrDefault(f => f.path == name);
            if (value == null) {
                value = new OutputFile { path = name };
                owner.files.Add(value);
                owner.files.Sort((a, b) => string.CompareOrdinal(a.path, b.path));
            }
            value.guid = AssetDatabase.AssetPathToGUID(path);
            value.type = type.FullName;
            ImportProfile.Require(!string.IsNullOrEmpty(value.guid), "Generated resource " + name + " has no stable GUID.");
            WriteOwner(source, owner);
        }

        static void FlushOwned(string source, Owner owner) {
            foreach (var file in owner.files) {
                var asset = AssetDatabase.LoadMainAssetAtPath(OutputPath(source, file.path));
                if (asset != null)
                    AssetDatabase.SaveAssetIfDirty(asset);
            }
        }

        static string OutputHash(Owner owner) {
            var rows = owner.files.OrderBy(f => f.path, StringComparer.Ordinal).Select(f =>
                f.path + "\t" + f.guid + "\t" + f.type + "\t" + f.bytes.ToString(System.Globalization.CultureInfo.InvariantCulture) + "\t" + f.sha256 + "\t" + f.metaSHA256);
            return ImportProfile.Hash(Encoding.UTF8.GetBytes("margo-owned-output-v2\nidentity\t" + IdentityHash(owner) + "\n" + string.Join("\n", rows) + "\n"));
        }

        /// <summary>Hashes every owned file and its .meta, binds them to <paramref name="tuple"/> and verifies the result.</summary>
        static void BindOutputs(string source, Owner owner, Tuple tuple) {
            foreach (var file in owner.files) {
                string path = OutputPath(source, file.path);
                file.bytes = new FileInfo(path).Length;
                file.sha256 = ImportProfile.FileHash(path);
                file.metaSHA256 = ImportProfile.FileHash(path + ".meta");
            }
            TargetPolicy.Files(RecordedFiles(owner), owner.intendedFiles, false);
            owner.generationId = tuple.generationId;
            tuple.identityManifestSHA256 = IdentityHash(owner);
            tuple.outputManifestSHA256 = OutputHash(owner);
            WriteOwner(source, owner);
            VerifyOutputs(source, owner, tuple);
        }

        static void VerifyOutputs(string source, Owner owner, Tuple tuple) {
            TargetPolicy.Files(RecordedFiles(owner), owner.intendedFiles, false);
            ImportProfile.Require(owner.generationId == tuple.generationId && tuple.identityManifestSHA256 == IdentityHash(owner) &&
                !string.IsNullOrEmpty(tuple.outputManifestSHA256) && OutputHash(owner) == tuple.outputManifestSHA256,
                "Generated semantic/output inventory is not bound to the ready generation; import again.");
            foreach (var file in owner.files)
                ImportProfile.Require(IsUnchanged(OutputPath(source, file.path), file), "Generated output changed or is dirty after successful target import: " + file.path);
        }

        static bool IsUnchanged(string path, OutputFile file) =>
            File.Exists(path) && new FileInfo(path).Length == file.bytes && ImportProfile.FileHash(path) == file.sha256 &&
            File.Exists(path + ".meta") && ImportProfile.FileHash(path + ".meta") == file.metaSHA256 &&
            !AssetDatabase.LoadAllAssetsAtPath(path).Any(EditorUtility.IsDirty);

        /// <summary>An output name is free, or already holds the owned asset of that type.</summary>
        static void CheckName(string source, Owner owner, string name, Type type) {
            string path = OutputPath(source, name);
            var value = AssetDatabase.LoadMainAssetAtPath(path);
            bool exists = File.Exists(path) || !string.IsNullOrEmpty(AssetDatabase.AssetPathToGUID(path));
            if (!exists) {
                ImportProfile.Require(owner == null || !owner.files.Any(f => f.path == name), "Owned generated resource " + name + " is missing; restore it or use a fresh target.");
                return;
            }
            var entry = owner?.files.SingleOrDefault(f => f.path == name);
            ImportProfile.Require(entry != null && entry.guid == AssetDatabase.AssetPathToGUID(path) && entry.type == type.FullName && value != null && type.IsInstanceOfType(value),
                "Generated filename conflicts with an unowned/wrong-type asset: " + name);
        }

        static void ValidateOutputNames(string source, Owner owner, Prepared p, bool clips) {
            CheckName(source, owner, TextureFile, typeof(Texture2D));
            CheckName(source, owner, MaterialFile, typeof(Material));
            CheckName(source, owner, PrefabFile(source), typeof(GameObject));
            foreach (string name in p.meshNames.Values.Distinct())
                CheckName(source, owner, name, typeof(Mesh));
            for (int i = 0; i < p.clips.Length; i++)
                CheckName(source, owner, ClipFile(i), typeof(AnimationClip));
            if (clips)
                CheckName(source, owner, ControllerFile(source), typeof(AnimatorController));
        }

        /// <summary><paramref name="asset"/> is the persistent owned resource recorded as <paramref name="name"/>.</summary>
        static void RequireOwned(Object asset, string source, Owner owner, string name, Type type) {
            string path = OutputPath(source, name);
            var file = owner.files.SingleOrDefault(f => f.path == name);
            ImportProfile.Require(asset != null && EditorUtility.IsPersistent(asset) && AssetDatabase.GetAssetPath(asset) == path && file != null &&
                file.type == type.FullName && AssetDatabase.AssetPathToGUID(path) == file.guid && type.IsInstanceOfType(asset),
                "Saved target reference is not the exact owned resource: " + name);
        }
    }
}

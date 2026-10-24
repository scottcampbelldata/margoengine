using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor.PackageManager;
using UnityEngine;

namespace MargoMesh.Unity.Editor {
    /// <summary>
    /// A validated <c>margo-profile.json</c> sidecar with its source GLB and atlas. Validation and hashes only; no image,
    /// mesh, skin, animation or hull kernel.
    /// </summary>
    internal sealed class ImportProfile {
        internal const string Id = "margo-unity-exact-v1", Package = "com.margo.mesh", Version = "0.3.0";
        const string UnityVersion = "6000.6.7f1", GltfastPackage = "com.unity.cloud.gltfast", GltfastVersion = "6.20.0";
        const int Nearest = 9728, ClampToEdge = 33071, Float = 5126, Triangles = 4;
        const long JsonLimit = 4 * 1024 * 1024, AtlasLimit = 128L * 1024 * 1024;
        // Four encoded Float32 components may each round by 2^-24; no normalization is applied on export.
        static readonly double UnitEnvelope = 4 * Math.Pow(2, -24);

        // JsonUtility assigns these serialized DTO fields in native code.
#pragma warning disable 0649
        [Serializable]
        public sealed class Source {
            public string glb, glbSHA256, png, pngSHA256;
            public int textureIndex, width, height;
        }
        [Serializable]
        public sealed class Sampler {
            public int magFilter, minFilter, wrapS, wrapT, anisotropy;
            public string dataColorSpace;
            public bool mipmaps;
        }
        [Serializable]
        public sealed class Node {
            public int nodeIndex, meshIndex;
            public string id, name, collider;
            public bool sourceVisible, rendererVisible;
        }
        [Serializable]
        public sealed class Clip {
            public int animationIndex;
            public string name;
            public float fps;
            public bool loop;
        }
        [Serializable]
        public sealed class Data {
            public int schema;
            public string profile;
            public ImportCompanion.Support support;
            public Source source;
            public Sampler sampler;
            public bool generateColliders;
            public Node[] nodes;
            public Clip[] clips;
        }
#pragma warning restore 0649

        internal Data data;
        internal GlbSource glb;
        internal string sourcePath, pngPath, profilePath, profileHash, sourceGuid;
        internal byte[] png;

        static readonly Regex HashPattern = new Regex("^[0-9a-f]{64}$", RegexOptions.CultureInvariant);
        static readonly Regex SourcePattern = new Regex("^Assets/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*/model[.]glb$", RegexOptions.CultureInvariant);
        static readonly Regex ReservedFolder = new Regex("^(editor|resources|plugins|streamingassets|cvs|con|prn|aux|nul|com[1-9]|lpt[1-9])$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        static readonly Regex Collision = new Regex("-(convcolonly|convcol|colonly|col)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        static readonly string[] Executable = { ".cs", ".dll", ".asmdef", ".asmref", ".rsp", ".winmd", ".so", ".dylib", ".bundle", ".exe" };

        // ---- Paths and hashes

        static string Hex(byte[] digest) => BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant();
        internal static string Hash(byte[] bytes) {
            using (var h = SHA256.Create())
                return Hex(h.ComputeHash(bytes));
        }
        internal static string FileHash(string path) {
            using (var stream = File.OpenRead(path))
            using (var h = SHA256.Create())
                return Hex(h.ComputeHash(stream));
        }
        internal static bool IsHash(string value) => value != null && HashPattern.IsMatch(value);
        static byte[] ReadBounded(string path, long limit) {
            Require(new FileInfo(path).Length <= limit, "Input file " + path + " is larger than " + limit + " bytes; export a smaller asset.");
            return File.ReadAllBytes(path);
        }
        /// <summary>A fixed <c>Assets/.../model.glb</c> path whose folders are not Unity special or ignored folders.</summary>
        internal static bool IsSourcePath(string path) {
            if (path == null || !SourcePattern.IsMatch(path))
                return false;
            var folders = path.Split('/');
            return !folders.Skip(1).Take(folders.Length - 2).Any(ReservedFolder.IsMatch);
        }
        internal static string ProfilePath(string source) => Folder(source) + "/margo-profile.json";
        static string Folder(string source) => Path.GetDirectoryName(source).Replace('\\', '/');
        internal static void RequireOrdinaryPath(string path) {
            string at = Path.GetFullPath(path);
            while (!File.Exists(at) && !Directory.Exists(at))
                at = Path.GetDirectoryName(at);
            Require(!string.IsNullOrEmpty(at) && !IsReparse(at), "Strict input/output cannot use filesystem reparse points; use an ordinary folder.");
        }
        static bool IsReparse(string path) {
            for (string at = Path.GetFullPath(path); !string.IsNullOrEmpty(at); at = Path.GetDirectoryName(at))
                if ((File.GetAttributes(at) & FileAttributes.ReparsePoint) != 0)
                    return true;
            return false;
        }
        static bool SafeRelative(string value) =>
            !string.IsNullOrEmpty(value) && !Path.IsPathRooted(value) && !value.Contains('\\') && !value.Contains(':') &&
            value.Split('/').All(p => p.Length > 0 && p != "." && p != "..");
        internal string SourceId(int index) => GlbSource.Text(Get(Obj(GlbSource.Obj(glb.nodes[index]), "extras"), "id"));

        // ---- Reading

        /// <summary>Reads and validates the sidecar, the installed support package, the source GLB and the atlas.</summary>
        internal static ImportProfile Read(string path) {
            Require(IsSourcePath(path), "Strict source path must be a safe Assets folder with the fixed model.glb filename.");
            string profilePath = ProfilePath(path);
            RequireOrdinaryPath(path);
            RequireOrdinaryPath(profilePath);
            var bytes = ReadBounded(profilePath, JsonLimit);
            ValidateSidecar(GlbSource.Parse(bytes));
            var value = new ImportProfile {
                data = JsonUtility.FromJson<Data>(Encoding.UTF8.GetString(bytes)),
                sourcePath = path,
                profilePath = profilePath,
                profileHash = Hash(bytes),
                pngPath = Folder(path) + "/atlas.png",
                sourceGuid = UnityEditor.AssetDatabase.AssetPathToGUID(path),
            };
            Require(!string.IsNullOrEmpty(value.sourceGuid), "Strict source has no asset GUID; let Unity import model.glb first.");
            value.ValidateSupport();
            value.glb = GlbSource.Read(path);
            Require(value.glb != null, "Source generator is not exactly Margo Mesh Studio; export the asset from Margo Mesh.");
            Require(Hash(value.glb.bytes) == value.data.source.glbSHA256, "Source GLB hash does not match the sidecar; export the bundle again.");
            RequireOrdinaryPath(value.pngPath);
            value.png = ReadBounded(value.pngPath, AtlasLimit);
            Require(Hash(value.png) == value.data.source.pngSHA256, "Atlas PNG hash does not match the sidecar; export the bundle again.");
            value.ValidateSource();
            return value;
        }

        /// <summary>Checks the raw sidecar JSON, so JsonUtility defaults never stand in for missing fields.</summary>
        static void ValidateSidecar(Dictionary<string, object> doc) {
            Require(Num(doc, "schema") == 1 && Text(doc, "profile") == Id, "Unsupported strict sidecar schema/profile; export with support " + Version + ".");
            var support = Obj(doc, "support");
            Require(Text(support, "package") == Package && Text(support, "version") == Version && IsHash(Text(support, "manifestSHA256")),
                "Sidecar support identity is invalid; install support " + Package + " " + Version + " and export again.");
            var source = Obj(doc, "source");
            Require(Text(source, "glb") == "model.glb" && Text(source, "png") == "atlas.png" && Num(source, "textureIndex") == 0 &&
                IsHash(Text(source, "glbSHA256")) && IsHash(Text(source, "pngSHA256")),
                "Sidecar source identity is invalid; export the bundle again.");
            Int(source, "width");
            Int(source, "height");
            var sampler = Obj(doc, "sampler");
            Require(Num(sampler, "magFilter") == Nearest && Num(sampler, "minFilter") == Nearest &&
                Num(sampler, "wrapS") == ClampToEdge && Num(sampler, "wrapT") == ClampToEdge && Num(sampler, "anisotropy") == 0 &&
                Text(sampler, "dataColorSpace") == "srgb" && !GlbSource.Bool(Get(sampler, "mipmaps")),
                "Sidecar atlas sampler is not the exact nearest/clamp profile; export the bundle again.");
            GlbSource.Bool(Get(doc, "generateColliders"));
            foreach (var item in Arr(doc, "nodes")) {
                var node = GlbSource.Obj(item);
                Int(node, "nodeIndex");
                Int(node, "meshIndex");
                Text(node, "id");
                Text(node, "name");
                Text(node, "collider");
                GlbSource.Bool(Get(node, "sourceVisible"));
                GlbSource.Bool(Get(node, "rendererVisible"));
            }
            foreach (var item in Arr(doc, "clips")) {
                var clip = GlbSource.Obj(item);
                Int(clip, "animationIndex");
                Text(clip, "name");
                Require(IsNativeFps((float)Num(clip, "fps")), "Sidecar clip fps must be a finite positive Float32; author a valid clip rate.");
                GlbSource.Bool(Get(clip, "loop"));
            }
        }
        static bool IsNativeFps(float fps) => fps > 0 && !float.IsInfinity(fps) && !float.IsNaN(fps);

        /// <summary>Fails when the source, atlas, sidecar or GUID changed after <see cref="Read"/>, or the support package changed.</summary>
        internal void AssertInputsCurrent() {
            Require(FileHash(sourcePath) == data.source.glbSHA256 && FileHash(pngPath) == data.source.pngSHA256 &&
                FileHash(profilePath) == profileHash && UnityEditor.AssetDatabase.AssetPathToGUID(sourcePath) == sourceGuid,
                "Strict input changed while the target import was in progress; wait for the copy to finish and import again.");
            ValidateSupport();
        }

        // ---- Installed support package

        void ValidateSupport() {
            Require(Application.unityVersion == UnityVersion, "This strict support version requires Unity " + UnityVersion + ".");
            var support = PackageInfo.FindForAssembly(typeof(ImportCompanion).Assembly);
            var gltf = PackageInfo.FindForAssembly(typeof(GLTFast.GltfImport).Assembly);
            Require(support != null && support.name == Package && support.version == Version && !string.IsNullOrEmpty(support.resolvedPath),
                "The executing support package is not " + Package + " " + Version + "; reinstall it.");
            Require(gltf != null && gltf.name == GltfastPackage && gltf.version == GltfastVersion, "Strict support requires official glTFast " + GltfastVersion + ".");
            string root = Path.GetFullPath(support.resolvedPath);
            var bytes = ReadBounded(Path.Combine(root, "support-manifest.json"), JsonLimit);
            Require(Hash(bytes) == data.support.manifestSHA256, "Installed support manifest hash does not match the sidecar; install the matching support package.");
            var manifest = GlbSource.Parse(bytes);
            var requires = Obj(manifest, "requires");
            Require(Num(manifest, "schema") == 1 && Text(manifest, "profile") == Id && Text(manifest, "package") == Package &&
                Text(manifest, "version") == Version && Text(requires, "unity") == UnityVersion && Text(requires, "gltfast") == GltfastVersion,
                "Installed support manifest identity is invalid; reinstall the support package.");
            var listed = ValidatePayload(root, Arr(manifest, "files"));
            foreach (string file in PayloadFiles(root)) {
                string name = Path.GetRelativePath(root, file).Replace('\\', '/');
                Require(!IsReparse(file), "Support package contains a reparse point; reinstall it as ordinary files.");
                if (Executable.Any(ext => name.EndsWith(ext, StringComparison.OrdinalIgnoreCase)))
                    Require(listed.Contains(name), "Unexpected executable support payload " + name + "; remove it or reinstall the package.");
            }
        }

        /// <summary>Checks every listed payload file's size and hash; returns the listed paths.</summary>
        static HashSet<string> ValidatePayload(string root, List<object> files) {
            var names = new HashSet<string>(StringComparer.Ordinal);
            string previous = "";
            foreach (var item in files) {
                var entry = GlbSource.Obj(item);
                string name = Text(entry, "path"), sha = Text(entry, "sha256");
                double length = Num(entry, "bytes");
                Require(SafeRelative(name) && name != "support-manifest.json" && names.Add(name) && string.CompareOrdinal(previous, name) < 0 && IsHash(sha),
                    "Support manifest has an invalid or duplicate payload entry; reinstall the package.");
                previous = name;
                string file = Path.GetFullPath(Path.Combine(root, name));
                Require(file.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase), "Support payload " + name + " escapes the package.");
                Require(!IsReparse(file) && File.Exists(file) && new FileInfo(file).Length == length && FileHash(file) == sha,
                    "Installed support payload " + name + " differs from its manifest; reinstall the package.");
            }
            Require(names.Contains("package.json") && names.Contains("Editor/ImportCompanion.cs"), "Support payload inventory is incomplete; reinstall the package.");
            return names;
        }

        static IEnumerable<string> PayloadFiles(string directory) {
            Require(!IsReparse(directory), "Support package contains a reparse point; reinstall it as ordinary files.");
            foreach (string entry in Directory.GetFileSystemEntries(directory)) {
                Require(!IsReparse(entry), "Support package contains a reparse point; reinstall it as ordinary files.");
                if (Directory.Exists(entry)) {
                    foreach (string file in PayloadFiles(entry))
                        yield return file;
                } else
                    yield return entry;
            }
        }

        // ---- Source GLB

        void ValidateSource() {
            ValidateBuffers();
            ValidateAccessors();
            ValidateAtlas();
            ValidateMaterial();
            ValidateNodes();
            ValidateScene();
            ValidateSkins();
            ValidateClips();
            ValidateMeshNodes();
        }

        /// <summary>One embedded buffer and in-range, aligned buffer views.</summary>
        void ValidateBuffers() {
            var buffers = Arr(glb.root, "buffers");
            Require(buffers.Count == 1 && !GlbSource.Obj(buffers[0]).ContainsKey("uri"), "Source must own exactly one embedded buffer; export a self-contained GLB.");
            int binaryLength = Int(GlbSource.Obj(buffers[0]), "byteLength");
            Require(binaryLength > 0 && binaryLength <= glb.binary.Length && glb.binary.Length - binaryLength <= 3, "Source buffer 0 length does not match its BIN chunk; export the GLB again.");
            foreach (var item in Arr(glb.root, "bufferViews")) {
                var view = GlbSource.Obj(item);
                Require(Int(view, "buffer") == 0 && !view.ContainsKey("extensions"), "Source buffer views must be ordinary views of buffer 0; export an uncompressed GLB.");
                int start = OptionalInt(view, "byteOffset"), length = Int(view, "byteLength");
                Require(length > 0 && (long)start + length <= binaryLength, "Source buffer view exceeds the embedded buffer; export the GLB again.");
                if (view.ContainsKey("byteStride")) {
                    int stride = Int(view, "byteStride");
                    Require(stride >= 4 && stride <= 252 && stride % 4 == 0, "Source buffer view stride must be 4..252 and a multiple of 4.");
                }
            }
        }

        /// <summary>Ordinary accessors inside their views, with every Float32 value finite.</summary>
        void ValidateAccessors() {
            var views = Arr(glb.root, "bufferViews");
            foreach (var item in Arr(glb.root, "accessors")) {
                var accessor = GlbSource.Obj(item);
                Require(!accessor.ContainsKey("sparse") && !accessor.ContainsKey("extensions"), "Only ordinary source accessors are supported; export a nonsparse, uncompressed GLB.");
                var view = GlbSource.Obj(views[GlbSource.Index(Get(accessor, "bufferView"), views.Count)]);
                int count = Int(accessor, "count"), size = ComponentSize(Int(accessor, "componentType")), arity = Arity(Text(accessor, "type"));
                int offset = OptionalInt(accessor, "byteOffset"), packed = checked(size * arity);
                int stride = view.ContainsKey("byteStride") ? Int(view, "byteStride") : packed;
                Require(count > 0 && stride >= packed && offset % size == 0 && (long)offset + (long)(count - 1) * stride + packed <= Int(view, "byteLength"),
                    "Source accessor exceeds its buffer view or is misaligned; export the GLB again.");
                if (Int(accessor, "componentType") != Float)
                    continue;
                var read = Reader(accessor);
                for (int i = 0; i < count; i++)
                    for (int c = 0; c < arity; c++) {
                        double value = read(i, c);
                        Require(!double.IsNaN(value) && !double.IsInfinity(value), "Source Float32 values must be finite; repair the exported attributes, binds or keys.");
                    }
            }
        }

        /// <summary>One embedded, unstrided PNG equal to the standalone atlas, with the declared RGBA8 power-of-two header.</summary>
        void ValidateAtlas() {
            var images = Arr(glb.root, "images");
            var views = Arr(glb.root, "bufferViews");
            Require(images.Count == 1 && glb.materials.Count == 1 && glb.textures.Count == 1 && glb.samplers.Count == 1,
                "Strict profile needs exactly one material, image, texture and sampler; use the general GLB for other assets.");
            var image = GlbSource.Obj(images[0]);
            Require(Text(image, "mimeType") == "image/png" && !image.ContainsKey("uri"), "Strict atlas must be an embedded PNG.");
            var view = GlbSource.Obj(views[GlbSource.Index(Get(image, "bufferView"), views.Count)]);
            Require(!view.ContainsKey("byteStride"), "Atlas buffer view cannot be strided.");
            int start = OptionalInt(view, "byteOffset"), length = Int(view, "byteLength");
            Require(png.Length == length && png.SequenceEqual(glb.binary.Skip(start).Take(length)), "Standalone atlas.png must equal the PNG embedded in model.glb; export the bundle again.");
            Require(png.Length >= 33 && png.Take(8).SequenceEqual(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 }) &&
                BigEndian(png, 8) == 13 && BigEndian(png, 12) == 0x49484452 &&
                png[24] == 8 && png[25] == 6 && png[26] == 0 && png[27] == 0 && png[28] == 0,
                "Atlas must be an ordinary noninterlaced RGBA8 PNG.");
            uint width = BigEndian(png, 16), height = BigEndian(png, 20);
            Require(IsAtlasSide(width) && IsAtlasSide(height) && width == data.source.width && height == data.source.height,
                "Atlas size must be a power of two up to 16384 and match the sidecar.");
        }
        static bool IsAtlasSide(uint side) => side > 0 && side <= 16384 && (side & (side - 1)) == 0;
        static uint BigEndian(byte[] b, int at) => (uint)b[at] << 24 | (uint)b[at + 1] << 16 | (uint)b[at + 2] << 8 | b[at + 3];

        /// <summary>The single untransformed base-color atlas material with exact nearest/clamp sampling.</summary>
        void ValidateMaterial() {
            var material = GlbSource.Obj(glb.materials[0]);
            var pbr = Obj(material, "pbrMetallicRoughness");
            var atlas = Obj(pbr, "baseColorTexture");
            var texture = GlbSource.Obj(glb.textures[0]);
            var sampler = GlbSource.Obj(glb.samplers[0]);
            bool onlyBaseColor = !material.ContainsKey("extensions") && !material.ContainsKey("normalTexture") &&
                !material.ContainsKey("occlusionTexture") && !material.ContainsKey("emissiveTexture") && !pbr.ContainsKey("metallicRoughnessTexture");
            bool directAtlas = Num(atlas, "index") == 0 && OptionalInt(atlas, "texCoord") == 0 && !atlas.ContainsKey("extensions") &&
                Num(texture, "source") == 0 && Num(texture, "sampler") == 0 && !texture.ContainsKey("extensions");
            Require(onlyBaseColor && directAtlas, "Source material must be the single untransformed base-color atlas; use the general GLB for other materials.");
            Require(Num(sampler, "magFilter") == Nearest && Num(sampler, "minFilter") == Nearest && Num(sampler, "wrapS") == ClampToEdge && Num(sampler, "wrapT") == ClampToEdge,
                "Source sampler must be NEAREST/NEAREST with CLAMP_TO_EDGE wrapping.");
        }

        /// <summary>Unique <c>extras.id</c> on every node, TRS only, finite transforms and unit rotations.</summary>
        void ValidateNodes() {
            var ids = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < glb.nodes.Count; i++) {
                var node = GlbSource.Obj(glb.nodes[i]);
                string id = SourceId(i);
                Require(id.Length > 0 && ids.Add(id), "Every source node, including bones and empties, needs a nonempty unique extras.id.");
                Require(!node.ContainsKey("matrix") && !Obj(node, "extensions").ContainsKey("EXT_mesh_gpu_instancing"),
                    "Source matrices and GPU instancing are unsupported by the exact target profile; export TRS nodes.");
                foreach (var (key, size) in new[] { ("translation", 3), ("rotation", 4), ("scale", 3) }) {
                    if (!node.ContainsKey(key))
                        continue;
                    var values = Arr(node, key);
                    Require(values.Count == size, "Source node " + key + " needs " + size + " numbers.");
                    foreach (var v in values)
                        GlbSource.Number(v);
                }
                if (node.ContainsKey("rotation")) {
                    double length = Arr(node, "rotation").Select(GlbSource.Number).Sum(v => v * v);
                    Require(Math.Abs(length - 1) <= UnitEnvelope, "Source rotation must be a unit quaternion; repair it in the source (export does not normalize).");
                }
            }
        }

        /// <summary>One explicit default scene whose roots reach every node.</summary>
        void ValidateScene() {
            var scenes = Arr(glb.root, "scenes");
            Require(scenes.Count == 1 && glb.root.ContainsKey("scene") && Int(glb.root, "scene") == 0, "Strict source needs one explicit complete default scene.");
            var roots = Arr(GlbSource.Obj(scenes[0]), "nodes").Select(n => GlbSource.Index(n, glb.nodes.Count)).ToArray();
            Require(roots.Distinct().Count() == roots.Length && roots.All(n => glb.parents[n] == -1), "Source scene roots must be unique parentless nodes.");
            for (int i = 0; i < glb.nodes.Count; i++) {
                int root = i;
                while (glb.parents[root] >= 0)
                    root = glb.parents[root];
                Require(roots.Contains(root), "Source scene drops an authored node; keep every node in the default scene.");
            }
        }

        /// <summary>Unique joints and one Float32 inverse bind per joint.</summary>
        void ValidateSkins() {
            foreach (var item in Arr(glb.root, "skins")) {
                var skin = GlbSource.Obj(item);
                var joints = Arr(skin, "joints").Select(n => GlbSource.Index(n, glb.nodes.Count)).ToArray();
                Require(joints.Length > 0 && joints.Distinct().Count() == joints.Length, "Source skin needs a nonempty list of unique joints.");
                if (skin.ContainsKey("skeleton"))
                    GlbSource.Index(Get(skin, "skeleton"), glb.nodes.Count);
                var bind = Accessor(Get(skin, "inverseBindMatrices"));
                Require(Text(bind, "type") == "MAT4" && Int(bind, "componentType") == Float && Int(bind, "count") == joints.Length,
                    "Source skin needs one Float32 inverse bind matrix per joint.");
            }
        }

        void ValidateClips() {
            Require(data.nodes != null && data.clips != null && data.clips.Length == glb.animations.Count, "Sidecar node or clip inventory is incomplete; export the bundle again.");
            var names = new HashSet<string>(StringComparer.Ordinal);
            for (int i = 0; i < glb.animations.Count; i++) {
                ValidateClip(i);
                Require(names.Add(data.clips[i].name), "Duplicate source clip names are unsupported; give every clip a unique name.");
            }
        }

        /// <summary>Clip metadata equal to the sidecar, strictly increasing STEP keys and TRS channels of matching arity.</summary>
        void ValidateClip(int index) {
            var clip = GlbSource.Obj(glb.animations[index]);
            var extra = Obj(clip, "extras");
            var policy = data.clips[index];
            double fps = Num(extra, "fps");
            string name = Text(clip, "name");
            bool loop = GlbSource.Bool(Get(extra, "loop"));
            Require(name.Length > 0 && fps > 0 && IsNativeFps(policy.fps) && policy.animationIndex == index && policy.name == name &&
                policy.fps == (float)fps && policy.loop == loop,
                "Clip " + index + " metadata differs from the sidecar or is not a native Float32 rate; export the bundle again.");
            var samplers = Arr(clip, "samplers");
            var channels = Arr(clip, "channels");
            Require(samplers.Count > 0 && channels.Count > 0, "Source clip " + name + " has no samplers or channels.");
            foreach (var item in samplers) {
                var sampler = GlbSource.Obj(item);
                Require(Text(sampler, "interpolation") == "STEP", "Only STEP clips are supported; clip " + name + " uses other interpolation.");
                var input = Accessor(Get(sampler, "input"));
                var output = Accessor(Get(sampler, "output"));
                Require(Text(input, "type") == "SCALAR" && Int(input, "componentType") == Float && !Normalized(input) &&
                    Int(output, "componentType") == Float && !Normalized(output) && Int(output, "count") == Int(input, "count"),
                    "Clip " + name + " needs matching Float32 STEP input and output keys.");
                var readTime = Reader(input);
                double previous = -1;
                for (int k = 0; k < Int(input, "count"); k++) {
                    double time = readTime(k, 0);
                    Require(time >= 0 && time > previous, "Clip " + name + " key times must be nonnegative and strictly increasing.");
                    previous = time;
                }
            }
            var targets = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in channels) {
                var channel = GlbSource.Obj(item);
                int at = GlbSource.Index(Get(channel, "sampler"), samplers.Count);
                var target = Obj(channel, "target");
                int node = GlbSource.Index(Get(target, "node"), glb.nodes.Count);
                string path = Text(target, "path");
                Require((path == "translation" || path == "rotation" || path == "scale") && targets.Add(node + "/" + path),
                    "Clip " + name + " needs one translation, rotation or scale channel per node path.");
                var output = Accessor(Get(GlbSource.Obj(samplers[at]), "output"));
                Require(Text(output, "type") == (path == "rotation" ? "VEC4" : "VEC3"), "Clip " + name + " output arity differs from its target path.");
            }
        }

        /// <summary>Every mesh node in source order matches its sidecar policy and carries exact geometry.</summary>
        void ValidateMeshNodes() {
            int inventory = 0;
            for (int i = 0; i < glb.nodes.Count; i++) {
                var node = GlbSource.Obj(glb.nodes[i]);
                if (!node.ContainsKey("mesh"))
                    continue;
                Require(inventory < data.nodes.Length, "Sidecar omits a mesh node; export the bundle again.");
                ValidateMeshNode(i, node, data.nodes[inventory++]);
            }
            Require(inventory == data.nodes.Length && inventory > 0, "Sidecar mesh-node inventory differs from the source; export the bundle again.");
        }

        void ValidateMeshNode(int index, Dictionary<string, object> node, Node policy) {
            var meshes = Arr(glb.root, "meshes");
            var skins = Arr(glb.root, "skins");
            int meshIndex = GlbSource.Index(Get(node, "mesh"), meshes.Count);
            string name = Text(node, "name"), id = SourceId(index);
            var tag = Collision.Match(name);
            string suffix = tag.Success ? tag.Groups[1].Value.ToLowerInvariant() : "";
            string collider = suffix.StartsWith("conv", StringComparison.Ordinal) ? "convex" : suffix.Length > 0 ? "concave" : "none";
            bool rendererVisible = glb.visible[index] && !suffix.EndsWith("only", StringComparison.Ordinal);
            Require(id.Length > 0 && name.Length > 0 && policy.nodeIndex == index && policy.meshIndex == meshIndex && policy.id == id &&
                policy.name == name && policy.sourceVisible == glb.visible[index] && policy.rendererVisible == rendererVisible && policy.collider == collider,
                "Sidecar policy for node " + index + " differs from the source; export the bundle again.");
            int? skin = node.ContainsKey("skin") ? GlbSource.Index(Get(node, "skin"), skins.Count) : (int?)null;
            int jointCount = skin.HasValue ? Arr(GlbSource.Obj(skins[skin.Value]), "joints").Count : 0;
            var primitives = Arr(GlbSource.Obj(meshes[meshIndex]), "primitives");
            Require(primitives.Count > 0, "Source mesh " + meshIndex + " has no primitives.");
            long triangles = 0;
            foreach (var item in primitives)
                triangles += PrimitiveTriangles(GlbSource.Obj(item), skin.HasValue, jointCount);
            if (!data.generateColliders || collider == "none")
                return;
            bool isStatic = !skin.HasValue && !node.ContainsKey("weights") && !Obj(node, "extensions").ContainsKey("EXT_mesh_gpu_instancing");
            Require(isStatic && (collider != "concave" || !glb.moving[index]) && (collider != "convex" || triangles <= 255),
                "Requested collider on node " + name + " needs a static helper (convex: at most 255 triangles); nothing is silently omitted.");
        }

        /// <summary>Triangle count of one exact Float32 atlas primitive, after checking its attributes, skin weights and indices.</summary>
        long PrimitiveTriangles(Dictionary<string, object> primitive, bool skinned, int jointCount) {
            Require(OptionalInt(primitive, "mode", Triangles) == Triangles && !primitive.ContainsKey("targets") && Num(primitive, "material") == 0,
                "Source primitives must be triangles bound to the atlas material, without morph targets.");
            var attributes = Obj(primitive, "attributes");
            int vertices = Int(Accessor(Get(attributes, "POSITION")), "count");
            foreach (var (key, type) in new[] { ("POSITION", "VEC3"), ("NORMAL", "VEC3"), ("TEXCOORD_0", "VEC2") })
                ValidateAttribute(Accessor(Get(attributes, key)), type, Float, vertices);
            if (skinned)
                ValidateSkinWeights(attributes, vertices, jointCount);
            int corners = vertices;
            if (primitive.ContainsKey("indices")) {
                var indices = Accessor(Get(primitive, "indices"));
                int component = Int(indices, "componentType");
                Require(Text(indices, "type") == "SCALAR" && (component == 5121 || component == 5123 || component == 5125) && !Normalized(indices),
                    "Source indices must be unsigned integer scalars.");
                corners = Int(indices, "count");
                var readIndex = Reader(indices);
                for (int j = 0; j < corners; j++)
                    Require(readIndex(j, 0) < vertices, "Source index exceeds its vertices; export the GLB again.");
            }
            Require(corners > 0 && corners % 3 == 0, "Source triangles must be complete.");
            return corners / 3;
        }

        /// <summary>Joint indices inside the skin and four weights per vertex in [0, 1] summing to one.</summary>
        void ValidateSkinWeights(Dictionary<string, object> attributes, int vertices, int jointCount) {
            var weights = Accessor(Get(attributes, "WEIGHTS_0"));
            ValidateAttribute(weights, "VEC4", Float, vertices);
            var joints = Accessor(Get(attributes, "JOINTS_0"));
            int component = Int(joints, "componentType");
            Require(Text(joints, "type") == "VEC4" && (component == 5121 || component == 5123) && Int(joints, "count") == vertices && !Normalized(joints),
                "Source JOINTS_0 must be unnormalized unsigned byte or short VEC4 per vertex.");
            var readWeight = Reader(weights);
            var readJoint = Reader(joints);
            for (int vertex = 0; vertex < vertices; vertex++) {
                double total = 0;
                for (int c = 0; c < 4; c++) {
                    double weight = readWeight(vertex, c);
                    Require(weight >= 0 && weight <= 1 && readJoint(vertex, c) < jointCount, "Source vertex " + vertex + " has a weight outside [0, 1] or a joint outside its skin.");
                    total += weight;
                }
                Require(Math.Abs(total - 1) <= UnitEnvelope, "Source vertex " + vertex + " weights must sum to one; repair the source (export does not normalize).");
            }
        }

        // ---- Accessor helpers

        Dictionary<string, object> Accessor(object index) {
            var list = Arr(glb.root, "accessors");
            return GlbSource.Obj(list[GlbSource.Index(index, list.Count)]);
        }

        /// <summary>Reader of one accessor's components; resolves its view, stride and type once for loops over every element.</summary>
        Func<int, int, double> Reader(Dictionary<string, object> accessor) {
            var views = Arr(glb.root, "bufferViews");
            var view = GlbSource.Obj(views[GlbSource.Index(Get(accessor, "bufferView"), views.Count)]);
            int type = Int(accessor, "componentType"), size = ComponentSize(type);
            int stride = view.ContainsKey("byteStride") ? Int(view, "byteStride") : size * Arity(Text(accessor, "type"));
            int start = checked(OptionalInt(view, "byteOffset") + OptionalInt(accessor, "byteOffset"));
            var b = glb.binary;
            return (entry, component) => {
                int at = checked(start + entry * stride + component * size);
                switch (type) {
                    case 5120:
                        return (sbyte)b[at];
                    case 5121:
                        return b[at];
                    case 5122:
                        return BitConverter.ToInt16(b, at);
                    case 5123:
                        return BitConverter.ToUInt16(b, at);
                    case 5125:
                        return BitConverter.ToUInt32(b, at);
                    default:
                        return BitConverter.ToSingle(b, at);
                }
            };
        }

        static int ComponentSize(int type) {
            switch (type) {
                case 5120:
                case 5121:
                    return 1;
                case 5122:
                case 5123:
                    return 2;
                case 5125:
                case Float:
                    return 4;
                default:
                    throw new InvalidDataException("Unsupported accessor componentType " + type + "; export an ordinary GLB.");
            }
        }

        static int Arity(string type) {
            switch (type) {
                case "SCALAR":
                    return 1;
                case "VEC2":
                    return 2;
                case "VEC3":
                    return 3;
                case "VEC4":
                case "MAT2":
                    return 4;
                case "MAT3":
                    return 9;
                case "MAT4":
                    return 16;
                default:
                    throw new InvalidDataException("Unsupported accessor type " + type + "; export an ordinary GLB.");
            }
        }

        static bool Normalized(Dictionary<string, object> accessor) => accessor.ContainsKey("normalized") && GlbSource.Bool(Get(accessor, "normalized"));
        static void ValidateAttribute(Dictionary<string, object> accessor, string type, int component, int count) =>
            Require(Text(accessor, "type") == type && Int(accessor, "componentType") == component && Int(accessor, "count") == count && !Normalized(accessor),
                "Source attributes must be unnormalized Float32 " + type + " with one value per vertex.");

        // ---- JSON helpers shared by the companion

        internal static void Require(bool condition, string message) {
            if (!condition)
                throw new InvalidDataException(message);
        }
        internal static object Get(Dictionary<string, object> doc, string key) => GlbSource.Get(doc, key);
        internal static Dictionary<string, object> Obj(Dictionary<string, object> doc, string key) => GlbSource.Obj(Get(doc, key));
        internal static List<object> Arr(Dictionary<string, object> doc, string key) => GlbSource.Arr(Get(doc, key));
        internal static string Text(Dictionary<string, object> doc, string key) => GlbSource.Text(Get(doc, key));
        internal static double Num(Dictionary<string, object> doc, string key) => GlbSource.Number(Get(doc, key));
        internal static int Int(Dictionary<string, object> doc, string key) {
            double n = Num(doc, key);
            Require(n >= 0 && n <= int.MaxValue && n == Math.Floor(n), "Expected a nonnegative integer for \"" + key + "\"; repair the JSON.");
            return (int)n;
        }
        static int OptionalInt(Dictionary<string, object> doc, string key, int fallback = 0) => doc.ContainsKey(key) ? Int(doc, key) : fallback;
    }
}

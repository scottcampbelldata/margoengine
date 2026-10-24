using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace MargoMesh.Unity.Editor {
    // Readiness report types and the owned report.json snapshot.
    public static partial class ImportCompanion {
        /// <summary>Support package identity a readiness tuple was generated with.</summary>
        [Serializable]
        public sealed class Support {
            /// <summary>Support package id, <c>com.margo.mesh</c>.</summary>
            public string package;
            /// <summary>Support package version.</summary>
            public string version;
            /// <summary>SHA-256 of the installed <c>support-manifest.json</c>.</summary>
            public string manifestSHA256;
        }

        /// <summary>Source GLB and atlas identity.</summary>
        [Serializable]
        public sealed class Source {
            /// <summary>Asset GUID of <c>model.glb</c>.</summary>
            public string guid;
            /// <summary>Project path of <c>model.glb</c>.</summary>
            public string glbPath;
            /// <summary>SHA-256 of <c>model.glb</c>.</summary>
            public string glbSHA256;
            /// <summary>Project path of <c>atlas.png</c>.</summary>
            public string pngPath;
            /// <summary>SHA-256 of <c>atlas.png</c>.</summary>
            public string pngSHA256;
            /// <summary>Atlas width in pixels.</summary>
            public int width;
            /// <summary>Atlas height in pixels.</summary>
            public int height;
        }

        /// <summary>Generated resource counts recorded for a readiness tuple.</summary>
        [Serializable]
        public sealed class Counts {
            /// <summary>Source mesh nodes in the prefab.</summary>
            public int meshNodes;
            /// <summary>Renderers left disabled (hidden source nodes and collider-only helpers).</summary>
            public int hiddenRenderers;
            /// <summary>Generated mesh colliders.</summary>
            public int colliders;
            /// <summary>Owned textures (one atlas).</summary>
            public int textures;
            /// <summary>Owned materials (one).</summary>
            public int materials;
            /// <summary>Owned animation clips.</summary>
            public int clips;
        }

        /// <summary>One generation attempt and everything it bound.</summary>
        [Serializable]
        public sealed class Tuple {
            /// <summary>Attempt id, a GUID in <c>N</c> format.</summary>
            public string generationId;
            /// <summary>SHA-256 of <c>margo-profile.json</c>.</summary>
            public string profileSHA256;
            /// <summary>Hash over every owned output file, its GUID and its hashes.</summary>
            public string outputManifestSHA256;
            /// <summary>Hash of the owned clip/mesh identity and intended file inventory.</summary>
            public string identityManifestSHA256;
            /// <summary>Support package identity.</summary>
            public Support support;
            /// <summary>Source GLB and atlas identity.</summary>
            public Source source;
            /// <summary>Whether tagged colliders were requested.</summary>
            public bool generateColliders;
            /// <summary>Generated resource counts.</summary>
            public Counts counts;
        }

        /// <summary>Why the last attempt failed.</summary>
        [Serializable]
        public sealed class Error {
            /// <summary>Failed stage (<c>validation</c>, <c>owned-output</c>, <c>resources</c>, <c>prefab</c>, ...), <c>cancelled</c> or <c>input-changed</c>.</summary>
            public string code;
            /// <summary>The failure message.</summary>
            public string message;
            /// <summary>What to do next.</summary>
            public string recovery;
            /// <summary>True when owned output may be partially updated.</summary>
            public bool partialOutput;
        }

        /// <summary>The owned <c>report.json</c> snapshot. Call <see cref="IsCurrent"/>; a stored report alone is not readiness.</summary>
        [Serializable]
        public sealed class Report {
            /// <summary>Report schema, 1.</summary>
            public int schema = 1;
            /// <summary>Import profile id.</summary>
            public string profile = ImportProfile.Id;
            /// <summary><c>preparing</c>, <c>ready</c>, <c>stale</c> or <c>rejected</c>.</summary>
            public string status;
            /// <summary>True only after a complete verified generation.</summary>
            public bool companionIsCurrent;
            /// <summary>The latest attempt.</summary>
            public Tuple current;
            /// <summary>The last attempt that completed, or null.</summary>
            public Tuple lastSuccessful;
            /// <summary>The latest failure, or null.</summary>
            public Error error;
        }

        /// <summary>A best-effort attempt record before the profile could be read (hashes are empty when a file is missing).</summary>
        static Tuple Attempt(string path) {
            string png = Path.GetDirectoryName(path).Replace('\\', '/') + "/atlas.png";
            return new Tuple {
                generationId = Guid.NewGuid().ToString("N"),
                profileSHA256 = SafeHash(ImportProfile.ProfilePath(path)),
                support = new Support { package = ImportProfile.Package, version = ImportProfile.Version, manifestSHA256 = "" },
                source = new Source { guid = AssetDatabase.AssetPathToGUID(path), glbPath = path, glbSHA256 = SafeHash(path), pngPath = png, pngSHA256 = SafeHash(png) },
                counts = new Counts(),
            };
        }

        /// <summary>The attempt record of a validated profile.</summary>
        static Tuple Attempt(ImportProfile p) {
            var support = p.data.support;
            var source = p.data.source;
            return new Tuple {
                generationId = Guid.NewGuid().ToString("N"),
                profileSHA256 = p.profileHash,
                support = new Support { package = support.package, version = support.version, manifestSHA256 = support.manifestSHA256 },
                source = new Source {
                    guid = p.sourceGuid, glbPath = p.sourcePath, glbSHA256 = source.glbSHA256,
                    pngPath = p.pngPath, pngSHA256 = source.pngSHA256, width = source.width, height = source.height,
                },
                generateColliders = p.data.generateColliders,
                counts = new Counts(),
            };
        }

        static string SafeHash(string path) {
            try {
                return ImportProfile.FileHash(path);
            } catch (Exception) { return ""; }
        }

        /// <summary>True when <paramref name="t"/> binds exactly this profile's support, source and collider request.</summary>
        static bool Matches(Tuple t, ImportProfile p) {
            if (t?.source == null || t.support == null || t.counts == null)
                return false;
            var support = p.data.support;
            var source = p.data.source;
            bool sameSupport = t.support.package == support.package && t.support.version == support.version && t.support.manifestSHA256 == support.manifestSHA256;
            bool sameSource = t.source.guid == p.sourceGuid && t.source.glbPath == p.sourcePath && t.source.glbSHA256 == source.glbSHA256 &&
                t.source.pngPath == p.pngPath && t.source.pngSHA256 == source.pngSHA256 && t.source.width == source.width && t.source.height == source.height;
            return t.profileSHA256 == p.profileHash && sameSupport && sameSource && t.generateColliders == p.data.generateColliders;
        }

        /// <summary>The stored report, with JsonUtility's blank placeholders turned back into nulls; null when absent or malformed.</summary>
        static Report ReadReport(string path) {
            string file = OutputPath(path, "report.json");
            try {
                if (!File.Exists(file))
                    return null;
                var bytes = File.ReadAllBytes(file);
                var raw = GlbSource.Parse(bytes);
                // JsonUtility stores a null inline serializable class as a fully blank
                // object. Validate its raw shape before restoring the API's null value.
                ImportProfile.Require(raw.ContainsKey("error") && raw.ContainsKey("lastSuccessful"), "Readiness nullable fields are missing.");
                bool noError = StoredErrorIsAbsent(raw["error"]), noLastSuccess = StoredLastSuccessIsAbsent(raw["lastSuccessful"]);
                var report = JsonUtility.FromJson<Report>(Encoding.UTF8.GetString(bytes));
                ImportProfile.Require(report != null && (noError || report.error != null) && (noLastSuccess || report.lastSuccessful != null), "Readiness nullable fields could not be read.");
                if (noError)
                    report.error = null;
                if (noLastSuccess)
                    report.lastSuccessful = null;
                return report;
            } catch (Exception) { return null; }
        }
        static Dictionary<string, object> StoredObject(object value, params string[] keys) {
            var map = value as Dictionary<string, object>;
            if (map == null || map.Count != keys.Length || keys.Any(key => !map.ContainsKey(key)))
                throw new InvalidDataException("Readiness object fields are missing or unsupported.");
            return map;
        }
        static bool StoredTextIsEmpty(object value) {
            if (value == null)
                return true;
            if (!(value is string text))
                throw new InvalidDataException("Readiness text field has an invalid type.");
            return text.Length == 0;
        }
        static bool StoredIntegerIsZero(object value) {
            if (!(value is double number) || number < 0 || number > int.MaxValue || number != Math.Floor(number))
                throw new InvalidDataException("Readiness integer field has an invalid type.");
            return number == 0;
        }
        static bool StoredErrorIsAbsent(object value) {
            if (value == null)
                return true;
            var map = StoredObject(value, "code", "message", "recovery", "partialOutput");
            bool code = StoredTextIsEmpty(map["code"]), message = StoredTextIsEmpty(map["message"]), recovery = StoredTextIsEmpty(map["recovery"]);
            bool partial = GlbSource.Bool(map["partialOutput"]);
            return code && message && recovery && !partial;
        }
        /// <summary>True for JsonUtility's fully blank placeholder of a null tuple; a partly filled tuple counts as present.</summary>
        static bool StoredLastSuccessIsAbsent(object value) {
            if (value == null)
                return true;
            var map = StoredObject(value, "generationId", "profileSHA256", "outputManifestSHA256", "identityManifestSHA256", "support", "source", "generateColliders", "counts");
            var support = StoredObject(map["support"], "package", "version", "manifestSHA256");
            var source = StoredObject(map["source"], "guid", "glbPath", "glbSHA256", "pngPath", "pngSHA256", "width", "height");
            var counts = StoredObject(map["counts"], "meshNodes", "hiddenRenderers", "colliders", "textures", "materials", "clips");
            // Validate every field even when a previous field is nonempty. A partial
            // tuple stays present and cannot become last-success/current evidence.
            bool blank = true;
            foreach (string key in new[] { "generationId", "profileSHA256", "outputManifestSHA256", "identityManifestSHA256" })
                blank &= StoredTextIsEmpty(map[key]);
            foreach (var field in support)
                blank &= StoredTextIsEmpty(field.Value);
            foreach (string key in new[] { "guid", "glbPath", "glbSHA256", "pngPath", "pngSHA256" })
                blank &= StoredTextIsEmpty(source[key]);
            foreach (string key in new[] { "width", "height" })
                blank &= StoredIntegerIsZero(source[key]);
            foreach (var field in counts)
                blank &= StoredIntegerIsZero(field.Value);
            bool colliders = GlbSource.Bool(map["generateColliders"]);
            return blank && !colliders;
        }

        /// <summary>Writes the report only into a folder this source already owns; never creates ownership.</summary>
        static void TryWriteOwnedReport(string path, Report report) {
            try {
                if (CheckOwner(path, AssetDatabase.AssetPathToGUID(path)) != null)
                    WriteReport(path, report);
            } catch (Exception e) { Debug.LogWarning("Margo could not update an owned readiness snapshot: " + e.Message); }
        }
        static void WriteReport(string path, Report report) {
            string file = OutputPath(path, "report.json");
            File.WriteAllText(file, JsonUtility.ToJson(report, true) + "\n");
            AssetDatabase.ImportAsset(file, ImportAssetOptions.ForceSynchronousImport);
        }
    }
}

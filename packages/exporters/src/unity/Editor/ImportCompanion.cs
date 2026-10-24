using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using GLTFast;
using GLTFast.Logging;
using UnityEditor;
using UnityEngine;
using Object = UnityEngine.Object;

namespace MargoMesh.Unity.Editor {
    /// <summary>Opt-in target import through public glTFast and Unity APIs. Raw GLB assets are never modified.</summary>
    public static partial class ImportCompanion {
        const string PartialRecovery = "Owned output may be partially updated. Reimport the complete valid model/profile/atlas only when every output remains ownership-recorded. An unrecorded/conflicting file requires explicit user review and manual recovery; it is never adopted. Require IsCurrent before use.";
        const string RejectedRecovery = "Correct the explicit profile/support/source or ownership conflict, then request a complete target import.";
        const string CleanupRecovery = "Do not use this attempt. Review native cleanup diagnostics, then perform a complete ownership-verified target import.";

        static readonly HashSet<string> generating = new HashSet<string>(StringComparer.Ordinal);
        static readonly Dictionary<string, CancellationTokenSource> cancellation = new Dictionary<string, CancellationTokenSource>(StringComparer.Ordinal);

        static ImportCompanion() {
            AssemblyReloadEvents.beforeAssemblyReload += CancelAll;
            EditorApplication.quitting += CancelAll;
        }

        static void CancelAll() {
            foreach (var token in cancellation.Values)
                token.Cancel();
        }

        internal static bool IsGenerating(string path) => generating.Contains(path);

        /// <summary>Owned output folder. A folder at this path is never adopted without the exact source GUID marker.</summary>
        public static string GetOutputDirectory(string sourcePath) =>
            Path.GetDirectoryName(sourcePath).Replace('\\', '/') + "/" + Path.GetFileNameWithoutExtension(sourcePath) + ".Margo";

        /// <summary>Generated prefab path; existence alone is not readiness.</summary>
        public static string GetPrefabPath(string sourcePath) => GetOutputDirectory(sourcePath) + "/" + Path.GetFileNameWithoutExtension(sourcePath) + ".prefab";

        /// <summary>Revalidates the actual executing support/profile/source tuple. Stored JSON alone is only a prior snapshot.</summary>
        public static bool IsCurrent(string sourcePath, out Report report) {
            report = null;
            try {
                var profile = ImportProfile.Read(sourcePath);
                var owner = CheckOwner(sourcePath, profile.sourceGuid);
                if (owner == null)
                    return false;
                report = ReadReport(sourcePath);
                if (!IsReadySnapshot(report, profile))
                    return false;
                RequireSourceIdentity(profile, owner);
                VerifyOutputs(sourcePath, owner, report.current);
                VerifySaved(profile, report.current.counts, owner);
                return true;
            } catch (Exception) { return false; }
        }

        /// <summary>A stored report that claims a complete generation of exactly this profile.</summary>
        static bool IsReadySnapshot(Report report, ImportProfile profile) {
            if (report == null || report.schema != 1 || report.profile != ImportProfile.Id || report.status != "ready" || !report.companionIsCurrent || report.error != null)
                return false;
            if (!Matches(report.current, profile) || !Matches(report.lastSuccessful, profile))
                return false;
            return Guid.TryParseExact(report.current.generationId, "N", out var generation) && generation != Guid.Empty &&
                JsonUtility.ToJson(report.lastSuccessful) == JsonUtility.ToJson(report.current);
        }

        /// <summary>Asynchronously imports one fixed, strictly validated asset through an isolated public glTFast invocation.</summary>
        public static async Task<bool> GenerateAsync(string sourcePath, CancellationToken cancellationToken = default) {
            if (!ImportProfile.IsSourcePath(sourcePath) || !generating.Add(sourcePath))
                return false;
            var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            cancellation.Add(sourcePath, linked);
            CancellationToken token = linked.Token;
            GltfImport importer = null;
            GameObject instance = null;
            var prepared = new Prepared();
            var report = new Report { status = "preparing", companionIsCurrent = false, current = Attempt(sourcePath) };
            Tuple priorLastSuccessful = null;
            bool wrote = false, reloadLocked = false, cleaned = false;
            string stage = "validation";
            try {
                var previous = ReadReport(sourcePath);
                priorLastSuccessful = previous?.lastSuccessful ?? (previous != null && previous.status == "ready" ? previous.current : null);
                report.lastSuccessful = priorLastSuccessful;
                // Invalidate an already-owned snapshot before asynchronous work; fresh/unowned folders receive no write.
                MarkNotCurrent(sourcePath, "preparing", "Input import or explicit target generation requested.", false);
                token.ThrowIfCancellationRequested();
                var profile = ImportProfile.Read(sourcePath);
                report.current = Attempt(profile);
                var owner = CheckOwner(sourcePath, profile.sourceGuid);
                ValidateHistory(profile, owner, previous);
                ValidateExistingClock(profile, owner);

                instance = new GameObject("model");
                instance.SetActive(false);
                instance.hideFlags = HideFlags.HideAndDontSave;
                var logger = new CollectingLogger();
                importer = new GltfImport(deferAgent: new UninterruptedDeferAgent(), logger: logger);
                // A reload cannot discard this asynchronous attempt before its finally
                // releases native resources. This owns exactly one balanced reload lock.
                EditorApplication.LockReloadAssemblies();
                reloadLocked = true;
                await LoadIsolatedAsync(profile, importer, logger, instance, token);

                ValidateGraph(profile, importer, instance);
                PreserveOverrides(instance, AssetDatabase.LoadAssetAtPath<GameObject>(GetPrefabPath(sourcePath)));
                Prepare(profile, importer, instance, prepared, report.current.counts);
                ValidateImportedAnimator(instance, prepared.clips.Length);
                var nextMeshes = MeshIdentities(profile, instance);
                ValidateUpdateIdentity(profile, owner, nextMeshes);
                ValidateOutputNames(sourcePath, owner, prepared, report.current.counts.clips > 0);
                // Recheck native graph edits after await; never silently reset them.
                ValidateExistingClock(profile, owner);
                var intendedOwner = owner ?? CreateOwnerIdentity(profile, nextMeshes);
                report.current.identityManifestSHA256 = IdentityHash(intendedOwner);
                profile.AssertInputsCurrent();
                token.ThrowIfCancellationRequested();

                stage = "owned-output";
                wrote = true;
                owner = EstablishOwner(profile, intendedOwner, owner != null);
                WriteReport(sourcePath, report);
                stage = "resources";
                SaveResources(profile, instance, prepared, owner);
                token.ThrowIfCancellationRequested();
                stage = "prefab";
                instance.hideFlags = HideFlags.None;
                instance.SetActive(true);
                if (PrefabUtility.SaveAsPrefabAsset(instance, GetPrefabPath(sourcePath)) == null)
                    throw new IOException("Unity did not save the generated prefab.");
                Record(owner, sourcePath, GetPrefabPath(sourcePath), typeof(GameObject));
                FlushOwned(sourcePath, owner);

                stage = "temporary-cleanup";
                var graph = instance;
                instance = null;
                var loaded = importer;
                importer = null;
                Cleanup(graph, prepared, loaded);
                cleaned = true;

                stage = "post-save-verification";
                profile.AssertInputsCurrent();
                VerifySaved(profile, report.current.counts, owner);
                token.ThrowIfCancellationRequested();
                BindOutputs(sourcePath, owner, report.current);
                report.status = "ready";
                report.companionIsCurrent = true;
                report.error = null;
                report.lastSuccessful = report.current;
                WriteReport(sourcePath, report);
                return true;
            } catch (Exception error) {
                string code = error is OperationCanceledException ? "cancelled" : stage;
                Fail(sourcePath, report, priorLastSuccessful, wrote, code, error.Message, wrote ? PartialRecovery : RejectedRecovery);
                Debug.LogWarning("Margo strict target rejected " + sourcePath + " [" + code + "]: " + error.Message);
                return false;
            } finally {
                try {
                    if (!cleaned)
                        try {
                            Cleanup(instance, prepared, importer);
                        } catch (Exception error) {
                            Fail(sourcePath, report, priorLastSuccessful, wrote, "temporary-cleanup", error.Message, CleanupRecovery);
                            Debug.LogWarning("Margo strict target cleanup failed for " + sourcePath + ": " + error.Message);
                        }
                } finally {
                    try {
                        linked.Dispose();
                        cancellation.Remove(sourcePath);
                        generating.Remove(sourcePath);
                    } finally {
                        if (reloadLocked)
                            EditorApplication.UnlockReloadAssemblies();
                    }
                }
            }
        }

        /// <summary>Loads the validated GLB bytes and instantiates the default scene under <paramref name="instance"/>, rejecting any glTFast error.</summary>
        static async Task LoadIsolatedAsync(ImportProfile profile, GltfImport importer, CollectingLogger logger, GameObject instance, CancellationToken token) {
            new NodeAddon(profile).Inject(importer);
            var settings = new ImportSettings {
                NodeNameMethod = NameImportMethod.OriginalUnique,
                AnimationMethod = AnimationMethod.Mecanim,
                GenerateMipMaps = false,
                TexturesReadable = true,
                AnisotropicFilterLevel = 0,
            };
            if (!await importer.Load(profile.glb.bytes, new Uri(Path.GetFullPath(profile.sourcePath)), settings, token))
                throw new InvalidDataException("Public glTFast target load failed.");
            token.ThrowIfCancellationRequested();
            ImportProfile.Require(importer.SceneCount == 1 && importer.DefaultSceneIndex == 0, "Public target source has no exact declared default scene.");
            var instantiator = new GameObjectInstantiator(importer, instance.transform, logger, new InstantiationSettings { SceneObjectCreation = SceneObjectCreation.Never });
            if (!await importer.InstantiateSceneAsync(instantiator, 0, token))
                throw new InvalidDataException("Public glTFast target instantiation failed.");
            if (logger.Items != null && logger.Items.Any(item => item.Type == LogType.Error || item.Type == LogType.Exception)) {
                logger.LogAll();
                throw new InvalidDataException("Public glTFast target reported an import error.");
            }
            token.ThrowIfCancellationRequested();
        }

        /// <summary>Marks <paramref name="report"/> failed, restores the prior last success and writes it when the folder is owned.</summary>
        static void Fail(string sourcePath, Report report, Tuple priorLastSuccessful, bool wrote, string code, string message, string recovery) {
            report.status = wrote ? "stale" : "rejected";
            report.companionIsCurrent = false;
            report.lastSuccessful = priorLastSuccessful;
            report.error = new Error { code = code, message = message, partialOutput = wrote, recovery = recovery };
            TryWriteOwnedReport(sourcePath, report);
        }

        static void Cleanup(GameObject instance, Prepared prepared, GltfImport importer) {
            Exception failure = null;
            try {
                if (instance != null)
                    Object.DestroyImmediate(instance);
            } catch (Exception e) { failure = e; }
            try {
                prepared.Destroy();
            } catch (Exception e) { failure = failure ?? e; }
            try {
                importer?.Dispose();
            } catch (Exception e) { failure = failure ?? e; }
            if (failure != null)
                throw new InvalidOperationException("Controlled public target cleanup failed.", failure);
        }

        /// <summary>Cancels a running generation and marks an owned snapshot not current after an input changed.</summary>
        internal static void MarkNotCurrent(string path, string status, string message, bool cancel = true) {
            if (!ImportProfile.IsSourcePath(path))
                return;
            if (cancel && cancellation.TryGetValue(path, out var token))
                token.Cancel();
            var previous = ReadReport(path);
            if (previous == null)
                return;
            previous.lastSuccessful = previous.lastSuccessful ?? (previous.companionIsCurrent ? previous.current : null);
            previous.current = Attempt(path);
            previous.status = status;
            previous.companionIsCurrent = false;
            previous.error = new Error { code = "input-changed", message = message, partialOutput = false, recovery = "A complete valid target import and fresh IsCurrent check are required." };
            TryWriteOwnedReport(path, previous);
        }
    }
}
